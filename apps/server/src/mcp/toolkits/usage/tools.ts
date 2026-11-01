import { OrchestratorMcpFailure, UsageResetForecastEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const IsoOrNull = Schema.NullOr(Schema.String);

export const UsageResetPlanResult = Schema.Struct({
  staggering: Schema.Boolean,
  groups: Schema.Array(
    Schema.Struct({
      driver: Schema.String,
      accounts: Schema.Array(
        Schema.Struct({
          instanceId: Schema.String,
          name: Schema.String,
          state: Schema.Literals(["running", "idle", "unknown"]),
          sessionResetAt: IsoOrNull,
          weeklyResetAt: IsoOrNull,
          plannedStartAt: IsoOrNull,
          bankedResets: Schema.NullOr(
            Schema.Struct({
              count: Schema.Number,
              nextExpiresAt: IsoOrNull,
              expiresBeforeWeeklyReset: Schema.Boolean,
            }),
          ),
        }),
      ),
    }),
  ),
  forecast: Schema.Array(UsageResetForecastEntry),
});

const ForecastInput = Schema.Struct({
  driver: Schema.String.annotate({ description: "Provider driver: codex, claudeAgent, cursor…" }),
  kind: UsageResetForecastEntry.fields.kind,
  expectedAt: Schema.String.annotate({
    description: "ISO 8601 time the reset is expected or announced for.",
  }),
  confidence: UsageResetForecastEntry.fields.confidence.annotate({
    description:
      "1 for an official announcement, about 0.5 for credible reports, lower for rumors.",
  }),
  source: Schema.optional(Schema.String.annotate({ description: "URL of the evidence." })),
  note: Schema.optional(Schema.String),
});

const PlanTool = Tool.make("t3_usage_reset_plan", {
  description:
    "Read every account's session and weekly reset times, banked resets with expiry, the staggering plan and the recorded reset forecast. Use it before recording forecasts to avoid duplicates.",
  parameters: Tool.EmptyParams,
  success: UsageResetPlanResult,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
  ],
})
  .annotate(Tool.Title, "Read usage reset plan")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ForecastAddTool = Tool.make("t3_usage_forecast_add", {
  description:
    "Record an expected usage reset, such as a provider resetting everyone's limits, so automatic routing uses that provider's quota before it resets. Record only resets backed by a source; an entry for the same provider, kind and day replaces the older one.",
  parameters: ForecastInput,
  success: UsageResetPlanResult,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
  ],
})
  .annotate(Tool.Title, "Record usage reset forecast")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ForecastRemoveTool = Tool.make("t3_usage_forecast_remove", {
  description: "Remove a recorded usage reset forecast entry that turned out to be wrong.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: UsageResetPlanResult,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
  ],
})
  .annotate(Tool.Title, "Remove usage reset forecast")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const UsageToolkit = Toolkit.make(PlanTool, ForecastAddTool, ForecastRemoveTool);
