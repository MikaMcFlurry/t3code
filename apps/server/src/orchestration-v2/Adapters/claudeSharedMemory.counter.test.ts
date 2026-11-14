import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import { claudeSharedMemoryMarker, seedSharedClaudeMemory } from "./claudeSharedMemory.ts";

/**
 * Counter-cases from the two independent reviews of the shared memory seed: R1–R15 from the
 * first, SMS2 S1–S8 from the second. Each guards a way the seed once lost or overwrote memory.
 */

const memory = (name = "topic") => `---\nname: ${name}\ndescription: useful\n---\nbody\n`;

const injected = (method: string, description = "ENOSPC injected") =>
  PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method, description });

/** The relative paths a Markdown text links to, decoded like a Markdown reader would. */
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
  const memoryRoot = path.join(root, "claude-memory");
  const shared = path.join(memoryRoot, "project-1");
  const account = path.join(root, "account");
  yield* fileSystem.makeDirectory(shared, { recursive: true });
  yield* fileSystem.makeDirectory(account);
  const memoryFs = { fileSystem, path };
  const marker = claudeSharedMemoryMarker(path, shared, "work");
  const input = { sharedDirectory: shared, sourceDirectories: [account], account: "work" };
  const seed = (
    overrides: Partial<typeof input> = {},
    fs: { fileSystem: FileSystem.FileSystem; path: Path.Path } = memoryFs,
  ) => Effect.exit(seedSharedClaudeMemory(fs, { ...input, ...overrides }));
  const write = (file: string, text: string) => fileSystem.writeFileString(file, text);
  const read = (file: string) => fileSystem.readFileString(file);
  const exists = (file: string) => fileSystem.exists(file);
  const names = (directory: string) =>
    Effect.map(fileSystem.readDirectory(directory), (entries) => entries.sort());
  /** Every entry below a folder with its bytes, for "left exactly as it was" checks. */
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
    memoryRoot,
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

/** Records every call that could change `file`, to prove a run never wrote it. */
const watchWrites = (fileSystem: FileSystem.FileSystem, file: string) => {
  const calls: string[] = [];
  const note = (method: string, ...paths: readonly string[]) => {
    if (paths.includes(file)) calls.push(method);
  };
  const watched: FileSystem.FileSystem = {
    ...fileSystem,
    writeFile: (target, bytes, options) => {
      note("writeFile", target);
      return fileSystem.writeFile(target, bytes, options);
    },
    writeFileString: (target, text, options) => {
      note("writeFileString", target);
      return fileSystem.writeFileString(target, text, options);
    },
    rename: (from, to) => {
      note("rename", from, to);
      return fileSystem.rename(from, to);
    },
    link: (from, to) => {
      note("link", to);
      return fileSystem.link(from, to);
    },
    copyFile: (from, to) => {
      note("copyFile", to);
      return fileSystem.copyFile(from, to);
    },
    remove: (target, options) => {
      note("remove", target);
      return fileSystem.remove(target, options);
    },
    truncate: (target, length) => {
      note("truncate", target);
      return fileSystem.truncate(target, length);
    },
    open: (target, options) => {
      if (options?.flag !== undefined && options.flag !== "r") note(`open:${options.flag}`, target);
      return fileSystem.open(target, options);
    },
  };
  return { watched, calls };
};

