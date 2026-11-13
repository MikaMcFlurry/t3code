import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  COMPUTER_USE_LINUX_INTERACTION_TOOLS,
  COMPUTER_USE_LINUX_OBSERVATION_TOOLS,
} from "./ComputerUseLinuxPolicy.ts";
import { ComputerUseLinuxApprovalRevocation } from "./ComputerUseLinuxAvailability.ts";
import {
  ComputerUseLinuxBridgeApprovalError,
  ComputerUseLinuxBridgeRefusedError,
  ComputerUseLinuxBridgeRevokedError,
} from "./ComputerUseLinuxBridge.ts";
import {
  ComputerUseLinuxApprovalSurfaceService,
  ComputerUseLinuxUpstreamFactoryService,
  startComputerUseLinuxForCurrentMcpInvocation,
} from "./ComputerUseLinuxServerIntegration.ts";

const ComputerUseLinuxToolName = Schema.Literals([
  ...COMPUTER_USE_LINUX_OBSERVATION_TOOLS,
  ...COMPUTER_USE_LINUX_INTERACTION_TOOLS,
]);

export class ComputerUseLinuxToolError extends Schema.TaggedError<ComputerUseLinuxToolError>()(
  "ComputerUseLinuxToolError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const isComputerUseLinuxToolError = Schema.is(ComputerUseLinuxToolError);
const isMcpCapabilityUnavailableError = Schema.is(McpCapabilityUnavailableError);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

export const ComputerUseLinuxTool = Tool.make("computer_use_linux", {
  description:
    "Use T3's mediated desktop bridge for this machine: computer-use-linux tools (snake_case) on Linux, Windows-MCP tools (PascalCase) on Windows. Observation tools inspect the desktop; interaction tools wait for the user's approval unless their settings grant it standing.",
  parameters: Schema.Struct({
    toolName: ComputerUseLinuxToolName,
    arguments: Schema.optionalKey(Schema.Unknown),
    includeImage: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Default true: screenshots come back as images. False keeps only their text metadata, for providers that reject images in tool results.",
      }),
    ),
  }),
  success: Schema.Unknown,
  failure: Schema.Union([
    ComputerUseLinuxToolError,
    McpCapabilityUnavailableError,
    OrchestratorMcpFailure,
  ]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerSecretStore.ServerSecretStore,
    ComputerUseLinuxApprovalSurfaceService,
    ComputerUseLinuxUpstreamFactoryService,
    HostProcess.Platform,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Use Linux desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerUseLinuxToolkit = Toolkit.make(ComputerUseLinuxTool);

type DesktopSession = Effect.Success<
  ReturnType<typeof startComputerUseLinuxForCurrentMcpInvocation>
>;

interface KeptSession {
  readonly session: DesktopSession;
  /** The thread's Stop generation the session was opened in; a later Stop retires it. */
  readonly generation: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Calls in flight; the idle countdown only runs while this is zero. */
  active: number;
}

/** An unused desktop session closes after this long; the next call starts a new one. */
const KEPT_SESSION_IDLE_MS = 10 * 60_000;

/**
 * One desktop session per provider session and thread, kept between calls: the backends hold
 * state a later call needs, such as the element labels a Windows-MCP Snapshot resolves for a
 * Click, or cached accessibility handles on Linux. Revocation, Stop, an unexpected failure or
 * idling closes it; the broker closes whatever is left at shutdown.
 */
const keptSessions = new Map<string, KeptSession>();

class ComputerUseLinuxCallError extends Schema.TaggedError<ComputerUseLinuxCallError>()(
  "ComputerUseLinuxCallError",
  { cause: Schema.Defect() },
) {}

function scheduleIdleClose(key: string, entry: KeptSession): void {
  cancelIdleClose(entry);
  if (keptSessions.get(key) !== entry || entry.active > 0) return;
  // @effect-diagnostics-next-line globalTimers:off -- a plain unref'd idle timer outside any fiber.
  entry.idle = setTimeout(() => void closeKeptSession(key, entry), KEPT_SESSION_IDLE_MS);
  entry.idle.unref?.();
}

function cancelIdleClose(entry: KeptSession): void {
  if (entry.idle !== undefined) clearTimeout(entry.idle);
  entry.idle = undefined;
}

const forgetSession = (key: string, entry: KeptSession) => {
  if (keptSessions.get(key) === entry) keptSessions.delete(key);
  cancelIdleClose(entry);
};

const closeKeptSession = (key: string, entry: KeptSession) => {
  forgetSession(key, entry);
  return entry.session.close().catch(() => undefined);
};

const staleCall = () =>
  new ComputerUseLinuxToolError({
    reason:
      "The desktop session ended (Stop, a new session or a revoked approval). Call again to start a new one.",
  });

const keptSession = Effect.fn("ComputerUseLinuxMcpToolkit.keptSession")(function* (
  generation: number,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const scoped = yield* McpInvocationContext.requireThreadScope(invocation, "Computer Use");
  const lifecycle = yield* ComputerUseLinuxApprovalRevocation;
  const threadId = ThreadId.make(scoped.thread.threadId);
  // A call from before the latest Stop may run no desktop action, through any session.
  const current = () => lifecycle.generation(threadId) === generation;
  if (!current()) return yield* staleCall();
  const key = [
    scoped.thread.providerInstanceId,
    scoped.thread.providerSessionId,
    scoped.thread.threadId,
  ].join("\u0000");
  const reusable = (entry: KeptSession | undefined): entry is KeptSession =>
    entry !== undefined && !entry.session.closed && entry.generation === generation;
  const existing = keptSessions.get(key);
  if (reusable(existing)) return { key, entry: existing };
  if (existing !== undefined) yield* Effect.promise(() => closeKeptSession(key, existing));
  const session = yield* startComputerUseLinuxForCurrentMcpInvocation(generation);
  if (!current() || session.closed) {
    yield* Effect.promise(() => session.close().catch(() => undefined));
    return yield* staleCall();
  }
  // A concurrent first call may have kept its own session meanwhile; use one, close the other.
  const raced = keptSessions.get(key);
  if (reusable(raced)) {
    yield* Effect.promise(() => session.close().catch(() => undefined));
    return { key, entry: raced };
  }
  const entry: KeptSession = { session, generation, idle: undefined, active: 0 };
  keptSessions.set(key, entry);
  return { key, entry };
});

const isRefusedError = Schema.is(ComputerUseLinuxBridgeRefusedError);
const isApprovalError = Schema.is(ComputerUseLinuxBridgeApprovalError);
const isRevokedError = Schema.is(ComputerUseLinuxBridgeRevokedError);

/** Server-authored errors reach the agent; anything else may carry desktop output and is generic. */
const toolError = ({ cause }: ComputerUseLinuxCallError) =>
  new ComputerUseLinuxToolError({
    reason:
      isRefusedError(cause) || isApprovalError(cause)
        ? cause.message
        : isRevokedError(cause)
          ? "The desktop session ended (Stop, a new session or a revoked approval). Call again to start a new one."
          : "Desktop operation failed.",
  });

/** The thread's Stop generation, read first thing in the call; only MCP caller checks precede it. */
const callGeneration = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const lifecycle = yield* ComputerUseLinuxApprovalRevocation;
  return invocation.thread === undefined
    ? 0
    : lifecycle.generation(ThreadId.make(invocation.thread.threadId));
});

