import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";

export type UsageRingKind = "session" | "weekly";
export type UsageRingTone = "ok" | "low" | "critical";

export interface UsageRingWindow {
  readonly kind: UsageRingKind;
  readonly window: ServerProviderUsageWindow;
  readonly remaining: number;
  readonly centerLabel: string;
}

const RING_KINDS: ReadonlyArray<UsageRingKind> = ["session", "weekly"];

function sessionCenterLabel(window: ServerProviderUsageWindow): string {
  const mins = window.windowDurationMins;
  return mins !== undefined && mins > 0 && mins < 24 * 60 && mins % 60 === 0
    ? `${mins / 60}h`
    : "5h";
}

function ringRemaining(window: ServerProviderUsageWindow, now: number): number {
  const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt <= now ? 100 : remainingPercent(window);
}

/**
 * One ring per kind, showing its tightest window: Claude and Antigravity report several scoped
 * weekly windows, and the one closest to empty is what stops the next turn.
 */
export function usageRingWindows(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): ReadonlyArray<UsageRingWindow> {
  if (!limits || limits.unavailable?.reason === "unsupported") return [];
  return RING_KINDS.flatMap((kind) => {
    const tightest = limits.windows
      .filter((window) => window.kind === kind)
      .map((window) => ({ window, remaining: ringRemaining(window, now) }))
      .toSorted((left, right) => left.remaining - right.remaining)[0];
    if (!tightest) return [];
    return [
      {
        kind,
        ...tightest,
        centerLabel: kind === "session" ? sessionCenterLabel(tightest.window) : "W",
      },
    ];
  });
}

export function usageRingTone(remaining: number): UsageRingTone {
  if (remaining <= 10) return "critical";
  if (remaining <= 25) return "low";
  return "ok";
}
