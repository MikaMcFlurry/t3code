import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageResetForecastEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { routeModelSelection } from "./autoModelRouting.ts";
import { mergeUsageResetForecast, planUsageResets, resetPlanAdjustment } from "./resetPlanner.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-11-02T12:00:00.000Z");
const at = (offset: number) => DateTime.formatIso(DateTime.makeUnsafe(now + offset));

function account(
  instanceId: string,
  weekly: { readonly used: number; readonly resetsIn?: number } | null,
  extra: Partial<ServerProviderUsageLimits> = {},
): ServerProvider {
  const driver = ProviderDriverKind.make(instanceId.startsWith("codex") ? "codex" : "claudeAgent");
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: at(0),
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Opus",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: at(0),
      windows:
        weekly === null
          ? []
          : [
              {
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: weekly.used,
                ...(weekly.resetsIn === undefined ? {} : { resetsAt: at(weekly.resetsIn) }),
              },
            ],
      ...extra,
    },
  };
}

const settings = (
  overrides: Partial<typeof DEFAULT_SERVER_SETTINGS> = {},
): typeof DEFAULT_SERVER_SETTINGS => ({
  ...DEFAULT_SERVER_SETTINGS,
  usageResetStaggering: true,
  ...overrides,
});

const forecastEntry = (overrides: Partial<UsageResetForecastEntry>): UsageResetForecastEntry => ({
  id: "f1",
  driver: "codex",
  kind: "free-reset",
  expectedAt: at(12 * HOUR),
  confidence: 0.8,
  recordedAt: at(-HOUR),
  ...overrides,
});

describe("planUsageResets", () => {
  const providers = [
    account("claude_a", { used: 30, resetsIn: 2 * DAY }),
    account("claude_b", { used: 0 }),
    account("claude_c", { used: 0, resetsIn: -HOUR }),
  ];

  it("spreads idle accounts' weekly resets as far from the running ones as possible", () => {
    const [group] = planUsageResets({ providers, settings: settings(), now }).groups;
    const byId = new Map(group?.accounts.map((entry) => [entry.instanceId, entry]));
    expect(byId.get("claude_a")).toMatchObject({ state: "running", plannedStartAt: null });
    // Opposite claude_a's reset on the weekly circle: 3.5 days away.
    expect(byId.get("claude_b")?.plannedStartAt).toBe(now + 5.5 * DAY);
    // Between the two: the earliest of the two equally distant slots.
    expect(byId.get("claude_c")?.plannedStartAt).toBe(now + 6 * HOUR);
    expect(byId.get("claude_c")?.weeklyResetAt).toBe(now + 7 * DAY + 6 * HOUR);
  });

  it("plans nothing with staggering off or for a single account", () => {
    const off = planUsageResets({
      providers,
      settings: settings({ usageResetStaggering: false }),
      now,
    });
    expect(off.groups[0]?.accounts.every((entry) => entry.plannedStartAt === null)).toBe(true);
    const single = planUsageResets({
      providers: [account("claude_b", { used: 0 })],
      settings: settings(),
      now,
    });
    expect(single.groups[0]?.accounts[0]?.plannedStartAt).toBeNull();
  });

  it("counts two instances on the same login once", () => {
    const plan = planUsageResets({
      providers: [
        account("claude_a", { used: 30, resetsIn: DAY }, { credentialFingerprint: "same" }),
        account("claude_b", { used: 0 }, { credentialFingerprint: "same" }),
      ],
      settings: settings(),
      now,
    });
    expect(plan.groups[0]?.accounts.map((entry) => entry.instanceId)).toEqual(["claude_a"]);
  });

  it("flags banked resets that expire before the account's own weekly reset", () => {
    const plan = planUsageResets({
      providers: [
        account(
          "claude_a",
          { used: 50, resetsIn: 5 * DAY },
          { resetCredits: { availableCount: 2, nextExpiresAt: at(2 * DAY) } },
        ),
      ],
      settings: settings(),
      now,
    });
    expect(plan.groups[0]?.accounts[0]?.credits).toEqual({
      count: 2,
      expiresAt: now + 2 * DAY,
      expiresFirst: true,
    });
  });

  it("keeps upcoming forecast entries, soonest first", () => {
    const plan = planUsageResets({
      providers,
      settings: settings({
        usageResetForecast: [
          forecastEntry({ id: "later", expectedAt: at(3 * DAY) }),
          forecastEntry({ id: "past", expectedAt: at(-2 * DAY) }),
          forecastEntry({ id: "soon", expectedAt: at(HOUR) }),
        ],
      }),
      now,
    });
    expect(plan.forecast.map((entry) => entry.id)).toEqual(["soon", "later"]);
  });
});

