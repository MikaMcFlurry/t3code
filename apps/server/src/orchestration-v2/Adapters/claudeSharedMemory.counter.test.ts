import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import { repairClaudeMemoryIndex, seedSharedClaudeMemory } from "./claudeSharedMemory.ts";

/**
 * Counter-cases from the independent review of the shared memory seed (R1–R15): each failed, or
 * guards a property that held, before seeding and index repair were made atomic and alias-safe.
 */

const memory = (name = "topic") => `---\nname: ${name}\ndescription: useful\n---\nbody\n`;

const injected = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    description: "ENOSPC injected",
  });

/** The relative paths a Markdown index links to, decoded like a Markdown reader would. */
const linkedPaths = (index: string) =>
  [...index.matchAll(/\]\(\s*(?:<([^>\n]*)>|([^)\s]+))\)/g)].map((match) => {
    const target = (match[1] ?? match[2] ?? "").replace(/[#?].*$/, "");
    try {
      return decodeURIComponent(target);
    } catch {
      return target;
    }
  });

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-memory-counter-" });
  const shared = path.join(root, "shared");
  const account = path.join(root, "account");
  const marker = path.join(root, "markers", "work");
  yield* fileSystem.makeDirectory(shared);
  yield* fileSystem.makeDirectory(account);
  const memoryFs = { fileSystem, path };
  const input = { sharedDirectory: shared, sourceDirectories: [account], account: "work", marker };
  const seed = (
    overrides: Partial<typeof input> = {},
    fs: { fileSystem: FileSystem.FileSystem; path: Path.Path } = memoryFs,
  ) => Effect.exit(seedSharedClaudeMemory(fs, { ...input, ...overrides }));
  const write = (file: string, text: string) => fileSystem.writeFileString(file, text);
  const read = (file: string) => fileSystem.readFileString(file);
  const exists = (file: string) => fileSystem.exists(file);
  const names = (directory: string) =>
    Effect.map(fileSystem.readDirectory(directory), (entries) => entries.sort());
  /** Every file below a folder with its bytes, for "left exactly as it was" checks. */
  const tree = (directory: string) =>
    Effect.gen(function* () {
      const out: Record<string, string> = {};
      for (const name of (yield* fileSystem.readDirectory(directory, { recursive: true })).sort()) {
        const full = path.join(directory, name);
        const info = yield* fileSystem.lstat(full);
        out[name] =
          info.type === "File"
            ? Buffer.from(yield* fileSystem.readFile(full)).toString("base64")
            : info.type;
      }
      return out;
    });
  return {
    fileSystem,
    path,
    root,
    shared,
    account,
    marker,
    memoryFs,
    input,
    seed,
    write,
    read,
    exists,
    names,
    tree,
  };
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("shared memory: aliases never let a write reach an account's files (P1)", () => {
  it.effect("R1 a shared MEMORY.md symlinked to the account index is left alone", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, memoryFs, write, read } = yield* setup;
        const accountIndex = path.join(account, "MEMORY.md");
        yield* write(accountIndex, "# Account-only memory\n");
        yield* fileSystem.symlink(accountIndex, path.join(shared, "MEMORY.md"));
        yield* write(path.join(shared, "topic.md"), memory());
        const repaired = yield* Effect.exit(repairClaudeMemoryIndex(memoryFs, shared));
        assert.equal(yield* read(accountIndex), "# Account-only memory\n");
        assert.equal(
          (yield* fileSystem.lstat(path.join(shared, "MEMORY.md"))).type,
          "SymbolicLink",
        );
        assert.isTrue(Exit.isSuccess(repaired));
      }),
    ),
  );

  it.effect("R13 a shared MEMORY.md hard-linked to the account index is left alone", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, memoryFs, write, read } = yield* setup;
        const accountIndex = path.join(account, "MEMORY.md");
        yield* write(accountIndex, "# Account\n");
        yield* fileSystem.link(accountIndex, path.join(shared, "MEMORY.md"));
        yield* write(path.join(shared, "topic.md"), memory());
        yield* Effect.exit(repairClaudeMemoryIndex(memoryFs, shared));
        assert.equal(yield* read(accountIndex), "# Account\n");
        assert.equal(yield* read(path.join(shared, "MEMORY.md")), "# Account\n");
      }),
    ),
  );

  it.effect("R13 a seed never merges index lines into a hard-linked account index", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, marker, seed, write, read, exists } =
          yield* setup;
        const other = path.join(root, "other-account");
        yield* fileSystem.makeDirectory(other);
        yield* write(path.join(other, "MEMORY.md"), "# Other account\n");
        yield* fileSystem.link(path.join(other, "MEMORY.md"), path.join(shared, "MEMORY.md"));
        yield* write(path.join(account, "MEMORY.md"), "- [one](one.md)\n");
        yield* write(path.join(account, "one.md"), memory("one"));
        const result = yield* seed();
        assert.equal(yield* read(path.join(other, "MEMORY.md")), "# Other account\n");
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
      }),
    ),
  );

  it.effect("a shared folder that is a symlink to the account folder is never written", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, account, marker, memoryFs, seed, write, exists, tree } =
          yield* setup;
        const linked = path.join(root, "linked-shared");
        yield* fileSystem.symlink(account, linked);
        yield* write(path.join(account, "MEMORY.md"), "# Account\n");
        yield* write(path.join(account, "topic.md"), memory());
        const before = yield* tree(account);
        yield* Effect.exit(repairClaudeMemoryIndex(memoryFs, linked));
        const result = yield* seed({
          sharedDirectory: linked,
          sourceDirectories: [path.join(root, "none")],
        });
        assert.deepEqual(yield* tree(account), before);
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
      }),
    ),
  );

  it.effect("a shared folder inside an account folder is never written", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, account, marker, memoryFs, seed, write, exists, tree } =
          yield* setup;
        const nested = path.join(account, "shared");
        yield* fileSystem.makeDirectory(nested);
        yield* write(path.join(nested, "topic.md"), memory());
        const before = yield* tree(account);
        yield* Effect.exit(
          repairClaudeMemoryIndex(memoryFs, nested, { protectedDirectories: [account] }),
        );
        const result = yield* seed({ sharedDirectory: nested });
        assert.deepEqual(yield* tree(account), before);
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
      }),
    ),
  );

  it.effect("a shared subfolder symlinked into an account folder receives no copies", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, marker, seed, write, exists, tree } =
          yield* setup;
        const victim = path.join(root, "victim-account");
        yield* fileSystem.makeDirectory(victim);
        yield* write(path.join(victim, "keep.md"), memory("keep"));
        yield* fileSystem.symlink(victim, path.join(shared, "notes"));
        yield* fileSystem.makeDirectory(path.join(account, "notes"));
        yield* write(path.join(account, "notes", "topic.md"), memory());
        const before = yield* tree(victim);
        const result = yield* seed();
        assert.deepEqual(yield* tree(victim), before);
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
      }),
    ),
  );

  it.effect("R8 a memory file symlinked into the account folder is never replaced or written", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, seed, write, read } = yield* setup;
        yield* write(path.join(account, "other.md"), memory("account"));
        yield* write(path.join(account, "topic.md"), memory("new"));
        yield* fileSystem.symlink(path.join(account, "other.md"), path.join(shared, "topic.md"));
        yield* seed();
        assert.equal(yield* read(path.join(account, "other.md")), memory("account"));
        assert.equal(yield* read(path.join(shared, "topic.conflict-work.md")), memory("new"));
      }),
    ),
  );
});

