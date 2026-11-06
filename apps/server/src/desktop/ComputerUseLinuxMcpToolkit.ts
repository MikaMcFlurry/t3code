import { McpCapabilityUnavailableError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
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

const ComputerUseLinuxTool = Tool.make("computer_use_linux", {
  description:
    "Use T3's mediated desktop bridge for this machine: computer-use-linux tools (snake_case) on Linux, Windows-MCP tools (PascalCase) on Windows. Observation tools inspect the desktop; interaction tools wait for the user's approval unless their settings grant it standing.",
  parameters: Schema.Struct({
    toolName: ComputerUseLinuxToolName,
    arguments: Schema.optionalKey(Schema.Unknown),
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

/** Optional registration only; it is deliberately not part of McpHttpServer.layerTools. */
export const layer = McpToolAccess.toLayer(ComputerUseLinuxToolkit, handlers);
