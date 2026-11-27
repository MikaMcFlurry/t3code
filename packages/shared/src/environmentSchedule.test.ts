// @effect-diagnostics globalDate:off -- Local wall-clock instants keep the schedule assertions zone-independent.
import { describe, expect, it } from "vite-plus/test";

import { environmentAvailability } from "./environmentSchedule.ts";

// Thursday 5 November 2026, local time.
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();
const nights = {
  environmentId: "wohnzimmer",
  alwaysOn: false,
  // Off every night 23:00 to 07:00, and all Sunday.
  offline: [
    { days: [0, 1, 2, 3, 4, 5, 6], from: "23:00", to: "07:00" },
    { days: [0], from: "00:00", to: "23:59" },
  ],
};

describe("environmentAvailability", () => {
  it("is available outside offline windows, until the next one starts", () => {
    expect(environmentAvailability(nights, local(5, 15))).toEqual({
      availableNow: true,
      changesAt: local(5, 23),
    });
  });

  it("is offline inside a window that runs past midnight, until it ends", () => {
    expect(environmentAvailability(nights, local(6, 2, 30))).toEqual({
      availableNow: false,
      changesAt: local(6, 7),
    });
  });

  it("joins overlapping windows to the latest end", () => {
    // Saturday 23:30: the night runs into Sunday, Sunday is off until 23:59, and Sunday night's
    // window starts at 23:00, so the machine is back only on Monday at 07:00.
    expect(environmentAvailability(nights, local(7, 23, 30))).toEqual({
      availableNow: false,
      changesAt: local(9, 7),
    });
  });

  it("treats always-on machines and missing schedules as available without changes", () => {
    expect(environmentAvailability({ ...nights, alwaysOn: true }, local(6, 2))).toEqual({
      availableNow: true,
      changesAt: null,
    });
    expect(environmentAvailability(undefined, local(6, 2))).toEqual({
      availableNow: true,
      changesAt: null,
    });
  });

  describe("across daylight-saving changes in an explicit IANA zone", () => {
    const berlin = (offline: (typeof nights)["offline"]) => ({
      environmentId: "wohnzimmer",
      alwaysOn: false,
      timeZone: "Europe/Berlin",
      offline,
    });
    const utc = (iso: string) => Date.parse(iso);

    it("ends a window at the right instant on a spring-forward night", () => {
      // Sunday 29 March 2026: clocks jump from 02:00 CET to 03:00 CEST. 01:30 CET is 00:30Z.
      const schedule = berlin([{ days: [0], from: "00:00", to: "04:00" }]);
      expect(environmentAvailability(schedule, utc("2026-03-29T00:30:00Z"))).toEqual({
        availableNow: false,
        // 04:00 CEST, not 04:00 at the old offset.
        changesAt: utc("2026-03-29T02:00:00Z"),
      });
    });

    it("starts a window at the end of the gap when its start time is skipped", () => {
      // 02:30 never happens that night; the clock reads past it from 03:00 CEST (01:00Z).
      const schedule = berlin([{ days: [0], from: "02:30", to: "05:00" }]);
      expect(environmentAvailability(schedule, utc("2026-03-28T23:00:00Z"))).toEqual({
        availableNow: true,
        changesAt: utc("2026-03-29T01:00:00Z"),
      });
      expect(environmentAvailability(schedule, utc("2026-03-29T01:00:00Z"))).toEqual({
        availableNow: false,
        changesAt: utc("2026-03-29T03:00:00Z"),
      });
    });

    it("ends a window at the right instant on a fall-back night", () => {
      // Sunday 25 October 2026: clocks go back from 03:00 CEST to 02:00 CET. 01:30 CEST is 23:30Z.
      const schedule = berlin([{ days: [0], from: "00:00", to: "04:00" }]);
      expect(environmentAvailability(schedule, utc("2026-10-24T23:30:00Z"))).toEqual({
        availableNow: false,
        // 04:00 CET, an hour later than 04:00 at the summer offset.
        changesAt: utc("2026-10-25T03:00:00Z"),
      });
      // A repeated wall-clock time resolves to its first occurrence (02:30 CEST).
      const repeated = berlin([{ days: [0], from: "00:00", to: "02:30" }]);
      expect(environmentAvailability(repeated, utc("2026-10-24T23:30:00Z"))).toEqual({
        availableNow: false,
        changesAt: utc("2026-10-25T00:30:00Z"),
      });
    });

    it("plans the next window a week ahead in local time across the change", () => {
      // Sunday 22 March 2026 13:30 CET (12:30Z); next Sunday's 12:00 is CEST (10:00Z).
      const schedule = berlin([{ days: [0], from: "12:00", to: "13:00" }]);
      expect(environmentAvailability(schedule, utc("2026-03-22T12:30:00Z"))).toEqual({
        availableNow: true,
        changesAt: utc("2026-03-29T10:00:00Z"),
      });
    });

    it("reads now in the schedule's zone, not this server's", () => {
      const schedule = {
        ...berlin([{ days: [4], from: "09:00", to: "17:00" }]),
        timeZone: "America/New_York",
      };
      // Thursday 5 November 2026 15:00Z is 10:00 in New York (EST, UTC-5).
      expect(environmentAvailability(schedule, utc("2026-11-05T15:00:00Z"))).toEqual({
        availableNow: false,
        changesAt: utc("2026-11-05T22:00:00Z"),
      });
    });

    it("never comes back on when the windows cover the whole week", () => {
      const always = berlin([{ days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "00:00" }]);
      expect(environmentAvailability(always, utc("2026-03-29T00:30:00Z"))).toEqual({
        availableNow: false,
        changesAt: null,
      });
      // Night windows joined back to back around the week count too.
      const chained = berlin([{ days: [0, 1, 2, 3, 4, 5, 6], from: "12:00", to: "12:00" }]);
      expect(environmentAvailability(chained, utc("2026-10-25T01:30:00Z"))).toEqual({
        availableNow: false,
        changesAt: null,
      });
    });
  });
});
