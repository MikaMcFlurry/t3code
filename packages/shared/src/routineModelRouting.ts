import type {
  ModelSelection,
  ProjectId,
  ProviderOptionSelection,
  ScheduledTaskModelRouting,
  ServerProvider,
  ServerProviderUsageWindow,
  ServerSettings,
} from "@t3tools/contracts";

import { inferTaskProfileFromPrompt } from "./autoLaunchPlan.ts";
import {
  type AutoModelRoutingContext,
  chooseModelForTask,
  filterAllowedProviders,
  inferTaskProfile,
  isUsable,
  modelForTaskProfile,
  routeModelSelection,
} from "./autoModelRouting.ts";
import { createModelSelection } from "./model.ts";
import { exhaustedUsageWindow } from "./usageLimits.ts";

/** What a webhook body may ask for under its `t3` key. Every field is optional. */
export interface RoutineRoutingDirective {
  readonly routing?: "auto" | "fixed";
  /** `instanceId/model`, used as is when that account can run it. */
  readonly model?: string;
  /** Narrows the allowed list further for this run; same entry format as the setting. */
  readonly allowed?: ReadonlyArray<string>;
  readonly effort?: string;
}

export interface RoutineModelStart {
  readonly startable: true;
  readonly selection: ModelSelection;
  readonly reason: string;
}

/**
 * The run must not start: its stored model is outside the allowed list and no allowed model
 * can take it. `no-allowed-model`: the allowed lists match no configured model at all.
 * `no-allowed-model-available`: allowed models exist, but none is usable right now.
 */
export interface RoutineModelNotStartable {
  readonly startable: false;
  readonly code: "no-allowed-model" | "no-allowed-model-available";
  readonly reason: string;
}

export type RoutineModelRoute = RoutineModelStart | RoutineModelNotStartable;

const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort", "thinking"]);

const stringList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : undefined;

/** Reads the `t3` routing object from a webhook body; anything malformed is ignored. */
export function parseRoutineRoutingDirective(bodyText: string): RoutineRoutingDirective | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || !("t3" in body)) return null;
  const raw = (body as { readonly t3: unknown }).t3;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const allowed = stringList(record.allowed);
  const directive: RoutineRoutingDirective = {
    ...(record.routing === "auto" || record.routing === "fixed" ? { routing: record.routing } : {}),
    ...(typeof record.model === "string" && record.model.includes("/")
      ? { model: record.model.trim() }
      : {}),
    ...(allowed ? { allowed } : {}),
    ...(typeof record.effort === "string" && record.effort.trim() !== ""
      ? { effort: record.effort.trim() }
      : {}),
  };
  return Object.keys(directive).length > 0 ? directive : null;
}

function withEffort(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  effort: string | undefined,
): ModelSelection {
  if (effort === undefined) return selection;
  const descriptor = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model)
    ?.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.type === "select" && EFFORT_OPTION_IDS.has(candidate.id),
    );
  if (!descriptor || descriptor.type !== "select") return selection;
  if (!descriptor.options.some((option) => option.id === effort)) return selection;
  const options: ProviderOptionSelection[] = [
    ...(selection.options ?? []).filter((option) => option.id !== descriptor.id),
    { id: descriptor.id, value: effort },
  ];
  return createModelSelection(selection.instanceId, selection.model, options);
}

function windowLeft(window: ServerProviderUsageWindow, now: number) {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(resetsAt) && resetsAt <= now ? 100 : 100 - (window.usedPercent ?? 0);
}

const CLAUDE_SCOPED_WINDOW_PREFIX = "seven_day_";

/**
 * The account as `model` sees it: Claude's model-scoped weekly window counts only for its own
 * model and the monthly spend cap only without plan windows (upstream's `windowLimitsModel`).
 * Where `exhaustedUsageWindow` already applies these rules, this changes nothing.
 */
function forModel(provider: ServerProvider, model: string): ServerProvider {
  const limits = provider.usageLimits;
  if (provider.driver !== "claudeAgent" || !limits) return provider;
  const plan = limits.windows.some(
    (window) => window.id === "five_hour" || window.id === "seven_day",
  );
  const token = model.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const windows = limits.windows.filter((window) =>
    window.id === "monthly_spend"
      ? !plan
      : !window.id.startsWith(CLAUDE_SCOPED_WINDOW_PREFIX) ||
        token.includes(window.id.slice(CLAUDE_SCOPED_WINDOW_PREFIX.length)),
  );
  return windows.length === limits.windows.length
    ? provider
    : { ...provider, usageLimits: { ...limits, windows } };
}

/**
 * Percent left for `model`: the least any window that can stop it has left, by
 * `exhaustedUsageWindow`'s rule (model scopes, pools, credit caps), asked per level as "would
 * spending every window with at most this much left stop it?" 100 if none applies; null if no data.
 */
