// Generated from the portal helper source; keep it free of backticks and dollar-brace.
/**
 * Python helper for the desktop live view on Linux. It holds one xdg-desktop-portal RemoteDesktop
 * session with a monitor stream (one consent, kept with a restore token), encodes frames to JPEG
 * with GStreamer, and injects pointer and keyboard input. Ubuntu desktops ship everything it needs:
 * python3-gi, gir1.2-gstreamer-1.0, gstreamer1.0-pipewire and gstreamer1.0-plugins-good.
 */
export const DESKTOP_LIVE_VIEW_PORTAL_SCRIPT = String.raw`"""T3 desktop live view: one xdg-desktop-portal RemoteDesktop session with a monitor stream.

stdout: frames of [u32 big-endian length][u8 kind][payload]; kind F is a JPEG, J is JSON status.
stdin: one JSON input command per line. The portal restore token goes only to the token file.
"""

import json
import os
import struct
import sys
import threading

LOCK = threading.Lock()


def emit(kind, payload):
    with LOCK:
        try:
            sys.stdout.buffer.write(struct.pack(">IB", len(payload), kind) + payload)
            sys.stdout.buffer.flush()
        except (BrokenPipeError, ValueError):
            os._exit(0)


def status(message):
    emit(0x4A, json.dumps(message).encode())


try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gio, GLib, Gst
except Exception:
    status({"type": "error", "code": "missing-gstreamer-python"})
    sys.exit(2)

Gst.init(None)
for element in ("pipewiresrc", "jpegenc", "videoscale", "videoconvert", "videorate", "appsink"):
    if Gst.ElementFactory.find(element) is None:
        status({"type": "error", "code": "missing-element", "element": element})
        sys.exit(2)

TOKEN_PATH = sys.argv[1]
MAX_WIDTH, MAX_HEIGHT, QUALITY, FPS = (int(value) for value in sys.argv[2:6])
MODE = sys.argv[6] if len(sys.argv) > 6 else ""
CHECK_ONLY = MODE == "--check"
# A moving test pattern instead of the screen, for checking T3 end to end without the compositor.
# A click toggles the pattern, so input-to-frame latency shows in the stream.
TEST_SOURCE = MODE == "--test-source"

DESKTOP = "org.freedesktop.portal.Desktop"
DESKTOP_PATH = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
SCREEN = "org.freedesktop.portal.ScreenCast"
KEYBOARD, POINTER, MONITOR, CURSOR_EMBEDDED, PERSIST_UNTIL_REVOKED = 1, 2, 1, 2, 2
BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112}

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
sender = bus.get_unique_name()[1:].replace(".", "_")
loop = GLib.MainLoop()
requests = [0]
state = {"session": None, "node": None, "pipeline": None, "closing": False}
pressed_keys = set()
pressed_buttons = set()
wheel = [0.0, 0.0]


def call(interface, method, signature, values, path=DESKTOP_PATH):
    return bus.call_sync(
        DESKTOP, path, interface, method, GLib.Variant(signature, values),
        None, Gio.DBusCallFlags.NONE, -1, None,
    )


def request(interface, method, signature, build):
    """Calls a portal method that answers through a Request object, and waits for it."""
    requests[0] += 1
    token = "t3live%d_%d" % (os.getpid(), requests[0])
    path = "%s/request/%s/%s" % (DESKTOP_PATH, sender, token)
    answer = {}

    def on_response(_bus, _sender, _path, _interface, _signal, parameters):
        answer["code"], answer["results"] = parameters.unpack()
        loop.quit()

    subscription = bus.signal_subscribe(
        DESKTOP, "org.freedesktop.portal.Request", "Response", path, None,
        Gio.DBusSignalFlags.NONE, on_response,
    )
    call(interface, method, signature, build({"handle_token": GLib.Variant("s", token)}))
    loop.run()
    bus.signal_unsubscribe(subscription)
    return answer["code"], answer["results"]


def save_token(token):
    directory = os.path.dirname(TOKEN_PATH)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    temporary = "%s.%d.tmp" % (TOKEN_PATH, os.getpid())
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(token)
    os.replace(temporary, TOKEN_PATH)


def read_token():
    try:
        with open(TOKEN_PATH) as handle:
            return handle.read().strip() or None
    except OSError:
        return None


def notify(method, signature, values):
    if state["session"] is None or state["closing"]:
        return
    try:
        call(REMOTE, method, signature, values)
    except GLib.Error:
        pass


def key(keysym, down):
    if down:
        pressed_keys.add(keysym)
    elif keysym in pressed_keys:
        pressed_keys.discard(keysym)
    else:
        return
    notify("NotifyKeyboardKeysym", "(oa{sv}iu)", (state["session"], {}, keysym, 1 if down else 0))


def button(name, down):
    code = BUTTONS.get(name)
    if code is None or (down == (code in pressed_buttons)):
        return
    (pressed_buttons.add if down else pressed_buttons.discard)(code)
    notify("NotifyPointerButton", "(oa{sv}iu)", (state["session"], {}, code, 1 if down else 0))


def release_all():
    for keysym in list(pressed_keys):
        key(keysym, False)
    for name, code in BUTTONS.items():
        if code in pressed_buttons:
            button(name, False)


def scroll(dx, dy):
    # Browsers report about 100 per wheel notch; a notch is one discrete step here.
    for axis, delta in ((0, dy), (1, dx)):
        wheel[axis] += delta
        steps = int(wheel[axis] / 100)
        if steps:
            wheel[axis] -= steps * 100
            notify("NotifyPointerAxisDiscrete", "(oa{sv}ui)", (state["session"], {}, axis, steps))


def handle(message):
    kind = message.get("t")
    if TEST_SOURCE:
        source = state["pipeline"].get_by_name("source") if state["pipeline"] else None
        if kind == "button" and message.get("down") and source is not None:
            # videotestsrc patterns: 1 snow, 18 ball.
            source.set_property("pattern", 1 if int(source.get_property("pattern")) != 1 else 18)
        return
    if kind == "move":
        notify(
            "NotifyPointerMotionAbsolute", "(oa{sv}udd)",
            (state["session"], {}, state["node"], float(message["x"]), float(message["y"])),
        )
    elif kind == "button":
        button(message.get("b"), bool(message.get("down")))
    elif kind == "wheel":
        scroll(float(message.get("dx", 0)), float(message.get("dy", 0)))
    elif kind == "key":
        key(int(message["keysym"]), bool(message.get("down")))
    elif kind == "release":
        release_all()


def read_input():
    for line in sys.stdin.buffer:
        try:
            handle(json.loads(line))
        except (ValueError, KeyError, TypeError):
            continue
    GLib.idle_add(shutdown)


def shutdown(*_args):
    if state["closing"]:
        return False
    release_all()
    state["closing"] = True
    if state["pipeline"] is not None:
        state["pipeline"].set_state(Gst.State.NULL)
    if state["session"] is not None:
        try:
            bus.call_sync(
                DESKTOP, state["session"], "org.freedesktop.portal.Session", "Close", None,
                None, Gio.DBusCallFlags.NONE, 2000, None,
            )
        except GLib.Error:
            pass
    loop.quit()
    return False


def on_sample(sink):
    sample = sink.emit("pull-sample")
    if sample is None:
        return Gst.FlowReturn.OK
    buffer = sample.get_buffer()
    ok, info = buffer.map(Gst.MapFlags.READ)
    if ok:
        data = bytes(info.data)
        buffer.unmap(info)
        emit(0x46, data)
    return Gst.FlowReturn.OK


def on_bus_message(_bus, message):
    if message.type == Gst.MessageType.ERROR:
        error, _debug = message.parse_error()
        status({"type": "error", "code": "pipeline", "element": message.src.get_name(), "detail": error.message[:300]})
        shutdown()
    elif message.type == Gst.MessageType.EOS:
        shutdown()


def run_pipeline(source, width, height):
    pipeline = Gst.parse_launch(
        source
        # Scale before converting: on a 4K screen that is a quarter of the pixels to convert.
        + " ! videorate drop-only=true max-rate=%d ! videoscale n-threads=4"
        " ! video/x-raw,width=[1,%d],height=[1,%d],pixel-aspect-ratio=1/1"
        " ! videoconvert n-threads=4 ! video/x-raw,format=I420 ! jpegenc quality=%d ! appsink name=sink emit-signals=true max-buffers=1 drop=true sync=false"
        % (FPS, MAX_WIDTH, MAX_HEIGHT, QUALITY)
    )
    state["pipeline"] = pipeline
    pipeline.get_by_name("sink").connect("new-sample", on_sample)
    pipeline_bus = pipeline.get_bus()
    pipeline_bus.add_signal_watch()
    pipeline_bus.connect("message", on_bus_message)
    pipeline.set_state(Gst.State.PLAYING)
    status({"type": "ready", "width": width, "height": height, "keyboard": True, "pointer": True})
    threading.Thread(target=read_input, daemon=True).start()
    loop.run()
    return 0


def main():
    if TEST_SOURCE:
        return run_pipeline(
            "videotestsrc name=source is-live=true pattern=ball"
            " ! video/x-raw,format=BGRx,width=3840,height=2160,framerate=10/1",
            3840,
            2160,
        )
    code, results = request(
        REMOTE, "CreateSession", "(a{sv})",
        lambda options: (dict(options, session_handle_token=GLib.Variant("s", "t3live%d" % os.getpid())),),
    )
    if code != 0:
        status({"type": "error", "code": "create-session"})
        return 3
    state["session"] = results["session_handle"]
    bus.signal_subscribe(
        DESKTOP, "org.freedesktop.portal.Session", "Closed", state["session"], None,
        Gio.DBusSignalFlags.NONE, lambda *_args: (status({"type": "closed"}), shutdown()),
    )
    token = read_token()
    devices = {
        "types": GLib.Variant("u", KEYBOARD | POINTER),
        "persist_mode": GLib.Variant("u", PERSIST_UNTIL_REVOKED),
    }
    if token:
        devices["restore_token"] = GLib.Variant("s", token)
    code, _ = request(
        REMOTE, "SelectDevices", "(oa{sv})", lambda options: (state["session"], dict(options, **devices))
    )
    if code != 0:
        status({"type": "error", "code": "select-devices"})
        return 3
    code, _ = request(
        SCREEN, "SelectSources", "(oa{sv})",
        lambda options: (
            state["session"],
            dict(
                options,
                types=GLib.Variant("u", MONITOR),
                multiple=GLib.Variant("b", False),
                cursor_mode=GLib.Variant("u", CURSOR_EMBEDDED),
            ),
        ),
    )
    if code != 0:
        status({"type": "error", "code": "select-sources"})
        return 3
    if CHECK_ONLY:
        status({"type": "checked", "restorable": token is not None})
        shutdown()
        return 0
    status({"type": "consent", "restorable": token is not None})
    code, results = request(
        REMOTE, "Start", "(osa{sv})", lambda options: (state["session"], "", options)
    )
    if code != 0:
        status({"type": "denied" if code == 1 else "error", "code": "start"})
        return 3
    if results.get("restore_token"):
        save_token(results["restore_token"])
    streams = results.get("streams") or []
    if not streams or (results.get("devices", 0) & POINTER) == 0:
        status({"type": "error", "code": "no-stream"})
        shutdown()
        return 3
    node, properties = streams[0]
    state["node"] = node
    width, height = properties.get("size", (0, 0))
    reply, fds = bus.call_with_unix_fd_list_sync(
        DESKTOP, DESKTOP_PATH, SCREEN, "OpenPipeWireRemote",
        GLib.Variant("(oa{sv})", (state["session"], {})), GLib.VariantType("(h)"),
        Gio.DBusCallFlags.NONE, -1, None, None,
    )
    descriptor = fds.get(reply.unpack()[0])
    # Plain memory only: offered DMA-BUF formats send Mutter down its modifier path. Not enough on
    # its own: GNOME Shell 46 still crashes at stream start on GPUs without DRM format modifiers
    # (AMD GCN3, Radeon R9 M395X); see docs/desktop-live-view.md.
    return run_pipeline(
        "pipewiresrc fd=%d path=%d do-timestamp=true always-copy=true"
        " ! video/x-raw,format={BGRx,BGRA,RGBx,RGBA}" % (descriptor, node),
        width,
        height,
    )


if __name__ == "__main__":
    try:
        exit_code = main()
    except GLib.Error as error:
        status({"type": "error", "code": "dbus", "domain": error.domain})
        exit_code = 3
    sys.stdout.flush()
    os._exit(exit_code)
`;