describe("SMS2-1: publication never replaces a file, and has no rename fallback (P1)", () => {
  it.effect.each(["ENOTSUP", "EPERM", "EXDEV"])(
    "S1 %s: a failing hard link publishes nothing and replaces nothing",
    (code) =>
      run(
        Effect.gen(function* () {
          const { fileSystem, path, shared, account, marker, memoryFs, seed, write, read, names } =
            yield* setup;
          yield* write(path.join(account, "topic.md"), memory());
          const target = path.join(shared, "topic.md");
          let renamedOver = false;
          const noLinks: FileSystem.FileSystem = {
            ...fileSystem,
            link: () => Effect.fail(injected("link", code)),
            // Claude writes the file just before any rename onto it would happen.
            rename: (from, to) =>
              (to === target && !renamedOver
                ? Effect.sync(() => {
                    renamedOver = true;
                  }).pipe(
                    Effect.andThen(fileSystem.writeFileString(target, "CLAUDE NEW CONTENT\n")),
                  )
                : Effect.void
              ).pipe(Effect.andThen(fileSystem.rename(from, to))),
          };
          const result = yield* seed({}, { ...memoryFs, fileSystem: noLinks });
          assert.isTrue(Exit.isFailure(result));
          assert.isFalse(renamedOver, "a rename onto the target was attempted");
          assert.isFalse(yield* fileSystem.exists(marker));
          // Nothing published, no temporary file left behind.
          assert.deepEqual(yield* names(shared), []);
          assert.equal(yield* read(path.join(account, "topic.md")), memory());
        }),
      ),
  );

  it.effect("S1 a file another writer creates just before publication is kept as it is", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, memoryFs, seed, write, read, exists } =
          yield* setup;
        yield* write(path.join(account, "topic.md"), memory("account"));
        const target = path.join(shared, "topic.md");
        let raced = false;
        const racing: FileSystem.FileSystem = {
          ...fileSystem,
          link: (from, to) =>
            (to === target && !raced
              ? Effect.sync(() => {
                  raced = true;
                }).pipe(Effect.andThen(fileSystem.writeFileString(target, "CLAUDE NEW CONTENT\n")))
              : Effect.void
            ).pipe(Effect.andThen(fileSystem.link(from, to))),
        };
        assert.isTrue(Exit.isSuccess(yield* seed({}, { ...memoryFs, fileSystem: racing })));
        assert.isTrue(raced);
        assert.equal(yield* read(target), "CLAUDE NEW CONTENT\n");
        assert.equal(yield* read(path.join(shared, "topic.conflict-work.md")), memory("account"));
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );
});

