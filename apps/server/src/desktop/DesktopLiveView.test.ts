// @effect-diagnostics nodeBuiltinImport:off -- the login capture guard is checked against a real temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  ComputerUseLinuxBridge,
  ComputerUseLinuxBridgeRefusedError,
} from "./ComputerUseLinuxBridge.ts";
import type { ComputerUseLinuxLease } from "./ComputerUseLinuxHostLease.ts";
import { desktopLiveControl } from "./DesktopLiveControl.ts";
import {
  type DesktopLiveViewCaptureGuard,
  type DesktopLiveViewOutput,
  DesktopLiveViewHub,
  loginCaptureGuard,
  type SpawnDesktopLiveViewHelper,
  keysymForKey,
} from "./DesktopLiveView.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

interface FakeHelper {
  readonly commands: Array<Record<string, unknown>>;
  stopped: boolean;
  frame: (jpeg: Uint8Array) => void;
  status: (status: Record<string, unknown>) => void;
  exit: () => void;
}

/** `acknowledge`: how the helper answers a release; false never answers. */
function fakeSpawner(options: { acknowledge?: boolean | "failed" } = {}) {
  const acknowledge = options.acknowledge ?? true;
  const helpers: Array<FakeHelper> = [];
  const spawn: SpawnDesktopLiveViewHelper = (events) => {
    const helper: FakeHelper = {
      commands: [],
      stopped: false,
      frame: events.onFrame,
      status: events.onStatus,
      exit: events.onExit,
    };
    helpers.push(helper);
    return {
      send: (command) => {
        helper.commands.push(command);
        // The real helper acknowledges a release once it applied it.
        if (command.t === "release" && acknowledge !== false)
          queueMicrotask(() =>
            events.onStatus({ type: "released", id: command.id, ok: acknowledge !== "failed" }),
          );
      },
      stop: () => {
        helper.stopped = true;
      },
    };
  };
  return { spawn, helpers };
}

function viewer(id: string, canOperate = true) {
  const outputs: Array<DesktopLiveViewOutput> = [];
  return {
    entry: {
      id,
      canOperate,
      push: (output: DesktopLiveViewOutput) => outputs.push(output),
      pressedKeys: new Map(),
    },
    outputs,
    last: <T extends DesktopLiveViewOutput["_tag"]>(tag: T) =>
      outputs.findLast((output) => output._tag === tag) as
        | Extract<DesktopLiveViewOutput, { _tag: T }>
        | undefined,
  };
}

const streaming = (helper: FakeHelper) =>
  helper.status({ type: "ready", width: 3840, height: 2160 });

const hubs: Array<DesktopLiveViewHub> = [];
const makeHub = () => {
  const spawner = fakeSpawner();
  const hub = new DesktopLiveViewHub(spawner.spawn);
  hubs.push(hub);
  return { hub, ...spawner };
};

afterEach(async () => {
  const controller = desktopLiveControl.humanController;
  if (controller !== null) await desktopLiveControl.control.release(controller);
  for (const hub of hubs.splice(0)) void hub.shutdown();
  vi.useRealTimers();
});

describe("keysymForKey", () => {
  it("maps characters to layout-independent keysyms", () => {
    expect(keysymForKey("a", "KeyA")).toBe(0x61);
    expect(keysymForKey("A", "KeyA")).toBe(0x41);
    expect(keysymForKey("@", "KeyQ")).toBe(0x40);
    expect(keysymForKey("ä", "Quote")).toBe(0xe4);
    expect(keysymForKey("€", "KeyE")).toBe(0x010020ac);
  });

  it("maps named and modifier keys, and skips keys without a symbol", () => {
    expect(keysymForKey("Enter", "Enter")).toBe(0xff0d);
    expect(keysymForKey("Backspace", "Backspace")).toBe(0xff08);
    expect(keysymForKey("Shift", "ShiftRight")).toBe(0xffe2);
    expect(keysymForKey("Control", "ControlLeft")).toBe(0xffe3);
    expect(keysymForKey("F5", "F5")).toBe(0xffc2);
    expect(keysymForKey("Dead", "BracketLeft")).toBeNull();
    expect(keysymForKey("Unidentified", "")).toBeNull();
  });
});

