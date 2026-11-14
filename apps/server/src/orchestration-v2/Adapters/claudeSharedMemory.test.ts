import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import {
  claudeAccountMemoryDirectories,
  claudeMemoryProjectPaths,
  memoryFrontmatter,
  seedSharedClaudeMemory,
} from "./claudeSharedMemory.ts";

const memoryFile = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: project\n---\n\n${body}\n`;

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-shared-memory-" });
  const shared = path.join(root, "claude-memory", "project-1");
  const gmail = path.join(root, "gmail");
  const work = path.join(root, "work");
  for (const directory of [shared, gmail, work]) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
  }
  const memoryFs = { fileSystem, path };
  const read = (directory: string, name: string) =>
    fileSystem.readFileString(path.join(directory, name));
  const write = (directory: string, name: string, text: string) =>
    fileSystem.writeFileString(path.join(directory, name), text);
  const seed = (source: string, account: string) =>
    seedSharedClaudeMemory(memoryFs, {
      sharedDirectory: shared,
      sourceDirectories: [source],
      account,
    });
  const files = Effect.map(fileSystem.readDirectory(shared), (names) => names.sort());
  return { fileSystem, path, root, shared, gmail, work, memoryFs, read, write, seed, files };
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("seedSharedClaudeMemory", () => {
  it.effect("keeps both versions when two accounts hold different files, whatever their age", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, gmail, work, read, write, seed, files } = yield* setup;
        const older = memoryFile("deploy", "How deploys run", "Deploy with make ship.");
        const newer = memoryFile("deploy", "How deploys run", "Deploy with the release script.");
        yield* write(gmail, "deploy.md", older);
        yield* write(gmail, "MEMORY.md", "- [Deploy](deploy.md) — how deploys run\n");
        yield* write(work, "deploy.md", newer);
        yield* write(work, "MEMORY.md", "- [Deploy](deploy.md) — how deploys run\n");
        // The work copy looks newer, as after a sync tool touched it.
        yield* fileSystem.utimes(path.join(gmail, "deploy.md"), 1, 1);
        yield* fileSystem.utimes(path.join(work, "deploy.md"), 2_000_000_000, 2_000_000_000);

        assert.isTrue(yield* seed(gmail, "gmail"));
        assert.isTrue(yield* seed(work, "work"));

        assert.deepEqual(yield* files, [
          "MEMORY.md",
          "SEED-CONFLICTS.md",
          "deploy.conflict-work.md",
          "deploy.md",
        ]);
        assert.equal(yield* read(shared, "deploy.md"), older);
        assert.equal(yield* read(shared, "deploy.conflict-work.md"), newer);
        // The first account created the index; the second left it alone and wrote a note.
        assert.equal(yield* read(shared, "MEMORY.md"), "- [Deploy](deploy.md) — how deploys run\n");
        assert.include(
          yield* read(shared, "SEED-CONFLICTS.md"),
          "- [Conflict: deploy.md](deploy.conflict-work.md): account work's different version of deploy.md. Merge the two and delete one.\n",
        );
        // The accounts' own folders are only read.
        assert.equal(yield* read(work, "deploy.md"), newer);
        assert.equal(yield* read(gmail, "deploy.md"), older);
      }),
    ),
  );

  it.effect("does nothing for a file both accounts hold in the same version", () =>
    run(
      Effect.gen(function* () {
        const { shared, gmail, work, read, write, seed, files } = yield* setup;
        const same = memoryFile("style", "Code style", "Two spaces.");
        yield* write(gmail, "style.md", same);
        yield* write(work, "style.md", same);
        yield* seed(gmail, "gmail");
        const index = yield* read(shared, "MEMORY.md");
        assert.equal(index, "- [style](style.md): Code style\n");
        yield* seed(work, "work");
        assert.deepEqual(yield* files, ["MEMORY.md", "style.md"]);
        assert.equal(yield* read(shared, "style.md"), same);
        assert.equal(yield* read(shared, "MEMORY.md"), index);
      }),
    ),
  );

  it.effect("lists a later account's files in a note and seeds each account only once", () =>
    run(
      Effect.gen(function* () {
        const { shared, gmail, work, read, write, seed, files } = yield* setup;
        yield* write(gmail, "a.md", memoryFile("a", "A", "a"));
        yield* write(gmail, "MEMORY.md", "- [A](a.md) — A");
        yield* write(work, "b.md", memoryFile("b", "B", "b"));
        yield* write(work, "MEMORY.md", "- [B](b.md) — B\n- [A](a.md) — A\n");
        yield* seed(gmail, "gmail");
        yield* seed(work, "work");
        assert.equal(yield* read(shared, "MEMORY.md"), "- [A](a.md) — A\n");
        const note = yield* read(shared, "SEEDED-FILES.md");
        assert.include(note, "\n- [B](b.md) — B\n");
        assert.notInclude(note, "a.md");

        // A file the account adds later is not copied again; the shared folder is the memory now.
        yield* write(gmail, "late.md", memoryFile("late", "Late", "late"));
        assert.isFalse(yield* seed(gmail, "gmail"));
        assert.deepEqual(yield* files, ["MEMORY.md", "SEEDED-FILES.md", "a.md", "b.md"]);
      }),
    ),
  );

  it.effect("finds an account's memory under the repository a worktree belongs to", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, memoryFs } = yield* setup;
        const repo = path.join(root, "repo");
        const worktree = path.join(root, "worktrees", "feature");
        yield* fileSystem.makeDirectory(path.join(repo, ".git", "worktrees", "feature"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(path.join(worktree, "src"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(worktree, ".git"),
          `gitdir: ${path.join(repo, ".git", "worktrees", "feature")}\n`,
        );
        const config = path.join(root, "config");
        const memory = path.join(config, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
        yield* fileSystem.makeDirectory(memory, { recursive: true });

        const paths = yield* claudeMemoryProjectPaths(memoryFs, path.join(worktree, "src"));
        assert.deepEqual(paths, [repo, path.join(worktree, "src")]);
        assert.deepEqual(yield* claudeAccountMemoryDirectories(memoryFs, config, paths), [memory]);
      }),
    ),
  );

  it.effect("keeps no state in the memory root but the versioned seed markers", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, gmail, write, seed, files } = yield* setup;
        yield* write(gmail, "a.md", memoryFile("a", "A", "a"));
        yield* seed(gmail, "gmail");
        const memoryRoot = path.join(root, "claude-memory");
        assert.deepEqual((yield* fileSystem.readDirectory(memoryRoot)).sort(), [
          ".seeded-v2",
          "project-1",
        ]);
        assert.deepEqual(
          yield* fileSystem.readDirectory(path.join(memoryRoot, ".seeded-v2", "project-1")),
          ["gmail"],
        );
        assert.isTrue((yield* files).every((name) => !name.startsWith(".")));
        assert.isFalse(yield* fileSystem.exists(path.join(shared, ".index-state")));
      }),
    ),
  );
});

describe("memoryFrontmatter", () => {
  it("reads quoted and plain values and needs a name", () => {
    assert.deepEqual(memoryFrontmatter('---\nname: x\ndescription: "a: b"\n---\nbody'), {
      name: "x",
      description: "a: b",
    });
    assert.deepEqual(memoryFrontmatter("---\nname: x\n---\n"), { name: "x", description: null });
    assert.isNull(memoryFrontmatter("---\ndescription: y\n---\n"));
    assert.isNull(memoryFrontmatter("name: x\n"));
  });
});