const handlers = {
  computer_use_linux: McpToolAccess.actsAsCaller((input) =>
    callGeneration.pipe(
      Effect.flatMap((generation) =>
        McpInvocationContext.requireThreadMcpCapability("desktop").pipe(
          Effect.andThen(keptSession(generation)),
        ),
      ),
      Effect.flatMap(({ key, entry }) => {
        entry.active += 1;
        cancelIdleClose(entry);
        return Effect.tryPromise({
          try: () =>
            entry.session.callTool({
              arguments: input.arguments,
              toolName: input.toolName,
            }),
          catch: (cause) => new ComputerUseLinuxCallError({ cause }),
        }).pipe(
          // A refusal or a declined approval leaves the session usable; anything else may have
          // left the backend broken, so the next call starts fresh.
          Effect.tapError(({ cause }) =>
            isRefusedError(cause) || isApprovalError(cause)
              ? Effect.void
              : Effect.promise(() => closeKeptSession(key, entry)),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              entry.active -= 1;
              scheduleIdleClose(key, entry);
            }),
          ),
          Effect.mapError(toolError),
        );
      }),
      Effect.mapError((cause) =>
        isOrchestratorMcpFailure(cause) ||
        isMcpCapabilityUnavailableError(cause) ||
        isComputerUseLinuxToolError(cause)
          ? cause
          : new ComputerUseLinuxToolError({ reason: "Desktop session could not be started." }),
      ),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerUseLinuxToolkit.tools>;

const IMAGE_MIME_TYPE = /^image\/(png|jpeg|webp|gif)$/;
const MAX_FALLBACK_TEXT_CHARS = 20_000;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The upstream MCP result as this server's result. Text and image blocks pass through as blocks,
 * so a screenshot reaches the agent as an image instead of several hundred kilobytes of base64
 * text, and an upstream error stays an error. Other block types are dropped.
 */
export function computerUseLinuxToolResult(
  upstream: unknown,
  includeImage: boolean,
): McpSchema.CallToolResult {
  const result = asRecord(upstream);
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const content: Array<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: Uint8Array; readonly mimeType: string }
  > = [];
  let omittedImages = 0;
  for (const entry of blocks) {
    const block = asRecord(entry);
    if (block?.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (
      block?.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string" &&
      IMAGE_MIME_TYPE.test(block.mimeType)
    ) {
      if (includeImage) {
        content.push({
          type: "image",
          data: new Uint8Array(Buffer.from(block.data, "base64")),
          mimeType: block.mimeType,
        });
      } else {
        omittedImages += 1;
      }
    }
  }
  if (omittedImages > 0) {
    content.push({
      type: "text",
      text: `${omittedImages} image${omittedImages === 1 ? "" : "s"} left out (includeImage: false).`,
    });
  }
  if (content.length === 0) {
    content.push({
      type: "text",
      text: (JSON.stringify(upstream ?? null) ?? "null").slice(0, MAX_FALLBACK_TEXT_CHARS),
    });
  }
  const structuredContent = asRecord(result?.structuredContent);
  return new McpSchema.CallToolResult({
    isError: result?.isError === true,
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  });
}

/** Optional registration only; it is deliberately not part of McpHttpServer.layerTools. */
export const layer = McpToolAccess.toLayer(ComputerUseLinuxToolkit, handlers);

export const __testing = {
  scheduleIdleClose,
  cancelIdleClose,
  keptSessions,
  idleMs: KEPT_SESSION_IDLE_MS,
  /** Closes every kept session, so one test's backend never serves the next. */
  closeKeptSessions: () =>
    Promise.all([...keptSessions.entries()].map(([key, entry]) => closeKeptSession(key, entry))),
};
