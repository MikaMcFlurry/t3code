import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { AuthPreviewOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import * as DesktopLiveView from "./DesktopLiveView.ts";

const DESKTOP_STREAM_ROUTE_PREFIX = "/api/desktop-stream";
/** The server does not offer a live view: turned off, or no supported desktop. */
const UNAVAILABLE_CODE = 4404;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const textDecoder = new TextDecoder();

const parseMessage = (chunk: Uint8Array | string): unknown => {
  try {
    return JSON.parse(typeof chunk === "string" ? chunk : textDecoder.decode(chunk));
  } catch {
    return null;
  }
};

const isAck = (message: unknown) =>
  typeof message === "object" && message !== null && "type" in message && message.type === "ack";

/**
 * The live view speaks the preview stream's protocol (JPEG binary frames acknowledged with
 * `ack`, `viewport` and `control` messages, the same mouse and key input), so the web canvas and
 * the mobile WebView reuse their viewer. `desktop` messages add the capture's state.
 */
const makeHandler = Effect.fnUntraced(function* (
  liveView: DesktopLiveView.DesktopLiveView["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  if (
    url.value.pathname !== `${DESKTOP_STREAM_ROUTE_PREFIX}/ws` ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  // The whole screen is more than one preview tab: watching needs the operate scope too.
  yield* authenticateMediaRequest(AuthPreviewOperateScope);
  const canOperate = url.value.searchParams.get("interactive") !== "false";
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const attached = yield* liveView.attachViewer({ canOperate }).pipe(
        Effect.map((viewer) => ({ _tag: "attached" as const, viewer })),
        Effect.catchTags({
          DesktopLiveViewUnavailableError: (error) =>
            Effect.succeed({ _tag: "unavailable" as const, message: error.message }),
        }),
      );
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      // JPEGs are already compressed; without deflate all pending writes sit in the socket
      // buffer bounded below.
      delete incoming.headers["sec-websocket-extensions"];
      const transport = incoming.socket;
      const socket = yield* request.upgrade;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      if (attached._tag === "unavailable") {
        yield* writer.write(new Socket.CloseEvent(UNAVAILABLE_CODE, attached.message));
        return HttpServerResponse.empty();
      }
      const viewer = attached.viewer;
      // One frame on the wire per viewer and only the newest waiting, so a slow phone skips
      // frames instead of falling behind, and input replies never queue behind images.
      let inFlight = false;
      let pending: Uint8Array | null = null;
      const write = (data: Uint8Array | string) =>
        Effect.suspend(() => {
          const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          if (transport.writableLength + bytes + 14 > MAX_SOCKET_BUFFER_BYTES) {
            return Effect.sync(() => transport.destroy()).pipe(Effect.andThen(Effect.interrupt));
          }
          return writer.write(data);
        });
      const sendFrame = (data: Uint8Array) => {
        inFlight = true;
        return write(data);
      };
      const sendOutput = Queue.take(viewer.output).pipe(
        Effect.flatMap((output) => {
          if (output._tag === "frame") {
            if (!inFlight) return sendFrame(output.data);
            pending = output.data;
            return Effect.void;
          }
          const { _tag: type, ...data } = output;
          return write(
            JSON.stringify(
              type === "control" ? { type, ...data, dialog: null } : { type, ...data },
            ),
          );
        }),
      );
      const receive = Effect.fnUntraced(function* (chunk: Uint8Array | string) {
        const message = parseMessage(chunk);
        if (!isAck(message)) {
          return yield* canOperate
            ? viewer.input(message).pipe(Effect.forkScoped, Effect.asVoid)
            : Effect.void;
        }
        const next = pending;
        inFlight = false;
        pending = null;
        return yield* next ? sendFrame(next) : Effect.void;
      });
      const receiveInput = reader.pull.pipe(
        Effect.flatMap((chunks) => Effect.forEach(chunks, receive, { discard: true })),
      );
      return yield* Effect.raceFirst(Effect.forever(sendOutput), Effect.forever(receiveInput));
    }),
  ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));
});

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const liveView = yield* DesktopLiveView.DesktopLiveView;
    yield* router.add("GET", `${DESKTOP_STREAM_ROUTE_PREFIX}/*`, makeHandler(liveView));
  }),
);