describe("shared memory: the seed marker means every file arrived (P1)", () => {
  it.effect("R2 a shared folder that cannot be written leaves no marker; a retry copies", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, seed, write, read, exists } =
          yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        yield* fileSystem.chmod(shared, 0o500);
        const failed = yield* seed().pipe(
          Effect.ensuring(fileSystem.chmod(shared, 0o700).pipe(Effect.orDie)),
        );
        assert.isFalse(yield* exists(marker));
        assert.isTrue(Exit.isFailure(failed));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );

  it.effect("R3 a write that stops part-way publishes nothing partial; a retry completes", () =>
    run(
      Effect.gen(function* () {
        const {
          fileSystem,
          path,
          shared,
          account,
          marker,
          memoryFs,
          seed,
          write,
          read,
          exists,
          names,
        } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        let first = true;
        const broken: FileSystem.FileSystem = {
          ...fileSystem,
          writeFile: (file, bytes, options) => {
            if (!first) return Effect.fail(injected("writeFile"));
            first = false;
            return fileSystem
              .writeFile(file, bytes.slice(0, 5), options)
              .pipe(Effect.andThen(Effect.fail(injected("writeFile"))));
          },
        };
        const failed = yield* seed({}, { ...memoryFs, fileSystem: broken });
        assert.isTrue(Exit.isFailure(failed));
        assert.isFalse(yield* exists(marker));
        assert.deepEqual(yield* names(shared), []);
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );

  it.effect("a write that silently stores too few bytes is caught before publishing", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, memoryFs, seed, write, exists, names } =
          yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        const short: FileSystem.FileSystem = {
          ...fileSystem,
          writeFile: (file, bytes, options) =>
            fileSystem.writeFile(file, bytes.slice(0, 5), options),
        };
        const failed = yield* seed({}, { ...memoryFs, fileSystem: short });
        assert.isTrue(Exit.isFailure(failed));
        assert.isFalse(yield* exists(marker));
        assert.deepEqual(yield* names(shared), []);
      }),
    ),
  );

  it.effect("R4 an account folder that cannot be read leaves no marker; a retry copies", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, seed, write, read, exists } =
          yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        yield* fileSystem.chmod(account, 0);
        const failed = yield* seed().pipe(
          Effect.ensuring(fileSystem.chmod(account, 0o700).pipe(Effect.orDie)),
        );
        assert.isTrue(Exit.isFailure(failed));
        assert.isFalse(yield* exists(marker));
        yield* seed();
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
      }),
    ),
  );

  it.effect("R6 a memory file that cannot be read leaves no marker; a retry copies", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, seed, write, read, exists } =
          yield* setup;
        const file = path.join(account, "topic.md");
        yield* write(file, memory());
        yield* fileSystem.chmod(file, 0);
        const failed = yield* seed().pipe(
          Effect.ensuring(fileSystem.chmod(file, 0o600).pipe(Effect.orDie)),
        );
        assert.isTrue(Exit.isFailure(failed));
        assert.isFalse(yield* exists(marker));
        yield* seed();
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
      }),
    ),
  );

  it.effect("R11 a long legal file name keeps its conflicting version under a short name", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, marker, seed, write, read, exists, names } = yield* setup;
        const name = `${"x".repeat(245)}.md`;
        yield* write(path.join(shared, name), "old");
        yield* write(path.join(account, name), "new");
        const result = yield* seed();
        const files = yield* names(shared);
        const contents = yield* Effect.forEach(files, (file) => read(path.join(shared, file)));
        assert.include(contents, "new");
        assert.include(contents, "old");
        assert.isTrue(files.every((file) => Buffer.byteLength(file) <= 255));
        assert.isTrue(Exit.isSuccess(result));
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );

  it.effect("no free conflict name fails the seed instead of marking it done", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, marker, seed, write, exists } = yield* setup;
        yield* write(path.join(shared, "topic.md"), "shared");
        yield* write(path.join(shared, "topic.conflict-work.md"), "taken");
        for (let number = 2; number < 99; number++) {
          yield* write(path.join(shared, `topic.conflict-work-${number}.md`), "taken");
        }
        yield* write(path.join(account, "topic.md"), "account");
        const result = yield* seed();
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
      }),
    ),
  );

  it.effect("R7 bytes, taken conflict names and odd account ids keep every original", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, seed, write, read } = yield* setup;
        const binary = new Uint8Array([0, 255, 254, 128, 10]);
        yield* fileSystem.writeFile(path.join(account, "blob.bin"), binary);
        yield* write(path.join(account, "topic.md"), memory("source"));
        yield* write(path.join(shared, "topic.md"), memory("target"));
        yield* write(path.join(shared, "topic.conflict-work.md"), memory("existing-conflict"));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.deepEqual(
          [...(yield* fileSystem.readFile(path.join(shared, "blob.bin")))],
          [...binary],
        );
        assert.equal(yield* read(path.join(shared, "topic.md")), memory("target"));
        assert.equal(
          yield* read(path.join(shared, "topic.conflict-work.md")),
          memory("existing-conflict"),
        );
        assert.equal(yield* read(path.join(shared, "topic.conflict-work-2.md")), memory("source"));
        yield* seed({ account: "../../elsewhere/☃", marker: path.join(root, "other-marker") });
        assert.equal(yield* read(path.join(account, "topic.md")), memory("source"));
        assert.isFalse(yield* fileSystem.exists(path.join(root, "elsewhere")));
      }),
    ),
  );

  it.effect("a file over the size budget stops the seed without a marker", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, seed, exists, names } = yield* setup;
        yield* fileSystem.writeFile(
          path.join(account, "huge.bin"),
          new Uint8Array(32 * 1024 * 1024 + 1),
        );
        const result = yield* seed();
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
        assert.deepEqual(yield* names(shared), []);
      }),
    ),
  );
});

