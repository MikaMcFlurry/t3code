// @effect-diagnostics nodeBuiltinImport:off -- bridge integration tests use an isolated real filesystem lease.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, expect, it } from "@effect/vitest";

import {
  ComputerUseLinuxBridge,
  ComputerUseLinuxBridgeApprovalError,
  ComputerUseLinuxBridgeRevokedError,
  ComputerUseLinuxBridgeSessionError,
} from "./ComputerUseLinuxBridge.ts";
import {
  type ComputerUseLinuxLease,
  ComputerUseLinuxLeaseBusyError,
} from "./ComputerUseLinuxHostLease.ts";

interface TestLeaseState {
  held: boolean;
}

class TestLease implements ComputerUseLinuxLease {
  private readonly state: TestLeaseState;

  constructor(state: TestLeaseState = { held: false }) {
    this.state = state;
  }

  async withLease<A>(operation: () => Promise<A>): Promise<A> {
    if (this.state.held) throw new ComputerUseLinuxLeaseBusyError();
    this.state.held = true;
    try {
      return await operation();
    } finally {
      this.state.held = false;
    }
  }
}

async function withTemporaryLeaseDirectory<A>(
  operation: (directory: string) => Promise<A>,
): Promise<A> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-computer-use-bridge-"));
  try {
    return await operation(NodePath.join(root, "desktop.lock"));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

const request = (
  toolName: string,
): {
  arguments: unknown;
  providerInstanceId: string;
  providerSessionId: string;
  threadId: string;
  toolName: string;
} => ({
  toolName,
  providerInstanceId: "claude-office",
  providerSessionId: "provider-session-authorized",
  threadId: "thread-authorized",
  arguments: { marker: toolName },
});
const authorizedSession = {
  providerInstanceId: "claude-office",
  providerSessionId: "provider-session-authorized",
  threadId: "thread-authorized",
};

describe("ComputerUseLinuxBridge", () => {
  it("snapshots session, tool and arguments before a queued request can be mutated", async () => {
    await withTemporaryLeaseDirectory(async (_directory) => {
      let release: () => void = () => undefined;
      let started: () => void = () => undefined;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const calls: Array<{ readonly arguments_: unknown; readonly toolName: string }> = [];
      const mutableSession = { ...authorizedSession };
      const bridge = new ComputerUseLinuxBridge(
        {
          invoke: async (toolName, arguments_) => {
            calls.push({ toolName, arguments_ });
            if (calls.length === 1) {
              started();
              await releasePromise;
            }
            return toolName;
          },
        },
        new TestLease(),
        mutableSession,
        async () => true,
      );
      const first = bridge.invoke(request("screenshot"));
      await startedPromise;
      const mutableRequest = request("screenshot");
      const second = bridge.invoke(mutableRequest);
      mutableRequest.toolName = "run_shell";
      mutableRequest.arguments = { command: "forbidden" };
      mutableSession.threadId = "thread-other";
      release();
      await Promise.all([first, second]);

      assert.deepStrictEqual(calls, [
        { toolName: "screenshot", arguments_: { marker: "screenshot" } },
        { toolName: "screenshot", arguments_: { marker: "screenshot" } },
      ]);
      await expect(
        bridge.invoke({ ...request("screenshot"), threadId: "thread-other" }),
      ).rejects.toBeInstanceOf(ComputerUseLinuxBridgeSessionError);
    });
  });

  it("does not begin the second approval while the first invocation is pending", async () => {
    await withTemporaryLeaseDirectory(async (_directory) => {
      let approveFirst: (approved: boolean) => void = () => undefined;
      const firstApproval = new Promise<boolean>((resolve) => {
        approveFirst = resolve;
      });
      const backendOrder: number[] = [];
      const bridge = new ComputerUseLinuxBridge(
        {
          invoke: async (_toolName, arguments_) => {
            backendOrder.push((arguments_ as { readonly sequence: number }).sequence);
          },
        },
        new TestLease(),
        authorizedSession,
        async ({ arguments: arguments_ }) =>
          (arguments_ as { readonly sequence: number }).sequence === 1 ? firstApproval : true,
      );
      const first = bridge.invoke({ ...request("click"), arguments: { sequence: 1 } });
      const second = bridge.invoke({ ...request("click"), arguments: { sequence: 2 } });
      await Promise.resolve();
      assert.deepStrictEqual(backendOrder, []);
      approveFirst(true);
      await Promise.all([first, second]);
      assert.deepStrictEqual(backendOrder, [1, 2]);
    });
  });

  it("does not expose the backend snapshot to a mutating approval callback", async () => {
    await withTemporaryLeaseDirectory(async (_directory) => {
      const calls: Array<{ readonly arguments_: unknown; readonly toolName: string }> = [];
      const bridge = new ComputerUseLinuxBridge(
        {
          invoke: async (toolName, arguments_) => {
            calls.push({ toolName, arguments_ });
          },
        },
        new TestLease(),
        authorizedSession,
        async (approvalRequest) => {
          const mutable = approvalRequest as {
            arguments: { nested: { y: number }; x: number };
            toolName: string;
          };
          mutable.toolName = "run_shell";
          mutable.arguments.nested.y = 99;
          mutable.arguments.x = 42;
          return true;
        },
      );

      await bridge.invoke({ ...request("click"), arguments: { x: 1, nested: { y: 2 } } });
      assert.deepStrictEqual(calls, [
        { toolName: "click", arguments_: { x: 1, nested: { y: 2 } } },
      ]);
    });
  });

  it("aborts a pending approval and waits for its invocation before close returns", async () => {
    await withTemporaryLeaseDirectory(async (_directory) => {
      let approvalStarted: () => void = () => undefined;
      const approvalStartedPromise = new Promise<void>((resolve) => {
        approvalStarted = resolve;
      });
      let backendCalls = 0;
      const bridge = new ComputerUseLinuxBridge(
        {
          invoke: async () => {
            backendCalls += 1;
          },
        },
        new TestLease(),
        authorizedSession,
        async (_request, { signal }) => {
          approvalStarted();
          return new Promise<boolean>((resolve) => {
            signal.addEventListener("abort", () => resolve(false), { once: true });
          });
        },
      );
      const invocation = bridge.invoke(request("click"));
      await approvalStartedPromise;
      await bridge.close();
      await expect(invocation).rejects.toBeInstanceOf(ComputerUseLinuxBridgeRevokedError);
      assert.equal(backendCalls, 0);
    });
  });

  it("keeps the lease until an aborted backend has actually settled", async () => {
    await withTemporaryLeaseDirectory(async (_directory) => {
      let backendStarted: () => void = () => undefined;
      const backendStartedPromise = new Promise<void>((resolve) => {
        backendStarted = resolve;
      });
      let observedAbort = false;
      let settleBackend: () => void = () => undefined;
      const bridge = new ComputerUseLinuxBridge(
        {
          invoke: async (_toolName, _arguments, { signal }) => {
            backendStarted();
            return new Promise((resolve) => {
              settleBackend = () => resolve(undefined);
              signal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                },
                { once: true },
              );
            });
          },
        },
        new TestLease(),
        authorizedSession,
        async () => true,
      );
      const invocation = bridge.invoke(request("screenshot"));
      const invocationRejected = expect(invocation).rejects.toBeInstanceOf(
        ComputerUseLinuxBridgeRevokedError,
      );
      await backendStartedPromise;
      let closeSettled = false;
      const closing = bridge.close().then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      assert.isFalse(closeSettled);
      settleBackend();
      await invocationRejected;
      await closing;
      assert.isTrue(observedAbort);
    });
  });

  it("never forwards denied tools and requires approval for every interaction", async () => {
    await withTemporaryLeaseDirectory(async (_directory) => {
      const invoked: string[] = [];
      const approvals: string[] = [];
      const bridge = new ComputerUseLinuxBridge(
        {
          invoke: async (toolName) => {
            invoked.push(toolName);
            return toolName;
          },
        },
        new TestLease(),
        authorizedSession,
        async ({ toolName }) => {
          approvals.push(toolName);
          return toolName !== "click";
        },
      );

      assert.equal(await bridge.invoke(request("screenshot")), "screenshot");
      await expect(bridge.invoke(request("click"))).rejects.toBeInstanceOf(
        ComputerUseLinuxBridgeApprovalError,
      );
      await expect(bridge.invoke(request("run_shell"))).rejects.toThrow("not exposed by T3");
      await expect(bridge.invoke(request("setup_accessibility"))).rejects.toThrow(
        "not exposed by T3",
      );
      assert.deepStrictEqual(approvals, ["click"]);
      assert.deepStrictEqual(invoked, ["screenshot"]);

      await expect(
        bridge.invoke({ ...request("screenshot"), threadId: "thread-other" }),
      ).rejects.toBeInstanceOf(ComputerUseLinuxBridgeSessionError);
    });
  });

  it("prevents a competing bridge from operating while another process lease is held", async () => {
    await withTemporaryLeaseDirectory(async (directory) => {
      void directory;
      const state = { held: false };
      let release: () => void = () => undefined;
      let started: () => void = () => undefined;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const first = new ComputerUseLinuxBridge(
        {
          invoke: async () => {
            started();
            await releasePromise;
            return "first";
          },
        },
        new TestLease(state),
        authorizedSession,
        async () => true,
      );
      const second = new ComputerUseLinuxBridge(
        { invoke: async () => "second" },
        new TestLease(state),
        authorizedSession,
        async () => true,
      );

      const firstCall = first.invoke(request("screenshot"));
      await startedPromise;
      await expect(second.invoke(request("screenshot"))).rejects.toBeInstanceOf(
        ComputerUseLinuxLeaseBusyError,
      );
      release();
      assert.equal(await firstCall, "first");
      assert.equal(await second.invoke(request("screenshot")), "second");
    });
  });

  it("revocation aborts active, queued and future work and releases the lease", async () => {
    await withTemporaryLeaseDirectory(async (directory) => {
      void directory;
      const state = { held: false };
      let release: () => void = () => undefined;
      let started: () => void = () => undefined;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const bridge = new ComputerUseLinuxBridge(
        {
          invoke: async () => {
            started();
            await releasePromise;
            return "finished";
          },
        },
        new TestLease(state),
        authorizedSession,
        async () => true,
      );

      const active = bridge.invoke(request("screenshot"));
      await startedPromise;
      const queued = bridge.invoke(request("screenshot"));
      const activeRejected = expect(active).rejects.toBeInstanceOf(
        ComputerUseLinuxBridgeRevokedError,
      );
      const queuedRejected = expect(queued).rejects.toBeInstanceOf(
        ComputerUseLinuxBridgeRevokedError,
      );
      bridge.revoke();
      await expect(bridge.invoke(request("screenshot"))).rejects.toBeInstanceOf(
        ComputerUseLinuxBridgeRevokedError,
      );
      const closing = bridge.close();
      await Promise.resolve();
      assert.isTrue(state.held);
      release();
      await Promise.all([activeRejected, queuedRejected, closing]);

      await new TestLease(state).withLease(async () => undefined);
    });
  });
});
