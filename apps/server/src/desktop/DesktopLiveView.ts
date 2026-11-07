// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the portal helper is a child process with a binary pipe protocol, driven from plain callbacks.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ComputerUseLinuxHostLease,
  ComputerUseLinuxLeaseBusyError,
  userLeaseScopeKey,
} from "./ComputerUseLinuxHostLease.ts";
import { desktopLiveControl } from "./DesktopLiveControl.ts";
import { DESKTOP_LIVE_VIEW_PORTAL_SCRIPT } from "./DesktopLiveViewPortalScript.ts";

/**
 * starting: the helper is opening its portal session. consent: the portal asks on the machine's
 * own screen. streaming: frames flow. denied: the person at the machine refused. ended: the
 * session was stopped there (GNOME's sharing indicator). unavailable: the host cannot stream.
 */
export type DesktopLiveViewState =
  | "unverified"
  | "starting"
  | "consent"
  | "streaming"
  | "denied"
  | "ended"
  | "unavailable";

export type DesktopLiveViewOutput =
  | { readonly _tag: "frame"; readonly data: Uint8Array }
  /** The coordinate space input is sent in: the stream's logical size, not the frame size. */
  | { readonly _tag: "viewport"; readonly width: number; readonly height: number }
  | {
      readonly _tag: "control";
      readonly canOperate: boolean;
      readonly controller: "agent" | "you" | "another-viewer";
      readonly generation: number;
    }
  | { readonly _tag: "desktop"; readonly state: DesktopLiveViewState; readonly detail?: string }
  /** The viewer must go: the feature was turned off. */
  | { readonly _tag: "closed"; readonly reason: string };

export interface DesktopLiveViewer {
  readonly output: Queue.Dequeue<DesktopLiveViewOutput>;
  readonly input: (message: unknown) => Effect.Effect<void>;
}

export class DesktopLiveViewUnavailableError extends Schema.TaggedError<DesktopLiveViewUnavailableError>()(
  "DesktopLiveViewUnavailableError",
  { reason: Schema.Literals(["disabled", "platform", "full"]) },
) {
  override get message(): string {
    return this.reason === "disabled"
      ? "Desktop live view is turned off in this server's settings."
      : this.reason === "full"
        ? "Too many viewers are watching this desktop."
        : "Desktop live view needs a Linux desktop session on this server.";
  }
}

export class DesktopLiveView extends Context.Service<
  DesktopLiveView,
  {
    readonly attachViewer: (input: {
      readonly canOperate: boolean;
    }) => Effect.Effect<DesktopLiveViewer, DesktopLiveViewUnavailableError, Scope.Scope>;
  }
>()("t3/desktop/DesktopLiveView") {}

/** A running portal helper, seen from the hub. */
export interface DesktopLiveViewHelper {
  readonly send: (command: Record<string, unknown>) => void;
  readonly stop: () => void;
}

export type SpawnDesktopLiveViewHelper = (events: {
  readonly onFrame: (jpeg: Uint8Array) => void;
  readonly onStatus: (status: Record<string, unknown>) => void;
  readonly onExit: () => void;
}) => DesktopLiveViewHelper;

const VIEWER_OUTPUT_LIMIT = 32;
/** The capture keeps running this long after the last viewer leaves, for a quick reconnect. */
const IDLE_STOP_MS = 20_000;
/** How long the portal's consent dialog may wait on the machine's screen. */
const CONSENT_TIMEOUT_MS = 3 * 60_000;
const WHEEL_KEY = "wheel";
const HOVER_KEY = "hover";

const NAMED_KEYSYMS: Readonly<Record<string, number>> = {
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  CapsLock: 0xffe5,
  ContextMenu: 0xff67,
  PrintScreen: 0xff61,
  AltGraph: 0xfe03,
  Meta: 0xffeb,
  OS: 0xffeb,
  " ": 0x20,
};

/** The X keysym for a DOM key; layout-independent, so the host types the character the viewer saw. */
export function keysymForKey(key: string, code: string): number | null {
  if (key === "Shift") return code === "ShiftRight" ? 0xffe2 : 0xffe1;
  if (key === "Control") return code === "ControlRight" ? 0xffe4 : 0xffe3;
  if (key === "Alt") return code === "AltRight" ? 0xffea : 0xffe9;
  const named = NAMED_KEYSYMS[key];
  if (named !== undefined) return named;
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (functionKey) return 0xffbe + Number(functionKey[1]) - 1;
  const codePoint = key.codePointAt(0);
  if (codePoint === undefined || String.fromCodePoint(codePoint).length !== key.length) return null;
  return keysymForCodePoint(codePoint);
}

