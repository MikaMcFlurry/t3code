import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import {
  mergeUsageResetForecast,
  planUsageResets,
  type ResetPlan,
} from "@t3tools/shared/resetPlanner";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { UsageToolkit, type UsageResetPlanResult } from "./tools.ts";

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const iso = (at: number | null) =>
  at === null ? null : DateTime.formatIso(DateTime.makeUnsafe(at));

function toResult(plan: ResetPlan): typeof UsageResetPlanResult.Type {
  return {
    staggering: plan.staggering,
    forecast: plan.forecast,
    groups: plan.groups.map((group) => ({
      driver: group.driver,
      accounts: group.accounts.map((account) => ({
        instanceId: account.instanceId,
        name: account.name,
        state: account.state,
        sessionResetAt: iso(account.sessionResetAt),
        weeklyResetAt: iso(account.weeklyResetAt),
        plannedStartAt: iso(account.plannedStartAt),
        bankedResets: account.credits
          ? {
              count: account.credits.count,
              nextExpiresAt: iso(account.credits.expiresAt),
              expiresBeforeWeeklyReset: account.credits.expiresFirst,
            }
          : null,
      })),
    })),
  };
}

const planFor = Effect.fn("UsageToolkit.planFor")(function* (settings: ServerSettings) {
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  return toResult(planUsageResets({ providers, settings, now }));
});

const invalidDate = new OrchestratorMcpFailure({
  code: "invalid_request",
  message: "expectedAt must be an ISO 8601 date and time.",
});

const invalidSource = new OrchestratorMcpFailure({
  code: "invalid_request",
  message: "source must be an http(s) URL.",
});

const currentPlan = ServerSettingsService.ServerSettingsService.pipe(
  Effect.flatMap((service) => service.getSettings),
  Effect.flatMap(planFor),
  Effect.mapError(toFailure),
);

const addForecast = Effect.fn("UsageToolkit.addForecast")(function* (input: {
  readonly driver: string;
  readonly kind: ServerSettings["usageResetForecast"][number]["kind"];
  readonly expectedAt: string;
  readonly confidence: number;
  readonly source?: string | undefined;
  readonly note?: string | undefined;
}) {
  const service = yield* ServerSettingsService.ServerSettingsService;
  const settings = yield* service.getSettings;
  const now = yield* DateTime.now;
  const usageResetForecast = mergeUsageResetForecast(
    settings.usageResetForecast,
    {
      driver: input.driver,
      kind: input.kind,
      expectedAt: input.expectedAt,
      confidence: input.confidence,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.note === undefined ? {} : { note: input.note.slice(0, 500) }),
    },
    DateTime.toEpochMillis(now),
    DateTime.formatIso(now),
  );
  return yield* planFor(yield* service.updateSettings({ usageResetForecast }));
}, Effect.mapError(toFailure));

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  t3_usage_reset_plan: McpToolAccess.reads(() => currentPlan),
  t3_usage_forecast_add: McpToolAccess.writes((input) =>
    !Number.isFinite(Date.parse(input.expectedAt))
      ? Effect.fail(invalidDate)
      : input.source !== undefined && !/^https?:\/\//i.test(input.source)
        ? Effect.fail(invalidSource)
        : addForecast(input),
  ),
  t3_usage_forecast_remove: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService.ServerSettingsService;
      const settings = yield* service.getSettings;
      return yield* planFor(
        yield* service.updateSettings({
          usageResetForecast: settings.usageResetForecast.filter((entry) => entry.id !== input.id),
        }),
      );
    }).pipe(Effect.mapError(toFailure)),
  ),
});
