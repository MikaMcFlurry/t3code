import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTaskModelRouting,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterAllowedProviders } from "./autoModelRouting.ts";
import {
  parseRoutineRoutingDirective,
  resolveRoutineModelSelection,
} from "./routineModelRouting.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

function model(slug: string, optionId: string, isDefault = false): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    ...(isDefault ? { isDefault: true } : {}),
    capabilities: {
      optionDescriptors: [
        {
          id: optionId,
          label: "Effort",
          type: "select",
          options: ["low", "medium", "high"].map((id) => ({
            id,
            label: id,
            ...(id === "medium" ? { isDefault: true } : {}),
          })),
        },
      ],
    },
  };
}

function provider(instanceId: string, usedPercent: number): ServerProvider {
  const claude = instanceId.startsWith("claude");
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: claude ? CLAUDE : CODEX,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: claude
      ? [model("claude-opus-5-5", "effort", true), model("claude-haiku-5-5", "effort")]
      : [model("gpt-6-astra", "reasoningEffort", true), model("gpt-6-luna", "reasoningEffort")],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2026-09-03T14:00:00.000Z",
        },
      ],
    },
  };
}

const providers = [provider("claude-1", 90), provider("claude-2", 20), provider("codex-1", 10)];
const stored = { instanceId: ProviderInstanceId.make("claude-1"), model: "claude-opus-5-5" };
const settings = (patch: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    providers.map((entry) => [
      entry.instanceId,
      { driver: entry.driver, enabled: true, config: {} },
    ]),
  ),
  ...patch,
});
const route = (input: {
  readonly prompt?: string;
  readonly body?: unknown;
  readonly settings?: ServerSettings;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly routing?: ScheduledTaskModelRouting;
}) =>
  resolveRoutineModelSelection({
    ...(input.routing === undefined ? {} : { taskRouting: input.routing }),
    stored,
    prompt: input.prompt ?? "Check the contact forms",
    directive:
      input.body === undefined ? null : parseRoutineRoutingDirective(JSON.stringify(input.body)),
    providers: input.providers ?? providers,
    settings: input.settings ?? settings(),
    projectId: null,
    now,
  });
/** A route that starts; fails the test otherwise. */
const resolve = (input: Parameters<typeof route>[0]) => {
  const result = route(input);
  if (!result.startable) throw new Error(`Expected a startable route: ${result.reason}`);
  return result;
};