function keysymForCodePoint(codePoint: number): number | null {
  if (codePoint === 0x0a || codePoint === 0x0d) return 0xff0d;
  if (codePoint === 0x09) return 0xff09;
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff))
    return codePoint;
  return codePoint > 0xff ? 0x01000000 + codePoint : null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const BUTTONS = new Set(["left", "middle", "right"]);

interface HubViewer {
  readonly id: string;
  readonly canOperate: boolean;
  readonly push: (output: DesktopLiveViewOutput) => void;
  /** Keys this viewer holds down, by DOM code, so a release sends the keysym the press did. */
  readonly pressedKeys: Map<string, number>;
}

/** Holds the host-wide desktop lease, which agents in every T3 server on this login also take. */
export interface DesktopLiveViewHostLease {
  readonly release: () => Promise<void>;
}

/** One screen capture, as the crash guard sees it. */
export interface DesktopLiveViewCaptureRun {
  /** The first frame arrived: screen sharing works on this machine. */
  readonly succeeded: () => void;
  /** The capture is over; `crashed` when it ended after the stream started and before a frame. */
  readonly end: (crashed: boolean) => void;
}

/**
 * Screen sharing can take the whole desktop session down (GNOME Shell 46 on GPUs without DRM
 * format modifiers), so the guard is per OS login, armed before the stream starts, and fails
 * closed: a marker left by an attempt that never finished counts as a crash.
 */
export interface DesktopLiveViewCaptureGuard {
  readonly status: () => "verified" | "unverified" | "crashed";
  /** Claims this login's one capture and arms the marker, or says why not. */
  readonly begin: () => Promise<
    DesktopLiveViewCaptureRun | { readonly refused: string; readonly crashed: boolean }
  >;
}

// DOM modifier mask bits (Alt 1, Control 2, Meta 4, Shift 8) and their keysyms, left then right.
const MODIFIER_KEYSYMS: ReadonlyArray<readonly [number, ReadonlyArray<number>]> = [
  [1, [0xffe9, 0xffea]],
  [2, [0xffe3, 0xffe4]],
  [4, [0xffeb, 0xffec]],
  [8, [0xffe1, 0xffe2]],
];
const MAX_TEXT_CHARACTERS = 1000;
const MAX_WHEEL_DELTA = 2400;
const RELEASE_ACK_TIMEOUT_MS = 1500;
const LEASE_WAIT_MS = 10_000;
const LEASE_RETRY_MS = 200;

const UNVERIFIED_DETAIL =
  "Screen sharing has not worked on this machine yet. On some GPUs GNOME Shell 46 crashes when a screen share starts, which ends the desktop session and closes its apps. Start only if that is acceptable now.";

const clampWheel = (value: unknown) =>
  Math.min(Math.max(finite(value), -MAX_WHEEL_DELTA), MAX_WHEEL_DELTA);

type ReleaseOutcome = "applied" | "failed" | "timeout" | "gone";

/**
 * One capture for the machine, shared by every viewer. It starts with the first viewer and
 * stops a little after the last one leaves. Viewers only watch until one takes control; agents
 * are refused desktop calls until that viewer hands control back.
 */
export class DesktopLiveViewHub {
  private readonly spawnHelper: SpawnDesktopLiveViewHelper;
  private readonly viewers = new Map<string, HubViewer>();
  private helper: DesktopLiveViewHelper | null = null;
  private launching = false;
  private state: DesktopLiveViewState = "starting";
  private detail: string | undefined;
  private viewport: { width: number; height: number } | null = null;
  private lastFrame: Uint8Array | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = true;
  /** Set on a detected crash even when the marker cannot be written. */
  private crashLatched = false;
  private hostLease: DesktopLiveViewHostLease | null = null;
  /** Takeovers, hand-backs and switch-off run one at a time, each to completion. */
  private handoffs: Promise<unknown> = Promise.resolve();
  private nextRelease = 0;
  private readonly releases = new Map<
    number,
    { readonly helper: DesktopLiveViewHelper; readonly settle: (outcome: ReleaseOutcome) => void }
  >();
  private readonly exits = new WeakMap<DesktopLiveViewHelper, Promise<void>>();
  private readonly stopped = new WeakSet<DesktopLiveViewHelper>();
  private readonly stopListening: () => void;
  private readonly onHelperError: (status: Record<string, unknown>) => void;
  private readonly captureGuard: DesktopLiveViewCaptureGuard | null;
  private readonly acquireHostLease: (() => Promise<DesktopLiveViewHostLease | null>) | null;

