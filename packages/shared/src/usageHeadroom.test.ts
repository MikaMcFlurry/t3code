import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  currentUsageWindow,
  formatCountdown,
  exhaustedUsageWindow,
  formatUsageHeadroom,
  headroomExhausted,
  nextHeadroomReset,
  providerUsageHeadroom,
  usagePaceTone,
  usageWindowRefilled,
} from "./usageLimits.ts";
import { describeUsageHeadroom } from "./usageLimitsCopy.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + offsetMs));
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function claudeWindows(input: {
  readonly session?: Partial<ServerProviderUsageWindow>;
  readonly weekly?: Partial<ServerProviderUsageWindow>;
  readonly extra?: ReadonlyArray<ServerProviderUsageWindow>;
}): ReadonlyArray<ServerProviderUsageWindow> {
  return [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 28,
      windowDurationMins: 300,
      resetsAt: at(2 * HOUR + 10 * MIN),
      ...input.session,
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 59,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: at(3 * DAY + 4 * HOUR),
      ...input.weekly,
    },
    ...(input.extra ?? []),
  ];
}

function limits(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits {
  return { checkedAt: at(-MIN), windows, ...overrides };
}

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "me@example.com" },
    checkedAt: at(-MIN),
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const headroomOf = (providers: readonly ServerProvider[], instanceId = "claude", now = NOW) =>
  providerUsageHeadroom(ProviderInstanceId.make(instanceId), providers, [], now);

describe("providerUsageHeadroom", () => {
  it("formats the session and weekly windows with a countdown to each reset", () => {
    const headroom = headroomOf([provider({ usageLimits: limits(claudeWindows({})) })]);
    expect(headroom && formatUsageHeadroom(headroom, NOW)).toBe("5h 72% →2h10m | all: 41% →3d4h");
  });

  it("labels a model pool apart from the weekly headline, before the shared weekly arrow", () => {
    const fable: ServerProviderUsageWindow = {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 82,
      resetsAt: at(3 * DAY + 4 * HOUR),
    };
    const headroom = headroomOf([
      provider({ usageLimits: limits(claudeWindows({ extra: [fable] })) }),
    ]);
    expect(headroom?.weekly?.remaining).toBe(41);
    expect(headroom?.scoped.map((pool) => [pool.label, pool.remaining])).toEqual([["fable", 18]]);
    expect(headroom && formatUsageHeadroom(headroom, NOW)).toBe(
      "5h 72% →2h10m | all: 41% • fable: 18% →3d4h",
    );
    // The tightest pool never replaces the provider-wide headline.
    expect(headroom?.weekly?.window.id).toBe("seven_day");
  });

  it("gives a model pool on its own clock its own arrow", () => {
    const opus: ServerProviderUsageWindow = {
      id: "seven_day_opus",
      kind: "weekly",
      label: "Weekly · Opus",
      usedPercent: 50,
      resetsAt: at(DAY),
    };
    const headroom = headroomOf([
      provider({ usageLimits: limits(claudeWindows({ extra: [opus] })) }),
    ]);
    expect(headroom && formatUsageHeadroom(headroom, NOW)).toBe(
      "5h 72% →2h10m | all: 41% →3d4h | opus: 50% →1d0h",
    );
  });

  it("refills a window whose reset passed after the read", () => {
    const headroom = headroomOf([
      provider({
        usageLimits: limits(
          claudeWindows({ session: { usedPercent: 100, resetsAt: at(-30 * 1000) } }),
          { checkedAt: at(-HOUR) },
        ),
      }),
    ]);
    expect(headroom?.session).toMatchObject({ remaining: 100, resetsAt: null, tone: "ok" });
  });

  it("keeps the reported usage when the reset passed before the read (stale clock)", () => {
    const headroom = headroomOf([
      provider({
        usageLimits: limits(claudeWindows({ session: { usedPercent: 64, resetsAt: at(-HOUR) } }), {
          checkedAt: at(-MIN),
        }),
      }),
    ]);
    expect(headroom?.session).toMatchObject({ remaining: 36, resetsAt: null });
    expect(headroom && formatUsageHeadroom(headroom, NOW)).toBe("5h 36% | all: 41% →3d4h");
  });

  it("keeps a future reset as a countdown and shows no reset text when resetsAt is missing", () => {
    const headroom = headroomOf([
      provider({
        usageLimits: limits(claudeWindows({ weekly: { resetsAt: undefined } })),
      }),
    ]);
    expect(headroom?.session?.resetsAt).toBe(NOW + 2 * HOUR + 10 * MIN);
    expect(headroom?.weekly?.resetsAt).toBeNull();
    expect(headroom && formatUsageHeadroom(headroom, NOW)).toBe("5h 72% →2h10m | all: 41%");
  });

  it("reads the freshest snapshot of the same login, not another account on the driver", () => {
    const own = provider({ usageLimits: limits(claudeWindows({}), { checkedAt: at(-HOUR) }) });
    const sibling = provider({
      instanceId: ProviderInstanceId.make("claude-2"),
      usageLimits: limits(claudeWindows({ session: { usedPercent: 50 } }), {
        checkedAt: at(-MIN),
      }),
    });
    const otherLogin = provider({
      instanceId: ProviderInstanceId.make("claude-work"),
      auth: { status: "authenticated", email: "work@example.com" },
      usageLimits: limits(claudeWindows({ session: { usedPercent: 99 } }), {
        checkedAt: at(-1000),
      }),
    });
    expect(headroomOf([own, sibling, otherLogin])?.session?.remaining).toBe(50);
    expect(headroomOf([own, sibling, otherLogin], "claude-work")?.session?.remaining).toBe(1);
  });

  it("reads a hub snapshot of the same login when it is fresher", () => {
    const own = provider({ usageLimits: limits(claudeWindows({}), { checkedAt: at(-HOUR) }) });
    const headroom = providerUsageHeadroom(
      own.instanceId,
      [own],
      [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy",
          label: "Hub",
          checkedAt: at(-MIN),
          accounts: [
            {
              id: "me.json",
              driver: own.driver,
              email: "me@example.com",
              usageLimits: limits(claudeWindows({ session: { usedPercent: 90 } })),
            },
          ],
        },
      ],
      NOW,
    );
    expect(headroom?.session?.remaining).toBe(10);
  });

  it("keeps the last good windows after a failed probe, marked stale", () => {
    const headroom = headroomOf([
      provider({
        usageLimits: limits(claudeWindows({}), { unavailable: { reason: "probeFailed" } }),
      }),
    ]);
    expect(headroom?.stale).toBe(true);
    expect(headroom && describeUsageHeadroom(headroom, NOW)).toMatch(/^Last known usage: 5h: 72%/);
  });

  it("shows nothing for accounts without limits or without provider-wide windows", () => {
    expect(headroomOf([provider({})])).toBeNull();
    expect(
      headroomOf([
        provider({ usageLimits: limits([], { unavailable: { reason: "unsupported" } }) }),
      ]),
    ).toBeNull();
    const cursor = provider({
      instanceId: ProviderInstanceId.make("cursor"),
      driver: ProviderDriverKind.make("cursor"),
      usageLimits: limits([
        { id: "auto", kind: "weekly", label: "Auto", usedPercent: 10, resetsAt: at(DAY) },
      ]),
    });
    expect(headroomOf([cursor], "cursor")).toBeNull();
  });

  it("treats every Codex window as provider-wide", () => {
    const codex = provider({
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      usageLimits: limits([
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: at(HOUR),
        },
        { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 20, resetsAt: at(DAY) },
      ]),
    });
    const headroom = headroomOf([codex], "codex");
    expect(headroom && formatUsageHeadroom(headroom, NOW)).toBe("5h 90% →1h0m | all: 80% →1d0h");
    expect(headroom && nextHeadroomReset(headroom)?.kind).toBe("session");
  });
});