describe("SMS2-2: an existing MEMORY.md is never written (P1)", () => {
  it.effect("S2 a rewrite of MEMORY.md during the seed is kept byte for byte", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, memoryFs, seed, write, read } = yield* setup;
        const indexPath = path.join(shared, "MEMORY.md");
        yield* write(indexPath, "# Memory\n");
        yield* write(path.join(account, "topic.md"), memory());
        yield* write(path.join(account, "MEMORY.md"), "- [topic](topic.md): useful\n");
        const { watched, calls } = watchWrites(fileSystem, indexPath);
        let rewrites = 0;
        // Claude finishes a whole write of MEMORY.md after each file the seed prepares.
        const racing: FileSystem.FileSystem = {
          ...watched,
          writeFile: (file, bytes, options) =>
            watched
              .writeFile(file, bytes, options)
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => ++rewrites).pipe(
                    Effect.flatMap((count) =>
                      fileSystem.writeFileString(indexPath, `# Memory\nUSER FACT ${count}\n`),
                    ),
                  ),
                ),
              ),
        };
        assert.isTrue(Exit.isSuccess(yield* seed({}, { ...memoryFs, fileSystem: racing })));
        assert.isAbove(rewrites, 0);
        assert.equal(yield* read(indexPath), `# Memory\nUSER FACT ${rewrites}\n`);
        assert.deepEqual(calls, []);
        assert.include(yield* read(path.join(shared, "SEEDED-FILES.md")), "](topic.md)");
      }),
    ),
  );

  it.effect("S3 a writer holding MEMORY.md open keeps everything it writes", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, memoryFs, write, read } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        yield* write(path.join(account, "MEMORY.md"), "- [topic](topic.md): useful\n");
        const indexPath = path.join(shared, "MEMORY.md");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const writer = yield* fileSystem.open(indexPath, { flag: "w" });
            yield* writer.writeAll(new TextEncoder().encode("# Claude\n"));
            const result = yield* Effect.exit(
              seedSharedClaudeMemory(memoryFs, {
                sharedDirectory: shared,
                sourceDirectories: [account],
                account: "work",
              }),
            );
            assert.isTrue(Exit.isSuccess(result));
            yield* writer.writeAll(new TextEncoder().encode("LIVE WRITER FINISHES\n"));
          }),
        );
        assert.equal(yield* read(indexPath), "# Claude\nLIVE WRITER FINISHES\n");
      }),
    ),
  );

  it.effect("a MEMORY.md Claude creates just before the seed's own is kept", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, memoryFs, seed, write, read } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        const indexPath = path.join(shared, "MEMORY.md");
        const racing: FileSystem.FileSystem = {
          ...fileSystem,
          link: (from, to) =>
            (to === indexPath
              ? fileSystem.writeFileString(indexPath, "# Claude was first\n")
              : Effect.void
            ).pipe(Effect.andThen(fileSystem.link(from, to))),
        };
        assert.isTrue(Exit.isSuccess(yield* seed({}, { ...memoryFs, fileSystem: racing })));
        assert.equal(yield* read(indexPath), "# Claude was first\n");
        assert.include(
          yield* read(path.join(shared, "SEEDED-FILES.md")),
          "- [topic](topic.md): useful\n",
        );
      }),
    ),
  );

  it.effect("a missing MEMORY.md is created listing every copied and conflicting file", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, seed, write, read, names } = yield* setup;
        yield* write(path.join(shared, "clash.md"), memory("shared"));
        yield* write(path.join(account, "clash.md"), memory("account"));
        yield* write(path.join(account, "indexed.md"), memory("indexed"));
        yield* write(path.join(account, "unindexed.md"), memory("unindexed"));
        yield* write(path.join(account, "MEMORY.md"), "# Account\n- [Indexed](indexed.md) — i\n");
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(
          yield* read(path.join(shared, "MEMORY.md")),
          "# Account\n- [Indexed](indexed.md) — i\n" +
            "- [unindexed](unindexed.md): useful\n" +
            "- [Conflict: clash.md](clash.conflict-work.md): account work's different version of clash.md. Merge the two and delete one.\n",
        );
        assert.deepEqual(yield* names(shared), [
          "MEMORY.md",
          "clash.conflict-work.md",
          "clash.md",
          "indexed.md",
          "unindexed.md",
        ]);
      }),
    ),
  );

  it.effect("notes never replace an older note and are not repeated by a retry", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, seed, write, read, names } =
          yield* setup;
        yield* write(path.join(shared, "MEMORY.md"), "# Memory\n");
        yield* write(path.join(shared, "SEEDED-FILES.md"), "an older note\n");
        yield* write(path.join(account, "topic.md"), memory());
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "SEEDED-FILES.md")), "an older note\n");
        assert.include(yield* read(path.join(shared, "SEEDED-FILES-2.md")), "](topic.md)");
        // A retry, as after a seed that failed only at its marker, finds its own note.
        yield* fileSystem.remove(marker);
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.deepEqual(yield* names(shared), [
          "MEMORY.md",
          "SEEDED-FILES-2.md",
          "SEEDED-FILES.md",
          "topic.md",
        ]);
      }),
    ),
  );
});

