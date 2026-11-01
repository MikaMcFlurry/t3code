import {
  type AutoModelSelectionMode,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isProviderAvailable,
  type ModelCapabilities,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";

import { createModelSelection, modelSelectionsEqual } from "./model.ts";
import { planUsageResets, type ResetPlan, resetPlanAdjustment } from "./resetPlanner.ts";
import { exhaustedUsageWindow, resolveNewThreadModelSelection } from "./usageLimits.ts";

export type AutoRoutingMode = Exclude<AutoModelSelectionMode, "off">;
export type TaskProfile = "light" | "standard" | "heavy";

export interface AutoModelRoute {
  readonly selection: ModelSelection;
  /** One short sentence for tooltips and logs. */
  readonly reason: string;
  /** Remaining percent of the scarcer usage window; null when the account reports none. */
  readonly headroom: number | null;
  /** True when the route left the desired provider kind. */
  readonly crossProvider: boolean;
}

export interface AutoModelRoutingContext {
  readonly providers: readonly ServerProvider[];
  readonly now: number;
  /** Applies per-project provider enablement when present. */
  readonly settings?: ServerSettings;
  readonly projectId?: ProjectId | null;
}

/** Accounts without usage data rank below a half-used account but above a nearly empty one. */
const UNKNOWN_HEADROOM = 35;
/** `any-provider` leaves the preferred kind only when its best account scores below this. */
const LOW_HEADROOM = 15;

const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort", "thinking"]);

/**
 * light: text-generation model at low effort; standard: default model and effort;
 * heavy: default model at high, then xhigh, then max. Prompt-injected efforts are never chosen.
 */
const EFFORT_PREFERENCE: Record<Exclude<TaskProfile, "standard">, readonly string[]> = {
  light: ["low", "minimal", "medium"],
  heavy: ["high", "xhigh", "max"],
};

function instanceName(provider: ServerProvider) {
  return provider.displayName ?? provider.instanceId;
}

function windowRemaining(window: ServerProviderUsageWindow, now: number) {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(resetsAt) && resetsAt <= now ? 100 : 100 - window.usedPercent;
}

/** Session and weekly windows when reported; providers with only other windows use those. */
function remainingPercents(provider: ServerProvider, now: number) {
  const windows = provider.usageLimits?.windows ?? [];
  const timed = windows.filter((window) => window.kind === "session" || window.kind === "weekly");
  return (timed.length > 0 ? timed : windows).map((window) => windowRemaining(window, now));
}

/** Remaining percent of the scarcer usage window; null without usage data. */
export function instanceHeadroom(provider: ServerProvider, now: number): number | null {
  const remaining = remainingPercents(provider, now);
  return remaining.length > 0 ? Math.min(...remaining) : null;
}

/** The scarcer window dominates; the average separates accounts that tie on it. */
function headroomScore(provider: ServerProvider, now: number) {
  const remaining = remainingPercents(provider, now);
  if (remaining.length === 0) return UNKNOWN_HEADROOM;
  const mean = remaining.reduce((sum, value) => sum + value, 0) / remaining.length;
  return 0.8 * Math.min(...remaining) + 0.2 * mean;
}

function isUsable(provider: ServerProvider, model: string, context: AutoModelRoutingContext) {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated" &&
    (!context.settings ||
      resolveProjectProviderInstanceEnabled(
        context.settings,
        context.projectId ?? null,
        provider.instanceId,
      )) &&
    !exhaustedUsageWindow(provider, context.now, model)
  );
}

function effortOption(
  capabilities: ModelCapabilities | null,
  profile: TaskProfile,
): ProviderOptionSelection | null {
  const descriptor = capabilities?.optionDescriptors?.find(
    (candidate) => candidate.type === "select" && EFFORT_OPTION_IDS.has(candidate.id),
  );
  if (!descriptor || descriptor.type !== "select") return null;
  const choices = descriptor.options.filter(
    (option) => !descriptor.promptInjectedValues?.includes(option.id),
  );
  const value =
    profile === "standard"
      ? (choices.find((option) => option.isDefault)?.id ??
        choices.find((option) => option.id === descriptor.currentValue)?.id ??
        choices.find((option) => option.id === "medium")?.id)
      : EFFORT_PREFERENCE[profile].find((effort) => choices.some((option) => option.id === effort));
  return value ? { id: descriptor.id, value } : null;
}

/** The selection a task profile maps to on one instance, or null when it lists no models. */
export function modelForTaskProfile(
  provider: ServerProvider,
  profile: TaskProfile,
): ModelSelection | null {
  const models = provider.models.filter((model) => !model.isLegacy);
  const bySlug = (slug: string | undefined) => models.find((model) => model.slug === slug);
  const defaultModel =
    models.find((model) => model.isDefault) ??
    bySlug(DEFAULT_MODEL_BY_PROVIDER[provider.driver]) ??
    models[0];
  const model =
    profile === "light"
      ? (bySlug(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider.driver]) ?? defaultModel)
      : defaultModel;
  if (!model) return null;
  const effort = effortOption(model.capabilities, profile);
  return createModelSelection(provider.instanceId, model.slug, effort ? [effort] : null);
}

