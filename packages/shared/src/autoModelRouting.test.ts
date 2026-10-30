import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseModelForTask,
  instanceHeadroom,
  modelForTaskProfile,
  resolveNewThreadModelRoute,
  routeModelSelection,
} from "./autoModelRouting.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const later = "2026-09-03T14:00:00.000Z";
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

function effortModel(
  slug: string,
  id: string,
  efforts: readonly string[],
  extra: Partial<ServerProviderModel> = {},
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id,
          label: "Effort",
          type: "select",
          options: efforts.map((effort) => ({
            id: effort,
            label: effort,
            ...(effort === "medium" ? { isDefault: true } : {}),
          })),
          ...(id === "effort" ? { promptInjectedValues: ["ultrathink"] } : {}),
        },
      ],
    },
    ...extra,
  };
}

const codexModels = [
  effortModel("gpt-6-astra", "reasoningEffort", ["low", "medium", "high", "xhigh"], {
    isDefault: true,
  }),
  effortModel("gpt-6-luna", "reasoningEffort", ["low", "medium"]),
];
const claudeModels = [
  effortModel("claude-opus-5-5", "effort", ["low", "medium", "high", "max", "ultrathink"]),
  effortModel("claude-haiku-5-5", "effort", ["low", "medium"]),
];

function provider(
  instanceId: string,
  used: { session?: number; weekly?: number } | null,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  const driver = overrides.driver ?? (instanceId.startsWith("claude") ? CLAUDE : CODEX);
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: driver === CLAUDE ? claudeModels : codexModels,
    slashCommands: [],
    skills: [],
    ...(used
      ? {
          usageLimits: {
            checkedAt: "2026-09-03T11:00:00.000Z",
            windows: [
              ...(used.session === undefined
                ? []
                : [
                    {
                      id: "five_hour",
                      kind: "session" as const,
                      label: "Session",
                      usedPercent: used.session,
                      resetsAt: later,
                    },
                  ]),
              ...(used.weekly === undefined
                ? []
                : [
                    {
                      id: "weekly",
                      kind: "weekly" as const,
                      label: "Weekly",
                      usedPercent: used.weekly,
                      resetsAt: "2026-09-08T00:00:00.000Z",
                    },
                  ]),
            ],
          },
        }
      : {}),
    ...overrides,
  };
}

const desired = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "high" }],
};

function route(
  providers: readonly ServerProvider[],
  mode: "balance-accounts" | "any-provider" = "balance-accounts",
) {
  return routeModelSelection({ providers, desired, mode, now });
}

describe("instanceHeadroom", () => {
  it.each([
    ["the scarcer window", { session: 20, weekly: 70 }, now, 30],
    ["a reset window as full", { session: 100 }, Date.parse(later) + 1, 100],
    ["no data as null", null, now, null],
  ] as const)("reports %s", (_name, used, at, expected) => {
    expect(instanceHeadroom(provider("codex", used), at)).toBe(expected);
  });
});

describe("routeModelSelection", () => {
  it("balances to the sibling account with the most headroom, keeping model and options", () => {
    const result = route([
      provider("codex", { session: 80, weekly: 40 }),
      provider("codex-2", { session: 10, weekly: 30 }),
      provider("codex-3", { session: 50, weekly: 50 }),
    ]);
    expect(result?.selection).toEqual({ ...desired, instanceId: "codex-2" });
    expect(result?.headroom).toBe(70);
    expect(result?.crossProvider).toBe(false);
    expect(result?.reason).toContain("codex-2");
  });

  it("weighs the scarcer window over the average", () => {
    // codex-2 has the better average but its weekly window is nearly gone.
    const result = route([
      provider("codex", { session: 40, weekly: 40 }),
      provider("codex-2", { session: 0, weekly: 85 }),
    ]);
    expect(result?.selection.instanceId).toBe("codex");
  });

  it("keeps the desired account on a tie, then breaks ties by instance id", () => {
    const tied = { session: 30, weekly: 30 };
    expect(
      route([provider("codex-b", tied), provider("codex", tied), provider("codex-a", tied)])
        ?.selection.instanceId,
    ).toBe("codex");
    expect(
      route([
        provider("codex", { session: 90 }),
        provider("codex-b", tied),
        provider("codex-a", tied),
      ])?.selection.instanceId,
    ).toBe("codex-a");
  });

  it("never picks exhausted, unauthenticated, disabled, or broken accounts", () => {
    const result = route([
      provider("codex", { session: 90 }),
      provider("codex-exhausted", { session: 100 }),
      provider("codex-signed-out", null, { auth: { status: "unauthenticated" } }),
      provider("codex-disabled", null, { enabled: false }),
      provider("codex-missing", null, { installed: false }),
      provider("codex-error", null, { status: "error" }),
      provider("codex-unavailable", null, { availability: "unavailable" }),
    ]);
    expect(result?.selection.instanceId).toBe("codex");
  });

  it("ranks an account without usage data below a healthy one and above a nearly empty one", () => {
    expect(
      route([provider("codex", { session: 30 }), provider("codex-2", null)])?.selection.instanceId,
    ).toBe("codex");
    expect(
      route([provider("codex", { session: 90 }), provider("codex-2", null)])?.selection.instanceId,
    ).toBe("codex-2");
  });

  it("skips siblings that lack the model and respects project provider overrides", () => {
    const providers = [
      provider("codex", { session: 90 }),
      provider("codex-2", { session: 0 }, { models: codexModels.slice(1) }),
      provider("codex-3", { session: 0 }),
    ];
    expect(route(providers)?.selection.instanceId).toBe("codex-3");
    expect(
      routeModelSelection({
        providers,
        desired,
        mode: "balance-accounts",
        now,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex-3")]: { driver: CODEX, enabled: false, config: {} },
          },
        },
      })?.selection.instanceId,
    ).toBe("codex");
  });

  it("returns null when no account of the kind is usable in balance mode", () => {
    expect(
      route([provider("codex", { session: 100 }), provider("claude", { session: 0 })]),
    ).toBeNull();
  });

  it("moves to another kind's equivalent model when every preferred account is low", () => {
    const result = route(
      [
        provider("codex", { session: 95 }),
        provider("codex-2", { weekly: 100 }),
        provider("claude", { session: 20 }),
        provider("claude-2", { session: 60 }),
      ],
      "any-provider",
    );
    expect(result).toMatchObject({
      selection: {
        instanceId: "claude",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      crossProvider: true,
    });
  });

  it("stays on the preferred kind in any-provider mode while it has headroom", () => {
    const result = route(
      [provider("codex", { session: 70 }), provider("claude", { session: 0 })],
      "any-provider",
    );
    expect(result?.selection).toEqual(desired);
    expect(result?.crossProvider).toBe(false);
  });
});

