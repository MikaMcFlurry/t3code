// @effect-diagnostics nodeBuiltinImport:off -- adapter integration tests use an isolated real filesystem lease.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  ComputerUseLinuxBridgeApprovalError,
  ComputerUseLinuxBridgeRevokedError,
} from "./ComputerUseLinuxBridge.ts";
import { ComputerUseLinuxMcpAdapter } from "./ComputerUseLinuxMcpAdapter.ts";

describe("ComputerUseLinuxMcpAdapter", () => {
  it("filters upstream tools and routes allowed calls through approval and the bridge", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cu-mcp-adapter-"));
    try {
      const calls: Array<{ readonly arguments?: unknown; readonly name: string }> = [];
      const approvals: string[] = [];
      let upstreamClosed = false;
      const adapter = new ComputerUseLinuxMcpAdapter(
        {
          close: async () => {
            upstreamClosed = true;
          },
          listTools: async () => [
            { name: "screenshot", inputSchema: { type: "object" } },
            { name: "click", inputSchema: { type: "object" } },
            { name: "run_shell", inputSchema: { type: "object" } },
            { name: "setup_accessibility", inputSchema: { type: "object" } },
            { name: "future_unknown", inputSchema: { type: "object" } },
          ],
          callTool: async (input) => {
            calls.push(input);
            return { content: [{ type: "text", text: input.name }] };
          },
        },
        { withLease: (operation) => operation() },
        {
          providerInstanceId: "codex-office",
          providerSessionId: "provider-session-authorized",
          threadId: "thread-authorized",
        },
        async ({ toolName }) => {
          approvals.push(toolName);
          return toolName !== "click";
        },
      );

      assert.deepStrictEqual(
        (await adapter.listTools()).map((tool) => tool.name),
        ["screenshot", "click"],
      );
      await adapter.callTool({
        toolName: "screenshot",
        arguments: { max_width: 800 },
        providerInstanceId: "codex-office",
        providerSessionId: "provider-session-authorized",
        threadId: "thread-authorized",
      });
      await expect(
        adapter.callTool({
          toolName: "click",
          arguments: { x: 1, y: 2 },
          providerInstanceId: "codex-office",
          providerSessionId: "provider-session-authorized",
          threadId: "thread-authorized",
        }),
      ).rejects.toBeInstanceOf(ComputerUseLinuxBridgeApprovalError);
      await expect(
        adapter.callTool({
          toolName: "run_shell",
          arguments: { command: "true" },
          providerInstanceId: "codex-office",
          providerSessionId: "provider-session-authorized",
          threadId: "thread-authorized",
        }),
      ).rejects.toThrow("not exposed by T3");

      assert.deepStrictEqual(approvals, ["click"]);
      assert.deepStrictEqual(calls, [{ name: "screenshot", arguments: { max_width: 800 } }]);
      await adapter.close();
      assert.isTrue(upstreamClosed);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("waits for an aborted backend to settle before reporting an upstream close failure", async () => {
    let backendSignal: AbortSignal | undefined;
    let finishBackend: (() => void) | undefined;
    let leaseHeld = false;
    let closeSettled = false;
    const backendStarted = Promise.withResolvers<void>();
    const backendFinished = new Promise<void>((resolve) => {
      finishBackend = resolve;
    });
    const adapter = new ComputerUseLinuxMcpAdapter(
      {
        callTool: async (_input, { signal }) => {
          backendSignal = signal;
          backendStarted.resolve();
          await backendFinished;
          return { content: [] };
        },
        close: async () => {
          throw new Error("upstream close failed");
        },
        listTools: async () => [{ name: "screenshot" }],
      },
      {
        withLease: async (operation) => {
          leaseHeld = true;
          try {
            return await operation();
          } finally {
            leaseHeld = false;
          }
        },
      },
      {
        providerInstanceId: "codex-office",
        providerSessionId: "provider-session-authorized",
        threadId: "thread-authorized",
      },
      async () => true,
    );
    const invocation = adapter
      .callTool({
        providerInstanceId: "codex-office",
        providerSessionId: "provider-session-authorized",
        threadId: "thread-authorized",
        toolName: "screenshot",
      })
      .catch((cause: unknown) => cause);
    await backendStarted.promise;

    const closing = adapter.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.isFalse(closeSettled);
    assert.isTrue(leaseHeld);
    assert.isTrue(backendSignal?.aborted);

    finishBackend?.();
    await expect(closing).rejects.toThrow("upstream close failed");
    await expect(invocation).resolves.toBeInstanceOf(ComputerUseLinuxBridgeRevokedError);
    assert.isFalse(leaseHeld);
  });
});