describe("shared memory: folders migrate with their index links (P2)", () => {
  it.effect("R5 nested indexed memory is copied with its folder", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, seed, write, read, exists } =
          yield* setup;
        yield* fileSystem.makeDirectory(path.join(account, "notes", "deep"), { recursive: true });
        yield* write(path.join(account, "notes", "topic.md"), memory());
        yield* write(path.join(account, "notes", "deep", "more.md"), memory("more"));
        yield* write(path.join(account, "MEMORY.md"), "- [Topic](notes/topic.md)\n");
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "notes", "topic.md")), memory());
        assert.equal(yield* read(path.join(shared, "notes", "deep", "more.md")), memory("more"));
        assert.equal(yield* read(path.join(shared, "MEMORY.md")), "- [Topic](notes/topic.md)\n");
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );

  it.effect("the index repair finds unindexed memory in subfolders", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, memoryFs, write, read } = yield* setup;
        yield* fileSystem.makeDirectory(path.join(shared, "notes"));
        yield* write(path.join(shared, "notes", "topic.md"), memory());
        yield* write(path.join(shared, "MEMORY.md"), "# Memory\n");
        yield* repairClaudeMemoryIndex(memoryFs, shared);
        assert.equal(
          yield* read(path.join(shared, "MEMORY.md")),
          "# Memory\n- [topic](notes/topic.md): useful\n",
        );
      }),
    ),
  );

  it.effect("a symlink in the account folder pointing outside it stops the seed", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, marker, seed, write, exists, names } =
          yield* setup;
        yield* write(path.join(root, "outside.md"), memory("outside"));
        yield* fileSystem.symlink(path.join(root, "outside.md"), path.join(account, "topic.md"));
        const result = yield* seed();
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
        assert.deepEqual(yield* names(shared), []);
      }),
    ),
  );
});