function inferTaskProfile(provider: ServerProvider, selection: ModelSelection): TaskProfile {
  if (selection.model === DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider.driver]) {
    return "light";
  }
  const effort = selection.options?.find((option) => EFFORT_OPTION_IDS.has(option.id))?.value;
  if (typeof effort !== "string") return "standard";
  if (EFFORT_PREFERENCE.heavy.includes(effort)) return "heavy";
  return effort === "low" || effort === "minimal" ? "light" : "standard";
}

interface Candidate {
  readonly provider: ServerProvider;
  readonly selection: ModelSelection;
  /** Headroom plus the reset plan's adjustment; ranks candidates. */
  readonly score: number;
  /** Headroom alone; decides whether a provider counts as low. */
  readonly headroom: number;
  readonly planReasons: ReadonlyArray<string>;
}

// One plan per routing call: candidates of the same call share the context object.
const resetPlans = new WeakMap<AutoModelRoutingContext, ResetPlan | null>();

/** The reset plan when staggering or a forecast can change the choice; null otherwise. */
function resetPlanFor(context: AutoModelRoutingContext): ResetPlan | null {
  if (resetPlans.has(context)) return resetPlans.get(context) ?? null;
  const settings = context.settings;
  const plan =
    settings &&
    (settings.usageResetStaggering ||
      settings.usageResetForecast.length > 0 ||
      context.providers.some((provider) => provider.usageLimits?.resetCredits))
      ? planUsageResets({ providers: context.providers, settings, now: context.now })
      : null;
  resetPlans.set(context, plan);
  return plan;
}

function candidate(
  provider: ServerProvider,
  selection: ModelSelection | null,
  context: AutoModelRoutingContext,
): Candidate | null {
  if (!selection || !isUsable(provider, selection.model, context)) return null;
  const plan = resetPlanFor(context);
  const adjustment = plan
    ? resetPlanAdjustment(plan, provider.instanceId, context.now)
    : { score: 0, reasons: [] };
  const headroom = headroomScore(provider, context.now);
  return {
    provider,
    selection,
    score: headroom + adjustment.score,
    headroom,
    planReasons: adjustment.reasons,
  };
}

/** Highest score wins; ties keep the preferred instance, then the lowest instance id. */
function best(candidates: readonly Candidate[], preferred: string | null) {
  let winner: Candidate | null = null;
  for (const entry of candidates) {
    if (
      !winner ||
      entry.score > winner.score ||
      (entry.score === winner.score &&
        winner.provider.instanceId !== preferred &&
        (entry.provider.instanceId === preferred ||
          entry.provider.instanceId < winner.provider.instanceId))
    )
      winner = entry;
  }
  return winner;
}

function describeHeadroom(provider: ServerProvider, now: number) {
  const headroom = instanceHeadroom(provider, now);
  return headroom === null ? "no usage data" : `${Math.round(headroom)}% left`;
}

function toRoute(winner: Candidate, now: number, reason: string, crossProvider: boolean) {
  return {
    selection: winner.selection,
    reason:
      winner.planReasons.length > 0
        ? `${reason} Reset plan: ${winner.planReasons.join(", ")}.`
        : reason,
    headroom: instanceHeadroom(winner.provider, now),
    crossProvider,
  } satisfies AutoModelRoute;
}

function routeAcrossKinds(
  sameKind: Candidate | null,
  otherKinds: readonly Candidate[],
  context: AutoModelRoutingContext,
  preferredLabel: string,
): AutoModelRoute | null {
  const other = sameKind && sameKind.headroom >= LOW_HEADROOM ? null : best(otherKinds, null);
  if (other && (!sameKind || other.score > sameKind.score)) {
    return toRoute(
      other,
      context.now,
      `Picked ${instanceName(other.provider)} (${describeHeadroom(other.provider, context.now)}): every ${preferredLabel} account is low or out of usage.`,
      true,
    );
  }
  return null;
}

/**
 * Picks the account for `desired` with the most usage headroom. `balance-accounts` stays on
 * the desired provider kind and model; `any-provider` may move to another kind's model of the
 * same profile when every account of the desired kind is low. Null when nothing is usable.
 */