  constructor(
    spawnHelper: SpawnDesktopLiveViewHelper,
    options: {
      readonly onHelperError?: (status: Record<string, unknown>) => void;
      readonly captureGuard?: DesktopLiveViewCaptureGuard;
      /** Resolves null while the lease is busy; the hub retries for a while. */
      readonly acquireHostLease?: () => Promise<DesktopLiveViewHostLease | null>;
    } = {},
  ) {
    this.spawnHelper = spawnHelper;
    this.onHelperError = options.onHelperError ?? (() => undefined);
    this.captureGuard = options.captureGuard ?? null;
    this.acquireHostLease = options.acquireHostLease ?? null;
    this.stopListening = desktopLiveControl.onChange(() => this.broadcastControl());
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  attach(viewer: HubViewer): void {
    if (!this.enabled) {
      viewer.push({ _tag: "closed", reason: SWITCHED_OFF_REASON });
      return;
    }
    this.viewers.set(viewer.id, viewer);
    this.cancelIdleStop();
    // Later viewers join what is there; after a refusal or failure, "reload" asks again.
    if (this.helper === null && !this.launching && this.viewers.size === 1)
      void this.startCapture(false);
    viewer.push({ _tag: "desktop", state: this.state, ...this.detailField() });
    if (this.viewport) viewer.push({ _tag: "viewport", ...this.viewport });
    viewer.push(this.controlFor(viewer));
    if (this.lastFrame && this.state === "streaming")
      viewer.push({ _tag: "frame", data: this.lastFrame });
  }

  async detach(viewerId: string): Promise<void> {
    const viewer = this.viewers.get(viewerId);
    // Leaving first makes a takeover this viewer still has pending give up.
    this.viewers.delete(viewerId);
    await this.handoff(() => this.handBack(viewerId, viewer));
    if (this.viewers.size === 0) this.scheduleIdleStop();
  }

  /** Follows the setting: turning it off ends every viewer and the capture at once. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) return;
    const helper = this.helper;
    this.stopHelper();
    for (const viewer of this.viewers.values())
      viewer.push({ _tag: "closed", reason: SWITCHED_OFF_REASON });
    const controller = desktopLiveControl.humanController;
    if (controller !== null && this.viewers.has(controller)) {
      void this.handoff(async () => {
        if (helper !== null) await this.exits.get(helper);
        await this.handBack(controller, this.viewers.get(controller));
      });
    }
  }

  shutdown(): void {
    this.stopListening();
    this.cancelIdleStop();
    this.stopHelper();
    void this.dropHostLease();
  }

  async input(viewerId: string, raw: unknown): Promise<void> {
    const viewer = this.viewers.get(viewerId);
    const message = asRecord(raw);
    if (!viewer?.canOperate || !message || !this.enabled) return;
    const control = desktopLiveControl.control;
    try {
      switch (message.type) {
        case "takeControl":
          return await this.handoff(() => this.take(viewerId));
        case "releaseControl":
          return await this.handoff(() => this.handBack(viewerId, viewer));
        case "reload":
          // Also the explicit "start anyway" on a machine where sharing never worked yet.
          if (this.helper === null && !this.launching) await this.startCapture(true);
          return;
        case "mouse":
          return await this.mouse(viewerId, message);
        case "wheel": {
          const point = this.point(message);
          if (!point) return;
          const dx = clampWheel(message.deltaX);
          const dy = clampWheel(message.deltaY);
          return await control.humanLatest(
            viewerId,
            `${WHEEL_KEY}:${Math.sign(dx)}:${Math.sign(dy)}`,
            { ...point, dx, dy },
            async (wheel) => {
              this.helper?.send({ t: "move", x: wheel.x, y: wheel.y });
              this.helper?.send({ t: "wheel", dx: wheel.dx, dy: wheel.dy });
            },
            (waiting, next) => ({
              ...next,
              dx: clampWheel(waiting.dx + next.dx),
              dy: clampWheel(waiting.dy + next.dy),
            }),
          );
        }
        case "key":
          return await control.human(viewerId, async () => this.key(viewer, message));
        case "text":
          if (typeof message.text !== "string") return;
          return await control.human(viewerId, async () => this.typeText(message.text as string));
        default:
          return;
      }
    } catch {
      // Not this viewer's turn, or control changed underneath; the next control message says so.
      this.broadcastControl();
    }
  }

  private handoff<A>(run: () => Promise<A>): Promise<A> {
    const result = this.handoffs.then(run);
    this.handoffs = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Takes the host-wide lease, then control. Rechecks after every wait: a viewer that left or a
   * switch-off cancels the takeover and gives the lease back.
   */
  private async take(viewerId: string) {
    const wanted = () => this.enabled && this.viewers.get(viewerId)?.canOperate === true;
    if (!wanted()) return;
    const controller = desktopLiveControl.humanController;
    if (controller === viewerId) return;
    if (controller !== null) throw new Error("Another viewer controls the desktop.");
    let lease: DesktopLiveViewHostLease | null = null;
    if (this.acquireHostLease !== null) {
      const deadline = performance.now() + LEASE_WAIT_MS;
      lease = await this.acquireHostLease();
      while (lease === null && wanted() && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LEASE_RETRY_MS));
        lease = await this.acquireHostLease();
      }
      if (lease === null) throw new Error("An agent is still using the desktop.");
      if (!wanted()) {
        await lease.release().catch(() => undefined);
        return;
      }
    }
    this.hostLease = lease;
    try {
      await desktopLiveControl.control.take(viewerId);
    } catch (cause) {
      await this.dropHostLease();
      throw cause;
    }
    // Draining the agent's running call took time; the viewer may have gone meanwhile.
    if (!wanted()) await this.handBack(viewerId, undefined);
  }

  /** Releases what the viewer held, then the lease; agents stay out until both are done. */
  private async handBack(viewerId: string, viewer: HubViewer | undefined) {
    if (desktopLiveControl.humanController !== viewerId) return;
    await desktopLiveControl.release(viewerId, async () => {
      viewer?.pressedKeys.clear();
      await this.releaseHeldInput();
      await this.dropHostLease();
    });
  }

  private async dropHostLease() {
    const lease = this.hostLease;
    this.hostLease = null;
    await lease?.release().catch(() => undefined);
  }

  /**
   * Asks the helper to release every key and button and waits for its answer. Without a clean
   * answer the capture ends: its portal session goes, and every key it held goes with it.
   */
  private async releaseHeldInput() {
    const helper = this.helper;
    if (helper === null) return;
    const id = ++this.nextRelease;
    const outcome = await new Promise<ReleaseOutcome>((resolve) => {
      const timer = setTimeout(() => settle("timeout"), RELEASE_ACK_TIMEOUT_MS);
      const settle = (result: ReleaseOutcome) => {
        clearTimeout(timer);
        this.releases.delete(id);
        resolve(result);
      };
      this.releases.set(id, { helper, settle });
      helper.send({ t: "release", id });
    });
    if (outcome === "applied" || outcome === "gone") return;
    this.stopHelper();
    await this.exits.get(helper);
    this.setState(
      "unavailable",
      "The capture stopped because releasing held keys was not confirmed.",
    );
  }

  private async mouse(viewerId: string, message: Record<string, unknown>) {
    const point = this.point(message);
    if (!point) return;
    const control = desktopLiveControl.control;
    const button = typeof message.button === "string" ? message.button : "none";
    if (message.action === "move" && finite(message.buttons) === 0) {
      return control.humanLatest(viewerId, HOVER_KEY, point, async (latest) => {
        this.helper?.send({ t: "move", ...latest });
      });
    }
    return control.human(viewerId, async () => {
      this.helper?.send({ t: "move", ...point });
      if ((message.action === "down" || message.action === "up") && BUTTONS.has(button)) {
        this.helper?.send({ t: "button", b: button, down: message.action === "down" });
      }
    });
  }

  private key(viewer: HubViewer, message: Record<string, unknown>) {
    const code = typeof message.code === "string" ? message.code : "";
    const key = typeof message.key === "string" ? message.key : "";
    if (message.action === "down") {
      const keysym = keysymForKey(key, code);
      if (keysym === null) return;
      // Shortcuts such as the viewer's Copy arrive as one key with a modifier mask.
      const held = new Set(viewer.pressedKeys.values());
      const missing = MODIFIER_KEYSYMS.filter(
        ([bit, keysyms]) =>
          (finite(message.modifiers) & bit) !== 0 &&
          !keysyms.includes(keysym) &&
          !keysyms.some((each) => held.has(each)),
      ).map(([, keysyms]) => keysyms[0]!);
      for (const modifier of missing) this.helper?.send({ t: "key", keysym: modifier, down: true });
      viewer.pressedKeys.set(code || key, keysym);
      this.helper?.send({ t: "key", keysym, down: true });
      for (const modifier of missing.toReversed())
        this.helper?.send({ t: "key", keysym: modifier, down: false });
    } else if (message.action === "up") {
      const keysym = viewer.pressedKeys.get(code || key) ?? keysymForKey(key, code);
      viewer.pressedKeys.delete(code || key);
      if (keysym !== null) this.helper?.send({ t: "key", keysym, down: false });
    }
  }

  private typeText(text: string) {
    const keysyms: Array<number> = [];
    for (const character of [...text].slice(0, MAX_TEXT_CHARACTERS)) {
      const keysym = keysymForCodePoint(character.codePointAt(0) ?? 0);
      if (keysym !== null) keysyms.push(keysym);
    }
    if (keysyms.length > 0) this.helper?.send({ t: "text", keysyms });
  }

  /** Input arrives in the viewport's coordinate space; anything outside it is clamped. */
  private point(message: Record<string, unknown>): { x: number; y: number } | null {
    const viewport = this.viewport;
    if (!viewport || this.state !== "streaming") return null;
    return {
      x: Math.min(Math.max(finite(message.x), 0), viewport.width - 1),
      y: Math.min(Math.max(finite(message.y), 0), viewport.height - 1),
    };
  }

  private controlFor(viewer: HubViewer): DesktopLiveViewOutput {
    const controller = desktopLiveControl.humanController;
    return {
      _tag: "control",
      canOperate: viewer.canOperate,
      controller:
        controller === null ? "agent" : controller === viewer.id ? "you" : "another-viewer",
      generation: desktopLiveControl.control.generation,
    };
  }

  private broadcastControl() {
    for (const viewer of this.viewers.values()) viewer.push(this.controlFor(viewer));
  }

  private setState(state: DesktopLiveViewState, detail?: string) {
    this.state = state;
    this.detail = detail;
    for (const viewer of this.viewers.values())
      viewer.push({ _tag: "desktop", state, ...this.detailField() });
  }

  private detailField() {
    return this.detail === undefined ? {} : { detail: this.detail };
  }

  /** `confirmed`: a viewer chose to start although sharing never worked on this machine. */
  private async startCapture(confirmed: boolean) {
    this.lastFrame = null;
    if (!this.enabled || this.helper !== null || this.launching) return;
    if (this.crashLatched) {
      this.setState("unavailable", CRASH_GUARD_DETAIL);
      return;
    }
    let run: DesktopLiveViewCaptureRun | null = null;
    const guard = this.captureGuard;
    if (guard !== null) {
      const status = guard.status();
      if (status === "crashed") {
        this.crashLatched = true;
        this.setState("unavailable", CRASH_GUARD_DETAIL);
        return;
      }
      if (status === "unverified" && !confirmed) {
        this.setState("unverified", UNVERIFIED_DETAIL);
        return;
      }
      this.launching = true;
      this.setState("starting");
      const begun = await guard.begin().finally(() => {
        this.launching = false;
      });
      if ("refused" in begun) {
        if (begun.crashed) this.crashLatched = true;
        this.setState("unavailable", begun.refused);
        return;
      }
      if (!this.enabled || this.viewers.size === 0 || this.helper !== null) {
        begun.end(false);
        return;
      }
      run = begun;
    }
    this.spawnCapture(run);
  }

  private spawnCapture(run: DesktopLiveViewCaptureRun | null) {
    this.setState("starting");
    let helper: DesktopLiveViewHelper | null = null;
    // The stream starts with the portal's Start call, which comes right after "consent".
    let hazardous = false;
    let framed = false;
    let finished = false;
    const finish = (crashed: boolean) => {
      if (finished) return;
      finished = true;
      if (crashed) this.crashLatched = true;
      run?.end(crashed);
    };
    // Only a guarded capture can take the desktop down; the test source cannot.
    const looksCrashed = () => run !== null && hazardous && !framed && !this.stopped.has(helper!);
    let exited: () => void = () => undefined;
    helper = this.spawnHelper({
      onFrame: (jpeg) => {
        if (!framed) {
          framed = true;
          run?.succeeded();
        }
        if (this.helper !== helper) return;
        this.lastFrame = jpeg;
        for (const viewer of this.viewers.values()) viewer.push({ _tag: "frame", data: jpeg });
      },
      onStatus: (status) => {
        if (status.type === "consent" || status.type === "ready") hazardous = true;
        if (status.type === "released") {
          const release = this.releases.get(finite(status.id));
          if (release?.helper === helper)
            release.settle(status.ok === false ? "failed" : "applied");
          return;
        }
        if (status.type === "denied") finish(false);
        else if (status.type === "error" || status.type === "closed") {
          const crashed = looksCrashed();
          finish(crashed);
          if (crashed && this.helper === helper) {
            this.onHelperError(status);
            this.stopHelper();
            this.setState("unavailable", CRASH_GUARD_DETAIL);
            return;
          }
        }
        if (this.helper !== helper) return;
        this.onHelperStatus(status);
      },
      onExit: () => {
        finish(looksCrashed());
        for (const release of this.releases.values())
          if (release.helper === helper) release.settle("gone");
        exited();
        if (this.helper !== helper) return;
        this.helper = null;
        this.clearStartTimer();
        if (this.crashLatched) this.setState("unavailable", CRASH_GUARD_DETAIL);
        else if (
          this.state === "starting" ||
          this.state === "consent" ||
          this.state === "streaming"
        )
          this.setState("unavailable", "The desktop capture stopped.");
      },
    });
    this.exits.set(
      helper,
      new Promise<void>((resolve) => {
        exited = resolve;
      }),
    );
    this.helper = helper;
    // A restore token the portal ignores still shows the dialog, so the deadline always runs.
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.helper !== helper || this.state === "streaming") return;
      this.stopHelper();
      this.setState("unavailable", "Nobody answered the screen sharing prompt on the machine.");
    }, CONSENT_TIMEOUT_MS);
    this.startTimer.unref?.();
  }

  private onHelperStatus(status: Record<string, unknown>) {
    switch (status.type) {
      case "consent":
        if (status.restorable !== true) this.setState("consent");
        return;
      case "ready": {
        this.clearStartTimer();
        const width = finite(status.width);
        const height = finite(status.height);
        if (width > 0 && height > 0) {
          this.viewport = { width, height };
          for (const viewer of this.viewers.values())
            viewer.push({ _tag: "viewport", width, height });
        }
        this.setState("streaming");
        return;
      }
      case "denied":
        this.stopHelper();
        this.setState("denied");
        return;
      case "closed":
        this.stopHelper();
        this.setState("ended");
        return;
      case "error":
        this.onHelperError(status);
        this.stopHelper();
        this.setState("unavailable", helperErrorDetail(status));
        return;
    }
  }

  /** Asks the current helper to stop; its exit, not this call, settles anything waiting on it. */
  private stopHelper() {
    this.clearStartTimer();
    const helper = this.helper;
    this.helper = null;
    this.lastFrame = null;
    if (helper === null) return;
    this.stopped.add(helper);
    helper.stop();
  }

  private clearStartTimer() {
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private scheduleIdleStop() {
    this.cancelIdleStop();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.viewers.size === 0) {
        this.stopHelper();
        this.state = "starting";
        this.detail = undefined;
      }
    }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  private cancelIdleStop() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

