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

- Live frames to every client, acked so slow links skip frames: `/api/preview-stream`
  (`ServerBrowserStream.ts`).
- Who drives, and pausing the agent: `SessionControl` (`preview/SessionControl.ts`).
- Canvas viewer with mouse, touch, keyboard, IME and paste: `ServerBrowserSurface` (web),
  `PreviewStreamWebView` with `preview-stream.browser.ts` (mobile).
- Media auth for canvas and WebSocket over T3 Connect: `wsTicket` (`resolveDeviceHubAccess`,
  `authenticateMediaRequest`).
- Desktop backends, approvals, host lease: `ComputerUseLinux*` (fork).

The live view adds a capture source and one route; it does not add a new viewer.

Related upstream work it should line up with rather than duplicate: draft #16531 floats the window
a computer-use agent drives over the chat, polling it every 1.5 s through Cua's
`get_window_state` (web and desktop, watch only); draft #28050 lets Claude and Codex drive remote
desktops through agentcast's MCP (agent input only, refuses on UAC). Neither gives a person a live
view with takeover on every client, and both could feed the same viewer: #16531's frames for a
single window, this route for the whole screen.

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
  every start into the server's state directory (a fresh `0600` file in a `0700` directory,
  renamed into place and read without following links; never logged or sent to a client).
