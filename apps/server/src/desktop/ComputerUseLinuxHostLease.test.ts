// @effect-diagnostics nodeBuiltinImport:off -- platform-gated integration test exercises the real Linux abstract socket lease.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  ComputerUseLinuxHostLease,
  ComputerUseLinuxLeaseBusyError,
  ComputerUseLinuxLeasePlatformError,
  userLeaseScopeKey,
} from "./ComputerUseLinuxHostLease.ts";

describe("ComputerUseLinuxHostLease", () => {
  it("fails closed before binding on a platform without a backend", async () => {
    const lease = new ComputerUseLinuxHostLease({
      platform: "darwin",
      scopeKey: "unused",
    });
    await expect(lease.acquire()).rejects.toBeInstanceOf(ComputerUseLinuxLeasePlatformError);
  });

  it("lets the Linux kernel serialize holders and release ownership", async () => {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Platform-gated integration test has no Effect runtime.
    if (NodeOS.platform() !== "linux") return;
    const scopeKey = `test-${NodeCrypto.randomUUID()}`;
    const first = new ComputerUseLinuxHostLease({ platform: "linux", scopeKey });
    const second = new ComputerUseLinuxHostLease({ platform: "linux", scopeKey });
    const firstHandle = await first.acquire();
    await expect(second.acquire()).rejects.toBeInstanceOf(ComputerUseLinuxLeaseBusyError);
    await firstHandle.release();
    const secondHandle = await second.acquire();
    await secondHandle.release();
  });

  it("lets a Windows named pipe serialize holders and release ownership", async () => {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Platform-gated integration test has no Effect runtime.
    if (NodeOS.platform() !== "win32") return;
    const scopeKey = `test-${NodeCrypto.randomUUID()}`;
    const first = new ComputerUseLinuxHostLease({ platform: "win32", scopeKey });
    const second = new ComputerUseLinuxHostLease({ platform: "win32", scopeKey });
    const firstHandle = await first.acquire();
    expect(firstHandle.socketName.startsWith("\\\\.\\pipe\\t3-computer-use-")).toBe(true);
    await expect(second.acquire()).rejects.toBeInstanceOf(ComputerUseLinuxLeaseBusyError);
    await firstHandle.release();
    const secondHandle = await second.acquire();
    await secondHandle.release();
  });

  it("gives every T3 server of one OS user the same lease key", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lease-key-"));
    try {
      const input = {
        platform: "linux" as const,
        environment: { XDG_STATE_HOME: NodePath.join(home, "state") },
        homeDirectory: home,
      };
      const [first, second] = await Promise.all([
        userLeaseScopeKey(input),
        userLeaseScopeKey(input),
      ]);
      expect(first).toBe(second);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(await userLeaseScopeKey(input)).toBe(first);
      const file = NodePath.join(home, "state", "t3code", "computer-use-lease.key");
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Platform-gated file mode check.
      if (NodeOS.platform() !== "win32") {
        expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});
