# Desktop live view and takeover

Status: prototype on the fork branch `mika/desktop-live-view` (Linux, GNOME on Wayland).
Builds on the mediated desktop toolkit in `mika/linux-computer-use` (upstream discussion #32088).

## Problem

An agent driving a desktop stops at things only a person can do: a password or 2FA prompt, a
captcha, a polkit or UAC dialog, a "share your screen?" question. Today the person has to walk to
the machine. T3 already solves this for server browser tabs: the preview stream shows the tab live
on every client, including the phone, and **Take control** pauses the agent until the person
releases it. Nothing like it exists for the desktop itself; agents get one screenshot per tool
call, and desktop approvals only show in the web app.

## What it reuses

| Need | Existing piece |
| --- | --- |
| Live frames to every client, acked so slow links skip frames | `/api/preview-stream` (`ServerBrowserStream.ts`) |
| Who drives, and pausing the agent | `SessionControl` (`preview/SessionControl.ts`) |
| Canvas viewer with mouse, touch, keyboard, IME and paste | `ServerBrowserSurface` (web), `PreviewStreamWebView` + `preview-stream.browser.ts` (mobile) |
| Media auth for `<canvas>`/WebSocket over T3 Connect | `wsTicket` (`resolveDeviceHubAccess`, `authenticateMediaRequest`) |
| Desktop backends, approvals, host lease | `ComputerUseLinux*` (fork) |

The live view adds a capture source and one route; it does not add a new viewer.

## Architecture

```
GNOME (Mutter) ──xdg-desktop-portal RemoteDesktop session──▶ portal helper (python3 + GStreamer)
   ▲  pointer/keysym input                                    │ JPEG frames + JSON status on stdout
   └──────────────────────────────────────────────────────────┤ JSON input lines on stdin
                                                              ▼
                                         DesktopLiveViewHub (one per server process)
                                           │ fan-out, last frame for late joiners
                                           │ SessionControl: agent / you / another viewer
                                           ▼
                         /api/desktop-stream/ws  (same protocol as /api/preview-stream)
                           ▼                         ▼                          ▼
                  web dialog (canvas)      desktop app (same web UI)     mobile WebView screen
```

- **Capture and input in one portal session.** The helper opens one
  `org.freedesktop.portal.RemoteDesktop` session with keyboard and pointer devices and adds a
  monitor through `ScreenCast.SelectSources` on the same session. `persist_mode=2` goes on
  `SelectDevices` (the spec forbids it on `SelectSources` for remote desktop sessions), so the
  person at the machine answers one dialog once. The single-use restore token is rewritten after
  every start into the server's state directory (`0600`, never logged or sent to a client).
- **Frames.** `pipewiresrc` → `videorate` (max 10 fps) → scale to at most 1920×1080 → `jpegenc`
  (q 60) → `appsink`. Mutter only sends frames on damage, so an idle screen costs nothing.
- **Input.** Viewers send the preview stream's `mouse`, `wheel`, `key` and `text` messages in the
  stream's logical coordinate space (the `viewport` message). The hub clamps them and the helper
  calls `NotifyPointerMotionAbsolute`, `NotifyPointerButton`, `NotifyPointerAxisDiscrete` and
  `NotifyKeyboardKeysym`. Keys go as keysyms from the DOM `key`, so the host types the character
  the viewer saw regardless of either keyboard layout; Mutter adds Shift/AltGr as the host
  layout needs. A key release uses the keysym its press used.
- **Lifetime.** The helper starts with the first viewer and stops 20 s after the last one leaves.
  A consent dialog that nobody answers within 3 minutes is cancelled.
- **Dependencies.** None beyond a stock Ubuntu desktop: `python3-gi`, `gir1.2-gstreamer-1.0`,
  `gstreamer1.0-pipewire`, `gstreamer1.0-plugins-good`. Missing pieces are reported to the viewer
  with the `apt` line.

### Protocol (`/api/desktop-stream/ws`)

Identical to `/api/preview-stream/ws`, so existing viewers work unchanged:

- server → client: binary JPEG frame (client answers `{"type":"ack"}`; one frame in flight per
  viewer, only the newest waits), `{"type":"viewport","width","height"}`,
  `{"type":"control","canOperate","controller","generation","dialog":null}`.
- new: `{"type":"desktop","state":"starting|consent|streaming|denied|ended|unavailable","detail"?}`.
- client → server: `takeControl`, `releaseControl`, `mouse`, `wheel`, `key`, `text`, and `reload`
  (restart a stopped capture). `resize`, `probe` and navigation messages are ignored.
- close `4404` with a reason: live view is off or the platform is unsupported.

Lesson from #26796/#19456 kept: every view carries the coordinate space it expects input in.
Frames may be smaller than the viewport; clients map from the drawn frame to the viewport.

## Security

- **Opt-in per machine.** Server setting `enableDesktopLiveView`, default off. On Linux the portal
  dialog on the machine itself is a second, OS-level consent, and GNOME shows its screen-sharing
  indicator in the top bar for as long as the capture runs; stopping it there ends the session for
  every viewer (`ended`).
- **Who may watch.** The whole screen is more than one preview tab, so watching already needs
  `preview:operate` (preview tabs need `orchestration:read`). Upstream this should become its own
  scope (for example `desktop:view` / `desktop:operate`) that a pairing or T3 Connect grant does
  not include by default; that also answers the concern in #32098 that cloud authorization alone
  can reach a machine.
- **Who may drive.** One viewer at a time, as with preview tabs: `takeControl` fails while another
  viewer holds control, and a viewer that disconnects (phone locked, tab closed) hands control
  back, releasing every key and button it held.
- **Passwords.** While a person holds control, every agent desktop call is refused, observation
  included, so no screenshot reaches a model while a password or code is on screen. The server
  never stores or logs frames or input; input messages are not traced. On the phone, the text
  field is masked by default. Typed text goes to whatever field has focus on the machine, like a
  physical keyboard.
- **Child process.** The helper gets an allowlisted environment (session bus, display, `HOME`,
  `PATH`, locale), no T3 secrets, and only the stdin/stdout pipes.
- **Not done in the prototype:** an audit line per viewer (who watched, who drove, when), a
  per-viewer "watching" notice on the machine, and a cap on concurrent viewers.

## Agent behaviour during a takeover

- `takeControl` reserves control immediately; desktop calls that are already running finish
  before the person's first input is applied (the drain is queued inside the ownership change).
- A call that starts while a person holds control fails with a server-authored message the agent
  sees: *"A person is using this desktop through T3's live view. Wait until they hand it back,
  then take a new screenshot before acting."* It runs after the approval card, so an approval
  answered during the takeover still acts on nothing. Agent calls are not serialized by this
  gate; the host lease keeps its existing busy semantics.
- After `releaseControl` the next call runs normally. The agent is told to take a new screenshot
  because the screen changed under it.
- Next step (not in this prototype): `request_human_takeover` (reason, optional hint), modelled on
  `request_secret`: a card in the thread with **Open live view** and **Done**, a phone push that
  deep-links to the live view (`?desktopLiveView=…` on web, `settings/environments/:id/desktop`
  on mobile), and the tool call returning when the person presses **Done** or releases control.
  Desktop approvals and this request should also reach the phone, which today only sees runtime
  requests (`AgentAwarenessRelay`).

## Several viewers and bandwidth

- One capture per machine, any number of viewers. Each viewer has at most one frame in flight and
  keeps only the newest waiting frame, so a slow phone over T3 Connect skips frames instead of
  building a backlog, and control and state messages never wait behind images.
- A late viewer starts from the last frame. Idle screens send nothing.
- Measured numbers are in the evidence section below. If JPEG proves too heavy over T3 Connect,
  the device panel's H.264-over-WebCodecs path is the model; on stock Ubuntu only `vp8enc` is
  available without extra packages, so VP8 via WebCodecs would be the first candidate.

## Alternatives considered (Linux)

- **Screenshots in a loop** (`gnome-screenshot`, what the agent toolkit uses): no consent per call,
  but one process and PNG per frame, 2–3 fps at best on a 4K panel, and no input path.
- **Mutter's own `org.gnome.Mutter.ScreenCast`/`RemoteDesktop` D-Bus API:** no dialog, but a
  private GNOME interface without user consent, not available on KDE or wlroots.
- **`gnome-remote-desktop` (RDP) or a VNC server:** solid, but needs system configuration and
  credentials outside T3, another port, and a separate client on each device.
- **Reusing `computer-use-linux`'s portal session:** it holds a keyboard-only RemoteDesktop grant
  without a stream, and restore tokens are single-use, so sharing it would break its persistence.
- **libei/InputCapture:** for capturing input on the host, not injecting it.

The portal session is the only option that works on GNOME, KDE and wlroots with OS-level consent,
needs no extra packages on Ubuntu, and gives frames and input from one grant.

## Windows and macOS

Both stay behind the same route, hub, protocol, control and viewers; only the helper changes.

- **Windows:** a small helper using Windows.Graphics.Capture (or DXGI Desktop Duplication) and
  `SendInput`. Limits to state up front: the secure desktop (UAC prompts, Ctrl+Alt+Del, the lock
  screen) can neither be captured nor driven from the user session; a UAC prompt needs
  "prompt on the normal desktop" or a service running as SYSTEM, which is out of scope. Elevated
  windows reject input from a non-elevated helper (UIPI). There is no OS consent dialog, so the T3
  setting is the only gate; the fork's Windows backend (Windows-MCP) has no stream to reuse.
- **macOS:** ScreenCaptureKit for frames and `CGEventPost` for input, which need the Screen
  Recording and Accessibility permissions. They attach to a stable signed app, which is exactly
  the helper proposed in #18803; the live view would be one of its capabilities. Secure input
  fields still accept posted events; the login window and FileVault unlock do not.

## Evidence

Filled in from the live test on the fork (see the PR/discussion for screenshots):

- Portal versions on the test machines (Ubuntu 24.04, GNOME Shell 46.0): xdg-desktop-portal
  1.18.4, xdg-desktop-portal-gnome 46.2, ScreenCast v5, RemoteDesktop v2, PipeWire 1.0.5,
  GStreamer 1.24.2 with `pipewiresrc` and `jpegenc`; no H.264 encoder installed.
- Unit tests: `apps/server/src/desktop/DesktopLiveView.test.ts` (keysyms, fan-out, consent and
  refusal states, input only from the controller, hand-back on disconnect, agent refused during
  takeover and drained before the person's first input).