describe("routineModelRouting", () => {
  it("reads only a well-formed t3 object from the webhook body", () => {
    expect(parseRoutineRoutingDirective('{"task":"x"}')).toBeNull();
    expect(parseRoutineRoutingDirective("not json")).toBeNull();
    expect(
      parseRoutineRoutingDirective(
        '{"t3":{"routing":"auto","allowed":["driver:codex",3],"effort":"high","model":"bad"}}',
      ),
    ).toEqual({ routing: "auto", allowed: ["driver:codex"], effort: "high" });
  });

  it("keeps the stored model when nothing asks for routing", () => {
    expect(resolve({}).selection).toEqual(stored);
  });

  it("uses an explicitly requested model with the requested effort", () => {
    expect(
      resolve({ body: { t3: { model: "codex-1/gpt-6-luna", effort: "high" } } }).selection,
    ).toEqual({
      instanceId: "codex-1",
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("auto-routes to the allowed account with the most headroom", () => {
    expect(resolve({ body: { t3: { routing: "auto" } } }).selection.instanceId).toBe("codex-1");
    expect(
      resolve({ body: { t3: { routing: "auto", allowed: ["driver:claudeAgent"] } } }).selection
        .instanceId,
    ).toBe("claude-2");
  });

  it("lets a webhook narrow the allowed setting but never widen it", () => {
    const narrowed = filterAllowedProviders(providers, [["claude-2", "codex-1"], ["driver:codex"]]);
    expect(narrowed.map((entry) => entry.instanceId)).toEqual(["codex-1"]);
    const result = resolve({
      body: { t3: { model: "claude-1/claude-opus-5-5" } },
      settings: settings({ autoRoutingAllowed: ["claude-2"] }),
    });
    expect(result.selection.instanceId).toBe("claude-2");
  });

  it("narrows models with instance/model entries", () => {
    const narrowed = filterAllowedProviders(providers, [["claude-2/claude-haiku-5-5"]]);
    expect(narrowed.map((entry) => entry.models.map((item) => item.slug))).toEqual([
      ["claude-haiku-5-5"],
    ]);
  });

  it("applies the global automatic account setting to the stored model", () => {
    expect(
      resolve({ settings: settings({ autoModelSelection: "balance-accounts" }) }).selection
        .instanceId,
    ).toBe("claude-2");
    expect(
      resolve({
        body: { t3: { routing: "fixed" } },
        settings: settings({ autoModelSelection: "balance-accounts" }),
      }).selection.instanceId,
    ).toBe("claude-1");
  });

  it("does not start a run whose allowed lists match no model", () => {
    // The webhook narrows to codex, the setting allows only claude-2: nothing is left.
    const result = route({
      body: { t3: { allowed: ["driver:codex"] } },
      settings: settings({ autoRoutingAllowed: ["claude-2"] }),
    });
    expect(result).toMatchObject({ startable: false, code: "no-allowed-model" });
    expect(result).not.toHaveProperty("selection");
    expect(result.reason).toContain("claude-1/claude-opus-5-5");
  });

  it("does not start a run when every allowed model is unavailable", () => {
    const unavailable = providers.map((entry) =>
      entry.instanceId === "claude-2" ? { ...entry, status: "error" as const } : entry,
    );
    for (const body of [undefined, { t3: { routing: "auto" } }]) {
      const result = route({
        body,
        providers: unavailable,
        settings: settings({ autoRoutingAllowed: ["claude-2"] }),
      });
      expect(result).toMatchObject({ startable: false, code: "no-allowed-model-available" });
      expect(result.reason).toContain("claude-2");
    }
    // An explicitly requested model outside the list does not get around it either.
    expect(
      route({
        body: { t3: { model: "claude-1/claude-opus-5-5" } },
        providers: unavailable,
        settings: settings({ autoRoutingAllowed: ["claude-2"] }),
      }),
    ).toMatchObject({ startable: false, code: "no-allowed-model-available" });
  });

  it("runs an allowed stored model even when routing finds nothing better", () => {
    expect(resolve({ settings: settings({ autoRoutingAllowed: ["claude-1"] }) }).selection).toEqual(
      stored,
    );
  });

  it("treats no allowed list as allowing every model, the stored one included", () => {
    // Nothing usable to route to, but no list excludes the stored model.
    const none = providers.map((entry) => ({ ...entry, status: "error" as const }));
    expect(resolve({ providers: none, body: { t3: { routing: "auto" } } }).selection).toEqual(
      stored,
    );
  });

  describe("per-task priority routing", () => {
    // claude-1 has 10% left, claude-2 80%, codex-1 90%.
    it("runs the first usable candidate in priority order, not the one with most headroom", () => {
      const result = resolve({ routing: { candidates: ["claude-1", "codex-1", "claude-2"] } });
      expect(result.selection).toEqual(stored);
      expect(result.reason).toContain("claude-1");
    });

    it("skips a candidate with less than the threshold left", () => {
      const result = resolve({
        routing: { candidates: ["claude-1", "codex-1", "claude-2"], minUsageLeftPercent: 20 },
      });
      // codex-1 does not offer the stored model, so it runs its default model for the profile.
      expect(result.selection).toMatchObject({ instanceId: "codex-1", model: "gpt-6-astra" });
    });

    it("falls back to the candidate with the most usage left when none reaches the threshold", () => {
      const result = resolve({
        routing: { candidates: ["claude-2", "claude-1", "codex-1"], minUsageLeftPercent: 95 },
      });
      expect(result.selection.instanceId).toBe("codex-1");
      expect(result.reason).toContain("most usage left");
    });

    it("keeps priority order between candidates that tie on headroom in the fallback", () => {
      const tied = [provider("claude-1", 50), provider("claude-2", 50), provider("codex-1", 50)];
      const result = resolve({
        providers: tied,
        routing: { candidates: ["claude-2", "codex-1", "claude-1"], minUsageLeftPercent: 60 },
      });
      expect(result.selection.instanceId).toBe("claude-2");
    });

    it("stays inside the global allowed list, which a task list can narrow but never widen", () => {
      const allowed = settings({ autoRoutingAllowed: ["driver:claudeAgent"] });
      expect(
        resolve({ settings: allowed, routing: { candidates: ["codex-1", "claude-2"] } }).selection
          .instanceId,
      ).toBe("claude-2");
      // A list naming only models outside the setting starts nothing, not the stored model.
      const outside = route({ settings: allowed, routing: { candidates: ["codex-1"] } });
      expect(outside).toMatchObject({ startable: false, code: "no-allowed-model" });
      // A webhook's t3.allowed narrows it further.
      expect(
        route({
          body: { t3: { allowed: ["claude-1"] } },
          routing: { candidates: ["claude-2"] },
        }),
      ).toMatchObject({ startable: false, code: "no-allowed-model" });
    });

    it("skips unknown, unavailable and exhausted candidates", () => {
      const mixed = [
        { ...provider("codex-1", 10), status: "error" as const },
        provider("claude-1", 100),
        provider("claude-2", 20),
      ];
      const result = resolve({
        providers: mixed,
        routing: {
          candidates: ["missing", "claude-2/no-such-model", "codex-1", "claude-1", "claude-2"],
        },
      });
      expect(result.selection).toEqual({ ...stored, instanceId: "claude-2" });
    });

    it("does not start when no candidate is usable", () => {
      const down = providers.map((entry) => ({ ...entry, status: "error" as const }));
      const result = route({
        providers: down,
        routing: { candidates: ["claude-2", "codex-1"], minUsageLeftPercent: 20 },
      });
      expect(result).toMatchObject({ startable: false, code: "no-allowed-model-available" });
      expect(result.reason).toContain("claude-2");
    });

    it("judges a candidate only by the usage windows its model uses", () => {
      const scoped: ServerProvider = {
        ...provider("codex-1", 10),
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 10,
              resetsAt: "2026-09-03T14:00:00.000Z",
            },
            {
              id: "luna_weekly",
              kind: "weekly",
              label: "Luna",
              usedPercent: 95,
              resetsAt: "2026-09-08T00:00:00.000Z",
              modelIds: ["gpt-6-luna"],
            },
          ],
        },
      };
      const routing = (candidates: string[]) => ({ candidates, minUsageLeftPercent: 20 });
      const list = [scoped, provider("claude-2", 20)];
      expect(
        resolve({ providers: list, routing: routing(["codex-1/gpt-6-astra", "claude-2"]) })
          .selection.model,
      ).toBe("gpt-6-astra");
      expect(
        resolve({ providers: list, routing: routing(["codex-1/gpt-6-luna", "claude-2"]) }).selection
          .instanceId,
      ).toBe("claude-2");
    });

    it("counts a window whose reset has passed as full", () => {
      const reset: ServerProvider = {
        ...provider("claude-1", 95),
        usageLimits: {
          checkedAt: "2026-09-03T08:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 95,
              resetsAt: "2026-09-03T11:00:00.000Z",
            },
          ],
        },
      };
      expect(
        resolve({
          providers: [reset, provider("claude-2", 0)],
          routing: { candidates: ["claude-1", "claude-2"], minUsageLeftPercent: 50 },
        }).selection.instanceId,
      ).toBe("claude-1");
    });

    it("lets an account without usage data pass the threshold", () => {
      const { usageLimits: _omitted, ...unknown } = provider("codex-1", 0);
      expect(
        resolve({
          providers: [provider("claude-1", 90), unknown],
          routing: { candidates: ["claude-1", "codex-1"], minUsageLeftPercent: 20 },
        }).selection.instanceId,
      ).toBe("codex-1");
    });

    it("tries a driver entry's accounts with the most usage left first", () => {
      expect(
        resolve({ routing: { candidates: ["driver:claudeAgent"], minUsageLeftPercent: 20 } })
          .selection,
      ).toEqual({ ...stored, instanceId: "claude-2" });
    });

    it("leaves a webhook's explicit model and fixed routing in charge of their run", () => {
      const routing = { candidates: ["codex-1"] };
      expect(
        resolve({ routing, body: { t3: { model: "claude-2/claude-haiku-5-5" } } }).selection,
      ).toMatchObject({ instanceId: "claude-2", model: "claude-haiku-5-5" });
      expect(resolve({ routing, body: { t3: { routing: "fixed" } } }).selection).toEqual(stored);
      // routing: "auto" and the global account setting give way to the task's list.
      expect(
        resolve({
          routing,
          body: { t3: { routing: "auto" } },
          settings: settings({ autoModelSelection: "any-provider" }),
        }).selection.instanceId,
      ).toBe("codex-1");
    });

    it("applies a webhook's effort to the candidate it picks", () => {
      expect(
        resolve({ routing: { candidates: ["codex-1"] }, body: { t3: { effort: "high" } } })
          .selection.options,
      ).toEqual([{ id: "reasoningEffort", value: "high" }]);
    });
  });
});
