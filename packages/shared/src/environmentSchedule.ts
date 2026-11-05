// @effect-diagnostics globalDate:off -- Offline windows are wall-clock times in this server's local zone.
import type { EnvironmentSchedule } from "@t3tools/contracts";

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

export interface EnvironmentAvailability {
  /** False inside a configured offline window. */
  readonly availableNow: boolean;
  /**
   * When that changes next: the start of the next offline window while available, the end of
   * the current one while offline. Null for always-on machines and machines without a schedule.
   */
  readonly changesAt: number | null;
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** Offline windows as [start, end) minute ranges within one week, Sunday 00:00 = 0. */
function weeklyRanges(schedule: EnvironmentSchedule): Array<readonly [number, number]> {
  return schedule.offline.flatMap((window) => {
    const from = minutesOf(window.from);
    let to = minutesOf(window.to);
    if (to <= from) to += DAY_MINUTES;
    return window.days.map((day) => [day * DAY_MINUTES + from, day * DAY_MINUTES + to] as const);
  });
}

/**
 * Whether a machine should be reachable at `now`, from its schedule in local time. Without a
 * schedule, or when it is always on, a machine counts as available with no planned change.
 */
export function environmentAvailability(
  schedule: EnvironmentSchedule | undefined,
  now: number,
): EnvironmentAvailability {
  if (!schedule || schedule.alwaysOn || schedule.offline.length === 0) {
    return { availableNow: true, changesAt: null };
  }
  const date = new Date(now);
  const weekMinute = date.getDay() * DAY_MINUTES + date.getHours() * 60 + date.getMinutes();
  const startOfMinute = now - date.getSeconds() * 1000 - date.getMilliseconds();
  const at = (offset: number) => startOfMinute + offset * MINUTE;
  const ranges = weeklyRanges(schedule);
  // Windows can wrap past Saturday midnight, so compare against the week before and after too.
  const shifted = ranges.flatMap(([start, end]) =>
    [-WEEK_MINUTES, 0, WEEK_MINUTES].map((shift) => [start + shift, end + shift] as const),
  );
  if (shifted.some(([start, end]) => start <= weekMinute && weekMinute < end)) {
    // Back-to-back or overlapping windows count as one: follow them to the last end.
    let end = weekMinute;
    for (;;) {
      const next = Math.max(
        end,
        ...shifted.filter(([start, rangeEnd]) => start <= end && end < rangeEnd).map(([, e]) => e),
      );
      if (next === end) break;
      end = next;
    }
    return { availableNow: false, changesAt: at(end - weekMinute) };
  }
  const nextStart = Math.min(
    ...ranges.map(([start]) => (start > weekMinute ? start : start + WEEK_MINUTES)),
  );
  return { availableNow: true, changesAt: at(nextStart - weekMinute) };
}