describe("SMS2-3: metadata paths get the same alias checks as memory files (P1)", () => {
  it.effect("S4/S5 a marker folder linked to an account folder is never written through", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, memoryRoot, shared, account, marker, seed, write, tree, names } =
          yield* setup;
        yield* fileSystem.makeDirectory(path.join(account, "project-1"));
        yield* write(path.join(account, "topic.md"), memory());
        yield* fileSystem.symlink(account, path.join(memoryRoot, ".seeded-v2"));
        const before = yield* tree(account);
        const history = path.join(account, "project-1", "work");
        let raced = false;
        // As in S5: an account file appears at the marker's name after the first look.
        const racing: FileSystem.FileSystem = {
          ...fileSystem,
          makeDirectory: (directory, options) =>
            fileSystem.makeDirectory(directory, options).pipe(
              Effect.tap(() =>
                raced || directory !== path.dirname(marker)
                  ? Effect.void
                  : Effect.sync(() => {
                      raced = true;
                    }).pipe(Effect.andThen(write(history, "ACCOUNT HISTORY\n"))),
              ),
            ),
        };
        const result = yield* seed({}, { fileSystem: racing, path });
        assert.isTrue(Exit.isFailure(result));
        assert.deepEqual(
          yield* tree(account),
          raced
            ? {
                ...before,
                "project-1/work": Buffer.from("ACCOUNT HISTORY\n").toString("base64"),
              }
            : before,
        );
        assert.deepEqual(yield* names(shared), []);
      }),
    ),
  );

  it.effect("S4 a project marker folder linked to an account folder is never written through", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, memoryRoot, account, seed, write, tree } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        yield* write(path.join(account, "work"), "ACCOUNT HISTORY\n");
        yield* fileSystem.makeDirectory(path.join(memoryRoot, ".seeded-v2"));
        yield* fileSystem.symlink(account, path.join(memoryRoot, ".seeded-v2", "project-1"));
        const before = yield* tree(account);
        const result = yield* seed();
        assert.isTrue(Exit.isFailure(result));
        assert.deepEqual(yield* tree(account), before);
      }),
    ),
  );

  it.effect("a memory root inside an account folder is never written", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, account, seed, write, tree } = yield* setup;
        const nestedRoot = path.join(account, "claude-memory");
        const nestedShared = path.join(nestedRoot, "project-1");
        yield* fileSystem.makeDirectory(nestedShared, { recursive: true });
        const other = path.join(root, "other");
        yield* fileSystem.makeDirectory(other);
        yield* write(path.join(other, "topic.md"), memory());
        const before = yield* tree(account);
        const result = yield* seed({
          sharedDirectory: nestedShared,
          sourceDirectories: [other, account],
        });
        assert.isTrue(Exit.isFailure(result));
        assert.deepEqual(yield* tree(account), before);
      }),
    ),
  );
});

describe("SMS2-4: markers are versioned; markers of the earlier seed are ignored (P2)", () => {
  it.effect("S6 an old marker does not stop the new seed from copying", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, memoryRoot, shared, account, marker, seed, write, read, exists } =
          yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        const legacy = path.join(memoryRoot, ".seeded", "project-1", "work");
        yield* fileSystem.makeDirectory(path.dirname(legacy), { recursive: true });
        yield* write(legacy, "2026-11-14T00:00:00.000Z\n");
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
        assert.isTrue(yield* exists(marker));
        assert.equal(yield* read(legacy), "2026-11-14T00:00:00.000Z\n");
      }),
    ),
  );

  it.effect("a v2 marker skips the seed without reading the account", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, memoryFs, seed, write, names } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        assert.isTrue(Exit.isSuccess(yield* seed()));
        yield* fileSystem.remove(path.join(shared, "topic.md"));
        let accountReads = 0;
        const counted: FileSystem.FileSystem = {
          ...fileSystem,
          readDirectory: (directory, options) => {
            if (directory.startsWith(account)) accountReads++;
            return fileSystem.readDirectory(directory, options);
          },
        };
        const again = yield* seed({}, { ...memoryFs, fileSystem: counted });
        assert.isTrue(Exit.isSuccess(again) && again.value === false);
        assert.equal(accountReads, 0);
        assert.deepEqual(yield* names(shared), ["MEMORY.md"]);
      }),
    ),
  );
});

