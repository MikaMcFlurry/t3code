import { describe, expect, it } from "vite-plus/test";

import { centralSkillSourceFromInput } from "./CentralSkillsSection.logic";

describe("centralSkillSourceFromInput", () => {
  it("reads a raw SKILL.md address as a single-file download", () => {
    expect(
      centralSkillSourceFromInput("https://raw.githubusercontent.com/acme/skills/main/SKILL.md"),
    ).toEqual({
      kind: "url",
      url: "https://raw.githubusercontent.com/acme/skills/main/SKILL.md",
    });
  });

  it("clones other remote addresses", () => {
    expect(
      centralSkillSourceFromInput(" https://github.com/acme/skills/tree/main/review "),
    ).toEqual({ kind: "git", url: "https://github.com/acme/skills/tree/main/review" });
    expect(centralSkillSourceFromInput("git@github.com:acme/skills.git")).toEqual({
      kind: "git",
      url: "git@github.com:acme/skills.git",
    });
  });

  it("treats anything else as a folder and ignores blank input", () => {
    expect(centralSkillSourceFromInput("D:\\Skills\\review")).toEqual({
      kind: "path",
      path: "D:\\Skills\\review",
    });
    expect(centralSkillSourceFromInput("   ")).toBeNull();
  });
});