describe("chooseModelForTask", () => {
  it.each([
    ["light", "codex", "gpt-6-luna", "low"],
    ["standard", "codex", "gpt-6-astra", "medium"],
    ["heavy", "codex", "gpt-6-astra", "high"],
    ["light", "claude", "claude-haiku-5-5", "low"],
    ["heavy", "claude", "claude-opus-5-5", "high"],
  ] as const)("maps %s on %s to %s at %s effort", (profile, instanceId, model, effort) => {
    const selection = modelForTaskProfile(provider(instanceId, null), profile);
    expect(selection?.model).toBe(model);
    expect(selection?.options?.[0]?.value).toBe(effort);
  });

  it("falls back to the default model and skips prompt-injected efforts", () => {
    const onlyOpus = provider("claude", null, {
      models: [effortModel("claude-opus-5-5", "effort", ["ultrathink"], { isDefault: true })],
    });
    expect(modelForTaskProfile(onlyOpus, "light")).toEqual({
      instanceId: "claude",
      model: "claude-opus-5-5",
    });
  });

  it("balances accounts across kinds without a preference", () => {
    const result = chooseModelForTask({
      profile: "heavy",
      providers: [
        provider("codex", { session: 50 }),
        provider("claude", { session: 90 }),
        provider("claude-2", { session: 10 }),
      ],
      now,
    });
    expect(result?.selection).toEqual({
      instanceId: "claude-2",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("honors the preferred kind until its accounts run low", () => {
    const providers = [provider("codex", { session: 70 }), provider("claude", { session: 0 })];
    const input = { profile: "standard" as const, providers, now, preferredDriver: CODEX };
    expect(chooseModelForTask(input)?.selection.instanceId).toBe("codex");
    const low = [provider("codex", { session: 95 }), provider("claude", { session: 0 })];
    expect(chooseModelForTask({ ...input, providers: low })?.selection.instanceId).toBe("claude");
    expect(
      chooseModelForTask({ ...input, providers: low, mode: "balance-accounts" })?.selection
        .instanceId,
    ).toBe("codex");
  });
});

describe("resolveNewThreadModelRoute", () => {
  const providers = [provider("codex", { session: 90 }), provider("codex-2", { session: 10 })];
  const withMode = (autoModelSelection: "off" | "balance-accounts" | "any-provider") => ({
    ...DEFAULT_SERVER_SETTINGS,
    autoModelSelection,
    providerInstances: Object.fromEntries(
      ["codex", "codex-2", "claude", "claude-2"].map((id) => [
        ProviderInstanceId.make(id),
        { driver: id.startsWith("claude") ? CLAUDE : CODEX, enabled: true, config: {} },
      ]),
    ),
  });
  const base = { defaultSelection: desired, fallbackSelection: null, providers, now };

  it("leaves new threads alone when the setting is off", () => {
    expect(resolveNewThreadModelRoute({ ...base, settings: withMode("off") })).toMatchObject({
      selection: desired,
      auto: null,
    });
  });

  it("routes the default and never overrides an explicit selection", () => {
    const settings = withMode("balance-accounts");
    expect(resolveNewThreadModelRoute({ ...base, settings })).toMatchObject({
      selection: { instanceId: "codex-2" },
      fallback: null,
      auto: { crossProvider: false },
    });
    expect(
      resolveNewThreadModelRoute({ ...base, settings, explicitSelection: desired }).selection,
    ).toEqual(desired);
  });

  it("prefers a configured fallback over a cross-kind route", () => {
    const fallbackSelection = {
      instanceId: ProviderInstanceId.make("claude-2"),
      model: "claude-haiku-5-5",
    };
    const result = resolveNewThreadModelRoute({
      ...base,
      fallbackSelection,
      providers: [
        provider("codex", { session: 100 }),
        provider("claude", { session: 0 }),
        provider("claude-2", { session: 50 }),
      ],
      settings: withMode("any-provider"),
    });
    expect(result.selection).toEqual(fallbackSelection);
    expect(result.auto).toBeNull();
  });
});