describe("SMS2-5: crash leftovers are cleaned up carefully (P3)", () => {
  it.effect("a temporary name found taken is never removed as if it were the seed's own", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, account, marker, memoryFs, seed, write, exists } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        const removed: string[] = [];
        const taken: FileSystem.FileSystem = {
          ...fileSystem,
          writeFile: (file) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "AlreadyExists",
                module: "FileSystem",
                method: "writeFile",
                pathOrDescriptor: file,
              }),
            ),
          remove: (file, options) => {
            removed.push(file);
            return fileSystem.remove(file, options);
          },
        };
        assert.isTrue(Exit.isFailure(yield* seed({}, { ...memoryFs, fileSystem: taken })));
        assert.deepEqual(removed, []);
        assert.isFalse(yield* exists(marker));
      }),
    ),
  );

  it.effect("no account folder found records nothing, so a later start can still seed", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, marker, seed, write, read, exists } = yield* setup;
        const nothing = yield* seed({ sourceDirectories: [] });
        assert.isTrue(Exit.isSuccess(nothing) && nothing.value === false);
        assert.isFalse(yield* exists(marker));
        yield* write(path.join(account, "topic.md"), memory());
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
      }),
    ),
  );

  it.live("only this module's temporary files older than an hour, only in the shared folder", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, seed, write, names, exists } =
          yield* setup;
        const name = (id: string) => `.t3-memory-${id.padEnd(36, "0")}.tmp`;
        // utimes takes seconds.
        const old = ((yield* Clock.currentTimeMillis) - 2 * 60 * 60 * 1000) / 1000;
        yield* fileSystem.makeDirectory(path.join(shared, "notes"));
        const stale = [path.join(shared, name("a")), path.join(shared, "notes", name("b"))];
        for (const file of stale) {
          yield* write(file, "crash leftover");
          yield* fileSystem.utimes(file, old, old);
        }
        const fresh = path.join(shared, name("c"));
        yield* write(fresh, "a seed running elsewhere");
        const lookalike = path.join(shared, ".t3-memory-mine.tmp");
        yield* write(lookalike, "not ours");
        yield* fileSystem.utimes(lookalike, old, old);
        // Not followed: a linked folder, and the account's own folder.
        const outside = path.join(root, "outside");
        yield* fileSystem.makeDirectory(outside);
        const outsideTemporary = path.join(outside, name("d"));
        yield* write(outsideTemporary, "outside");
        yield* fileSystem.utimes(outsideTemporary, old, old);
        yield* fileSystem.symlink(outside, path.join(shared, "linked"));
        const accountTemporary = path.join(account, name("e"));
        yield* write(accountTemporary, "account");
        yield* fileSystem.utimes(accountTemporary, old, old);

        assert.isTrue(Exit.isSuccess(yield* seed()));
        for (const file of stale) assert.isFalse(yield* exists(file));
        assert.isTrue(yield* exists(fresh));
        assert.isTrue(yield* exists(lookalike));
        assert.isTrue(yield* exists(outsideTemporary));
        assert.isTrue(yield* exists(accountTemporary));
        // The account's temporary file was not copied either.
        assert.isFalse((yield* names(shared)).includes(name("e")));
      }),
    ),
  );
});

describe("shared memory: aliases never let a write reach an account's files (R1, R8, R13)", () => {
  it.effect("R1 a shared MEMORY.md symlinked to the account index is left alone", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, seed, write, read } = yield* setup;
        const accountIndex = path.join(account, "MEMORY.md");
        yield* write(accountIndex, "# Account-only memory\n");
        yield* write(path.join(account, "topic.md"), memory());
        yield* fileSystem.symlink(accountIndex, path.join(shared, "MEMORY.md"));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(accountIndex), "# Account-only memory\n");
        assert.equal(
          (yield* fileSystem.lstat(path.join(shared, "MEMORY.md"))).type,
          "SymbolicLink",
        );
      }),
    ),
  );

  it.effect("R13 a shared MEMORY.md hard-linked to another account's index is left alone", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, seed, write, read } = yield* setup;
        const other = path.join(root, "other-account");
        yield* fileSystem.makeDirectory(other);
        yield* write(path.join(other, "MEMORY.md"), "# Other account\n");
        yield* fileSystem.link(path.join(other, "MEMORY.md"), path.join(shared, "MEMORY.md"));
        yield* write(path.join(account, "MEMORY.md"), "- [one](one.md)\n");
        yield* write(path.join(account, "one.md"), memory("one"));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(other, "MEMORY.md")), "# Other account\n");
        assert.include(yield* read(path.join(shared, "SEEDED-FILES.md")), "- [one](one.md)\n");
      }),
    ),
  );

  it.effect("a shared folder that is a symlink to the account folder is never written", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, memoryRoot, account, seed, write, tree } = yield* setup;
        const linked = path.join(memoryRoot, "linked-shared");
        yield* fileSystem.symlink(account, linked);
        yield* write(path.join(account, "MEMORY.md"), "# Account\n");
        yield* write(path.join(account, "topic.md"), memory());
        const before = yield* tree(account);
        const result = yield* seed({
          sharedDirectory: linked,
          sourceDirectories: [path.join(memoryRoot, "none")],
        });
        assert.deepEqual(yield* tree(account), before);
        assert.isTrue(Exit.isFailure(result));
      }),
    ),
  );

  it.effect("a shared folder inside an account folder is never written", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, account, seed, write, tree } = yield* setup;
        const nested = path.join(account, "shared");
        yield* fileSystem.makeDirectory(nested);
        yield* write(path.join(account, "topic.md"), memory());
        const before = yield* tree(account);
        const result = yield* seed({ sharedDirectory: nested });
        assert.deepEqual(yield* tree(account), before);
        assert.isTrue(Exit.isFailure(result));
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
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(account, "other.md")), memory("account"));
        assert.equal(yield* read(path.join(shared, "topic.conflict-work.md")), memory("new"));
      }),
    ),
  );
});