const SWITCHED_OFF_REASON = "Desktop live view was turned off on this machine.";

const CRASH_GUARD_DETAIL =
  "A screen share on this machine ended before its first frame, which is how a desktop crash looks (GNOME Shell 46 on GPUs without DRM format modifiers). Live view stays off for this login; see docs/desktop-live-view.md to reset it.";

/**
 * Markers per OS login, shared by every T3 server and checkout on it: `starting` is written before
 * the stream starts and removed once a frame arrived or the attempt ended harmlessly, so one left
 * behind means the attempt never finished. `verified` and `crashed` record the outcome.
 */
export const loginCaptureGuard = (input: {
  readonly directory: string;
  /** This login's single capture; resolves null while another process holds it. */
  readonly acquireCaptureLock: () => Promise<{ readonly release: () => Promise<void> } | null>;
}): DesktopLiveViewCaptureGuard => {
  const file = (name: string) => NodePath.join(input.directory, name);
  const write = (name: string, text: string) => {
    NodeFS.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(file(name), text, { mode: 0o600 });
  };
  const exists = (name: string) => NodeFS.existsSync(file(name));
  const remove = (name: string) => NodeFS.rmSync(file(name), { force: true });
  const markCrashed = () => {
    try {
      write("crashed", "A screen share ended before its first frame.\n");
    } catch {}
  };
  return {
    status: () => (exists("crashed") ? "crashed" : exists("verified") ? "verified" : "unverified"),
    begin: async () => {
      let lock: { readonly release: () => Promise<void> } | null;
      try {
        lock = await input.acquireCaptureLock();
      } catch {
        return {
          refused: "The screen share could not claim this login's capture.",
          crashed: false,
        };
      }
      if (lock === null) {
        return {
          refused: "Another T3 server on this login is sharing the screen.",
          crashed: false,
        };
      }
      const held = lock;
      const refuse = async (refused: string, crashed: boolean) => {
        await held.release().catch(() => undefined);
        return { refused, crashed };
      };
      if (exists("starting")) {
        markCrashed();
        return await refuse(CRASH_GUARD_DETAIL, true);
      }
      try {
        write("starting", "A screen share is starting.\n");
      } catch {
        // Fail closed: without the marker a crash here could repeat unnoticed.
        return await refuse(
          "The screen share could not arm its crash guard, so it stays off.",
          false,
        );
      }
      return {
        succeeded: () => {
          try {
            write("verified", "Screen sharing worked on this machine.\n");
            remove("starting");
          } catch {}
        },
        end: (crashed) => {
          if (crashed) markCrashed();
          try {
            remove("starting");
          } catch {}
          void held.release().catch(() => undefined);
        },
      };
    },
  };
};

