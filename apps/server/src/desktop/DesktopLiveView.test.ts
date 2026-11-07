import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  ComputerUseLinuxBridge,
  ComputerUseLinuxBridgeRefusedError,
} from "./ComputerUseLinuxBridge.ts";
import type { ComputerUseLinuxLease } from "./ComputerUseLinuxHostLease.ts";
import { desktopLiveControl } from "./DesktopLiveControl.ts";
import {
  type DesktopLiveViewOutput,
  DesktopLiveViewHub,
  type SpawnDesktopLiveViewHelper,
  keysymForKey,
} from "./DesktopLiveView.ts";

interface FakeHelper {
  readonly commands: Array<Record<string, unknown>>;
  stopped: boolean;
  frame: (jpeg: Uint8Array) => void;
  status: (status: Record<string, unknown>) => void;
  exit: () => void;
}

function fakeSpawner() {
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
      send: (command) => helper.commands.push(command),
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
  for (const hub of hubs.splice(0)) hub.shutdown();
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
      { t: "key", keysym: 0x6f, down: true },
      { t: "key", keysym: 0x6f, down: false },
      { t: "key", keysym: 0x6b, down: true },
      { t: "key", keysym: 0x6b, down: false },
      { t: "key", keysym: 0xff0d, down: true },
      { t: "key", keysym: 0xff0d, down: false },
    ]);

    await hub.input("driver", { type: "releaseControl" });
    expect(helper.commands.at(-1)).toEqual({ t: "release" });
    expect(driver.last("control")?.controller).toBe("agent");
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
    expect(helpers[0]!.commands).toContainEqual({ t: "release" });
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

describe("DesktopLiveViewHub crash guard", () => {
  it("stops starting screen streams after one ended before its first frame", () => {
    let tripped = false;
    const spawner = fakeSpawner();
    const hub = new DesktopLiveViewHub(spawner.spawn, {
      crashGuard: { isTripped: () => tripped, trip: () => (tripped = true) },
    });
    hubs.push(hub);
    const first = viewer("first");
    hub.attach(first.entry);
    streaming(spawner.helpers[0]!);
    // The compositor died: the helper ends with no frame after "ready".
    spawner.helpers[0]!.exit();
    expect(tripped).toBe(true);
    expect(first.last("desktop")?.state).toBe("unavailable");
    expect(first.last("desktop")?.detail).toContain("before its first frame");
    return hub.input("first", { type: "reload" }).then(() => {
      expect(spawner.helpers).toHaveLength(1);
    });
  });

  it("does not trip when frames arrived or the stream never started", () => {
    let tripped = false;
    const spawner = fakeSpawner();
    const hub = new DesktopLiveViewHub(spawner.spawn, {
      crashGuard: { isTripped: () => tripped, trip: () => (tripped = true) },
    });
    hubs.push(hub);
    hub.attach(viewer("watcher").entry);
    spawner.helpers[0]!.status({ type: "error", code: "missing-element", element: "pipewiresrc" });
    expect(tripped).toBe(false);
    void hub.input("watcher", { type: "reload" });
    streaming(spawner.helpers[1]!);
    spawner.helpers[1]!.frame(new Uint8Array([1]));
    spawner.helpers[1]!.exit();
    expect(tripped).toBe(false);
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