describe("resetPlanAdjustment", () => {
  it("holds idle accounts back until shortly before their planned start", () => {
    const providers = [
      account("claude_a", { used: 30, resetsIn: 2 * DAY }),
      account("claude_b", { used: 0 }),
    ];
    const plan = planUsageResets({ providers, settings: settings(), now });
    expect(resetPlanAdjustment(plan, "claude_b", now).score).toBe(-50);
    expect(resetPlanAdjustment(plan, "claude_b", now + 5.5 * DAY - HOUR).score).toBe(10);
    expect(resetPlanAdjustment(plan, "claude_a", now).score).toBe(0);
  });

  it("prefers a provider with a free reset forecast soon, weighted by confidence", () => {
    const plan = planUsageResets({
      providers: [account("codex_a", { used: 60, resetsIn: 4 * DAY })],
      settings: settings({ usageResetForecast: [forecastEntry({})] }),
      now,
    });
    expect(resetPlanAdjustment(plan, "codex_a", now).score).toBeCloseTo(16);
    expect(resetPlanAdjustment(plan, "codex_a", now + 13 * HOUR).score).toBe(0);
  });

  it("prefers an account whose banked reset expires within three days", () => {
    const plan = planUsageResets({
      providers: [
        account(
          "claude_a",
          { used: 50, resetsIn: 5 * DAY },
          { resetCredits: { availableCount: 1, nextExpiresAt: at(2 * DAY) } },
        ),
      ],
      settings: settings(),
      now,
    });
    expect(resetPlanAdjustment(plan, "claude_a", now)).toEqual({
      score: 10,
      reasons: ["a banked reset expires soon"],
    });
  });
});

describe("automatic routing with a reset plan", () => {
  it("keeps using a running account instead of starting an idle one early", () => {
    const providers = [
      account("claude_a", { used: 40, resetsIn: 2 * DAY }),
      account("claude_b", { used: 0 }),
    ];
    const route = (staggering: boolean) =>
      routeModelSelection({
        desired: { instanceId: ProviderInstanceId.make("claude_a"), model: "claude-opus-5-5" },
        mode: "balance-accounts",
        providers,
        settings: settings({
          usageResetStaggering: staggering,
          providerInstances: Object.fromEntries(
            providers.map((entry) => [entry.instanceId, { driver: entry.driver, enabled: true }]),
          ),
        }),
        now,
      })?.selection.instanceId;
    expect(route(false)).toBe("claude_b");
    expect(route(true)).toBe("claude_a");
  });
});

describe("mergeUsageResetForecast", () => {
  it("keeps one entry per provider, kind and day and drops stale ones", () => {
    const merged = mergeUsageResetForecast(
      [
        forecastEntry({ id: "codex-free-reset-2026-11-03", confidence: 0.3 }),
        forecastEntry({ id: "old", expectedAt: at(-4 * DAY) }),
        forecastEntry({ id: "claudeAgent-free-reset-2026-11-04", driver: "claudeAgent" }),
      ],
      {
        driver: "codex",
        kind: "free-reset",
        expectedAt: "2026-11-03T08:00:00.000Z",
        confidence: 1,
      },
      now,
      at(0),
    );
    expect(merged.map((entry) => [entry.id, entry.confidence])).toEqual([
      ["claudeAgent-free-reset-2026-11-04", 0.8],
      ["codex-free-reset-2026-11-03", 1],
    ]);
  });

  it("ignores an unreadable date", () => {
    const existing = [forecastEntry({})];
    expect(
      mergeUsageResetForecast(
        existing,
        { driver: "codex", kind: "free-reset", expectedAt: "soon", confidence: 1 },
        now,
        at(0),
      ),
    ).toBe(existing);
  });
});