- **Frames.** `pipewiresrc` → plain-memory caps → `videorate` (max 10 fps) → scale to at most
  1920×1080 → convert → `jpegenc` (q 60) → `appsink`. Scaling before converting handles a quarter
  of the pixels on a 4K screen. Mutter only sends frames on damage, so an idle screen costs nothing.
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
- new: `{"type":"desktop","state":"unverified|starting|consent|streaming|denied|ended|unavailable","detail"?}`.
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
- **Who may watch and drive.** Its own scope, `desktop:operate` ("Watch and control the
  desktop"), which no standard client grant includes: enabling the setting does not turn existing
  preview or Connect grants into whole-screen access. The pairing dialog only offers permissions
  the current session holds, so the first such client is bootstrapped on the machine itself with
  the CLI. `--scope` replaces the defaults, so list every permission that client needs; this
  reduced example keeps threads, settings, previews and pairing: `t3 auth pairing create --scope
  orchestration:read --scope orchestration:operate --scope settings:write --scope preview:operate
  --scope access:read --scope access:write --scope desktop:operate`. Pairing others needs
  `access:write`, so that client can then pass the permission on through the pairing dialog. `interactive=false` narrows a socket further to
  watching. This also answers the concern in
  #32098 that cloud authorization alone can reach a machine.
- **Revocation and switch-off.** A revoked or expired session loses its socket at once (the route
  races it against `SessionStore.awaitInvalidation`, as #32245 does for preview streams). Turning
  the setting off closes every open viewer and stops the capture, and `reload` cannot restart it.
  Server shutdown is final the same way: a start still claiming the capture gives it back without
  spawning, and the desktop lease goes back once the helper has exited.
- **Who starts the capture.** The first viewer does, read-only ones included, since watching needs
  it; where no restore token exists that shows the portal dialog on the machine, and on an
  unverified login nothing starts until an operating viewer confirms. `reload` (also **Start screen
  sharing anyway** and **Try again**) is accepted only from viewers that may operate, all of whom
  already hold `desktop:operate`. Clients show the entry points only where the setting is on and
  the session holds that scope.
- **Who may drive.** One viewer at a time, as with preview tabs: `takeControl` fails while another
  viewer holds control, and a viewer that disconnects (phone locked, tab closed) hands control
  back. Taking control also takes the host-wide desktop lease that agents of every T3 server on
  this OS login take for each call, so a second server's agent cannot act during a takeover either.
  Takeovers, hand-backs, disconnects and switch-off run one at a time, each to completion, and a
  takeover rechecks after every wait, so a viewer that left or a switch-off cancels it and the
  lease goes back.
- **Bounded input.** At most 64 input messages per viewer in flight, text in batches of up to 1000
  characters, wheel deltas clamped, and the helper's input pipe capped at 256 KB (releases always
  pass). At most 8 viewers per machine.
- **Passwords.** While a person holds control, every mediated agent desktop call is refused,
  observation included, so T3's desktop tools return no screenshot to a model while a password or
  code is on screen. (Tools outside T3's mediation, such as a provider's own computer use, are not
  covered.) The server
  never stores or logs frames or input; input messages are not traced. On the phone, the text
  field is masked by default. Typed text goes to whatever field has focus on the machine, like a
  physical keyboard.
- **Child process.** The helper gets an allowlisted environment (session bus, display, `HOME`,
  `PATH`, locale), no T3 secrets, and only the stdin/stdout pipes.
- **Not done in the prototype:** an audit line per viewer (who watched, who drove, when) and a
  per-viewer "watching" notice on the machine.

## Agent behaviour during a takeover

- `takeControl` reserves control immediately; desktop calls that are already running finish
  before the person's first input is applied (the drain is queued inside the ownership change).
- A call that starts while a person holds control fails with a server-authored message the agent
  sees: _"A person is using this desktop through T3's live view. Wait until they hand it back,
  then take a new screenshot before acting."_ It runs after the approval card, so an approval
  answered during the takeover still acts on nothing. Agent calls are not serialized by this
  gate; the host lease keeps its existing busy semantics.
- Handing back keeps agents out until the person's held keys and buttons are released: the hub
  asks the helper to release everything and waits for its acknowledgement, which reports whether
  the portal took every release (a release the portal refused stays tracked and is retried, and
  one asked for while the helper is already closing reports failure).
  Without a clean acknowledgement within 1.5 s the capture ends, and agents return only once the
  helper has exited, since its portal session and every key it held go with it. The same holds
  for a helper stopped for any other reason (switch-off, a capture error, server shutdown): the
  desktop lease goes back only after that process is gone.
- The agent's turn itself keeps running; only its desktop calls are refused until hand-back.
- After that the next call runs normally. The agent is told to take a new screenshot because the
  screen changed under it.
- Next step (not in this prototype): `request_human_takeover` (reason, optional hint), modelled on
  `request_secret`: a card in the thread with **Open live view** and **Done**, a phone push that
  deep-links to the live view (`?desktopLiveView=…` on web, `settings/environments/:id/desktop`
  on mobile), and the tool call returning when the person presses **Done** or releases control.
  Desktop approvals and this request should also reach the phone, which today only sees runtime
  requests (`AgentAwarenessRelay`).

## GNOME Shell crash on GPUs without DRM format modifiers

The live test hit a GNOME bug that decides the Linux plan. On Ubuntu 24.04 with GNOME Shell 46.0,
mutter 46.2-1ubuntu0.24.04.18 and an AMD Radeon R9 M395X (GCN3, `amdgpu`), **every** portal screen
stream made GNOME Shell crash with SIGSEGV as the stream started, right after mutter logged
"Couldn't retrieve the supported modifiers" (`meta_screen_cast_query_modifiers` finds no modifiers
for the format and falls back to the implicit one). A Wayland compositor crash ends the graphical
session; the T3 server, a user service, kept running. It happened three times: at the first start
after consent, in a standalone helper run, and after forcing plain-memory caps on the consumer
(which does remove every DMA-BUF and modifier offer, checked against a test PipeWire node, but the
crash is on mutter's side). The journals of both test machines show no other shell crash since
2026-11-01; T3's agent desktop toolkit never opens a screen stream there (`CU_DISABLE_ABS_POINTER`).
OBS or a browser sharing the screen would most likely hit the same crash on that hardware.

Consequences:

- **Crash guard, per OS login and fail-closed.** Markers live in
  `~/.local/state/t3code/desktop-live-view/` under the home directory from the account database,
  not `$HOME` or `$XDG_STATE_HOME` (the host lease finds its key the same way), so every T3 server
  and checkout on the login shares them whatever its environment. The directory is kept at `0700`
  and each marker is written to a fresh file and renamed into place, and one capture lock per login, held until the helper process
  has exited, keeps two servers from sharing at once. Once it holds the lock a server checks
  `crashed` and `starting` again, since another server may have recorded a crash meanwhile.
  `starting` is written before the stream starts and removed once a frame arrived, the attempt
  ended harmlessly (refused at the machine, failed before the portal's Start) or its crash is on
  disk; a `starting` left behind therefore counts as a crash, and it stays when `crashed` cannot be
  written. An attempt that ends after Start without a frame writes `crashed`, and the server also
  latches in memory. If the `starting` marker cannot be written, the share does not start. A server
  killed before the first frame leaves `starting` too, which then refuses on purpose. Deleting
  `crashed` (and a stale `starting`) re-enables it.
- **Warning before the first share.** Until a share has produced a frame on this login
  (`verified`), viewers see the risk spelled out and must press **Start screen sharing anyway**;
  nothing starts on its own.
- **Fallback capture, next step, to be verified.** For such hosts: frames from screenshots at 1–3
  fps and input through a RemoteDesktop session _without_ a screen stream. Open points: GNOME 46
  only lets allowlisted callers use `org.gnome.Shell.Screenshot` directly, so frames would come
  through `gnome-screenshot` (as the agent toolkit does on these machines) or the Screenshot
  portal; and without a stream there is only relative pointer motion, so the viewer needs a
  trackpad-style mode or cursor feedback rather than absolute clicks. Enough for a password or a
  captcha; it needs its own one-time consent.
- **Upstream GNOME.** The crash deserves a mutter report with the trace; T3 should not paper over it.
- **Test source.** `T3CODE_DESKTOP_LIVE_VIEW_TEST_SOURCE=1` makes the helper stream a moving 4K test
  pattern instead (a click toggles the pattern), so the whole T3 side can be checked end to end on a
  machine whose compositor must not be touched.

## Several viewers and bandwidth

- One capture per machine, any number of viewers. Each viewer has at most one frame in flight and
  keeps only the newest waiting frame, so a slow phone over T3 Connect skips frames instead of
  building a backlog, and control and state messages never wait behind images.
- A late viewer starts from the last frame. Idle screens send nothing.
- Measured numbers are in the evidence section below (about 0.3 MB/s at 10 fps for a simple
  screen on the LAN). If JPEG proves too heavy over T3 Connect,
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
- **libei:** a real alternative for the input half. RemoteDesktop v2 can hand out an EIS
  connection (`ConnectToEIS`) for emulated input; worth adopting where the portal offers it. The
  InputCapture portal is the other direction (capturing the host's input) and does not apply.

On GNOME and KDE the RemoteDesktop portal gives frames and input from one grant with OS-level
consent and needs no extra packages on Ubuntu. Plain `xdg-desktop-portal-wlr` implements
ScreenCast and Screenshot but not RemoteDesktop, so wlroots compositors would get a view without
input; the helper should probe the portal interfaces and report what it can do.

## Windows and macOS

Both stay behind the same route, hub, protocol, control and viewers; only the helper changes.

- **Windows:** a small helper using DXGI Desktop Duplication, or Windows.Graphics.Capture through
  its monitor interop (`CreateForMonitor`), which skips the user-facing picker but draws a capture
  border where the system requires one; input through `SendInput`. Neither path asks the person
  for consent, so the T3 setting and scope are the gates. Limits to state up front: the secure
  desktop (UAC prompts, Ctrl+Alt+Del, the lock screen) can neither be captured nor driven from the
  user session, and elevated windows reject input from a non-elevated helper (UIPI); the helper
  should report both as explicit "unavailable" states. A UAC prompt needs "prompt on the normal
  desktop" or a SYSTEM service, which is out of scope. The helper must be per-monitor DPI aware
  (v2), or capture size and `SendInput` coordinates disagree on scaled displays, and it needs an
  active interactive session: after an RDP client disconnects, or before anyone logs in, there is
  no input desktop to capture or drive. The fork's Windows backend (Windows-MCP) has no stream to
  reuse.
- **macOS:** ScreenCaptureKit for frames and `CGEventPost` for input, which need the Screen
  Recording and Accessibility permissions. Those attach to the identity of the process that does
  the capture and posting, so both must run inside a stable signed GUI helper, which is exactly
  the helper proposed in #18803; signing alone grants nothing to other subprocesses. Secure Event
  Input mainly stops other processes from observing keystrokes, so posted events are expected to
  reach ordinary password fields, but apps that turn it on may behave differently and that needs
  testing (the helper can check `IsSecureEventInputEnabled()`); the login window and FileVault
  unlock are out of reach. Typing uses `CGEventKeyboardSetUnicodeString` rather than keysyms.

## Evidence (2026-11-07)

Verified:

- Unit tests (`apps/server/src/desktop/DesktopLiveView.test.ts`, 33 tests, plus the existing bridge
  tests): keysyms, fan-out, consent and refusal states, input only from the controller, hand-back on
  disconnect, agent refused during a takeover and drained before the person's first input, crash
  guard, release acknowledgement before agents return, host lease held while a person drives,
  modifier masks, wheel clamping, switch-off closing every viewer, the login capture guard with
  its markers (crash recheck under the lock, marker kept when the crash cannot be written), and
  takeovers cancelled by a disconnect or switch-off; the lease returned only after a stopped helper
  exited.
- Typecheck of server, contracts, client-runtime, web and mobile.
- On the real GNOME desktop: the consent dialog appears once on the machine, the restore token is
  written (`0600`) and the next start restores silently; the helper stops 20 s after the last viewer.
  Frames: **not** shown, because of the crash above.
- End to end with the test source, on the test machine over the LAN (headless Chromium on Windows
  through an SSH tunnel to the server): the web dialog (opened by its deep link) streams the
  3840×2160 coordinate space; Take control → `you`, Release → `agent`; while the web app at phone
  size holds control the desktop viewer shows "another viewer"; the mobile app's own WebView script
  (`preview-stream.browser.ts`, bundled as for the app) streams, takes control and sends taps and
  text. Click to changed frame: web median 211 ms (p90 242, n=12), mobile WebView median 202 ms
  (p90 251, n=10), including up to 100 ms of the 10 fps test source. Frame rate ~9.9 fps at
  ~325 KB/s with the simple pattern (1920×1080 JPEG q60; a busy screen costs more per frame).

Not verified yet:

- Frames and input on a real desktop (needs the fallback capture on the test hardware, or other
  hardware).
- An agent turn paused live by a takeover (covered by unit tests only).
- The native iOS/Android apps (their WebView code ran in Chromium, not in WKWebView or a device).
- T3 Connect relay bandwidth (tested on the LAN).

Environment:

- Portal versions on the test machines (Ubuntu 24.04, GNOME Shell 46.0): xdg-desktop-portal
  1.18.4, xdg-desktop-portal-gnome 46.2, ScreenCast v5, RemoteDesktop v2, PipeWire 1.0.5,
  GStreamer 1.24.2 with `pipewiresrc` and `jpegenc`; no H.264 encoder installed.
