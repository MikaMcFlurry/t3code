// @effect-diagnostics nodeBuiltinImport:off -- platform-gated integration test exercises the real Linux abstract socket lease.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  ComputerUseLinuxHostLease,
  ComputerUseLinuxLeaseBusyError,
  ComputerUseLinuxLeaseKeyError,
  ComputerUseLinuxLeasePlatformError,
  privateDaclRefusal,
  userLeaseKeyFile,
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
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Platform-gated key file test.
      const platform = NodeOS.platform();
      const file = NodePath.join(home, "t3code", "computer-use-lease.key");
      const keys = await Promise.all(
        Array.from({ length: 4 }, () => userLeaseScopeKey({ platform, file })),
      );
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]!.length).toBeGreaterThanOrEqual(32);
      expect(await userLeaseScopeKey({ platform, file })).toBe(keys[0]);
      expect(
        (await NodeFSP.readdir(NodePath.dirname(file))).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      if (platform !== "win32") {
        expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
        // A key others can read, or a link to someone else's file, is refused rather than used.
        await NodeFSP.chmod(file, 0o644);
        await expect(userLeaseScopeKey({ platform, file })).rejects.toBeInstanceOf(
          ComputerUseLinuxLeaseKeyError,
        );
        const linked = NodePath.join(home, "linked.key");
        await NodeFSP.symlink(file, linked);
        await expect(userLeaseScopeKey({ platform, file: linked })).rejects.toBeInstanceOf(
          ComputerUseLinuxLeaseKeyError,
        );
      }
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

  it("places the key by the OS account, not the process environment", () => {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Platform-gated key file test.
    const platform = NodeOS.platform();
    const home = NodeOS.userInfo().homedir;
    expect(userLeaseKeyFile({ platform })).toBe(
      platform === "win32"
        ? NodePath.join(home, "AppData", "Local", "t3code-desktop-lease", "lease.key")
        : NodePath.join(home, ".local", "state", "t3code-desktop-lease", "lease.key"),
    );
  });

  it("accepts only a DACL private to this user, SYSTEM and Administrators", () => {
    const user = "S-1-5-21-1-2-3-1001";
    for (const sddl of [
      `D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${user})(D;;FA;;;WD)`,
    ]) {
      expect(privateDaclRefusal(sddl, user)).toBeUndefined();
    }
    for (const sddl of [
      "D:(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;0x1301bf;;;AU)(A;ID;0x1200a9;;;BU)",
      `D:P(A;;FA;;;${user})(XA;;FA;;;WD;(Member_of {SID(BA)}))`,
      `D:P(A;;FA;;;${user})(OA;;CC;guid;;WD)`,
      `D:P(A;;FA;;;${user})(ZA;;FA;;;S-1-5-21-9-9-9-500)`,
      `D:P(A;;FA;;;${user})garbage`,
      "O:BA",
    ]) {
      expect(privateDaclRefusal(sddl, user)).toBeTypeOf("string");
    }
  });
});