describe("reset planner edge cases", () => {
  it("keeps a slot that passed a few hours ago due instead of moving it a week", () => {
    const providers = [
      account("claude_a", { used: 30, resetsIn: 2 * DAY }),
      account("claude_b", { used: 0 }),
    ];
    const later = now + 5.5 * DAY + 5 * HOUR;
    const plan = planUsageResets({
      providers: [
        // claude_a started its next week; its reset moved from now+2d to now+9d.
        account("claude_a", { used: 30, resetsIn: 9 * DAY }),
        account("claude_b", { used: 0 }),
      ],
      settings: settings(),
      now: later,
    });
    const b = plan.groups[0]?.accounts.find((entry) => entry.instanceId === "claude_b");
    expect(b?.plannedStartAt).toBeLessThanOrEqual(later);
    expect(resetPlanAdjustment(plan, "claude_b", later).score).toBe(10);
    expect(providers).toHaveLength(2);
  });

  it("treats a 0% weekly window whose reset is already counting down as running", () => {
    const counting = account("codex_a", { used: 0, resetsIn: 6 * DAY });
    const fresh = account("codex_b", { used: 0, resetsIn: 7 * DAY });
    const plan = planUsageResets({ providers: [counting, fresh], settings: settings(), now });
    const states = plan.groups[0]?.accounts.map((entry) => [entry.instanceId, entry.state]);
    expect(states).toEqual([
      ["codex_a", "running"],
      ["codex_b", "idle"],
    ]);
  });

  it("gives no free-reset bonus for a limit increase", () => {
    const plan = planUsageResets({
      providers: [account("codex_a", { used: 60, resetsIn: 4 * DAY })],
      settings: settings({ usageResetForecast: [forecastEntry({ kind: "limit-increase" })] }),
      now,
    });
    expect(resetPlanAdjustment(plan, "codex_a", now).score).toBe(0);
  });

  it("stores forecast times in UTC so offsets share one entry per day", () => {
    const merged = mergeUsageResetForecast(
      [],
      {
        driver: "codex",
        kind: "free-reset",
        expectedAt: "2026-11-03T01:00:00+02:00",
        confidence: 1,
      },
      now,
      at(0),
    );
    expect(merged[0]).toMatchObject({
      id: "codex-free-reset-2026-11-02",
      expectedAt: "2026-11-02T23:00:00.000Z",
    });
  });
});

describe("reset plan and provider switching", () => {
  it("does not leave the provider because an account is held back for staggering", () => {
    const session = (usedPercent: number) => ({
      id: "five_hour",
      kind: "session" as const,
      label: "Session",
      usedPercent,
      resetsAt: at(2 * HOUR),
    });
    const weekly = (usedPercent: number, resetsIn?: number) => ({
      id: "seven_day",
      kind: "weekly" as const,
      label: "Weekly",
      usedPercent,
      ...(resetsIn === undefined ? {} : { resetsAt: at(resetsIn) }),
    });
    const providers = [
      account("claude_a", null, { windows: [session(100), weekly(100, 2 * DAY)] }),
      account("claude_b", null, { windows: [session(40), weekly(0)] }),
      account("codex_a", { used: 10, resetsIn: 3 * DAY }),
    ];
    const route = routeModelSelection({
      desired: { instanceId: ProviderInstanceId.make("claude_b"), model: "claude-opus-5-5" },
      mode: "any-provider",
      providers,
      settings: settings({
        providerInstances: Object.fromEntries(
          providers.map((entry) => [entry.instanceId, { driver: entry.driver, enabled: true }]),
        ),
      }),
      now,
    });
    expect(route?.selection.instanceId).toBe("claude_b");
    expect(route?.reason).toContain("Reset plan: held back until its planned start.");
  });
});