describe("DesktopLiveViewHub", () => {
  it("shares one capture between viewers and sends each the coordinate space", () => {
    const { hub, helpers } = makeHub();
    const first = viewer("first");
    const second = viewer("second");
    hub.attach(first.entry);
    hub.attach(second.entry);
    expect(helpers).toHaveLength(1);
    expect(first.last("desktop")?.state).toBe("starting");
    streaming(helpers[0]!);
    helpers[0]!.frame(new Uint8Array([1, 2, 3]));
    for (const each of [first, second]) {
      expect(each.last("viewport")).toEqual({ _tag: "viewport", width: 3840, height: 2160 });
      expect(each.last("desktop")?.state).toBe("streaming");
      expect(each.last("frame")?.data).toEqual(new Uint8Array([1, 2, 3]));
    }
    // A late viewer starts from the latest frame instead of a blank canvas.
    const late = viewer("late");
    hub.attach(late.entry);
    expect(late.last("frame")?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(late.last("control")?.controller).toBe("agent");
  });

  it("reports a pending consent prompt, a refusal and a stop at the machine", () => {
    const { hub, helpers } = makeHub();
    const watcher = viewer("watcher");
    hub.attach(watcher.entry);
    helpers[0]!.status({ type: "consent", restorable: false });
    expect(watcher.last("desktop")?.state).toBe("consent");
    helpers[0]!.status({ type: "denied", code: "start" });
    expect(watcher.last("desktop")?.state).toBe("denied");
    expect(helpers[0]!.stopped).toBe(true);
    // Asking again starts a new capture.
    return hub.input("watcher", { type: "reload" }).then(() => {
      expect(helpers).toHaveLength(2);
      streaming(helpers[1]!);
      helpers[1]!.status({ type: "closed" });
      expect(watcher.last("desktop")?.state).toBe("ended");
    });
  });

  it("takes input only from the viewer in control, in the stream's coordinates", async () => {
    const { hub, helpers } = makeHub();
    const driver = viewer("driver");
    const watcher = viewer("watcher");
    hub.attach(driver.entry);
    hub.attach(watcher.entry);
    streaming(helpers[0]!);
    const helper = helpers[0]!;

    await hub.input("driver", {
      type: "mouse",
      action: "down",
      x: 10,
      y: 20,
      button: "left",
      buttons: 1,
    });
    expect(helper.commands).toEqual([]);

    await hub.input("driver", { type: "takeControl" });
    expect(driver.last("control")?.controller).toBe("you");
    expect(watcher.last("control")?.controller).toBe("another-viewer");
    await hub.input("watcher", { type: "takeControl" });
    expect(desktopLiveControl.humanController).toBe("driver");

    await hub.input("driver", {
      type: "mouse",
      action: "down",
      x: 9000,
      y: -5,
      button: "left",
      buttons: 1,
    });
    await hub.input("driver", {
      type: "mouse",
      action: "up",
      x: 100,
      y: 50,
      button: "left",
      buttons: 0,
    });
    await hub.input("driver", { type: "key", action: "down", key: "A", code: "KeyA" });
    await hub.input("driver", { type: "key", action: "up", key: "a", code: "KeyA" });
    await hub.input("driver", { type: "text", text: "ok\n" });
    await hub.input("watcher", { type: "text", text: "nope" });
    expect(helper.commands).toEqual([
      { t: "move", x: 3839, y: 0 },
      { t: "button", b: "left", down: true },
      { t: "move", x: 100, y: 50 },
      { t: "button", b: "left", down: false },
      // The release sends the keysym the press did, even if Shift changed the key meanwhile.
      { t: "key", keysym: 0x41, down: true },
      { t: "key", keysym: 0x41, down: false },
      // Text goes as one batch.
      { t: "text", keysyms: [0x6f, 0x6b, 0xff0d] },
    ]);

    await hub.input("driver", { type: "releaseControl" });
    expect(helper.commands.at(-1)).toMatchObject({ t: "release" });
    expect(driver.last("control")?.controller).toBe("agent");
  });

  it("presses the modifiers of a shortcut that arrives as one key with a mask", async () => {
    const { hub, helpers } = makeHub();
    hub.attach(viewer("driver").entry);
    streaming(helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    await hub.input("driver", {
      type: "key",
      action: "down",
      key: "c",
      code: "KeyC",
      modifiers: 2,
    });
    await hub.input("driver", { type: "key", action: "up", key: "c", code: "KeyC", modifiers: 2 });
    expect(helpers[0]!.commands).toEqual([
      { t: "key", keysym: 0xffe3, down: true },
      { t: "key", keysym: 0x63, down: true },
      { t: "key", keysym: 0xffe3, down: false },
      { t: "key", keysym: 0x63, down: false },
    ]);
  });

  it("clamps wheel deltas a client could inflate", async () => {
    const { hub, helpers } = makeHub();
    hub.attach(viewer("driver").entry);
    streaming(helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    await hub.input("driver", { type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 1e308 });
    expect(helpers[0]!.commands.at(-1)).toEqual({ t: "wheel", dx: 0, dy: 2400 });
  });

  it("closes every viewer and the capture when the setting is turned off", async () => {
    const { hub, helpers } = makeHub();
    const first = viewer("first");
    hub.attach(first.entry);
    streaming(helpers[0]!);
    hub.setEnabled(false);
    expect(helpers[0]!.stopped).toBe(true);
    expect(first.last("closed")?.reason).toContain("turned off");
    await hub.input("first", { type: "reload" });
    expect(helpers).toHaveLength(1);
  });

  it("keeps agents out until the person's held input is released", async () => {
    const { hub, helpers } = makeHub();
    hub.attach(viewer("driver").entry);
    streaming(helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    let agentRan = false;
    const releasing = hub.input("driver", { type: "releaseControl" });
    // Ownership is already gone, but the release is not yet acknowledged.
    await desktopLiveControl.agent(async () => (agentRan = true)).catch(() => undefined);
    expect(agentRan).toBe(false);
    await releasing;
    await desktopLiveControl.agent(async () => (agentRan = true));
    expect(agentRan).toBe(true);
  });

  it("holds the host-wide lease while a person drives, waiting out a busy one", async () => {
    let busy = 2;
    const events: Array<string> = [];
    const spawner = fakeSpawner();
    const hub = new DesktopLiveViewHub(spawner.spawn, {
      acquireHostLease: async () => {
        if (busy-- > 0) return null;
        events.push("acquired");
        return { release: async () => void events.push("released") };
      },
    });
    hubs.push(hub);
    hub.attach(viewer("driver").entry);
    streaming(spawner.helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    expect(events).toEqual(["acquired"]);
    expect(desktopLiveControl.humanController).toBe("driver");
    await hub.input("driver", { type: "releaseControl" });
    expect(events).toEqual(["acquired", "released"]);
  });

  it("ignores input from a read-only viewer", async () => {
    const { hub, helpers } = makeHub();
    const readOnly = viewer("read-only", false);
    hub.attach(readOnly.entry);
    streaming(helpers[0]!);
    await hub.input("read-only", { type: "takeControl" });
    expect(desktopLiveControl.humanController).toBeNull();
    expect(readOnly.last("control")?.canOperate).toBe(false);
  });

  it("hands control back when the controlling viewer leaves, and stops the capture after the last", async () => {
    vi.useFakeTimers();
    const { hub, helpers } = makeHub();
    const driver = viewer("driver");
    hub.attach(driver.entry);
    streaming(helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    await hub.detach("driver");
    expect(desktopLiveControl.humanController).toBeNull();
    expect(helpers[0]!.commands.some((command) => command.t === "release")).toBe(true);
    expect(helpers[0]!.stopped).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(helpers[0]!.stopped).toBe(true);
  });
});

class OpenLease implements ComputerUseLinuxLease {
  withLease<A>(operation: () => Promise<A>): Promise<A> {
    return operation();
  }
}

const session = {
  providerInstanceId: "codex",
  providerSessionId: "session",
  threadId: "thread",
};

function fakeGuard(status: "verified" | "unverified" | "crashed") {
  const events: Array<string> = [];
  const guard: DesktopLiveViewCaptureGuard = {
    status: () => status,
    begin: async () => {
      events.push("begin");
      return {
        succeeded: () => void events.push("succeeded"),
        crashed: () => void events.push("crashed"),
        end: () => void events.push("end"),
      };
    },
  };
  return { guard, events };
}

/** Lets the async capture start and handoffs run their pending steps. */
const settle = async () => {
  for (let step = 0; step < 20; step++) await Promise.resolve();
};

describe("DesktopLiveViewHub capture guard", () => {
  it("asks before the first screen share on a machine where it never worked", async () => {
    const spawner = fakeSpawner();
    const { guard, events } = fakeGuard("unverified");
    const hub = new DesktopLiveViewHub(spawner.spawn, { captureGuard: guard });
    hubs.push(hub);
    const first = viewer("first");
    hub.attach(first.entry);
    await settle();
    expect(spawner.helpers).toHaveLength(0);
    expect(first.last("desktop")?.state).toBe("unverified");
    expect(first.last("desktop")?.detail).toContain("ends the desktop session");
    await hub.input("first", { type: "reload" });
    expect(events).toEqual(["begin"]);
    expect(spawner.helpers).toHaveLength(1);
  });

  it("latches after a stream that started and died without a frame", async () => {
    const spawner = fakeSpawner();
    const { guard, events } = fakeGuard("verified");
    const hub = new DesktopLiveViewHub(spawner.spawn, { captureGuard: guard });
    hubs.push(hub);
    const first = viewer("first");
    hub.attach(first.entry);
    await settle();
    // The portal's Start follows "consent"; the compositor died before "ready" or a frame.
    spawner.helpers[0]!.status({ type: "consent", restorable: true });
    spawner.helpers[0]!.exit();
    expect(events).toEqual(["begin", "crashed", "end"]);
    expect(first.last("desktop")?.detail).toContain("before its first frame");
    await hub.input("first", { type: "reload" });
    expect(spawner.helpers).toHaveLength(1);
  });

  it("records success and harmless endings without latching", async () => {
    const spawner = fakeSpawner();
    const { guard, events } = fakeGuard("verified");
    const hub = new DesktopLiveViewHub(spawner.spawn, { captureGuard: guard });
    hubs.push(hub);
    hub.attach(viewer("watcher").entry);
    await settle();
    spawner.helpers[0]!.status({ type: "consent", restorable: false });
    spawner.helpers[0]!.status({ type: "denied", code: "start" });
    // The refused helper still holds the login's capture until it exits.
    const reloading = hub.input("watcher", { type: "reload" });
    await settle();
    expect(events).toEqual(["begin"]);
    spawner.helpers[0]!.exit();
    await reloading;
    streaming(spawner.helpers[1]!);
    spawner.helpers[1]!.frame(new Uint8Array([1]));
    spawner.helpers[1]!.exit();
    expect(events).toEqual(["begin", "end", "begin", "succeeded", "end"]);
  });

  it("keeps the login's markers: a marker left by an unfinished start counts as a crash", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-live-view-guard-"));
    try {
      const locks: Array<string> = [];
      const guard = loginCaptureGuard({
        directory,
        acquireCaptureLock: async () => {
          locks.push("lock");
          return { release: async () => void locks.push("unlock") };
        },
      });
      expect(guard.status()).toBe("unverified");
      const run = await guard.begin();
      if ("refused" in run) throw new Error("refused");
      expect(NodeFS.existsSync(NodePath.join(directory, "starting"))).toBe(true);
      run.succeeded();
      run.end();
      expect(guard.status()).toBe("verified");
      // A start that never finished, as after the compositor took the server's session down.
      const second = await guard.begin();
      if ("refused" in second) throw new Error("refused");
      const third = await guard.begin();
      expect(third).toMatchObject({ crashed: true });
      expect(guard.status()).toBe("crashed");
      expect(locks).toEqual(["lock", "unlock", "lock", "lock", "unlock"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rechecks for a crash another server recorded while it waited for the lock", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-live-view-guard-"));
    try {
      const locks: Array<string> = [];
      const guard = loginCaptureGuard({
        directory,
        acquireCaptureLock: async () => {
          NodeFS.writeFileSync(NodePath.join(directory, "crashed"), "another server\n");
          locks.push("lock");
          return { release: async () => void locks.push("unlock") };
        },
      });
      expect(guard.status()).toBe("unverified");
      expect(await guard.begin()).toMatchObject({ crashed: true });
      expect(NodeFS.existsSync(NodePath.join(directory, "starting"))).toBe(false);
      expect(locks).toEqual(["lock", "unlock"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the unfinished-start marker when the crash cannot be written", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-live-view-guard-"));
    try {
      NodeFS.writeFileSync(NodePath.join(directory, "verified"), "an earlier share worked\n");
      const lock = async () => ({ release: async () => undefined });
      const guard = loginCaptureGuard({ directory, acquireCaptureLock: lock });
      const run = await guard.begin();
      if ("refused" in run) throw new Error("refused");
      vi.mocked(NodeFS.writeFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      });
      run.crashed();
      run.end();
      expect(NodeFS.existsSync(NodePath.join(directory, "starting"))).toBe(true);
      // Another server still reads "verified", but its start finds the marker and refuses.
      const other = loginCaptureGuard({ directory, acquireCaptureLock: lock });
      expect(await other.begin()).toMatchObject({ crashed: true });
      expect(other.status()).toBe("crashed");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores a capture's late calls once it ended, so the next one keeps its marker", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-live-view-guard-"));
    try {
      const guard = loginCaptureGuard({
        directory,
        acquireCaptureLock: async () => ({ release: async () => undefined }),
      });
      const first = await guard.begin();
      if ("refused" in first) throw new Error("refused");
      first.end();
      const second = await guard.begin();
      if ("refused" in second) throw new Error("refused");
      first.succeeded();
      first.crashed();
      expect(NodeFS.existsSync(NodePath.join(directory, "starting"))).toBe(true);
      expect(guard.status()).toBe("unverified");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses while another server on the login is sharing the screen", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-live-view-guard-"));
    try {
      const guard = loginCaptureGuard({ directory, acquireCaptureLock: async () => null });
      expect(await guard.begin()).toMatchObject({ crashed: false });
      expect(NodeFS.existsSync(NodePath.join(directory, "starting"))).toBe(false);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("DesktopLiveViewHub handoffs", () => {
  function leasedHub(options: { busyFor?: number } = {}) {
    const events: Array<string> = [];
    let busy = options.busyFor ?? 0;
    let gate: (() => void) | null = null;
    const spawner = fakeSpawner();
    const hub = new DesktopLiveViewHub(spawner.spawn, {
      acquireHostLease: async () => {
        if (busy > 0) {
          busy -= 1;
          return null;
        }
        if (gate === null) await new Promise<void>((resolve) => (gate = resolve));
        events.push("acquire");
        return { release: async () => void events.push("release") };
      },
    });
    hubs.push(hub);
    return { hub, spawner, events, open: () => (gate ??= () => undefined)?.() };
  }

  it("gives a pending takeover up when its viewer leaves, and returns the lease", async () => {
    const { hub, spawner, events, open } = leasedHub();
    hub.attach(viewer("driver").entry);
    hub.attach(viewer("watcher").entry);
    streaming(spawner.helpers[0]!);
    const taking = hub.input("driver", { type: "takeControl" });
    await settle();
    const leaving = hub.detach("driver");
    open();
    await taking;
    await leaving;
    expect(desktopLiveControl.humanController).toBeNull();
    expect(events).toEqual(["acquire", "release"]);
  });

  it("gives a pending takeover up when the setting is turned off", async () => {
    const { hub, spawner, events, open } = leasedHub();
    hub.attach(viewer("driver").entry);
    streaming(spawner.helpers[0]!);
    const taking = hub.input("driver", { type: "takeControl" });
    await settle();
    hub.setEnabled(false);
    open();
    await taking;
    expect(desktopLiveControl.humanController).toBeNull();
    expect(events).toEqual(["acquire", "release"]);
  });

  it("lets a second viewer take over only after the first hand-back returned its lease", async () => {
    const { hub, spawner, events, open } = leasedHub();
    open();
    hub.attach(viewer("first").entry);
    hub.attach(viewer("second").entry);
    streaming(spawner.helpers[0]!);
    await hub.input("first", { type: "takeControl" });
    const handingBack = hub.input("first", { type: "releaseControl" });
    const takingOver = hub.input("second", { type: "takeControl" });
    await handingBack;
    await takingOver;
    expect(desktopLiveControl.humanController).toBe("second");
    expect(events).toEqual(["acquire", "release", "acquire"]);
  });

  it("ends the capture and keeps agents out when a release is not confirmed", async () => {
    vi.useFakeTimers();
    const spawner = fakeSpawner({ acknowledge: false });
    const hub = new DesktopLiveViewHub(spawner.spawn);
    hubs.push(hub);
    hub.attach(viewer("driver").entry);
    streaming(spawner.helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    const handingBack = hub.input("driver", { type: "releaseControl" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(spawner.helpers[0]!.stopped).toBe(true);
    let agentRan = false;
    await desktopLiveControl.agent(async () => (agentRan = true)).catch(() => undefined);
    expect(agentRan).toBe(false);
    // Only the helper's exit, which takes its portal session and held keys along, lets agents in.
    spawner.helpers[0]!.exit();
    await handingBack;
    await desktopLiveControl.agent(async () => (agentRan = true));
    expect(agentRan).toBe(true);
  });

  it("treats a release the portal refused like an unconfirmed one", async () => {
    const spawner = fakeSpawner({ acknowledge: "failed" });
    const hub = new DesktopLiveViewHub(spawner.spawn);
    hubs.push(hub);
    hub.attach(viewer("driver").entry);
    streaming(spawner.helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    const handingBack = hub.input("driver", { type: "releaseControl" });
    await settle();
    expect(spawner.helpers[0]!.stopped).toBe(true);
    spawner.helpers[0]!.exit();
    await handingBack;
    expect(desktopLiveControl.humanController).toBeNull();
  });

  it("returns the lease after a switch-off only once the helper exited, though its driver left first", async () => {
    const { hub, spawner, events, open } = leasedHub();
    open();
    hub.attach(viewer("driver").entry);
    streaming(spawner.helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    const leaving = hub.detach("driver");
    hub.setEnabled(false);
    await settle();
    let agentRan = false;
    await desktopLiveControl.agent(async () => (agentRan = true)).catch(() => undefined);
    expect(agentRan).toBe(false);
    expect(events).toEqual(["acquire"]);
    spawner.helpers[0]!.exit();
    await leaving;
    expect(events).toEqual(["acquire", "release"]);
    await desktopLiveControl.agent(async () => (agentRan = true));
    expect(agentRan).toBe(true);
  });

  it("keeps agents out after a capture error until the stopped helper exited", async () => {
    const { hub, helpers } = makeHub();
    hub.attach(viewer("driver").entry);
    streaming(helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    helpers[0]!.status({ type: "error", code: "pipeline" });
    expect(helpers[0]!.stopped).toBe(true);
    const handingBack = hub.input("driver", { type: "releaseControl" });
    await settle();
    let agentRan = false;
    await desktopLiveControl.agent(async () => (agentRan = true)).catch(() => undefined);
    expect(agentRan).toBe(false);
    helpers[0]!.exit();
    await handingBack;
    await desktopLiveControl.agent(async () => (agentRan = true));
    expect(agentRan).toBe(true);
  });

  it("shuts down by returning the lease only after the helper exited", async () => {
    const { hub, spawner, events, open } = leasedHub();
    open();
    hub.attach(viewer("driver").entry);
    streaming(spawner.helpers[0]!);
    await hub.input("driver", { type: "takeControl" });
    const closing = hub.shutdown();
    await settle();
    expect(spawner.helpers[0]!.stopped).toBe(true);
    expect(events).toEqual(["acquire"]);
    spawner.helpers[0]!.exit();
    await closing;
    expect(events).toEqual(["acquire", "release"]);
  });

  it("holds the login's capture until the helper exits, though its end came earlier", async () => {
    const spawner = fakeSpawner();
    const { guard, events } = fakeGuard("verified");
    const hub = new DesktopLiveViewHub(spawner.spawn, { captureGuard: guard });
    hubs.push(hub);
    hub.attach(viewer("watcher").entry);
    await settle();
    spawner.helpers[0]!.status({ type: "consent", restorable: true });
    spawner.helpers[0]!.status({ type: "error", code: "pipeline" });
    // Recorded at once, but the capture is only free again once the process is gone.
    expect(events).toEqual(["begin", "crashed"]);
    spawner.helpers[0]!.frame(new Uint8Array([1]));
    spawner.helpers[0]!.exit();
    expect(events).toEqual(["begin", "crashed", "end"]);
  });

  it("closes a viewer that attaches after the switch-off", () => {
    const { hub } = makeHub();
    hub.setEnabled(false);
    const late = viewer("late");
    hub.attach(late.entry);
    expect(late.last("closed")?.reason).toContain("turned off");
    expect(late.last("control")).toBeUndefined();
  });
});

describe("agent desktop calls during a live view takeover", () => {
  it("are refused while a person controls the desktop, observation included, and run after", async () => {
    const calls: Array<string> = [];
    const bridge = new ComputerUseLinuxBridge(
      { invoke: async (toolName) => calls.push(toolName) },
      new OpenLease(),
      session,
      async () => true,
    );
    await desktopLiveControl.control.take("viewer");
    const refused = await bridge
      .invoke({ ...session, toolName: "screenshot" })
      .catch((cause) => cause);
    expect(refused).toBeInstanceOf(ComputerUseLinuxBridgeRefusedError);
    expect((refused as Error).message).toContain("live view");
    expect(calls).toEqual([]);
    await desktopLiveControl.control.release("viewer");
    await bridge.invoke({ ...session, toolName: "screenshot" });
    expect(calls).toEqual(["screenshot"]);
  });

  it("let a running agent action finish before the person's first input", async () => {
    let finish: () => void = () => undefined;
    const order: Array<string> = [];
    const bridge = new ComputerUseLinuxBridge(
      {
        invoke: () =>
          new Promise((resolve) => {
            order.push("agent started");
            finish = () => {
              order.push("agent finished");
              resolve(undefined);
            };
          }),
      },
      new OpenLease(),
      session,
      async () => true,
    );
    const running = bridge.invoke({ ...session, toolName: "screenshot" });
    await vi.waitFor(() => expect(order).toEqual(["agent started"]));
    const taking = desktopLiveControl.control.take("viewer").then(() => order.push("person"));
    await Promise.resolve();
    expect(order).toEqual(["agent started"]);
    finish();
    await running;
    await taking;
    expect(order).toEqual(["agent started", "agent finished", "person"]);
  });
});
