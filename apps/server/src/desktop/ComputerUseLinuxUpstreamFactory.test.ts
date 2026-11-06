// @effect-diagnostics nodeBuiltinImport:off -- process-level MCP integration fixture.
import { assert, describe, expect, it } from "@effect/vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT } from "./ComputerUseLinuxPolicy.ts";
import type { ComputerUseLinuxUpstreamMcpClient } from "./ComputerUseLinuxMcpAdapter.ts";
import {
  __testing,
  ComputerUseLinuxExecutableUnavailableError,
  ComputerUseLinuxUpstreamStartError,
  makeComputerUseLinuxUpstreamFactory,
} from "./ComputerUseLinuxUpstreamFactory.ts";

describe("ComputerUseLinuxUpstreamFactory", () => {
  it("starts the fixed MCP command with a minimal inherited environment", async () => {
    const parameters: Array<{
      readonly args?: ReadonlyArray<string>;
      readonly command: string;
      readonly env?: Record<string, string>;
    }> = [];
    const calls: unknown[] = [];
    let closed = false;
    const startupController = new AbortController();
    const fakeTransport = { close: async () => undefined };
    const factory = makeComputerUseLinuxUpstreamFactory({
      platform: "linux",
      environment: {
        PATH: "/safe/bin",
        WAYLAND_DISPLAY: "wayland-1",
        XDG_RUNTIME_DIR: "/run/user/1000",
        LD_PRELOAD: "/untrusted/inject.so",
        COMPUTER_USE_LINUX_ENABLE_SHELL: "1",
        T3_PROVIDER_SESSION_ID: "attacker-controlled",
      },
      resolveExecutable: (command, platform, environment) => {
        assert.equal(command, "computer-use-linux");
        assert.equal(platform, "linux");
        assert.equal(environment.PATH, "/safe/bin");
        return "/safe/bin/computer-use-linux";
      },
      transportFactory: (input) => {
        parameters.push(input);
        return fakeTransport as never;
      },
      clientFactory: () => ({
        connect: async (transport, options) => {
          assert.equal(transport as unknown, fakeTransport as unknown);
          assert.equal(options?.signal, startupController.signal);
        },
        listTools: async () => ({ tools: [{ name: "screenshot" }] }),
        callTool: async (input, _schema, options) => {
          calls.push({ input, aborted: options?.signal?.aborted });
          return { content: [] };
        },
        close: async () => {
          closed = true;
        },
      }),
    });

    const upstream = await factory.start({
      environment: COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT,
      signal: startupController.signal,
    });
    assert.deepStrictEqual(parameters[0]?.args, ["mcp"]);
    assert.equal(parameters[0]?.command, "/safe/bin/computer-use-linux");
    assert.equal(parameters[0]?.env?.WAYLAND_DISPLAY, "wayland-1");
    assert.equal(parameters[0]?.env?.XDG_RUNTIME_DIR, "/run/user/1000");
    assert.equal(parameters[0]?.env?.COMPUTER_USE_LINUX_ENABLE_SHELL, "0");
    assert.notProperty(parameters[0]?.env ?? {}, "LD_PRELOAD");
    assert.notProperty(parameters[0]?.env ?? {}, "T3_PROVIDER_SESSION_ID");
    assert.notProperty(parameters[0]?.env ?? {}, "COMPUTER_USE_LINUX_BIN");
    assert.deepStrictEqual(await upstream.listTools(), [{ name: "screenshot" }]);
    await upstream.callTool(
      { name: "screenshot", arguments: { max_width: 800 } },
      { signal: new AbortController().signal },
    );
    assert.deepStrictEqual(calls, [
      { input: { name: "screenshot", arguments: { max_width: 800 } }, aborted: false },
    ]);
    await upstream.close();
    assert.isTrue(closed);
    assert.deepStrictEqual(__testing.args, ["mcp"]);
  });

  it("fails closed before making a client when the binary is unavailable", async () => {
    let madeClient = false;
    const factory = makeComputerUseLinuxUpstreamFactory({
      platform: "linux",
      resolveExecutable: () => undefined,
      clientFactory: () => {
        madeClient = true;
        throw new Error("must not run");
      },
    });

    await expect(factory.start({ environment: {} })).rejects.toBeInstanceOf(
      ComputerUseLinuxExecutableUnavailableError,
    );
    assert.isFalse(madeClient);
  });

  it("fails closed off Linux", async () => {
    const factory = makeComputerUseLinuxUpstreamFactory({
      platform: "win32",
      resolveExecutable: () => "computer-use-linux.exe",
    });
    await expect(factory.start({ environment: {} })).rejects.toBeInstanceOf(
      ComputerUseLinuxUpstreamStartError,
    );
  });

  it("closes the client and transport when startup is aborted", async () => {
    let clientClosed = false;
    let transportClosed = false;
    const controller = new AbortController();
    const fakeTransport = {
      close: async () => {
        transportClosed = true;
      },
    };
    const factory = makeComputerUseLinuxUpstreamFactory({
      platform: "linux",
      resolveExecutable: () => "/safe/bin/computer-use-linux",
      transportFactory: () => fakeTransport as never,
      clientFactory: () => ({
        connect: async (_transport, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("startup aborted")), {
              once: true,
            });
          }),
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          clientClosed = true;
        },
      }),
    });

    const starting = factory.start({ environment: {}, signal: controller.signal });
    controller.abort();
    await expect(starting).rejects.toBeInstanceOf(ComputerUseLinuxUpstreamStartError);
    assert.isTrue(clientClosed);
    assert.isTrue(transportClosed);
  });

  it("speaks MCP over a real child stdio transport with a controlled fake upstream", async () => {
    const fixture = NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "fixtures",
      "fakeComputerUseLinuxMcp.mjs",
    );
    const factory = makeComputerUseLinuxUpstreamFactory({
      platform: "linux",
      environment: {
        PATH: process.env.PATH,
        T3_PROVIDER_SESSION_ID: "must-not-cross-process-boundary",
      },
      resolveExecutable: () => "/test/bin/computer-use-linux",
      transportFactory: (parameters) => {
        assert.equal(parameters.command, "/test/bin/computer-use-linux");
        assert.deepStrictEqual(parameters.args, ["mcp"]);
        return new StdioClientTransport({
          ...parameters,
          command: process.execPath,
          args: [fixture],
        });
      },
    });
    const upstream = await factory.start({
      environment: COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT,
    });
    try {
      assert.deepStrictEqual(
        (await upstream.listTools()).map((tool) => tool.name),
        ["screenshot", "click", "run_shell"],
      );
      const result = (await upstream.callTool(
        { name: "screenshot", arguments: { max_width: 640 } },
        { signal: new AbortController().signal },
      )) as { readonly content: ReadonlyArray<{ readonly text: string }> };
      assert.deepStrictEqual(JSON.parse(result.content[0]!.text), {
        name: "screenshot",
        arguments: { max_width: 640 },
        shell: "0",
        screenshotBackend: "portal",
        leakedIdentity: null,
      });
    } finally {
      await upstream.close();
    }
  });

  it("waits for a cancellation-ignoring MCP child to exit before rejecting", async () => {
    const temporaryDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-cu-cancel-"),
    );
    const startedMarker = NodePath.join(temporaryDirectory, "child-started");
    const completedMarker = NodePath.join(temporaryDirectory, "child-completed");
    const fixture = NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "fixtures",
      "fakeComputerUseLinuxMcp.mjs",
    );
    const factory = makeComputerUseLinuxUpstreamFactory({
      platform: "linux",
      resolveExecutable: () => "/test/bin/computer-use-linux",
      transportFactory: (parameters) =>
        new StdioClientTransport({
          ...parameters,
          command: process.execPath,
          args: [fixture, startedMarker, completedMarker],
        }),
    });
    const markerWatcherAbort = new AbortController();
    const markerStarted = (async () => {
      for await (const _change of NodeFSP.watch(temporaryDirectory, {
        signal: markerWatcherAbort.signal,
      })) {
        if ((await NodeFSP.readFile(startedMarker, "utf8").catch(() => "")) === "started") return;
      }
    })();
    let upstream: ComputerUseLinuxUpstreamMcpClient | undefined;
    try {
      upstream = await factory.start({
        environment: COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT,
      });
      await upstream.listTools();
      const controller = new AbortController();
      const pending = upstream.callTool(
        { name: "click", arguments: { x: 1, y: 2 } },
        { signal: controller.signal },
      );
      await markerStarted;
      expect(await NodeFSP.readFile(startedMarker, "utf8")).toBe("started");
      controller.abort();
      await expect(pending).rejects.toThrow();
      // The fixture writes this only after its deliberately cancellation-ignoring operation.
      // Seeing it before rejection proves shutdown confirmation, without a duration assertion.
      expect(await NodeFSP.readFile(completedMarker, "utf8")).toBe("completed");
    } finally {
      markerWatcherAbort.abort();
      await upstream?.close().catch(() => undefined);
      await NodeFSP.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
