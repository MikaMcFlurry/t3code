import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  inferTaskProfileFromPrompt,
  planAutoLaunch,
  rankProjectsForPrompt,
  suggestProjectName,
} from "./autoLaunchPlan.ts";

const projects = [
  {
    id: ProjectId.make("website"),
    title: "Mikahertler Website",
    workspaceRoot: "D:\\Projects\\mikahertler-website",
  },
  {
    id: ProjectId.make("books"),
    title: "Buchhaltung Tool",
    workspaceRoot: "D:\\Projects\\buchhaltung-tool",
  },
];

describe("autoLaunchPlan", () => {
  it("ranks projects by words shared with the prompt, titles above paths", () => {
    const ranked = rankProjectsForPrompt("Fix the login on my website", projects);
    expect(ranked.map((entry) => entry.project.id)).toEqual(["website"]);
    expect(ranked[0]?.matched).toEqual(["website"]);
    expect(ranked[0]?.score).toBe(3);
  });

  it("reads task size from the prompt", () => {
    expect(inferTaskProfileFromPrompt("Refactor the billing architecture")).toBe("heavy");
    expect(inferTaskProfileFromPrompt("Erkläre kurz die Funktion")).toBe("light");
    expect(inferTaskProfileFromPrompt("Add a footer link")).toBe("standard");
    expect(inferTaskProfileFromPrompt("x".repeat(900))).toBe("heavy");
  });

  it("offers a new project when nothing matches", () => {
    const plan = planAutoLaunch({
      prompt: "Baue eine Wetter App für Kinder",
      projects,
      providers: [],
      now: 0,
    });
    expect(plan.project).toBeNull();
    expect(plan.route).toBeNull();
    expect(plan.suggestedProjectName).toBe("wetter-app-kinder");
  });

  it("picks the best matching project", () => {
    const plan = planAutoLaunch({
      prompt: "Buchhaltung: neue Rechnung exportieren",
      projects,
      providers: [],
      now: 0,
    });
    expect(plan.project?.project.id).toBe("books");
    expect(suggestProjectName("")).toBe("new-project");
  });
});
