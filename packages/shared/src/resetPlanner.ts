import type {
  ServerProvider,
  ServerProviderUsageWindow,
  ServerSettings,
  UsageResetForecastEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** An idle account may start this long before its planned slot. */
const START_TOLERANCE = 3 * HOUR;
/** A slot passed this recently stays due instead of moving to next week. */
const LATE_GRACE = DAY;
/** A weekly reset at least this close to a full window ahead means the countdown has not begun. */
const UNSTARTED_SLACK = HOUR;
/** A forecast reset this close turns the provider's remaining quota into use-it-or-lose-it. */
const FORECAST_HORIZON = 36 * HOUR;
/** Banked resets expiring this soon are worth exhausting the account for. */
const CREDIT_URGENCY = 3 * DAY;
/** Score changes, in headroom percentage points, applied by automatic routing. */
const HOLD_BACK_PENALTY = 50;
const START_ON_SCHEDULE_BONUS = 10;
const FORECAST_BONUS = 20;
const EXPIRING_CREDIT_BONUS = 10;

export type PlannedAccountState = "running" | "idle" | "unknown";

export interface PlannedAccount {
  readonly instanceId: string;
  readonly name: string;
  readonly driver: string;
  readonly state: PlannedAccountState;
  readonly sessionResetAt: number | null;
  /** Reset of the running weekly window, or the planned reset of an idle account. */
  readonly weeklyResetAt: number | null;
  /** Staggering only: when an idle account should start its weekly window. */
  readonly plannedStartAt: number | null;
  readonly credits: {
    readonly count: number;
    readonly expiresAt: number | null;
    /** The next banked reset expires before the account's own weekly reset. */
    readonly expiresFirst: boolean;
  } | null;
}

export interface ResetPlanGroup {
  readonly driver: string;
  readonly accounts: ReadonlyArray<PlannedAccount>;
}

export interface ResetPlan {
  readonly staggering: boolean;
  readonly groups: ReadonlyArray<ResetPlanGroup>;
  /** Upcoming forecast entries, soonest first. */
  readonly forecast: ReadonlyArray<UsageResetForecastEntry>;
}

function millis(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function upcomingReset(windows: ReadonlyArray<ServerProviderUsageWindow>, now: number) {
  let soonest: number | null = null;
  for (const window of windows) {
    const at = millis(window.resetsAt);
    if (at !== null && at > now && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

/**
 * A weekly window runs once it was used or its reset is counting down. Providers that round
 * early use to 0% still report a reset less than a full window away; an unstarted window reports
 * no reset (Claude) or one a full window ahead of the check (Codex). Fixed-schedule windows always
 * count as running, so they are never held back.
 */
function isRunning(window: ServerProviderUsageWindow, checkedAt: number, now: number) {
  const at = millis(window.resetsAt);
  if (at === null || at <= now) return false;
  if (window.usedPercent > 0) return true;
  const length = (window.windowDurationMins ?? 7 * 24 * 60) * 60_000;
  return at - checkedAt < length - UNSTARTED_SLACK;
}

function weeklyState(provider: ServerProvider, now: number) {
  const weekly = (provider.usageLimits?.windows ?? []).filter((window) => window.kind === "weekly");
  if (weekly.length === 0 || provider.usageLimits?.unavailable) {
    return { state: "unknown" as const, resetAt: upcomingReset(weekly, now) };
  }
  const checkedAt = millis(provider.usageLimits?.checkedAt) ?? now;
  const running = weekly.filter((window) => isRunning(window, checkedAt, now));
  return running.length > 0
    ? { state: "running" as const, resetAt: upcomingReset(running, now) }
    : { state: "idle" as const, resetAt: null };
}

function circularDistance(left: number, right: number) {
  const delta = (((left - right) % WEEK) + WEEK) % WEEK;
  return Math.min(delta, WEEK - delta);
}

/**
 * The start time whose weekly reset lands farthest from every anchor reset, checked hourly over
 * one week of positions; the earliest wins a tie. The search begins a day back, so a slot that
 * passed while nobody started a thread stays due (in the past) instead of moving a week ahead.
 * Without anchors the account starts now.
 */
function bestStart(anchors: ReadonlyArray<number>, now: number): number {
  if (anchors.length === 0) return now;
  let best = now;
  let bestDistance = -1;
  for (let offset = -LATE_GRACE; offset < WEEK - LATE_GRACE; offset += HOUR) {
    const start = now + offset;
    const distance = Math.min(...anchors.map((anchor) => circularDistance(start + WEEK, anchor)));
    if (distance > bestDistance + 60_000) {
      best = start;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Groups accounts by provider kind (one entry per login) and, with staggering on, plans when
 * each idle account should start so the group's weekly resets spread across the week.
 */
export function planUsageResets(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "usageResetStaggering" | "usageResetForecast">;
  readonly now: number;
}): ResetPlan {
  const { now } = input;
  const staggering = input.settings.usageResetStaggering;
  const byDriver = new Map<string, ServerProvider[]>();
  const logins = new Set<string>();
  for (const provider of input.providers) {
    if (!provider.enabled || !provider.usageLimits) continue;
    const login = provider.usageLimits.credentialFingerprint;
    if (login !== undefined) {
      // Two instances signed in to the same login share one quota.
      if (logins.has(`${provider.driver}:${login}`)) continue;
      logins.add(`${provider.driver}:${login}`);
    }
    byDriver.set(provider.driver, [...(byDriver.get(provider.driver) ?? []), provider]);
  }

  const groups = [...byDriver.entries()].map(([driver, providers]): ResetPlanGroup => {
    const states = providers
      .map((provider) => ({ provider, ...weeklyState(provider, now) }))
      .sort((left, right) => left.provider.instanceId.localeCompare(right.provider.instanceId));
    const anchors = states.flatMap((entry) =>
      entry.state === "running" && entry.resetAt !== null ? [entry.resetAt] : [],
    );
    const accounts = states.map(({ provider, state, resetAt }): PlannedAccount => {
      let plannedStartAt: number | null = null;
      let weeklyResetAt = resetAt;
      if (staggering && state === "idle" && providers.length > 1) {
        plannedStartAt = bestStart(anchors, now);
        weeklyResetAt = Math.max(plannedStartAt, now) + WEEK;
        anchors.push(weeklyResetAt);
      }
      const credits = provider.usageLimits?.resetCredits;
      const expiresAt = millis(credits?.nextExpiresAt);
      return {
        instanceId: provider.instanceId,
        name: provider.displayName ?? provider.instanceId,
        driver,
        state,
        sessionResetAt: upcomingReset(
          (provider.usageLimits?.windows ?? []).filter((window) => window.kind === "session"),
          now,
        ),
        weeklyResetAt,
        plannedStartAt,
        credits:
          credits && credits.availableCount > 0
            ? {
                count: credits.availableCount,
                expiresAt,
                expiresFirst:
                  expiresAt !== null && (weeklyResetAt === null || expiresAt < weeklyResetAt),
              }
            : null,
      };
    });
    return { driver, accounts };
  });

  const forecast = input.settings.usageResetForecast
    .filter((entry) => {
      const at = millis(entry.expectedAt);
      return at !== null && at > now - HOUR;
    })
    .map((entry) => ({ entry, at: millis(entry.expectedAt) ?? 0 }))
    .sort((left, right) => left.at - right.at)
    .map(({ entry }) => entry);

  return { staggering, groups, forecast };
}

export interface ResetPlanAdjustment {
  /** Added to an account's routing score. */
  readonly score: number;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * How the plan shifts automatic routing for one account: hold back idle accounts until their
 * planned start, prefer providers with a forecast free reset soon, and prefer accounts whose
 * banked resets expire before they could be used otherwise.
 */
export function resetPlanAdjustment(
  plan: ResetPlan,
  instanceId: string,
  now: number,
): ResetPlanAdjustment {
  const account = plan.groups
    .flatMap((group) => group.accounts)
    .find((entry) => entry.instanceId === instanceId);
  if (!account) return { score: 0, reasons: [] };
  let score = 0;
  const reasons: string[] = [];
  if (account.plannedStartAt !== null) {
    if (account.plannedStartAt > now + START_TOLERANCE) {
      score -= HOLD_BACK_PENALTY;
      reasons.push("held back until its planned start");
    } else {
      score += START_ON_SCHEDULE_BONUS;
      reasons.push("due to start its weekly window");
    }
  }
  // Only resets that refill the quota make the remaining quota use-it-or-lose-it.
  const forecast = plan.forecast.find((entry) => {
    const at = millis(entry.expectedAt);
    return (
      (entry.kind === "free-reset" || entry.kind === "outage-credit") &&
      entry.driver === account.driver &&
      at !== null &&
      at > now &&
      at - now <= FORECAST_HORIZON
    );
  });
  if (forecast) {
    score += FORECAST_BONUS * forecast.confidence;
    reasons.push("a free reset is expected soon");
  }
  if (
    account.credits?.expiresFirst &&
    account.credits.expiresAt !== null &&
    account.credits.expiresAt - now <= CREDIT_URGENCY
  ) {
    score += EXPIRING_CREDIT_BONUS;
    reasons.push("a banked reset expires soon");
  }
  return { score, reasons };
}

const FORECAST_RETENTION = 3 * DAY;
const FORECAST_LIMIT = 50;

/**
 * Adds a forecast entry: one per provider, kind and UTC day (the newer one wins), entries older
 * than three days dropped, at most 50 kept.
 */
export function mergeUsageResetForecast(
  existing: ReadonlyArray<UsageResetForecastEntry>,
  input: Omit<UsageResetForecastEntry, "id" | "recordedAt">,
  now: number,
  recordedAt: string,
): ReadonlyArray<UsageResetForecastEntry> {
  const expected = millis(input.expectedAt);
  if (expected === null) return existing;
  // Normalized to UTC, so offsets and loose date formats share one id per day.
  const expectedAt = DateTime.formatIso(DateTime.makeUnsafe(expected));
  const id = `${input.driver}-${input.kind}-${expectedAt.slice(0, 10)}`;
  const kept = existing.filter((entry) => {
    const at = millis(entry.expectedAt);
    return entry.id !== id && at !== null && at > now - FORECAST_RETENTION;
  });
  return [...kept, { ...input, expectedAt, id, recordedAt }].slice(-FORECAST_LIMIT);
}
