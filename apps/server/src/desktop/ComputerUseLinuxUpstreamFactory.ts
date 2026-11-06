import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import { ComputerUseLinuxUpstreamFactoryService } from "./ComputerUseLinuxServerIntegration.ts";
import type {
  ComputerUseLinuxMcpTool,
  ComputerUseLinuxUpstreamMcpClient,
} from "./ComputerUseLinuxMcpAdapter.ts";

const EXECUTABLE = "computer-use-linux";
const ARGS = ["mcp"] as const;

// Windows hosts run Windows-MCP (MIT, UI Automation) through uv, pinned so an update cannot
// change which tools exist. The policy allowlist only passes its screen and input tools.
const WINDOWS_EXECUTABLE = "uvx";
const WINDOWS_ARGS = ["windows-mcp==0.8.8", "serve"] as const;
const WINDOWS_ENVIRONMENT_ALLOWLIST = [
  "APPDATA",
  "COMPUTERNAME",
  "ComSpec",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "ProgramData",
  "ProgramFiles",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERPROFILE",
  "windir",
] as const;

// Keep the child tied to the current graphical login without inheriting arbitrary loader,
// downloader, backend-selection, or T3 identity variables from the server process.
const DESKTOP_ENVIRONMENT_ALLOWLIST = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DESKTOP_SESSION",
  "DISPLAY",
  "LANG",
  "LANGUAGE",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
] as const;

export class ComputerUseLinuxExecutableUnavailableError extends Schema.TaggedError<ComputerUseLinuxExecutableUnavailableError>()(
  "ComputerUseLinuxExecutableUnavailableError",
  { command: Schema.String },
) {
  override get message(): string {
    return `${this.command} is not installed or is not executable.`;
  }
}

export class ComputerUseLinuxUpstreamStartError extends Schema.TaggedError<ComputerUseLinuxUpstreamStartError>()(
  "ComputerUseLinuxUpstreamStartError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Computer Use for Linux MCP could not be started.";
  }
}

