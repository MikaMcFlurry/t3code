// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the portal helper is a child process with a binary pipe protocol, driven from plain callbacks.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { desktopLiveControl } from "./DesktopLiveControl.ts";
import { DESKTOP_LIVE_VIEW_PORTAL_SCRIPT } from "./DesktopLiveViewPortalScript.ts";

/**
 * starting: the helper is opening its portal session. consent: the portal asks on the machine's
 * own screen. streaming: frames flow. denied: the person at the machine refused. ended: the
 * session was stopped there (GNOME's sharing indicator). unavailable: the host cannot stream.
 */
export type DesktopLiveViewState =
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
  | { readonly _tag: "desktop"; readonly state: DesktopLiveViewState; readonly detail?: string };

export interface DesktopLiveViewer {
  readonly output: Queue.Dequeue<DesktopLiveViewOutput>;
  readonly input: (message: unknown) => Effect.Effect<void>;
}

export class DesktopLiveViewUnavailableError extends Schema.TaggedError<DesktopLiveViewUnavailableError>()(
  "DesktopLiveViewUnavailableError",
  { reason: Schema.Literals(["disabled", "platform"]) },
) {
  override get message(): string {
    return this.reason === "disabled"
      ? "Desktop live view is turned off in this server's settings."
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

/**
 * One capture for the machine, shared by every viewer. It starts with the first viewer and
 * stops a little after the last one leaves. Viewers only watch until one takes control; agents
 * are refused desktop calls until that viewer hands control back.
 */
export class DesktopLiveViewHub {
  private readonly spawnHelper: SpawnDesktopLiveViewHelper;
  private readonly viewers = new Map<string, HubViewer>();
  private helper: DesktopLiveViewHelper | null = null;
  private state: DesktopLiveViewState = "starting";
  private detail: string | undefined;
  private viewport: { width: number; height: number } | null = null;
  private lastFrame: Uint8Array | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private consentTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stopListening: () => void;
  private readonly onHelperError: (status: Record<string, unknown>) => void;
  private readonly crashGuard: DesktopLiveViewCrashGuard | null;

  constructor(
    spawnHelper: SpawnDesktopLiveViewHelper,
    options: {
      readonly onHelperError?: (status: Record<string, unknown>) => void;
      readonly crashGuard?: DesktopLiveViewCrashGuard;
    } = {},
  ) {
    this.spawnHelper = spawnHelper;
    this.onHelperError = options.onHelperError ?? (() => undefined);
    this.crashGuard = options.crashGuard ?? null;
    this.stopListening = desktopLiveControl.onChange(() => this.broadcastControl());
  }

  attach(viewer: HubViewer): void {
    this.viewers.set(viewer.id, viewer);
    this.cancelIdleStop();
    // Later viewers join what is there; after a refusal or failure, "reload" asks again.
    if (this.helper === null && this.viewers.size === 1) this.startHelper();
    viewer.push({ _tag: "desktop", state: this.state, ...this.detailField() });
    if (this.viewport) viewer.push({ _tag: "viewport", ...this.viewport });
    viewer.push(this.controlFor(viewer));
    if (this.lastFrame && this.state === "streaming")
      viewer.push({ _tag: "frame", data: this.lastFrame });
  }

  async detach(viewerId: string): Promise<void> {
    const viewer = this.viewers.get(viewerId);
    await desktopLiveControl.control.disconnect(viewerId, async () => {
      if (viewer) this.releaseKeys(viewer);
      this.helper?.send({ t: "release" });
    });
    this.viewers.delete(viewerId);
    if (this.viewers.size === 0) this.scheduleIdleStop();
  }

  shutdown(): void {
    this.stopListening();
    this.cancelIdleStop();
    this.stopHelper();
  }

  async input(viewerId: string, raw: unknown): Promise<void> {
    const viewer = this.viewers.get(viewerId);
    const message = asRecord(raw);
    if (!viewer?.canOperate || !message) return;
    const control = desktopLiveControl.control;
    try {
      switch (message.type) {
        case "takeControl":
          await control.take(viewerId);
          return;
        case "releaseControl":
          await control.release(viewerId, async () => {
            this.releaseKeys(viewer);
            this.helper?.send({ t: "release" });
          });
          return;
        case "reload":
          if (this.helper === null) this.startHelper();
          return;
        case "mouse":
          return await this.mouse(viewerId, message);
        case "wheel": {
          const point = this.point(message);
          if (!point) return;
          return await control.humanLatest(
            viewerId,
            `${WHEEL_KEY}:${Math.sign(finite(message.deltaX))}:${Math.sign(finite(message.deltaY))}`,
            { ...point, dx: finite(message.deltaX), dy: finite(message.deltaY) },
            async (wheel) => {
              this.helper?.send({ t: "move", x: wheel.x, y: wheel.y });
              this.helper?.send({ t: "wheel", dx: wheel.dx, dy: wheel.dy });
            },
            (waiting, next) => ({ ...next, dx: waiting.dx + next.dx, dy: waiting.dy + next.dy }),
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
      viewer.pressedKeys.set(code || key, keysym);
      this.helper?.send({ t: "key", keysym, down: true });
    } else if (message.action === "up") {
      const keysym = viewer.pressedKeys.get(code || key) ?? keysymForKey(key, code);
      viewer.pressedKeys.delete(code || key);
      if (keysym !== null) this.helper?.send({ t: "key", keysym, down: false });
    }
  }

  private typeText(text: string) {
    for (const character of text.slice(0, 4000)) {
      const keysym = keysymForCodePoint(character.codePointAt(0) ?? 0);
      if (keysym === null) continue;
      this.helper?.send({ t: "key", keysym, down: true });
      this.helper?.send({ t: "key", keysym, down: false });
    }
  }

  private releaseKeys(viewer: HubViewer) {
    viewer.pressedKeys.clear();
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

  private startHelper() {
    this.lastFrame = null;
    if (this.crashGuard?.isTripped()) {
      this.setState("unavailable", CRASH_GUARD_DETAIL);
      return;
    }
    this.setState("starting");
    let helper: DesktopLiveViewHelper | null = null;
    // A stream that ends after "ready" without one frame is how a compositor crash looks from here.
    let ready = false;
    let framed = false;
    const tripIfCrashed = () => {
      if (!ready || framed || this.crashGuard === null) return false;
      this.crashGuard.trip();
      return true;
    };
    helper = this.spawnHelper({
      onFrame: (jpeg) => {
        if (this.helper !== helper) return;
        framed = true;
        this.lastFrame = jpeg;
        for (const viewer of this.viewers.values()) viewer.push({ _tag: "frame", data: jpeg });
      },
      onStatus: (status) => {
        if (this.helper !== helper) return;
        if (status.type === "ready") ready = true;
        if ((status.type === "error" || status.type === "closed") && tripIfCrashed()) {
          this.onHelperError(status);
          this.stopHelper();
          this.setState("unavailable", CRASH_GUARD_DETAIL);
          return;
        }
        this.onHelperStatus(status);
      },
      onExit: () => {
        if (this.helper !== helper) return;
        this.helper = null;
        this.clearConsentTimer();
        if (tripIfCrashed()) this.setState("unavailable", CRASH_GUARD_DETAIL);
        else if (this.state === "starting" || this.state === "consent" || this.state === "streaming")
          this.setState("unavailable", "The desktop capture stopped.");
      },
    });
    this.helper = helper;
  }

  private onHelperStatus(status: Record<string, unknown>) {
    switch (status.type) {
      case "consent":
        if (status.restorable === true) return;
        this.setState("consent");
        this.clearConsentTimer();
        this.consentTimer = setTimeout(() => {
          this.stopHelper();
          this.setState("unavailable", "Nobody answered the screen sharing prompt on the machine.");
        }, CONSENT_TIMEOUT_MS);
        return;
      case "ready": {
        this.clearConsentTimer();
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

  private stopHelper() {
    this.clearConsentTimer();
    const helper = this.helper;
    this.helper = null;
    this.lastFrame = null;
    helper?.stop();
  }

  private clearConsentTimer() {
    if (this.consentTimer !== null) clearTimeout(this.consentTimer);
    this.consentTimer = null;
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

/** Remembers that a screen stream took the desktop down, so it never starts again on its own. */
export interface DesktopLiveViewCrashGuard {
  readonly isTripped: () => boolean;
  readonly trip: () => void;
}

const CRASH_GUARD_DETAIL =
  "The last screen stream on this machine ended before its first frame, which is how a desktop crash looks (GNOME Shell 46 on GPUs without DRM format modifiers). Live view stays off here; see docs/desktop-live-view.md to reset it.";

/** A marker file in the server state directory; deleting it re-enables the screen stream. */
export const fileCrashGuard = (path: string): DesktopLiveViewCrashGuard => ({
  isTripped: () => NodeFS.existsSync(path),
  trip: () => {
    try {
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
      NodeFS.writeFileSync(path, "A screen stream ended before its first frame.\n", {
        mode: 0o600,
      });
    } catch {}
  },
});

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
        if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
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
        ...(testSource ? {} : { crashGuard: fileCrashGuard(NodePath.join(stateDir, "screencast-crashed")) }),
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
          const kept = (["desktop", "viewport", "control"] as const).flatMap(
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