const SETUP_HINT =
  "Install it with: sudo apt install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good";

function helperErrorDetail(status: Record<string, unknown>): string {
  switch (status.code) {
    case "missing-python":
    case "missing-gstreamer-python":
      return `This machine is missing Python's GStreamer bindings. ${SETUP_HINT}`;
    case "missing-element":
      return `This machine is missing the GStreamer element ${String(status.element)}. ${SETUP_HINT}`;
    case "no-stream":
      return "The screen sharing session came without a screen or pointer.";
    case "create-session":
    case "select-devices":
    case "select-sources":
    case "dbus":
      return "The desktop portal refused the screen sharing session. Is a graphical session running?";
    default:
      return "The desktop capture failed.";
  }
}

// Keep the helper tied to the graphical login without inheriting T3's own secrets.
const HELPER_ENVIRONMENT_ALLOWLIST = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "PATH",
  "WAYLAND_DISPLAY",
  "XDG_CURRENT_DESKTOP",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
] as const;

const MAX_HELPER_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_HELPER_INPUT_BACKLOG_BYTES = 256 * 1024;
const MAX_VIEWERS = 8;
const FRAME_KIND = 0x46;
const STATUS_KIND = 0x4a;

/** Frames are capped at this size; the viewport stays the screen's own size. */
export const DESKTOP_LIVE_VIEW_FRAME = { maxWidth: 1920, maxHeight: 1080, quality: 60, fps: 10 };

