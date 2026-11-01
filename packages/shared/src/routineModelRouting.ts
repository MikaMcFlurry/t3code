import type {
  ModelSelection,
  ProjectId,
  ProviderOptionSelection,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";

import { inferTaskProfileFromPrompt } from "./autoLaunchPlan.ts";
import {
  chooseModelForTask,
  filterAllowedProviders,
  routeModelSelection,
} from "./autoModelRouting.ts";
import { createModelSelection } from "./model.ts";

/** What a webhook body may ask for under its `t3` key. Every field is optional. */
export interface RoutineRoutingDirective {
  readonly routing?: "auto" | "fixed";
  /** `instanceId/model`, used as is when that account can run it. */
  readonly model?: string;
  /** Narrows the allowed list further for this run; same entry format as the setting. */
  readonly allowed?: ReadonlyArray<string>;
  readonly effort?: string;
}

export interface RoutineModelRoute {
  readonly selection: ModelSelection;
  readonly reason: string;
}

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

/**
 * Model for a scheduled or webhook run. Precedence: an explicit `model`, then `routing: "auto"`
 * (task profile from the prompt, most headroom among allowed models), then the global automatic
 * account setting applied to the stored selection, then the stored selection unchanged.
 */
export function resolveRoutineModelSelection(input: {
  readonly stored: ModelSelection;
  readonly prompt: string;
  readonly directive: RoutineRoutingDirective | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId | null;
  readonly now: number;
}): RoutineModelRoute {
  const { directive, settings } = input;
  const allowed = filterAllowedProviders(input.providers, [
    settings.autoRoutingAllowed,
    directive?.allowed ?? [],
  ]);
  const context = { providers: allowed, settings, projectId: input.projectId, now: input.now };
  const effort = (selection: ModelSelection) => withEffort(selection, allowed, directive?.effort);

  if (directive?.model) {
    const cut = directive.model.indexOf("/");
    const instanceId = directive.model.slice(0, cut);
    const model = directive.model.slice(cut + 1);
    const provider = allowed.find((candidate) => candidate.instanceId === instanceId);
    if (provider?.models.some((candidate) => candidate.slug === model)) {
      return {
        selection: effort(createModelSelection(provider.instanceId, model, null)),
        reason: `Requested ${directive.model}.`,
      };
    }
  }

  const byProfile = () =>
    chooseModelForTask({ ...context, profile: inferTaskProfileFromPrompt(input.prompt) });

  if (directive?.routing === "auto") {
    const route = byProfile();
    if (route) return { selection: effort(route.selection), reason: route.reason };
  }

  if (directive?.routing !== "fixed" && settings.autoModelSelection !== "off") {
    const route = routeModelSelection({
      ...context,
      desired: input.stored,
      mode: settings.autoModelSelection,
    });
    if (route) return { selection: effort(route.selection), reason: route.reason };
  }

  const storedAllowed = allowed.some(
    (provider) =>
      provider.instanceId === input.stored.instanceId &&
      provider.models.some((model) => model.slug === input.stored.model),
  );
  if (!storedAllowed) {
    // The stored model is outside the allowed list; never run it, pick an allowed one instead.
    const route = byProfile();
    if (route) return { selection: effort(route.selection), reason: route.reason };
  }
  return {
    selection: effort(input.stored),
    reason: storedAllowed
      ? "Stored model."
      : "No allowed model is available; using the stored model.",
  };
}