export function routeModelSelection(
  input: AutoModelRoutingContext & {
    readonly desired: ModelSelection;
    readonly mode: AutoRoutingMode;
  },
): AutoModelRoute | null {
  const { desired, providers, now } = input;
  const desiredProvider = providers.find((provider) => provider.instanceId === desired.instanceId);
  if (!desiredProvider) return null;
  const sameKind = best(
    providers
      .filter(
        (provider) =>
          provider.driver === desiredProvider.driver &&
          (provider === desiredProvider ||
            provider.models.some((model) => model.slug === desired.model)),
      )
      .flatMap(
        (provider) =>
          candidate(
            provider,
            provider === desiredProvider
              ? desired
              : createModelSelection(provider.instanceId, desired.model, desired.options),
            input,
          ) ?? [],
      ),
    desired.instanceId,
  );
  if (input.mode === "any-provider") {
    const profile = inferTaskProfile(desiredProvider, desired);
    const crossed = routeAcrossKinds(
      sameKind,
      providers
        .filter((provider) => provider.driver !== desiredProvider.driver)
        .flatMap(
          (provider) => candidate(provider, modelForTaskProfile(provider, profile), input) ?? [],
        ),
      input,
      instanceName(desiredProvider),
    );
    if (crossed) return crossed;
  }
  if (!sameKind) return null;
  const kept = sameKind.provider === desiredProvider;
  return toRoute(
    sameKind,
    now,
    kept
      ? `Kept ${instanceName(desiredProvider)}: it has the most usage left (${describeHeadroom(desiredProvider, now)}).`
      : `Picked ${instanceName(sameKind.provider)} (${describeHeadroom(sameKind.provider, now)}) over ${instanceName(desiredProvider)} (${isUsable(desiredProvider, desired.model, input) ? describeHeadroom(desiredProvider, now) : "out of usage"}).`,
    false,
  );
}

/**
 * Picks a model, effort, and account for a task profile. Without `preferredDriver`, every
 * usable instance competes on headroom. With it, `balance-accounts` stays on that kind and
 * `any-provider` (the default) leaves it only when all its accounts are low.
 */
export function chooseModelForTask(
  input: AutoModelRoutingContext & {
    readonly profile: TaskProfile;
    readonly preferredDriver?: ProviderDriverKind | null;
    readonly mode?: AutoRoutingMode;
  },
): AutoModelRoute | null {
  const candidates = input.providers.flatMap(
    (provider) => candidate(provider, modelForTaskProfile(provider, input.profile), input) ?? [],
  );
  const preferred = input.preferredDriver ?? null;
  if (preferred === null) {
    const winner = best(candidates, null);
    return winner
      ? toRoute(
          winner,
          input.now,
          `Picked ${instanceName(winner.provider)} for a ${input.profile} task: it has the most usage left (${describeHeadroom(winner.provider, input.now)}).`,
          false,
        )
      : null;
  }
  const sameKind = best(
    candidates.filter((entry) => entry.provider.driver === preferred),
    null,
  );
  if ((input.mode ?? "any-provider") === "any-provider") {
    const crossed = routeAcrossKinds(
      sameKind,
      candidates.filter((entry) => entry.provider.driver !== preferred),
      input,
      preferred,
    );
    if (crossed) return crossed;
  }
  return sameKind
    ? toRoute(
        sameKind,
        input.now,
        `Picked ${instanceName(sameKind.provider)} for a ${input.profile} task (${describeHeadroom(sameKind.provider, input.now)}).`,
        false,
      )
    : null;
}

function matchesEntry(provider: ServerProvider, entry: string) {
  const trimmed = entry.trim();
  if (trimmed.startsWith("driver:")) return provider.driver === trimmed.slice("driver:".length);
  const [instanceId] = trimmed.split("/", 1);
  return provider.instanceId === instanceId;
}

/**
 * Keeps providers an entry allows; `instanceId/model` entries also narrow that provider's models.
 * Every list must allow a provider, so a webhook can narrow the setting but never widen it.
 */
export function filterAllowedProviders(
  providers: ReadonlyArray<ServerProvider>,
  lists: ReadonlyArray<ReadonlyArray<string>>,
): ServerProvider[] {
  const active = lists.filter((list) => list.length > 0);
  return providers.flatMap((provider) => {
    let models = provider.models;
    for (const list of active) {
      const entries = list.filter((entry) => matchesEntry(provider, entry));
      if (entries.length === 0) return [];
      const slugs = entries.flatMap((entry) => {
        const cut = entry.indexOf("/");
        return cut < 0 ? [] : [entry.slice(cut + 1).trim()];
      });
      if (slugs.length > 0 && entries.every((entry) => entry.includes("/"))) {
        models = models.filter((model) => slugs.includes(model.slug));
      }
    }
    return models.length > 0 ? [{ ...provider, models }] : [];
  });
}

/**
 * `resolveNewThreadModelSelection` plus the opt-in `autoModelSelection` setting. `auto` is set
 * only when routing changed the selection; a configured fallback still beats a cross-kind route.
 */
export function resolveNewThreadModelRoute(
  input: Parameters<typeof resolveNewThreadModelSelection>[0],
) {
  const base = { ...resolveNewThreadModelSelection(input), auto: null };
  const mode = input.settings?.autoModelSelection ?? "off";
  const desired = input.defaultSelection;
  if (mode === "off" || input.explicitSelection || !desired) return base;
  const route = routeModelSelection({
    ...input,
    providers: filterAllowedProviders(input.providers, [input.settings?.autoRoutingAllowed ?? []]),
    desired,
    mode,
  });
  if (
    !route ||
    (route.crossProvider && base.fallback) ||
    modelSelectionsEqual(route.selection, desired)
  )
    return base;
  return { selection: route.selection, fallback: null, auto: route };
}