function modelUsageLeft(account: ServerProvider, now: number, model: string) {
  const provider = forModel(account, model);
  const limits = provider.usageLimits;
  const windows = limits?.windows ?? [];
  // Windows that only limit other models say nothing about this one.
  if (!limits || windows.length === 0) return null;
  const levels = [...new Set(windows.map((window) => windowLeft(window, now)))].sort(
    (a, b) => a - b,
  );
  for (const level of levels) {
    const spent = windows.map((window) =>
      windowLeft(window, now) <= level ? { ...window, usedPercent: 100 } : window,
    );
    if (
      exhaustedUsageWindow({ ...provider, usageLimits: { ...limits, windows: spent } }, now, model)
    )
      return Math.max(0, level);
  }
  return 100;
}

const usableFor = (provider: ServerProvider, model: string, context: AutoModelRoutingContext) =>
  isUsable(forModel(provider, model), model, context);

interface PriorityCandidate {
  readonly entry: string;
  readonly provider: ServerProvider;
  readonly selection: ModelSelection;
  /** Null without usage data. */
  readonly left: number | null;
}

/**
 * The selection one account gives a candidate entry: `model` when named, else the task's model
 * when the account offers it (with its options on the same driver), else the account's model
 * for the task's profile.
 */
function candidateSelection(
  provider: ServerProvider,
  model: string | null,
  stored: ModelSelection,
  storedProvider: ServerProvider | undefined,
): ModelSelection | null {
  const offers = (slug: string) => provider.models.some((entry) => entry.slug === slug);
  const sameDriver = storedProvider?.driver === provider.driver;
  if (model !== null) {
    if (!offers(model)) return null;
    return createModelSelection(
      provider.instanceId,
      model,
      model === stored.model && sameDriver ? (stored.options ?? null) : null,
    );
  }
  if (offers(stored.model)) {
    return createModelSelection(
      provider.instanceId,
      stored.model,
      sameDriver ? (stored.options ?? null) : null,
    );
  }
  const profile = storedProvider ? inferTaskProfile(storedProvider, stored) : "standard";
  return modelForTaskProfile(provider, profile);
}

