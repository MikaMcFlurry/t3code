import { describe, expect, it } from "vite-plus/test";

import {
  formatDayAwareTimestamp,
  formatResetClock,
  formatUpcomingTimestamp,
} from "./timestampFormat";

describe("timestamps in an explicit time zone", () => {
  // 23:00 UTC on July 1 is 7 PM on July 1 in New York, whatever the host zone.
  const now = Date.parse("2026-07-01T23:00:00.000Z");
  const zone = "America/New_York";

  it("picks relative days from the calendar in that zone", () => {
    expect(formatUpcomingTimestamp("2026-07-02T00:30:00.000Z", "12-hour", now, zone)).not.toMatch(
      /tomorrow/,
    );
    expect(formatUpcomingTimestamp("2026-07-02T05:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^tomorrow at /,
    );
    expect(formatDayAwareTimestamp("2026-07-01T03:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^yesterday at /,
    );
  });
});

const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();

describe("formatResetClock", () => {
  const now = new Date(2026, 10, 2, 12, 0).getTime();

  it("shows only the time for a reset today or within 12 hours", () => {
    expect(formatResetClock(local(2, 14, 30), "24-hour", now)).toBe("14:30");
    const evening = new Date(2026, 10, 2, 20, 0).getTime();
    expect(formatResetClock(local(3, 2, 5), "24-hour", evening)).toBe("02:05");
  });

  it("adds the weekday for later resets, or shows only the weekday when compact", () => {
    const full = formatResetClock(local(5, 9), "24-hour", now);
    const compact = formatResetClock(local(5, 9), "24-hour", now, { compact: true });
    expect(full).toMatch(/09:00$/);
    expect(full.startsWith(compact)).toBe(true);
    expect(compact).not.toMatch(/\d/);
  });

  it("returns nothing for an invalid date", () => {
    expect(formatResetClock("not a date", "24-hour", now)).toBe("");
  });
});