describe("providerUsageHeadroom for one model", () => {
  // One Antigravity login: the Gemini pool is used up, the shared Claude/GPT pool is untouched.
  const antigravity = provider({
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    usageLimits: limits([
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini · 5-hour",
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: at(HOUR),
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 70,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: at(2 * DAY),
      },
      {
        id: "3p-5h",
        kind: "session",
        label: "Claude & GPT (shared) · 5-hour",
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: at(4 * HOUR),
      },
      {
        id: "3p-weekly",
        kind: "weekly",
        label: "Claude & GPT (shared) · Weekly",
        usedPercent: 25,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: at(5 * DAY),
      },
    ]),
  });
  const forModel = (model: string) =>
    providerUsageHeadroom(ProviderInstanceId.make("antigravity"), [antigravity], [], NOW, model);

  it("reads an Antigravity model's own family pool, never the tightest pool of the account", () => {
    const claude = forModel("claude-sonnet-4-6");
    const gemini = forModel("gemini-3.1-pro");
    expect(claude && formatUsageHeadroom(claude, NOW)).toBe("5h 100% →4h0m | week: 75% →5d0h");
    expect(gemini && formatUsageHeadroom(gemini, NOW)).toBe("5h 0% →1h0m | week: 30% →2d0h");
    expect(claude && headroomExhausted(claude)).toBe(false);
    expect(gemini && headroomExhausted(gemini)).toBe(true);
    // A hub prefix such as `gpt-…` routes to the shared pool too.
    expect(forModel("gpt-5.5")?.session?.window.id).toBe("3p-5h");
  });

  it("dims exactly the models exhaustedUsageWindow blocks", () => {
    for (const model of ["claude-sonnet-4-6", "gpt-5.5", "gemini-3.1-pro"]) {
      const headroom = forModel(model);
      expect(headroom && headroomExhausted(headroom)).toBe(
        exhaustedUsageWindow(antigravity, NOW, model) !== undefined,
      );
    }
  });

  it("shows no account-wide headroom for Antigravity, since no window stops every model", () => {
    expect(headroomOf([antigravity], "antigravity")).toBeNull();
  });

  it("drops another model's pool and keeps the provider-wide headline for Claude", () => {
    const fable: ServerProviderUsageWindow = {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      modelIds: ["claude-fable-5-2"],
      usedPercent: 100,
      resetsAt: at(3 * DAY + 4 * HOUR),
    };
    const claude = provider({ usageLimits: limits(claudeWindows({ extra: [fable] })) });
    const of = (model: string) =>
      providerUsageHeadroom(ProviderInstanceId.make("claude"), [claude], [], NOW, model);
    const opus = of("claude-opus-5-5");
    expect(opus && formatUsageHeadroom(opus, NOW)).toBe("5h 72% →2h10m | all: 41% →3d4h");
    const fableModel = of("claude-fable-5-2");
    expect(fableModel && formatUsageHeadroom(fableModel, NOW)).toBe(
      "5h 72% →2h10m | all: 41% • fable: 0% →3d4h",
    );
    // A used-up model pool never dims the model: only windows that stop it do, as in the picker.
    expect(fableModel && headroomExhausted(fableModel)).toBe(false);
  });

  it("dims a Claude model once the session window is used up", () => {
    const claude = provider({
      usageLimits: limits(claudeWindows({ session: { usedPercent: 100 } })),
    });
    const headroom = providerUsageHeadroom(
      ProviderInstanceId.make("claude"),
      [claude],
      [],
      NOW,
      "claude-opus-5-5",
    );
    expect(headroom && headroomExhausted(headroom)).toBe(true);
    expect(headroom && describeUsageHeadroom(headroom, NOW)).toContain("5h: 0% left");
  });

  it("describes a family's weekly window without claiming it covers all models", () => {
    const claude = forModel("claude-sonnet-4-6");
    expect(claude && describeUsageHeadroom(claude, NOW)).toBe(
      "5h: 100% left, resets in 4h 0m; week: 75% left, resets in 5d 0h",
    );
  });
});