interface McpClientLike {
  connect(
    transport: StdioClientTransport,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  listTools(): Promise<{ readonly tools: ReadonlyArray<ComputerUseLinuxMcpTool> }>;
  callTool(
    input: { readonly arguments?: Record<string, unknown>; readonly name: string },
    schema?: undefined,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface ComputerUseLinuxUpstreamDependencies {
  readonly clientFactory?: () => McpClientLike;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly resolveExecutable: (
    command: string,
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
  ) => string | undefined;
  readonly transportFactory?: (parameters: StdioServerParameters) => StdioClientTransport;
}

function inheritedDesktopEnvironment(
  environment: NodeJS.ProcessEnv,
  allowlist: ReadonlyArray<string> = DESKTOP_ENVIRONMENT_ALLOWLIST,
): Record<string, string> {
  const inherited = getDefaultEnvironment();
  for (const name of allowlist) {
    const value = environment[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

/**
 * Real stdio MCP process factory. The executable, args, inherited variable names, and all
 * security-sensitive overrides are server owned; tool input cannot influence process launch.
 */
export function makeComputerUseLinuxUpstreamFactory(
  dependencies: ComputerUseLinuxUpstreamDependencies,
): ComputerUseLinuxUpstreamFactoryService["Service"] {
  return ComputerUseLinuxUpstreamFactoryService.of({
    start: async ({ environment: controlledEnvironment, signal }) => {
      const windows = dependencies.platform === "win32";
      if (dependencies.platform !== "linux" && !windows) {
        throw new ComputerUseLinuxUpstreamStartError({
          cause: new Error(`Unsupported platform: ${dependencies.platform}`),
        });
      }
      const hostEnvironment = dependencies.environment ?? process.env;
      const command = windows ? WINDOWS_EXECUTABLE : EXECUTABLE;
      const executable = dependencies.resolveExecutable(
        command,
        dependencies.platform,
        hostEnvironment,
      );
      if (executable === undefined) {
        throw new ComputerUseLinuxExecutableUnavailableError({ command });
      }
      const transport = (
        dependencies.transportFactory ?? ((parameters) => new StdioClientTransport(parameters))
      )({
        command: executable,
        args: windows ? [...WINDOWS_ARGS] : [...ARGS],
        env: windows
          ? inheritedDesktopEnvironment(hostEnvironment, WINDOWS_ENVIRONMENT_ALLOWLIST)
          : {
              ...inheritedDesktopEnvironment(hostEnvironment),
              ...controlledEnvironment,
              // GNOME's Screenshot portal asks on every call for a caller without an app ID,
              // such as a system service, and rejects it when another app has focus.
              // gnome-screenshot is the route meant for background services.
              ...(controlledEnvironment.COMPUTER_USE_LINUX_SCREENSHOT_BACKEND === "portal" &&
              dependencies.resolveExecutable(
                "gnome-screenshot",
                dependencies.platform,
                hostEnvironment,
              ) !== undefined
                ? { COMPUTER_USE_LINUX_SCREENSHOT_BACKEND: "gnome-screenshot" }
                : {}),
            },
        // Do not let untrusted desktop/tool content or terminal controls reach server logs, and
        // do not leave an unread pipe that can fill and deadlock the MCP child.
        stderr: "ignore",
      });
      const client =
        dependencies.clientFactory?.() ??
        new Client({ name: "t3-code-computer-use-linux", version: "1.0.0" });
      try {
        await client.connect(transport, signal === undefined ? undefined : { signal });
      } catch (cause) {
        await Promise.allSettled([client.close(), transport.close()]);
        throw new ComputerUseLinuxUpstreamStartError({ cause });
      }
      let confirmTransportClosed: Promise<void> = Promise.resolve();
      if (typeof transport.pid === "number") {
        let markTransportClosed: () => void = () => undefined;
        confirmTransportClosed = new Promise<void>((resolve) => {
          markTransportClosed = resolve;
        });
        const protocolOnClose = transport.onclose;
        transport.onclose = () => {
          protocolOnClose?.();
          markTransportClosed();
        };
        // It may have exited between the pid check and replacing the callback.
        if (transport.pid === null) markTransportClosed();
      }
      let closePromise: Promise<void> | undefined;
      const closeOnce = () => {
        closePromise ??= (async () => {
          let closeError: unknown;
          try {
            await client.close();
          } catch (cause) {
            closeError = cause;
            try {
              await transport.close();
            } catch (transportCause) {
              closeError = new AggregateError(
                [cause, transportCause],
                "Computer Use MCP process shutdown failed.",
              );
            }
          }
          // The SDK's stdio close returns immediately after SIGKILL. Do not let the host lease go
          // until the kernel reports the child closed; a cancellation-ignoring process may still
          // be interacting with the desktop in this interval.
          await confirmTransportClosed;
          if (closeError !== undefined) throw closeError;
        })();
        return closePromise;
      };
      const callWithShutdownOnFailure = async <A>(operation: () => Promise<A>): Promise<A> => {
        try {
          return await operation();
        } catch (cause) {
          try {
            await closeOnce();
          } catch (closeCause) {
            throw new AggregateError(
              [cause, closeCause],
              "Computer Use MCP call and process shutdown failed.",
              { cause: closeCause },
            );
          }
          throw cause;
        }
      };
      const upstream: ComputerUseLinuxUpstreamMcpClient = {
        listTools: () => callWithShutdownOnFailure(async () => (await client.listTools()).tools),
        callTool: async (input, options) =>
          callWithShutdownOnFailure(() =>
            client.callTool(
              {
                name: input.name,
                ...(input.arguments !== undefined &&
                typeof input.arguments === "object" &&
                input.arguments !== null &&
                !Array.isArray(input.arguments)
                  ? { arguments: input.arguments as Record<string, unknown> }
                  : {}),
              },
              undefined,
              { signal: options.signal },
            ),
          ),
        close: closeOnce,
      };
      return upstream;
    },
  });
}

export const layer = Layer.effect(
  ComputerUseLinuxUpstreamFactoryService,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const resolveExecutable = yield* SpawnExecutableResolution;
    return makeComputerUseLinuxUpstreamFactory({ platform, resolveExecutable });
  }),
);

export const __testing = {
  args: ARGS,
  desktopEnvironmentAllowlist: DESKTOP_ENVIRONMENT_ALLOWLIST,
  executable: EXECUTABLE,
  inheritedDesktopEnvironment,
};