export const spawnPortalHelper =
  (options: {
    readonly tokenPath: string;
    readonly environment: NodeJS.ProcessEnv;
    /** A moving test pattern instead of the screen; the portal and compositor stay untouched. */
    readonly testSource?: boolean;
  }): SpawnDesktopLiveViewHelper =>
  (events) => {
    const environment: Record<string, string> = {};
    for (const name of HELPER_ENVIRONMENT_ALLOWLIST) {
      const value = options.environment[name];
      if (value !== undefined) environment[name] = value;
    }
    const child = NodeChildProcess.spawn(
      "python3",
      [
        "-I",
        "-c",
        DESKTOP_LIVE_VIEW_PORTAL_SCRIPT,
        options.tokenPath,
        String(DESKTOP_LIVE_VIEW_FRAME.maxWidth),
        String(DESKTOP_LIVE_VIEW_FRAME.maxHeight),
        String(DESKTOP_LIVE_VIEW_FRAME.quality),
        String(DESKTOP_LIVE_VIEW_FRAME.fps),
        ...(options.testSource ? ["--test-source"] : []),
      ],
      { env: environment, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    let pending: Buffer = Buffer.alloc(0);
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      events.onExit();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(0);
        if (length > MAX_HELPER_MESSAGE_BYTES) {
          child.kill("SIGKILL");
          return;
        }
        if (pending.length < 5 + length) break;
        const kind = pending[4];
        const payload = pending.subarray(5, 5 + length);
        pending = pending.subarray(5 + length);
        if (kind === FRAME_KIND) {
          events.onFrame(new Uint8Array(payload));
        } else if (kind === STATUS_KIND) {
          try {
            const status = asRecord(JSON.parse(payload.toString("utf8")));
            if (status) events.onStatus(status);
          } catch {}
        }
      }
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") events.onStatus({ type: "error", code: "missing-python" });
      exit();
    });
    child.on("exit", exit);
    return {
      send: (command) => {
        if (exited || !child.stdin.writable) return;
        // A helper that stops reading gets no more input piling up; releases still go through.
        if (child.stdin.writableLength > MAX_HELPER_INPUT_BACKLOG_BYTES && command.t !== "release")
          return;
        child.stdin.write(`${JSON.stringify(command)}\n`);
      },
      stop: () => {
        if (exited) return;
        // Closing stdin lets the helper close its portal session; a stuck one is killed.
        child.stdin.end();
        setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, 3_000).unref();
      },
    };
  };

