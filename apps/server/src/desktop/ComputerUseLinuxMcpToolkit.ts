import { McpCapabilityUnavailableError, OrchestratorMcpFailure } from "@t3tools/contracts";
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

const closeSession = (session: { readonly close: () => Promise<void> }) =>
  Effect.tryPromise({
    try: () => session.close(),
    catch: () => new ComputerUseLinuxToolError({ reason: "Desktop session cleanup failed." }),
  }).pipe(Effect.orDie);

const handlers = {
  computer_use_linux: McpToolAccess.actsAsCaller((input) =>
    McpInvocationContext.requireThreadMcpCapability("desktop").pipe(
      Effect.andThen(
        Effect.acquireUseRelease(
          startComputerUseLinuxForCurrentMcpInvocation(),
          (session) =>
            Effect.tryPromise({
              try: () =>
                session.callTool({
                  arguments: input.arguments,
                  toolName: input.toolName,
                }),
              catch: () => new ComputerUseLinuxToolError({ reason: "Desktop operation failed." }),
            }),
          closeSession,
        ),
      ),
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
