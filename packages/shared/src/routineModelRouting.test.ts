import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
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
}) =>
  resolveRoutineModelSelection({
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
});