describe("usageWindowRefilled and currentUsageWindow", () => {
  const window: ServerProviderUsageWindow = {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent: 100,
    resetsAt: at(-10 * MIN),
  };

  it("counts a reset as a refill only between the read and now", () => {
    expect(usageWindowRefilled(window, NOW - HOUR, NOW)).toBe(true);
    expect(usageWindowRefilled(window, NOW - MIN, NOW)).toBe(false);
    expect(usageWindowRefilled({ ...window, resetsAt: at(MIN) }, NOW - HOUR, NOW)).toBe(false);
    expect(usageWindowRefilled({ ...window, resetsAt: undefined }, NOW - HOUR, NOW)).toBe(false);
  });

  it("empties a refilled window and drops a passed reset time either way", () => {
    expect(currentUsageWindow(window, NOW - HOUR, NOW)).toEqual({
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 0,
    });
    expect(currentUsageWindow(window, NOW - MIN, NOW)).toEqual({
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 100,
    });
    const upcoming = { ...window, resetsAt: at(HOUR) };
    expect(currentUsageWindow(upcoming, NOW - MIN, NOW)).toBe(upcoming);
  });
});

describe("usagePaceTone", () => {
  it.each([
    // [used %, elapsed share, tone]
    [20, 0.5, "ok"],
    [55, 0.5, "ok"],
    [56, 0.5, "warning"],
    [75, 0.5, "warning"],
    [76, 0.5, "critical"],
    [90, 0.95, "critical"],
    [89, 0.95, "ok"],
    [60, null, "ok"],
    [70, null, "warning"],
    [90, null, "critical"],
  ] as const)("%i%% used with %s elapsed is %s", (used, elapsed, tone) => {
    expect(usagePaceTone(used, elapsed)).toBe(tone);
  });

  it("colours the picker windows by pace, not by remaining share alone", () => {
    // 72% left with 3h of 5h gone is well under pace; 41% left with 1 of 7 days gone is not.
    const headroom = headroomOf([
      provider({
        usageLimits: limits(claudeWindows({ weekly: { usedPercent: 59, resetsAt: at(6 * DAY) } })),
      }),
    ]);
    expect(headroom?.session?.tone).toBe("ok");
    expect(headroom?.weekly?.tone).toBe("critical");
  });
});

describe("formatCountdown", () => {
  it.each([
    [30 * 1000, "<1m"],
    [45 * MIN, "45m"],
    [2 * HOUR + 10 * MIN, "2h10m"],
    [3 * DAY + 4 * HOUR + 59 * MIN, "3d4h"],
  ])("%i ms is %s", (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});
