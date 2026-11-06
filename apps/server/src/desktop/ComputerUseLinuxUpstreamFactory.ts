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

function inheritedDesktopEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const inherited = getDefaultEnvironment();
  for (const name of DESKTOP_ENVIRONMENT_ALLOWLIST) {
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
      if (dependencies.platform !== "linux") {
        throw new ComputerUseLinuxUpstreamStartError({
          cause: new Error(`Unsupported platform: ${dependencies.platform}`),
        });
      }
      const hostEnvironment = dependencies.environment ?? process.env;
      const executable = dependencies.resolveExecutable(
        EXECUTABLE,
        dependencies.platform,
        hostEnvironment,
      );
      if (executable === undefined) {
        throw new ComputerUseLinuxExecutableUnavailableError({ command: EXECUTABLE });
      }
      const transport = (
        dependencies.transportFactory ?? ((parameters) => new StdioClientTransport(parameters))
      )({
        command: executable,
        args: [...ARGS],
        env: {
          ...inheritedDesktopEnvironment(hostEnvironment),
          ...controlledEnvironment,
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
