import { assert, describe, it } from "@effect/vitest";

import {
  COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT,
  ComputerUseLinuxOperationGate,
  computerUseLinuxToolAccess,
} from "./ComputerUseLinuxPolicy.ts";

describe("ComputerUseLinuxPolicy", () => {
  it("separates observation and interaction while denying setup, shell and unknown tools", () => {
    assert.equal(computerUseLinuxToolAccess("get_app_state"), "observe");
    assert.equal(computerUseLinuxToolAccess("click"), "interact");
    assert.equal(computerUseLinuxToolAccess("setup_accessibility"), "deny");
    assert.equal(computerUseLinuxToolAccess("setup_window_targeting"), "deny");
    assert.equal(computerUseLinuxToolAccess("run_shell"), "deny");
    assert.equal(computerUseLinuxToolAccess("future_tool"), "deny");
  });

  it("pins screenshots and input to portal routes without shell execution", () => {
    assert.deepStrictEqual(COMPUTER_USE_LINUX_PORTAL_ONLY_ENVIRONMENT, {
      CU_DISABLE_ABS_POINTER: "1",
      COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER: "1",
      COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD: "1",
      COMPUTER_USE_LINUX_SCREENSHOT_BACKEND: "portal",
      COMPUTER_USE_LINUX_ENABLE_SHELL: "0",
      COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP: "1",
    });
  });

  it("serializes operations from concurrent provider sessions", async () => {
    const gate = new ComputerUseLinuxOperationGate();
    let releaseFirst: () => void = () => undefined;
    let firstStarted: () => void = () => undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const first = gate.run("click", async () => {
      firstStarted();
      await releaseFirstPromise;
      return "first";
    });
    await firstStartedPromise;
    const second = gate.run("type_text", async () => {
      secondStarted = true;
      return "second";
    });
    await Promise.resolve();
    assert.isFalse(secondStarted);
    releaseFirst();
    assert.deepStrictEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.isTrue(secondStarted);
  });

  it("rejects denied tools before invoking their operation", async () => {
    const gate = new ComputerUseLinuxOperationGate();
    let invoked = false;
    let failure: unknown;
    try {
      await gate.run("setup_accessibility", async () => {
        invoked = true;
      });
    } catch (cause) {
      failure = cause;
    }
    assert.instanceOf(failure, Error);
    assert.include(failure.message, "not exposed by T3");
    assert.isFalse(invoked);
  });
});