export const DESKTOP_LIVE_VIEW_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["linux"]);

/** Per OS login, so every T3 server and checkout on it shares the crash markers. */
const loginStateDir = (environment: NodeJS.ProcessEnv) =>
  NodePath.join(
    environment.XDG_STATE_HOME ??
      NodePath.join(environment.HOME ?? NodeOS.homedir(), ".local", "state"),
    "t3code",
    "desktop-live-view",
  );

const isLeaseBusy = Schema.is(ComputerUseLinuxLeaseBusyError);

/** One screen capture per OS login, across T3 servers. */
const captureLockAcquirer = (platform: NodeJS.Platform) => async () => {
  const lease = new ComputerUseLinuxHostLease({
    platform,
    scopeKey: `${await userLeaseScopeKey({ platform })}:desktop-capture`,
  });
  try {
    return await lease.acquire();
  } catch (cause) {
    if (isLeaseBusy(cause)) return null;
    throw cause;
  }
};

/** The lease agents take for every desktop call, held for as long as a person drives. */
const hostLeaseAcquirer = (platform: NodeJS.Platform) => async () => {
  try {
    const lease = new ComputerUseLinuxHostLease({
      platform,
      scopeKey: await userLeaseScopeKey({ platform }),
    });
    return await lease.acquire();
  } catch {
    // Busy (an agent call is running), or no lease is possible here; the hub retries or refuses.
    return null;
  }
};

