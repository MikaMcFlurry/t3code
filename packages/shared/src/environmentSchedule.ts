// @effect-diagnostics globalDate:off -- Offline windows are wall-clock times in an IANA zone; Intl resolves them.
import type { EnvironmentSchedule } from "@t3tools/contracts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

export interface EnvironmentAvailability {
  /** False inside a configured offline window. */
  readonly availableNow: boolean;
  /**
   * When that changes next: the start of the next offline window while available, the end of
   * the current one while offline. Null for always-on machines, machines without a schedule,
   * and machines whose windows cover the whole week.
   */
  readonly changesAt: number | null;
}

/** This server's IANA zone, used for schedules saved before they named one. */
export function serverTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `timeZone` is an IANA zone this runtime can resolve. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall clock in `timeZone` at `instant`, as if that wall-clock time were UTC ("naive"
 * milliseconds), so calendar arithmetic on it never crosses an offset change.
 */
function wallClock(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const seconds = Math.floor(instant / 1000) * 1000;
  return (
    Date.UTC(
      parts.year ?? 1970,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    ) +
    (instant - seconds)
  );
}

/**
 * The instant a wall-clock time in `timeZone` happens. A time skipped by a spring-forward gap
 * resolves to the end of the gap, the first instant the clock reads at least that time; a time
 * repeated by a fall-back resolves to its first occurrence.
 */
function instantOf(naive: number, timeZone: string): number {
  // Offsets a day either side bracket any single transition near this time.
  const offsetBefore = wallClock(naive - DAY, timeZone) - (naive - DAY);
  const offsetAfter = wallClock(naive + DAY, timeZone) - (naive + DAY);
  const candidates = [naive - offsetBefore, naive - offsetAfter].filter(
    (instant) => wallClock(instant, timeZone) === naive,
  );
  if (candidates.length > 0) return Math.min(...candidates);
  // In a gap: the clock jumps from below `naive` to above it. Find the jump to the minute.
  let low = naive - offsetAfter;
  let high = naive - offsetBefore;
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
    if (middle === low) break;
    if (wallClock(middle, timeZone) >= naive) high = middle;
    else low = middle;
  }
  return high;
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
 * Whether a machine should be reachable at `now`, from its schedule's wall-clock windows in the
 * schedule's IANA zone (this server's zone for schedules without one). Without a schedule, or
 * when it is always on, a machine counts as available with no planned change.
 */
export function environmentAvailability(
  schedule: EnvironmentSchedule | undefined,
  now: number,
): EnvironmentAvailability {
  if (!schedule || schedule.alwaysOn || schedule.offline.length === 0) {
    return { availableNow: true, changesAt: null };
  }
  const timeZone =
    schedule.timeZone !== undefined && isValidTimeZone(schedule.timeZone)
      ? schedule.timeZone
      : serverTimeZone();
  const local = wallClock(now, timeZone);
  const localMinute = local - (((local % MINUTE) + MINUTE) % MINUTE);
  const day = new Date(localMinute);
  const weekMinute = day.getUTCDay() * DAY_MINUTES + day.getUTCHours() * 60 + day.getUTCMinutes();
  // Offsets are wall-clock minutes from now; the zone turns the resulting local time into an instant.
  const at = (offset: number) => instantOf(localMinute + offset * MINUTE, timeZone);
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
      // Offline around the clock: it never comes back on.
      if (next - weekMinute >= WEEK_MINUTES) return { availableNow: false, changesAt: null };
      end = next;
    }
    return { availableNow: false, changesAt: at(end - weekMinute) };
  }
  const nextStart = Math.min(
    ...ranges.map(([start]) => (start > weekMinute ? start : start + WEEK_MINUTES)),
  );
  return { availableNow: true, changesAt: at(nextStart - weekMinute) };
}
