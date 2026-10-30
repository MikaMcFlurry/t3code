import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageRingTone, usageRingWindows } from "./UsageRing.logic";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function usageWindow(
  overrides: Partial<ServerProviderUsageWindow> & Pick<ServerProviderUsageWindow, "id" | "kind">,
): ServerProviderUsageWindow {
  return { label: overrides.id, usedPercent: 0, ...overrides };
}

function limits(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  unavailable?: ServerProviderUsageLimits["unavailable"],
): ServerProviderUsageLimits {
  return {
    checkedAt: "2026-10-30T11:59:00.000Z",
    windows,
    ...(unavailable ? { unavailable } : {}),
  };
}

const summarize = (input: ServerProviderUsageLimits | undefined) =>
  usageRingWindows(input, NOW).map((ring) => [
    ring.kind,
    ring.window.id,
    ring.remaining,
    ring.centerLabel,
  ]);

describe("usageRingWindows", () => {
  it("shows the tightest session and weekly window as remaining percent", () => {
    expect(
      summarize(
        limits([
          usageWindow({ id: "seven_day", kind: "weekly", usedPercent: 30 }),
          usageWindow({
            id: "five_hour",
            kind: "session",
            usedPercent: 12.4,
            windowDurationMins: 300,
          }),
          usageWindow({ id: "weekly-opus", kind: "weekly", usedPercent: 81 }),
          usageWindow({ id: "monthly", kind: "monthly", usedPercent: 99 }),
        ]),
      ),
    ).toEqual([
      ["session", "five_hour", 88, "5h"],
      ["weekly", "weekly-opus", 19, "W"],
    ]);
  });

  it("labels the session ring by its reported duration", () => {
    expect(
      summarize(limits([usageWindow({ id: "s", kind: "session", windowDurationMins: 180 })])).map(
        ([, , , label]) => label,
      ),
    ).toEqual(["3h"]);
    expect(
      summarize(limits([usageWindow({ id: "s", kind: "session", windowDurationMins: 90 })])).map(
        ([, , , label]) => label,
      ),
    ).toEqual(["5h"]);
  });

  it("treats a window whose reset has passed as full", () => {
    expect(
      summarize(
        limits([
          usageWindow({
            id: "five_hour",
            kind: "session",
            usedPercent: 100,
            resetsAt: "2026-10-30T11:00:00.000Z",
          }),
          usageWindow({
            id: "seven_day",
            kind: "weekly",
            usedPercent: 100,
            resetsAt: "2026-11-02T00:00:00.000Z",
          }),
        ]),
      ),
    ).toEqual([
      ["session", "five_hour", 100, "5h"],
      ["weekly", "seven_day", 0, "W"],
    ]);
  });

  it("hides rings without limit data and keeps last good windows after a failed probe", () => {
    expect(summarize(undefined)).toEqual([]);
    expect(summarize(limits([]))).toEqual([]);
    expect(
      summarize(
        limits([usageWindow({ id: "w", kind: "weekly", usedPercent: 50 })], {
          reason: "unsupported",
        }),
      ),
    ).toEqual([]);
    expect(
      summarize(
        limits([usageWindow({ id: "w", kind: "weekly", usedPercent: 50 })], {
          reason: "probeFailed",
        }),
      ),
    ).toEqual([["weekly", "w", 50, "W"]]);
  });
});

describe("usageRingTone", () => {
  it.each([
    [100, "ok"],
    [26, "ok"],
    [25, "low"],
    [11, "low"],
    [10, "critical"],
    [0, "critical"],
  ] as const)("%i%% left is %s", (remaining, tone) => {
    expect(usageRingTone(remaining)).toBe(tone);
  });
});
