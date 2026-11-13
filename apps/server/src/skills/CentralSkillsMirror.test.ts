import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

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

describe("mirrorCentralSkills updates", () => {
  const writeAsset = Effect.fnUntraced(function* (
    directory: string,
    relative: string,
    contents: string,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, relative);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, contents);
  });

  const leftovers = Effect.fnUntraced(function* (targetSkillsDir: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    return (yield* fileSystem.readDirectory(targetSkillsDir)).filter((entry) =>
      entry.startsWith(".t3-"),
    );
  });

  it.effect("syncs a change to an asset, script or reference without touching SKILL.md", () =>
    Effect.gen(function* () {
      const { fileSystem, path, skillsDir, targetSkillsDir } = yield* setup;
      yield* writeSkill(skillsDir, "review", "Central review");
      yield* writeAsset(path.join(skillsDir, "review"), "scripts/run.sh", "echo v1");
      yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });

      // A different size keeps the test independent of the file system's mtime resolution.
      yield* writeAsset(path.join(skillsDir, "review"), "scripts/run.sh", "echo version-2");
      yield* writeAsset(path.join(skillsDir, "review"), "assets/logo.svg", "<svg/>");
      yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });

      const copy = path.join(targetSkillsDir, "review");
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(copy, "scripts", "run.sh")),
        "echo version-2",
      );
      assert.isTrue(yield* fileSystem.exists(path.join(copy, "assets", "logo.svg")));
      assert.deepStrictEqual(yield* leftovers(targetSkillsDir), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs two syncs of the same target one after the other", () =>
    Effect.gen(function* () {
      const { fileSystem, path, skillsDir, targetSkillsDir } = yield* setup;
      yield* writeSkill(skillsDir, "review", "Central review");
      yield* writeSkill(skillsDir, "deploy", "Central deploy");
      const firstCopyStarted = yield* Deferred.make<void>();
      const releaseFirstCopy = yield* Deferred.make<void>();
      let libraryReads = 0;
      let copies = 0;
      const observed = FileSystem.FileSystem.of({
        ...fileSystem,
        readDirectory: (directory, options) =>
          Effect.suspend(() => {
            if (directory === skillsDir) libraryReads++;
            return fileSystem.readDirectory(directory, options);
          }),
        copy: (from, to, options) =>
          Effect.suspend(() => {
            copies++;
            return copies === 1
              ? Deferred.succeed(firstCopyStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirstCopy)),
                  Effect.andThen(fileSystem.copy(from, to, options)),
                )
              : fileSystem.copy(from, to, options);
          }),
      });

      const first = yield* mirrorCentralSkills({ skillsDir, targetSkillsDir }).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
        Effect.forkChild,
      );
      yield* Deferred.await(firstCopyStarted);
      // The same folder spelled differently is the same target.
      const second = yield* mirrorCentralSkills({
        skillsDir,
        targetSkillsDir: `${targetSkillsDir}${path.sep}`,
      }).pipe(Effect.provideService(FileSystem.FileSystem, observed), Effect.forkChild);
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      // While the first sync is mid-copy, the second has not started reading the library.
      assert.strictEqual(libraryReads, 1);

      yield* Deferred.succeed(releaseFirstCopy, undefined);
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];

      for (const result of results) {
        assert.deepStrictEqual([...result.mirrored].sort(), ["deploy", "review"]);
      }
      // The second sync found both copies current and copied nothing.
      assert.strictEqual(copies, 2);
      for (const name of ["deploy", "review"]) {
        assert.isTrue(yield* fileSystem.exists(path.join(targetSkillsDir, name, "SKILL.md")));
      }
      assert.deepStrictEqual(yield* leftovers(targetSkillsDir), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the previous copy when the new one cannot be moved into place", () =>
    Effect.gen(function* () {
      const { fileSystem, path, skillsDir, targetSkillsDir } = yield* setup;
      yield* writeSkill(skillsDir, "review", "Central review");
      yield* writeAsset(path.join(skillsDir, "review"), "references/notes.md", "v1");
      yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });
      const copy = path.join(targetSkillsDir, "review");
      const firstMarker = yield* fileSystem.readFileString(
        path.join(copy, CENTRAL_SKILL_MIRROR_MARKER),
      );

      yield* writeAsset(path.join(skillsDir, "review"), "references/notes.md", "version 2");
      const failingSwap = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          path.basename(from).startsWith(".t3-staging-")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Busy",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: from,
                }),
              )
            : fileSystem.rename(from, to),
      });
      yield* mirrorCentralSkills({ skillsDir, targetSkillsDir }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingSwap),
      );

      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(copy, "references", "notes.md")),
        "v1",
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(copy, CENTRAL_SKILL_MIRROR_MARKER)),
        firstMarker,
      );
      assert.deepStrictEqual(yield* leftovers(targetSkillsDir), []);

      // The next sync that can swap brings the new version.
      yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(copy, "references", "notes.md")),
        "version 2",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores a copy a crashed sync left renamed aside", () =>
    Effect.gen(function* () {
      const { fileSystem, path, skillsDir, targetSkillsDir } = yield* setup;
      yield* writeSkill(skillsDir, "review", "Central review");
      yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });
      const copy = path.join(targetSkillsDir, "review");
      // The process died between moving the old copy aside and moving the new one in.
      yield* fileSystem.rename(copy, path.join(targetSkillsDir, ".t3-backup-review"));
      yield* fileSystem.makeDirectory(path.join(targetSkillsDir, ".t3-staging-abc"));

      const result = yield* mirrorCentralSkills({ skillsDir, targetSkillsDir });

      assert.deepStrictEqual(result, { mirrored: ["review"], shadowed: [] });
      assert.include(
        yield* fileSystem.readFileString(path.join(copy, "SKILL.md")),
        "Central review",
      );
      assert.deepStrictEqual(yield* leftovers(targetSkillsDir), []);
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