/** Expands entries in order; a `driver:` entry lists its accounts with the most left first. */
function priorityCandidates(
  routing: ScheduledTaskModelRouting,
  allowed: ReadonlyArray<ServerProvider>,
  stored: ModelSelection,
  storedProvider: ServerProvider | undefined,
  now: number,
): PriorityCandidate[] {
  const seen = new Set<string>();
  const result: PriorityCandidate[] = [];
  for (const raw of routing.candidates) {
    const entry = raw.trim();
    let matches: ReadonlyArray<{ provider: ServerProvider; model: string | null }>;
    if (entry.startsWith("driver:")) {
      const driver = entry.slice("driver:".length);
      matches = allowed
        .filter((provider) => provider.driver === driver)
        .map((provider) => ({ provider, model: null }));
    } else {
      const cut = entry.indexOf("/");
      const instanceId = cut < 0 ? entry : entry.slice(0, cut);
      const provider = allowed.find((candidate) => candidate.instanceId === instanceId);
      matches = provider ? [{ provider, model: cut < 0 ? null : entry.slice(cut + 1).trim() }] : [];
    }
    const group = matches.flatMap(({ provider, model }) => {
      const selection = candidateSelection(provider, model, stored, storedProvider);
      return selection
        ? [{ entry, provider, selection, left: modelUsageLeft(provider, now, selection.model) }]
        : [];
    });
    if (entry.startsWith("driver:")) {
      // Most left first; accounts without usage data after those that report it.
      group.sort(
        (a, b) =>
          (b.left ?? -1) - (a.left ?? -1) ||
          a.provider.instanceId.localeCompare(b.provider.instanceId),
      );
    }
    for (const candidate of group) {
      const key = `${candidate.selection.instanceId}/${candidate.selection.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

const describeLeft = (left: number | null) =>
  left === null ? "no usage data" : `${Math.round(left)}% left`;

/**
 * A task's own routing: the first usable candidate whose model has at least the threshold
 * left, then the first without usage data. When none, the usable one with the most left
 * (earlier entries win ties): a run with the most room beats one that never starts. Not
 * startable only when no candidate is usable at all.
 */
function routeByPriority(
  routing: ScheduledTaskModelRouting,
  allowed: ReadonlyArray<ServerProvider>,
  stored: ModelSelection,
  storedProvider: ServerProvider | undefined,
  context: AutoModelRoutingContext,
): RoutineModelRoute {
  const threshold = routing.minUsageLeftPercent ?? 0;
  const candidates = priorityCandidates(routing, allowed, stored, storedProvider, context.now);
  const usable = candidates.filter((candidate) =>
    usableFor(candidate.provider, candidate.selection.model, context),
  );
  const label = (candidate: PriorityCandidate) =>
    `${candidate.selection.instanceId}/${candidate.selection.model}`;
  // Without usage data nothing shows a threshold is met, so such an account comes after every
  // one that shows it; with no threshold the list order alone decides.
  const passing =
    threshold === 0
      ? usable[0]
      : (usable.find((candidate) => candidate.left !== null && candidate.left >= threshold) ??
        usable.find((candidate) => candidate.left === null));
  if (passing) {
    return {
      startable: true,
      selection: passing.selection,
      reason: `Task routing: ${label(passing)} (${describeLeft(passing.left)}), entry ${passing.entry}.`,
    };
  }
  let most: PriorityCandidate | undefined;
  for (const candidate of usable) {
    if (!most || (candidate.left ?? 0) > (most.left ?? 0)) most = candidate;
  }
  if (most) {
    return {
      startable: true,
      selection: most.selection,
      reason: `Task routing: no candidate has ${threshold}% left; ${label(most)} has the most usage left (${describeLeft(most.left)}).`,
    };
  }
  const entries = routing.candidates.join(", ");
  return candidates.length === 0
    ? {
        startable: false,
        code: "no-allowed-model",
        reason: `Not started: the task's models (${entries}) match no configured account and model within the allowed models.`,
      }
    : {
        startable: false,
        code: "no-allowed-model-available",
        reason: `Not started: none of the task's models (${entries}) is available right now.`,
      };
}

/**
 * Model for a scheduled or webhook run. A task's own list joins the allowed lists and picks,
 * unless a webhook's usable `model` or `routing: "fixed"` names a model in it. Otherwise: `model`,
 * `routing: "auto"`, the automatic account setting, the stored model, never outside allowed lists.
 */
export function resolveRoutineModelSelection(input: {
  readonly stored: ModelSelection;
  readonly prompt: string;
  readonly directive: RoutineRoutingDirective | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId | null;
  readonly now: number;
  /** The task's own priority list and threshold, when it has one. */
  readonly taskRouting?: ScheduledTaskModelRouting | undefined;
}): RoutineModelRoute {
  const { directive, settings, taskRouting } = input;
  const lists = [
    settings.autoRoutingAllowed,
    directive?.allowed ?? [],
    taskRouting?.candidates ?? [],
  ];
  const allowed = filterAllowedProviders(input.providers, lists);
  const context = { providers: allowed, settings, projectId: input.projectId, now: input.now };
  const effort = (selection: ModelSelection) => withEffort(selection, allowed, directive?.effort);
  const allowedProvider = (instanceId: string, model: string) => {
    const provider = allowed.find((candidate) => candidate.instanceId === instanceId);
    return provider?.models.some((candidate) => candidate.slug === model) ? provider : undefined;
  };

  if (directive?.model) {
    const cut = directive.model.indexOf("/");
    const model = directive.model.slice(cut + 1);
    const provider = allowedProvider(directive.model.slice(0, cut), model);
    // A task with its own list runs a requested model only while it can start.
    if (provider && (!taskRouting || usableFor(provider, model, context))) {
      return {
        startable: true,
        selection: effort(createModelSelection(provider.instanceId, model, null)),
        reason: `Requested ${directive.model}.`,
      };
    }
  }

  if (taskRouting) {
    const storedProvider = allowedProvider(input.stored.instanceId, input.stored.model);
    if (
      directive?.routing === "fixed" &&
      storedProvider &&
      usableFor(storedProvider, input.stored.model, context)
    ) {
      return { startable: true, selection: effort(input.stored), reason: "Stored model." };
    }
    const route = routeByPriority(
      taskRouting,
      allowed,
      input.stored,
      input.providers.find((provider) => provider.instanceId === input.stored.instanceId),
      context,
    );
    return route.startable ? { ...route, selection: effort(route.selection) } : route;
  }

  const byProfile = () =>
    chooseModelForTask({ ...context, profile: inferTaskProfileFromPrompt(input.prompt) });

  if (directive?.routing === "auto") {
    const route = byProfile();
    if (route) return { startable: true, selection: effort(route.selection), reason: route.reason };
  }

  if (directive?.routing !== "fixed" && settings.autoModelSelection !== "off") {
    const route = routeModelSelection({
      ...context,
      desired: input.stored,
      mode: settings.autoModelSelection,
    });
    if (route) return { startable: true, selection: effort(route.selection), reason: route.reason };
  }

  const storedAllowed = allowed.some(
    (provider) =>
      provider.instanceId === input.stored.instanceId &&
      provider.models.some((model) => model.slug === input.stored.model),
  );
  if (!storedAllowed) {
    // The stored model is outside the allowed list; never run it, pick an allowed one instead.
    const route = byProfile();
    if (route) return { startable: true, selection: effort(route.selection), reason: route.reason };
    if (lists.some((list) => list.length > 0)) {
      const stored = `${input.stored.instanceId}/${input.stored.model}`;
      return allowed.length === 0
        ? {
            startable: false,
            code: "no-allowed-model",
            reason: `Not started: the stored model ${stored} is not allowed, and the allowed models match no configured account and model.`,
          }
        : {
            startable: false,
            code: "no-allowed-model-available",
            reason: `Not started: the stored model ${stored} is not allowed, and no allowed model (${allowed.map((provider) => provider.instanceId).join(", ")}) is available right now.`,
          };
    }
  }
  // Without an allowed list every model is allowed, so the stored one may run.
  return {
    startable: true,
    selection: effort(input.stored),
    reason: storedAllowed
      ? "Stored model."
      : "No other model is available; using the stored model.",
  };
}
