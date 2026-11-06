// @effect-diagnostics nodeBuiltinImport:off -- platform-gated integration test exercises the real Linux abstract socket lease.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";

import {
  ComputerUseLinuxHostLease,
  ComputerUseLinuxLeaseBusyError,
  ComputerUseLinuxLeasePlatformError,
} from "./ComputerUseLinuxHostLease.ts";

describe("ComputerUseLinuxHostLease", () => {
  it("fails closed before binding on a non-Linux platform", async () => {
    const lease = new ComputerUseLinuxHostLease({
      platform: "win32",
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
});