describe("shared memory: the index is replaced whole, never appended to (P2)", () => {
  it.effect("R10 a writer holding MEMORY.md open cannot leave a fragment of a repair line", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, memoryFs, write, read } = yield* setup;
        yield* write(path.join(shared, "topic.md"), memory());
        const indexPath = path.join(shared, "MEMORY.md");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const writer = yield* fileSystem.open(indexPath, { flag: "w" });
            yield* writer.writeAll(new TextEncoder().encode("# Claude\n"));
            yield* repairClaudeMemoryIndex(memoryFs, shared);
            yield* writer.writeAll(new TextEncoder().encode("LIVE WRITER FINISHES\n"));
          }),
        );
        const index = yield* read(indexPath);
        assert.include(index, "- [topic](topic.md): useful\n");
        assert.isTrue(
          index
            .split("\n")
            .every((line) => line === "" || line === "# Claude" || line.startsWith("- [")),
          index,
        );
      }),
    ),
  );

  it.effect("an index rewritten while the repair prepares its update is read again", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, memoryFs, write, read } = yield* setup;
        yield* write(path.join(shared, "topic.md"), memory());
        const indexPath = path.join(shared, "MEMORY.md");
        yield* write(indexPath, "# Memory\n");
        let interfered = false;
        // Claude rewrites the index just after the repair wrote its replacement beside it.
        const racing: FileSystem.FileSystem = {
          ...fileSystem,
          writeFile: (file, bytes, options) =>
            fileSystem.writeFile(file, bytes, options).pipe(
              Effect.tap(() =>
                interfered || !path.basename(file).endsWith(".tmp")
                  ? Effect.void
                  : Effect.sync(() => {
                      interfered = true;
                    }).pipe(
                      Effect.andThen(
                        fileSystem.writeFileString(
                          indexPath,
                          "# Memory\n- [claude](claude.md): new\n",
                        ),
                      ),
                    ),
              ),
            ),
          writeFileString: (file, text, options) => {
            if (options?.flag === "a") return Effect.fail(injected("append"));
            return fileSystem.writeFileString(file, text, options);
          },
        };
        yield* repairClaudeMemoryIndex({ ...memoryFs, fileSystem: racing }, shared);
        assert.isTrue(interfered);
        assert.equal(
          yield* read(indexPath),
          "# Memory\n- [claude](claude.md): new\n- [topic](topic.md): useful\n",
        );
      }),
    ),
  );

  it.effect("R9 two same-process account starts keep every index entry once", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, seed, write, read } = yield* setup;
        const other = path.join(root, "account2");
        yield* fileSystem.makeDirectory(other);
        yield* write(path.join(account, "one.md"), memory("one"));
        yield* write(path.join(account, "MEMORY.md"), "- [one](one.md)\n");
        yield* write(path.join(other, "two.md"), memory("two"));
        yield* write(path.join(other, "MEMORY.md"), "- [two](two.md)\n");
        yield* Effect.all(
          [
            seed(),
            seed({
              sourceDirectories: [other],
              account: "other",
              marker: path.join(root, "marker2"),
            }),
          ],
          { concurrency: "unbounded" },
        );
        const index = yield* read(path.join(shared, "MEMORY.md"));
        assert.deepEqual(linkedPaths(index).sort(), ["one.md", "two.md"]);
      }),
    ),
  );

  it.effect("R14 two accounts seeding the same name at once keep both versions", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, seed, write, read, names } = yield* setup;
        const other = path.join(root, "account2");
        yield* fileSystem.makeDirectory(other);
        yield* write(path.join(account, "topic.md"), memory("one"));
        yield* write(path.join(other, "topic.md"), memory("two"));
        yield* Effect.all(
          [
            seed(),
            seed({
              sourceDirectories: [other],
              account: "other",
              marker: path.join(root, "marker2"),
            }),
          ],
          { concurrency: "unbounded" },
        );
        const contents = yield* Effect.forEach(yield* names(shared), (file) =>
          read(path.join(shared, file)),
        );
        assert.include(contents, memory("one"));
        assert.include(contents, memory("two"));
      }),
    ),
  );
});

