import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseGitSkillUrl } from "./CentralSkills.ts";
import {
  CENTRAL_SKILL_MIRROR_MARKER,
  centralSkillsClaudeDirectory,
  collectCentralSkillFolders,
  mirrorCentralSkills,
  mirrorCentralSkillsForClaude,
} from "./CentralSkillsMirror.ts";

const writeSkill = Effect.fnUntraced(function* (directory: string, name: string, body: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(directory, name), { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`,
  );
});

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-central-skills-" });
  const skillsDir = path.join(root, "library");
  const targetSkillsDir = path.join(root, "codex-home", "skills");
  return { fileSystem, path, skillsDir, targetSkillsDir };
});

describe("mirrorCentralSkills", () => {
  it.effect("copies enabled skills and keeps user-owned skills untouched", () =>
    Effect.gen(function* () {
      const { fileSystem, path, skillsDir, targetSkillsDir } = yield* setup;
      const library = skillsDir;
      yield* writeSkill(library, "review", "Central review");
      yield* writeSkill(library, "deploy", "Central deploy");
      yield* writeSkill(targetSkillsDir, "deploy", "User deploy");

      const result = yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });

      assert.deepStrictEqual(result, { mirrored: ["review"], shadowed: ["deploy"] });
      const review = yield* fileSystem.readFileString(
        path.join(targetSkillsDir, "review", "SKILL.md"),
      );
      assert.include(review, "Central review");
      assert.isTrue(
        yield* fileSystem.exists(path.join(targetSkillsDir, "review", CENTRAL_SKILL_MIRROR_MARKER)),
      );
      const deploy = yield* fileSystem.readFileString(
        path.join(targetSkillsDir, "deploy", "SKILL.md"),
      );
      assert.include(deploy, "User deploy");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes mirrored copies once the central skill is gone", () =>
    Effect.gen(function* () {
      const { fileSystem, path, skillsDir, targetSkillsDir } = yield* setup;
      const library = skillsDir;
      yield* writeSkill(library, "review", "Central review");
      yield* writeSkill(targetSkillsDir, "notes", "User notes");
      yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });

      yield* fileSystem.remove(path.join(library, "review"), { recursive: true });
      const result = yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });

      assert.deepStrictEqual(result, { mirrored: [], shadowed: [] });
      assert.isFalse(yield* fileSystem.exists(path.join(targetSkillsDir, "review")));
      assert.isTrue(yield* fileSystem.exists(path.join(targetSkillsDir, "notes", "SKILL.md")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("central skill library layout", () => {
  it.effect(
    "reads skill folders placed directly in the skills dir and mirrors them for Claude",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, skillsDir } = yield* setup;
        yield* writeSkill(skillsDir, "mika-dev-studio", "Dropped in by hand");
        yield* writeSkill(skillsDir, "disabled", "Reserved folder name");
        yield* fileSystem.makeDirectory(path.join(skillsDir, "no-skill-file"), { recursive: true });
        const claudeDirectory = centralSkillsClaudeDirectory(path, skillsDir);
        // Installed by an older version straight into the Claude folder: still part of the library.
        yield* writeSkill(claudeDirectory, "legacy", "Old location");

        const folders = yield* collectCentralSkillFolders(fileSystem, path, skillsDir);
        assert.deepStrictEqual([...folders.keys()].sort(), ["legacy", "mika-dev-studio"]);

        const result = yield* mirrorCentralSkillsForClaude(skillsDir);
        assert.deepStrictEqual(result, { mirrored: ["mika-dev-studio"], shadowed: ["legacy"] });
        const copy = path.join(claudeDirectory, "mika-dev-studio");
        assert.include(
          yield* fileSystem.readFileString(path.join(copy, "SKILL.md")),
          "Dropped in by hand",
        );
        assert.isTrue(yield* fileSystem.exists(path.join(copy, CENTRAL_SKILL_MIRROR_MARKER)));
        // A mirrored copy is not a second library entry.
        assert.deepStrictEqual(
          [...(yield* collectCentralSkillFolders(fileSystem, path, skillsDir)).keys()].sort(),
          ["legacy", "mika-dev-studio"],
        );

        yield* fileSystem.remove(path.join(skillsDir, "mika-dev-studio"), { recursive: true });
        yield* mirrorCentralSkillsForClaude(skillsDir);
        assert.isFalse(yield* fileSystem.exists(copy));
        assert.isTrue(yield* fileSystem.exists(path.join(claudeDirectory, "legacy", "SKILL.md")));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("parseGitSkillUrl", () => {
  it("splits a GitHub tree URL into repository, ref and folder", () => {
    assert.deepStrictEqual(
      parseGitSkillUrl({
        kind: "git",
        url: "https://github.com/acme/skills/tree/main/review/pr",
      }),
      { url: "https://github.com/acme/skills.git", ref: "main", subdirectory: "review/pr" },
    );
  });

  it("keeps plain clone URLs and explicit fields", () => {
    assert.deepStrictEqual(
      parseGitSkillUrl({ kind: "git", url: "git@github.com:acme/skills.git", ref: "v1" }),
      { url: "git@github.com:acme/skills.git", ref: "v1", subdirectory: undefined },
    );
  });
});