describe("shared memory: the seed marker means every file arrived (R2–R7, R11)", () => {
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
        for (let number = 2; number < 100; number++) {
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
        yield* seed({ account: "../../elsewhere/☃" });
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

describe("shared memory: folders migrate with their index links (R5)", () => {
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
        assert.equal(
          yield* read(path.join(shared, "MEMORY.md")),
          "- [Topic](notes/topic.md)\n- [more](notes/deep/more.md): useful\n",
        );
        assert.isTrue(yield* exists(marker));
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

describe("shared memory: concurrent seeds (R9, R14)", () => {
  it.effect("R9 two same-process account starts list every file once", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, seed, write, read, names } = yield* setup;
        const other = path.join(root, "account2");
        yield* fileSystem.makeDirectory(other);
        yield* write(path.join(account, "one.md"), memory("one"));
        yield* write(path.join(account, "MEMORY.md"), "- [one](one.md)\n");
        yield* write(path.join(other, "two.md"), memory("two"));
        yield* write(path.join(other, "MEMORY.md"), "- [two](two.md)\n");
        yield* Effect.all([seed(), seed({ sourceDirectories: [other], account: "other" })], {
          concurrency: "unbounded",
        });
        const listed: string[] = [];
        for (const file of yield* names(shared)) {
          if (file === "MEMORY.md" || file.startsWith("SEEDED-FILES")) {
            listed.push(...linkedPaths(yield* read(path.join(shared, file))));
          }
        }
        assert.deepEqual(listed.sort(), ["one.md", "two.md"]);
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
        yield* Effect.all([seed(), seed({ sourceDirectories: [other], account: "other" })], {
          concurrency: "unbounded",
        });
        const contents = yield* Effect.forEach(yield* names(shared), (file) =>
          read(path.join(shared, file)),
        );
        assert.include(contents, memory("one"));
        assert.include(contents, memory("two"));
      }),
    ),
  );
});

describe("shared memory: link targets are encoded file paths (R12)", () => {
  it.effect("R12 a # and other special characters in file names link to the file", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, seed, write, read } = yield* setup;
        const files = ["a#b.md", "with space.md", "paren (1).md", "100%.md", "q?.md"];
        for (const file of files) yield* write(path.join(account, file), memory("hash [x]"));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        const index = yield* read(path.join(shared, "MEMORY.md"));
        assert.include(index, "](a%23b.md)");
        assert.include(index, "[hash \\[x\\]]");
        assert.deepEqual(linkedPaths(index).sort(), [...files].sort());
      }),
    ),
  );
});

describe("shared memory: bounded start-up work (R15)", () => {
  it.effect("R15 large files stay byte-identical", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, seed } = yield* setup;
        const big = new Uint8Array(16 * 1024 * 1024).fill(0xa5);
        yield* fileSystem.writeFile(path.join(account, "big.bin"), big);
        assert.isTrue(Exit.isSuccess(yield* seed()));
        const copied = yield* fileSystem.readFile(path.join(shared, "big.bin"));
        assert.isTrue(copied.length === big.length && copied.every((byte) => byte === 0xa5));
      }),
    ),
  );
});
