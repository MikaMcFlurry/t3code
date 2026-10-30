import type { ProjectId } from "@t3tools/contracts";

import {
  type AutoModelRoute,
  type AutoModelRoutingContext,
  chooseModelForTask,
  filterAllowedProviders,
  type TaskProfile,
} from "./autoModelRouting.ts";

export interface AutoLaunchProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface RankedAutoLaunchProject {
  readonly project: AutoLaunchProject;
  readonly score: number;
  readonly matched: ReadonlyArray<string>;
}

export interface AutoLaunchPlan {
  /** Null when no project matches the prompt well enough; offer a new one. */
  readonly project: RankedAutoLaunchProject | null;
  readonly ranked: ReadonlyArray<RankedAutoLaunchProject>;
  readonly profile: TaskProfile;
  readonly route: AutoModelRoute | null;
  readonly suggestedProjectName: string;
}

const STOP_WORDS = new Set(
  (
    "the and for with that this from into have please make add fix use new code repo " +
    "build create write baue bau erstelle schreibe implementiere " +
    "der die das und mit für ein eine einen dem den des bitte mach mache auf aus bei ist " +
    "sind wie was noch auch nicht oder dass zum zur von vom neue neues neuen"
  ).split(" "),
);

const HEAVY_HINTS =
  /\b(refactor\w*|architekt\w*|architecture|migrat\w*|implement\w*|feature\w*|umbau\w*|rewrite|neu bauen|redesign|security|sicherheit\w*|audit\w*|end-to-end|komplett\w*|full app|from scratch|von grund auf)\b/i;
const LIGHT_HINTS =
  /\b(typo\w*|tippfehler|rename|umbenennen|explain|erkläre?\w*|summar\w*|zusammenfass\w*|question|frage|kurz\w*|quick|small|klein\w*|translate|übersetz\w*|format\w*)\b/i;
const LONG_PROMPT_CHARS = 800;
const MIN_PROJECT_SCORE = 2;

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (word) => !STOP_WORDS.has(word),
  );
}

/** Long or architectural prompts get a heavy profile; quick questions and small edits a light one. */
export function inferTaskProfileFromPrompt(prompt: string): TaskProfile {
  if (HEAVY_HINTS.test(prompt) || prompt.length > LONG_PROMPT_CHARS) return "heavy";
  if (LIGHT_HINTS.test(prompt)) return "light";
  return "standard";
}

/** Title words count twice as much as folder-path words. */
export function rankProjectsForPrompt(
  prompt: string,
  projects: ReadonlyArray<AutoLaunchProject>,
): RankedAutoLaunchProject[] {
  const promptWords = new Set(words(prompt));
  return projects
    .map((project) => {
      const titleWords = new Set(words(project.title));
      const pathWords = new Set(words(project.workspaceRoot.split(/[\\/]/).slice(-3).join(" ")));
      const matched = [...promptWords].filter(
        (word) => titleWords.has(word) || pathWords.has(word),
      );
      const score = matched.reduce(
        (sum, word) => sum + (titleWords.has(word) ? 2 : 0) + (pathWords.has(word) ? 1 : 0),
        0,
      );
      return { project, score, matched };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.project.title.localeCompare(right.project.title),
    );
}

export function suggestProjectName(prompt: string): string {
  const name = words(prompt).slice(0, 3).join("-");
  return name.length > 0 ? name : "new-project";
}

/** Picks a project from the prompt, a task profile, and the model and account to run it on. */
export function planAutoLaunch(
  input: AutoModelRoutingContext & {
    readonly prompt: string;
    readonly projects: ReadonlyArray<AutoLaunchProject>;
  },
): AutoLaunchPlan {
  const ranked = rankProjectsForPrompt(input.prompt, input.projects);
  const best = ranked[0];
  const project = best && best.score >= MIN_PROJECT_SCORE ? best : null;
  const profile = inferTaskProfileFromPrompt(input.prompt);
  return {
    project,
    ranked,
    profile,
    route: chooseModelForTask({
      providers: filterAllowedProviders(input.providers, [
        input.settings?.autoRoutingAllowed ?? [],
      ]),
      now: input.now,
      profile,
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      ...(project === null ? {} : { projectId: project.project.id }),
    }),
    suggestedProjectName: suggestProjectName(input.prompt),
  };
}