export const layer = Layer.effect(
  DesktopLiveView,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const context = yield* Effect.context<never>();
    const runSyncExit = Effect.runSyncExitWith(context);
    const runFork = Effect.runForkWith(context);
    const stateDir = NodePath.join(config.stateDir, "desktop-live-view");
    // For checking clients and transport on a host whose compositor must not be touched.
    const testSource = environment.T3CODE_DESKTOP_LIVE_VIEW_TEST_SOURCE === "1";
    const hub = new DesktopLiveViewHub(
      spawnPortalHelper({
        tokenPath: NodePath.join(stateDir, "portal-restore-token"),
        environment,
        testSource,
      }),
      {
        ...(testSource || !DESKTOP_LIVE_VIEW_PLATFORMS.has(platform)
          ? {}
          : {
              captureGuard: loginCaptureGuard({
                directory: loginStateDir(environment),
                acquireCaptureLock: captureLockAcquirer(platform),
              }),
            }),
        ...(DESKTOP_LIVE_VIEW_PLATFORMS.has(platform)
          ? { acquireHostLease: hostLeaseAcquirer(platform) }
          : {}),
        // The helper reports codes and GStreamer messages only, never frames or input.
        onHelperError: (status) =>
          void runFork(
            Effect.logWarning("desktop live view capture failed", {
              code: status.code,
              element: status.element,
              detail: status.detail,
            }),
          ),
      },
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => hub.shutdown()));
    // Turning the setting off ends every open viewer, not only the next connection.
    hub.setEnabled(
      yield* settings.getSettings.pipe(
        Effect.map((current) => current.enableDesktopLiveView),
        Effect.orElseSucceed(() => false),
      ),
    );
    yield* (yield* settings.subscribeChanges).pipe(
      Stream.runForEach((current) =>
        Effect.sync(() => hub.setEnabled(current.enableDesktopLiveView)),
      ),
      Effect.forkScoped,
    );
    return DesktopLiveView.of({
      attachViewer: Effect.fn("DesktopLiveView.attachViewer")(function* (input) {
        if (!DESKTOP_LIVE_VIEW_PLATFORMS.has(platform)) {
          return yield* new DesktopLiveViewUnavailableError({ reason: "platform" });
        }
        const enabled = yield* settings.getSettings.pipe(
          Effect.map((current) => current.enableDesktopLiveView),
          Effect.orElseSucceed(() => false),
        );
        if (!enabled) return yield* new DesktopLiveViewUnavailableError({ reason: "disabled" });
        if (hub.viewerCount >= MAX_VIEWERS) {
          return yield* new DesktopLiveViewUnavailableError({ reason: "full" });
        }
        const output = yield* Queue.make<DesktopLiveViewOutput>({
          capacity: VIEWER_OUTPUT_LIMIT,
          strategy: "dropping",
        });
        const id = NodeCrypto.randomUUID();
        const push = (next: DesktopLiveViewOutput) => {
          if (Queue.offerUnsafe(output, next) || next._tag === "frame") return;
          // A stalled viewer keeps only the latest state it cannot do without.
          const dropped = runSyncExit(Queue.clear(output));
          if (dropped._tag === "Failure") return;
          const kept = (["desktop", "viewport", "control", "closed"] as const).flatMap(
            (tag) => [...dropped.value, next].findLast((item) => item._tag === tag) ?? [],
          );
          for (const item of kept) Queue.offerUnsafe(output, item);
        };
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            hub.attach({ id, canOperate: input.canOperate, push, pressedKeys: new Map() }),
          ),
          () => Effect.promise(() => hub.detach(id)),
        );
        return {
          output,
          input: (message: unknown) => Effect.promise(() => hub.input(id, message)),
        } satisfies DesktopLiveViewer;
      }),
    });
  }),
);