describe("shared memory: link targets are encoded file paths (P2)", () => {
  it.effect("R12 a # and other special characters in file names link to the file", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, memoryFs, write, read } = yield* setup;
        const files = ["a#b.md", "with space.md", "paren (1).md", "100%.md", "q?.md"];
        for (const file of files) yield* write(path.join(shared, file), memory("hash [x]"));
        yield* repairClaudeMemoryIndex(memoryFs, shared);
        const index = yield* read(path.join(shared, "MEMORY.md"));
        assert.include(index, "](a%23b.md)");
        assert.include(index, "[hash \\[x\\]]");
        assert.deepEqual(linkedPaths(index).sort(), [...files].sort());
        // A second run sees every file as linked.
        yield* repairClaudeMemoryIndex(memoryFs, shared);
        assert.equal(yield* read(path.join(shared, "MEMORY.md")), index);
      }),
    ),
  );

  it.effect("a raw a#b.md link from before is recognised as broken and completed", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, memoryFs, write, read } = yield* setup;
        yield* write(path.join(shared, "a#b.md"), memory("hash"));
        yield* write(path.join(shared, "MEMORY.md"), "- [hash](a#b.md): useful\n");
        yield* repairClaudeMemoryIndex(memoryFs, shared);
        assert.equal(
          yield* read(path.join(shared, "MEMORY.md")),
          "- [hash](a#b.md): useful\n- [hash](a%23b.md): useful\n",
        );
      }),
    ),
  );
});

describe("shared memory: bounded start-up work (P3)", () => {
  it.effect("R15 large files stay byte-identical; an unchanged folder is not read again", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, memoryFs, seed, read } = yield* setup;
        const big = new Uint8Array(16 * 1024 * 1024).fill(0xa5);
        yield* fileSystem.writeFile(path.join(account, "big.bin"), big);
        assert.isTrue(Exit.isSuccess(yield* seed()));
        const copied = yield* fileSystem.readFile(path.join(shared, "big.bin"));
        assert.isTrue(copied.length === big.length && copied.every((byte) => byte === 0xa5));
        yield* Effect.forEach(
          Array.from({ length: 1000 }, (_, index) => index),
          (index) =>
            fileSystem.writeFileString(path.join(shared, `n-${index}.md`), memory(`n-${index}`)),
          { concurrency: 32 },
        );
        const stateFile = path.join(root, "index-state");
        const operations = { contentReads: 0, appends: 0, writes: 0 };
        const counted: FileSystem.FileSystem = {
          ...fileSystem,
          open: (file, options) => {
            if (file.endsWith(".md")) operations.contentReads++;
            return fileSystem.open(file, options);
          },
          readFile: (file) => {
            if (file.endsWith(".md")) operations.contentReads++;
            return fileSystem.readFile(file);
          },
          writeFile: (file, bytes, options) => {
            operations.writes++;
            return fileSystem.writeFile(file, bytes, options);
          },
          writeFileString: (file, text, options) => {
            if (options?.flag === "a") operations.appends++;
            else operations.writes++;
            return fileSystem.writeFileString(file, text, options);
          },
        };
        const countedFs = { ...memoryFs, fileSystem: counted };
        assert.equal(yield* repairClaudeMemoryIndex(countedFs, shared, { stateFile }), 1000);
        assert.equal(operations.appends, 0);
        const lines = (yield* read(path.join(shared, "MEMORY.md"))).split("\n").filter(Boolean);
        assert.equal(lines.length, 1000);

        operations.contentReads = 0;
        operations.writes = 0;
        assert.equal(yield* repairClaudeMemoryIndex(countedFs, shared, { stateFile }), 0);
        assert.deepEqual(operations, { contentReads: 0, appends: 0, writes: 0 });
      }),
    ),
  );
});
