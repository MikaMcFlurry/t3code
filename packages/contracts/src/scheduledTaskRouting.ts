import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Imports nothing but base schemas: orchestratorMcp.ts uses it while scheduledTask.ts loads.

export const MAX_SCHEDULED_TASK_ROUTING_CANDIDATES = 16;

const candidates = Schema.Array(TrimmedNonEmptyString).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SCHEDULED_TASK_ROUTING_CANDIDATES),
);
const minUsageLeftPercent = Schema.optional(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

/**
 * Per-task model routing: at run start the first usable candidate with at least
 * `minUsageLeftPercent` left in every window its model uses runs, else the usable one with the
 * most left. Bounded by the allowed-models setting, which it can narrow but never widen.
 */
export const ScheduledTaskModelRouting = Schema.Struct({
  candidates: candidates.annotate({
    description: "Priority order: `instanceId`, `instanceId/model` or `driver:<kind>`.",
  }),
  minUsageLeftPercent: minUsageLeftPercent.annotate({
    description: "Skip candidates with less usage left. If none has it, most left runs.",
  }),
});
export type ScheduledTaskModelRouting = typeof ScheduledTaskModelRouting.Type;

/** The same shape without descriptions, for results that echo it back. */
export const ScheduledTaskModelRoutingResult = Schema.Struct({ candidates, minUsageLeftPercent });
