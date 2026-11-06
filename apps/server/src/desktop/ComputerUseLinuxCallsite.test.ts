import { assert, describe, expect, it } from "@effect/vitest";

import { ComputerUseLinuxBridgeSessionError } from "./ComputerUseLinuxBridge.ts";
import {
  ComputerUseLinuxLeaseScopeKeyError,
  startComputerUseLinuxCallsite,
} from "./ComputerUseLinuxCallsite.ts";
import { ComputerUseLinuxLeasePlatformError } from "./ComputerUseLinuxHostLease.ts";
import { COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT } from "./ComputerUseLinuxPolicy.ts";

describe("startComputerUseLinuxCallsite", () => {
  it("binds provider identity, stable lease scope, portal environment, and approval surface", async () => {
    const approvalRequests: string[] = [];
    const leaseInputs: Array<{ platform: NodeJS.Platform; scopeKey: string }> = [];
    const upstreamCalls: Array<{ arguments?: unknown; name: string }> = [];
    const upstreamEnvironments: Array<Readonly<Record<string, string>>> = [];
    let upstreamClosed = false;

    const adapter = await startComputerUseLinuxCallsite({
      approvalSurface: {
        request: async (request) => {
          approvalRequests.push(
            `${request.providerInstanceId}:${request.providerSessionId}:${request.threadId}:${request.toolName}`,
          );
          return true;
        },
      },
      leaseFactory: (input) => {
        leaseInputs.push(input);
        return { withLease: (operation) => operation() };
      },
      leaseScopeKey: "stable-installation-secret",
      platform: "linux",
      providerInstanceId: "codex-office",
      providerSessionId: "provider-session-authorized",
      threadId: "thread-authorized",
      upstreamFactory: {
        start: async ({ environment }) => {
          upstreamEnvironments.push(environment);
          return {
            callTool: async (input) => {
              upstreamCalls.push(input);
              return { content: [{ text: input.name, type: "text" }] };
            },
            close: async () => {
              upstreamClosed = true;
            },
            listTools: async () => [
              { inputSchema: { type: "object" }, name: "screenshot" },
              { inputSchema: { type: "object" }, name: "click" },
              { inputSchema: { type: "object" }, name: "run_shell" },
              { inputSchema: { type: "object" }, name: "setup_accessibility" },
            ],
          };
        },
      },
    });

    assert.deepStrictEqual(leaseInputs, [
      { platform: "linux", scopeKey: "stable-installation-secret" },
    ]);
    assert.deepStrictEqual(upstreamEnvironments, []);
    assert.deepStrictEqual(
      (await adapter.listTools()).map((tool) => tool.name),
      ["screenshot", "click"],
    );
    assert.deepStrictEqual(upstreamEnvironments, [COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT]);

    await adapter.callTool({
      arguments: { max_width: 800 },
      providerInstanceId: "codex-office",
      providerSessionId: "provider-session-authorized",
      threadId: "thread-authorized",
      toolName: "screenshot",
    });
    await adapter.callTool({
      arguments: { x: 10, y: 20 },
      providerInstanceId: "codex-office",
      providerSessionId: "provider-session-authorized",
      threadId: "thread-authorized",
      toolName: "click",
    });
    await expect(
      adapter.callTool({
        providerInstanceId: "codex-office",
        providerSessionId: "provider-session-authorized",
        threadId: "thread-other",
        toolName: "screenshot",
      }),
    ).rejects.toBeInstanceOf(ComputerUseLinuxBridgeSessionError);
    await expect(
      adapter.callTool({
        providerInstanceId: "codex-other",
        providerSessionId: "provider-session-authorized",
        threadId: "thread-authorized",
        toolName: "screenshot",
      }),
    ).rejects.toBeInstanceOf(ComputerUseLinuxBridgeSessionError);

    await expect(
      adapter.callTool({
        providerInstanceId: "codex-office",
        providerSessionId: "provider-session-other",
        threadId: "thread-authorized",
        toolName: "screenshot",
      }),
    ).rejects.toBeInstanceOf(ComputerUseLinuxBridgeSessionError);

    assert.deepStrictEqual(approvalRequests, [
      "codex-office:provider-session-authorized:thread-authorized:click",
    ]);
    assert.deepStrictEqual(upstreamCalls, [
      { arguments: { max_width: 800 }, name: "screenshot" },
      { arguments: { x: 10, y: 20 }, name: "click" },
    ]);
    await adapter.close();
    assert.isTrue(upstreamClosed);
  });

  it("fails before starting the upstream outside Linux and Windows", async () => {
    let upstreamStarted = false;

    await expect(
      startComputerUseLinuxCallsite({
        approvalSurface: { request: async () => true },
        leaseScopeKey: "stable-installation-secret",
        platform: "darwin",
        providerInstanceId: "codex-office",
        providerSessionId: "provider-session-authorized",
        threadId: "thread-authorized",
        upstreamFactory: {
          start: async () => {
            upstreamStarted = true;
            throw new Error("must not start");
          },
        },
      }),
    ).rejects.toBeInstanceOf(ComputerUseLinuxLeasePlatformError);
    assert.isFalse(upstreamStarted);
  });

  it("does not start the upstream when an interaction is denied", async () => {
    let upstreamStarted = false;
    const adapter = await startComputerUseLinuxCallsite({
      approvalSurface: { request: async () => false },
      leaseFactory: () => ({ withLease: (operation) => operation() }),
      leaseScopeKey: "stable-installation-secret",
      platform: "linux",
      providerInstanceId: "codex-office",
      providerSessionId: "provider-session-authorized",
      threadId: "thread-authorized",
      upstreamFactory: {
        start: async () => {
          upstreamStarted = true;
          throw new Error("must not start");
        },
      },
    });

    await expect(
      adapter.callTool({
        arguments: { x: 10, y: 20 },
        providerInstanceId: "codex-office",
        providerSessionId: "provider-session-authorized",
        threadId: "thread-authorized",
        toolName: "click",
      }),
    ).rejects.toThrow("was not approved");
    assert.isFalse(upstreamStarted);
    await adapter.close();
  });

  it("aborts and awaits a pending upstream startup when the session closes", async () => {
    let markStarting: () => void = () => undefined;
    const starting = new Promise<void>((resolve) => {
      markStarting = resolve;
    });
    let startupAborted = false;
    const adapter = await startComputerUseLinuxCallsite({
      approvalSurface: { request: async () => true },
      leaseFactory: () => ({ withLease: (operation) => operation() }),
      leaseScopeKey: "stable-installation-secret",
      platform: "linux",
      providerInstanceId: "codex-office",
      providerSessionId: "provider-session-authorized",
      threadId: "thread-authorized",
      upstreamFactory: {
        start: async ({ signal }) => {
          markStarting();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                startupAborted = true;
                reject(new Error("startup aborted"));
              },
              { once: true },
            );
          });
        },
      },
    });

    const call = adapter.callTool({
      arguments: { x: 10, y: 20 },
      providerInstanceId: "codex-office",
      providerSessionId: "provider-session-authorized",
      threadId: "thread-authorized",
      toolName: "click",
    });
    await starting;
    await adapter.close();
    await expect(call).rejects.toThrow();
    assert.isTrue(startupAborted);
  });

  it("fails before starting the upstream with an empty lease scope", async () => {
    let upstreamStarted = false;

    await expect(
      startComputerUseLinuxCallsite({
        approvalSurface: { request: async () => true },
        leaseScopeKey: "   ",
        platform: "linux",
        providerInstanceId: "codex-office",
        providerSessionId: "provider-session-authorized",
        threadId: "thread-authorized",
        upstreamFactory: {
          start: async () => {
            upstreamStarted = true;
            throw new Error("must not start");
          },
        },
      }),
    ).rejects.toBeInstanceOf(ComputerUseLinuxLeaseScopeKeyError);
    assert.isFalse(upstreamStarted);
  });
});
