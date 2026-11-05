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
});
