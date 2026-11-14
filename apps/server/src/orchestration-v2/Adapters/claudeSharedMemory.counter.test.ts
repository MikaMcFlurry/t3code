import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import { claudeSharedMemoryMarker, seedSharedClaudeMemory } from "./claudeSharedMemory.ts";
import { createTestLink, folderLinkKinds } from "./sharedMemoryTestLinks.ts";

/**
 * Counter-cases from the independent reviews of the shared memory seed: R1–R15 from the first,
 * SMS2 S1–S8 from the second, SMS3 N1/N2 from the third. Each guards a way the seed once lost,
 * overwrote or removed memory.
 */

/**
 * POSIX permission bits (`chmod 0`/`0500`) do not deny reading or writing on Windows, and `?` is
 * not allowed in a Windows file name. Those cases run on POSIX only; the same protection is
 * checked on every platform by injecting the error the file system would report.
 */
const isWindows = HostProcess.Platform.defaultValue() === "win32";

const denied = (method: string, file: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: file,
  });

/**
 * A file system whose new files (opened `wx`, as the seed creates every file) are written by
 * `writeAll` instead, for write failures and writers racing the seed.
 */
const withNewFileWrites = (
  fileSystem: FileSystem.FileSystem,
  writeAll: (
    file: FileSystem.File,
    bytes: Uint8Array,
    target: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>,
): FileSystem.FileSystem => ({
  ...fileSystem,
  open: (target, options) =>
    options?.flag === "wx"
      ? Effect.map(fileSystem.open(target, options), (file) =>
          Object.assign(Object.create(file) as FileSystem.File, {
            writeAll: (bytes: Uint8Array) => writeAll(file, bytes, target),
          }),
        )
      : fileSystem.open(target, options),
});

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
    overrides: Partial<typeof input & { abandoned: () => boolean }> = {},
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
        const racing = withNewFileWrites(watched, (file, bytes) =>
          file
            .writeAll(bytes)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => ++rewrites).pipe(
                  Effect.flatMap((count) =>
                    fileSystem.writeFileString(indexPath, `# Memory\nUSER FACT ${count}\n`),
                  ),
                ),
              ),
            ),
        );
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

describe("SMS3-2: an account MEMORY.md is never lost, free notes included (P2)", () => {
  it.effect("N2 an account index with only an unlinked note is kept whole before the marker", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, marker, seed, write, read, exists, names } = yield* setup;
        yield* write(path.join(shared, "MEMORY.md"), "# Shared\n");
        const accountIndex = "ACCOUNT UNIQUE FACT WITHOUT A LINK\n";
        yield* write(path.join(account, "MEMORY.md"), accountIndex);
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "MEMORY.md")), "# Shared\n");
        assert.equal(yield* read(path.join(shared, "MEMORY.from-work.md")), accountIndex);
        assert.include(yield* read(path.join(shared, "SEEDED-FILES.md")), "](MEMORY.from-work.md)");
        assert.deepEqual(yield* names(shared), [
          "MEMORY.from-work.md",
          "MEMORY.md",
          "SEEDED-FILES.md",
        ]);
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );

  it.effect("N2 a mixed index keeps its layout, free text and own link labels byte for byte", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, seed, write, read } = yield* setup;
        yield* write(path.join(shared, "MEMORY.md"), "# Shared\n- [topic](topic.md): shared\n");
        yield* write(path.join(shared, "topic.md"), memory());
        yield* write(path.join(account, "topic.md"), memory());
        const accountIndex =
          "# Account\n\nContext paragraph.\n\n- [My label](topic.md): mine\n- [My label](topic.md): mine\nFREE NOTE\n";
        yield* write(path.join(account, "MEMORY.md"), accountIndex);
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "MEMORY.from-work.md")), accountIndex);
      }),
    ),
  );

  it.effect("an account index equal to the shared one is not copied again", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, seed, write, names } = yield* setup;
        yield* write(path.join(shared, "MEMORY.md"), "# Same\n");
        yield* write(path.join(account, "MEMORY.md"), "# Same\n");
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.deepEqual(yield* names(shared), ["MEMORY.md"]);
      }),
    ),
  );

  it.effect("a taken copy name keeps both: the account index goes to the next free name", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, seed, write, read } = yield* setup;
        yield* write(path.join(shared, "MEMORY.md"), "# Shared\n");
        yield* write(path.join(shared, "MEMORY.from-work.md"), "SOMEONE ELSE\n");
        yield* write(path.join(account, "MEMORY.md"), "ACCOUNT NOTE\n");
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "MEMORY.from-work.md")), "SOMEONE ELSE\n");
        assert.equal(yield* read(path.join(shared, "MEMORY.from-work-2.md")), "ACCOUNT NOTE\n");
        assert.include(
          yield* read(path.join(shared, "SEEDED-FILES.md")),
          "](MEMORY.from-work-2.md)",
        );
      }),
    ),
  );

  it.effect("a failed copy of the account index leaves no marker; a retry keeps it", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, memoryFs, seed, write, read, exists } =
          yield* setup;
        yield* write(path.join(shared, "MEMORY.md"), "# Shared\n");
        yield* write(path.join(account, "MEMORY.md"), "ACCOUNT NOTE\n");
        const failing: FileSystem.FileSystem = {
          ...fileSystem,
          link: (from, to) =>
            path.basename(to).startsWith("MEMORY.from-")
              ? Effect.fail(injected("link", "EIO injected"))
              : fileSystem.link(from, to),
        };
        assert.isTrue(Exit.isFailure(yield* seed({}, { ...memoryFs, fileSystem: failing })));
        assert.isFalse(yield* exists(marker));
        assert.isFalse(yield* exists(path.join(shared, "MEMORY.from-work.md")));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "MEMORY.from-work.md")), "ACCOUNT NOTE\n");
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );

  it.effect("a shared index another writer creates during the seed keeps the account index", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, memoryFs, seed, write, read } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        yield* write(path.join(account, "MEMORY.md"), "ACCOUNT NOTE\n- [topic](topic.md)\n");
        const indexPath = path.join(shared, "MEMORY.md");
        let raced = false;
        const racing: FileSystem.FileSystem = {
          ...fileSystem,
          link: (from, to) =>
            (to === indexPath && !raced
              ? Effect.sync(() => {
                  raced = true;
                }).pipe(Effect.andThen(fileSystem.writeFileString(indexPath, "# Claude\n")))
              : Effect.void
            ).pipe(Effect.andThen(fileSystem.link(from, to))),
        };
        assert.isTrue(Exit.isSuccess(yield* seed({}, { ...memoryFs, fileSystem: racing })));
        assert.isTrue(raced);
        assert.equal(yield* read(indexPath), "# Claude\n");
        assert.equal(
          yield* read(path.join(shared, "MEMORY.from-work.md")),
          "ACCOUNT NOTE\n- [topic](topic.md)\n",
        );
      }),
    ),
  );

  it.effect("a new MEMORY.md is the account index as it was; a second one is kept whole", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, root, shared, account, seed, write, read } = yield* setup;
        const other = path.join(root, "account-cwd");
        yield* fileSystem.makeDirectory(other);
        const first = "# Account\n\nFREE NOTE\n\n- [topic](topic.md)\n";
        yield* write(path.join(account, "topic.md"), memory());
        yield* write(path.join(account, "MEMORY.md"), first);
        yield* write(path.join(other, "MEMORY.md"), "OTHER FOLDER NOTE\n");
        assert.isTrue(Exit.isSuccess(yield* seed({ sourceDirectories: [account, other] })));
        const index = yield* read(path.join(shared, "MEMORY.md"));
        assert.isTrue(index.startsWith(first), index);
        assert.include(index, "](MEMORY.from-work.md)");
        assert.equal(yield* read(path.join(shared, "MEMORY.from-work.md")), "OTHER FOLDER NOTE\n");
      }),
    ),
  );
});

describe("SMS2-3: metadata paths get the same alias checks as memory files (P1)", () => {
  it.effect.each(folderLinkKinds)(
    "S4/S5 a marker folder linked to an account folder is never written through (%s)",
    (kind) =>
      run(
        Effect.gen(function* () {
          const {
            fileSystem,
            path,
            memoryRoot,
            shared,
            account,
            marker,
            seed,
            write,
            tree,
            names,
          } = yield* setup;
          yield* fileSystem.makeDirectory(path.join(account, "project-1"));
          yield* write(path.join(account, "topic.md"), memory());
          yield* createTestLink(account, path.join(memoryRoot, ".seeded-v2"), kind);
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

  it.effect.each(folderLinkKinds)(
    "S4 a project marker folder linked to an account folder is never written through (%s)",
    (kind) =>
      run(
        Effect.gen(function* () {
          const { fileSystem, path, memoryRoot, account, seed, write, tree } = yield* setup;
          yield* write(path.join(account, "topic.md"), memory());
          yield* write(path.join(account, "work"), "ACCOUNT HISTORY\n");
          yield* fileSystem.makeDirectory(path.join(memoryRoot, ".seeded-v2"));
          yield* createTestLink(account, path.join(memoryRoot, ".seeded-v2", "project-1"), kind);
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

  it.effect("a marker skips an unchanged account without reading its files", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, memoryFs, seed, write, names } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        assert.isTrue(Exit.isSuccess(yield* seed()));
        yield* fileSystem.remove(path.join(shared, "topic.md"));
        let accountReads = 0;
        const counted: FileSystem.FileSystem = {
          ...fileSystem,
          readFile: (file) => {
            if (file.startsWith(account)) accountReads++;
            return fileSystem.readFile(file);
          },
          open: (file, options) => {
            if (file.startsWith(account)) accountReads++;
            return fileSystem.open(file, options);
          },
        };
        const again = yield* seed({}, { ...memoryFs, fileSystem: counted });
        assert.isTrue(Exit.isSuccess(again) && again.value === false);
        assert.equal(accountReads, 0);
        // A file removed from the shared folder does not come back while the account's is unchanged.
        assert.deepEqual(yield* names(shared), ["MEMORY.md"]);
      }),
    ),
  );

  it.effect("a marker of the earlier format leads to one more additive seed", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, seed, write, read } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        yield* fileSystem.makeDirectory(path.dirname(marker), { recursive: true });
        yield* write(marker, "seeded v2\n");
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
        assert.isTrue((yield* read(marker)).startsWith("seeded v2\n{"));
        const again = yield* seed();
        assert.isTrue(Exit.isSuccess(again) && again.value === false);
      }),
    ),
  );
});

describe("SMS2-5/SMS3-1: only a temporary file this run created is ever removed (P1)", () => {
  it.effect("a temporary name found taken is never removed as if it were the seed's own", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, account, marker, memoryFs, seed, write, exists } = yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        const removed: string[] = [];
        const taken: FileSystem.FileSystem = {
          ...fileSystem,
          open: (file, options) =>
            options?.flag === "wx"
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "AlreadyExists",
                    module: "FileSystem",
                    method: "open",
                    pathOrDescriptor: file,
                  }),
                )
              : fileSystem.open(file, options),
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

  it.effect("a failed create proves no ownership: a file found under the name is kept", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, account, marker, memoryFs, seed, write, read, exists } =
          yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        let foreign: string | undefined;
        // Someone else's file appears under the name and the open fails with an unrelated error.
        const failing: FileSystem.FileSystem = {
          ...fileSystem,
          open: (file, options) =>
            options?.flag === "wx"
              ? fileSystem.writeFileString(file, "SOMEONE ELSE\n").pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      foreign = file;
                    }),
                  ),
                  Effect.andThen(Effect.fail(injected("open", "EIO injected"))),
                )
              : fileSystem.open(file, options),
        };
        assert.isTrue(Exit.isFailure(yield* seed({}, { ...memoryFs, fileSystem: failing })));
        assert.isDefined(foreign);
        assert.equal(yield* read(foreign!), "SOMEONE ELSE\n");
        assert.isFalse(yield* exists(marker));
      }),
    ),
  );

  it.effect("a file that replaced the seed's temporary file before its removal is kept", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, memoryFs, seed, write, read, exists } =
          yield* setup;
        yield* write(path.join(account, "topic.md"), memory());
        const swapped: string[] = [];
        const swapping: FileSystem.FileSystem = {
          ...fileSystem,
          link: (from, to) =>
            fileSystem
              .link(from, to)
              .pipe(
                Effect.tap(() =>
                  fileSystem
                    .remove(from)
                    .pipe(
                      Effect.andThen(fileSystem.writeFileString(from, "SOMEONE ELSE\n")),
                      Effect.andThen(Effect.sync(() => swapped.push(from))),
                    ),
                ),
              ),
        };
        assert.isTrue(Exit.isSuccess(yield* seed({}, { ...memoryFs, fileSystem: swapping })));
        assert.isAbove(swapped.length, 0);
        for (const file of swapped) assert.equal(yield* read(file), "SOMEONE ELSE\n");
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
        assert.isTrue(yield* exists(marker));
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

  it.live("N1 files named like old temporary files are never removed, whoever made them", () =>
    run(
      Effect.gen(function* () {
        const {
          fileSystem,
          path,
          root,
          shared,
          account,
          marker,
          seed,
          write,
          read,
          names,
          exists,
        } = yield* setup;
        // utimes takes seconds; a year old, far past any age rule.
        const old = ((yield* Clock.currentTimeMillis) - 365 * 24 * 60 * 60 * 1000) / 1000;
        yield* write(path.join(account, "topic.md"), memory());
        yield* fileSystem.makeDirectory(path.join(shared, "notes"));
        const userData = "USER DATA - never created by T3\n";
        const lookalikes = [
          path.join(shared, `.t3-memory-${"-".repeat(36)}.tmp`),
          path.join(shared, ".t3-memory-01234567-89ab-4cde-8fab-0123456789ab.tmp"),
          path.join(shared, "notes", ".t3-memory-fedcba98-7654-4321-8fed-cba987654321.tmp"),
        ];
        for (const file of lookalikes) {
          yield* write(file, userData);
          yield* fileSystem.utimes(file, old, old);
        }
        // A hard link to a file elsewhere, and a symlink, both under a temporary-looking name.
        const elsewhere = path.join(root, "elsewhere.md");
        yield* write(elsewhere, userData);
        const hardLinked = path.join(shared, ".t3-memory-11111111-2222-4333-8444-555555555555.tmp");
        yield* fileSystem.link(elsewhere, hardLinked);
        yield* fileSystem.utimes(hardLinked, old, old);
        const symlinked = path.join(shared, ".t3-memory-66666666-7777-4888-8999-aaaaaaaaaaaa.tmp");
        yield* createTestLink(elsewhere, symlinked, "file");

        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.isTrue(yield* exists(marker));
        for (const file of [...lookalikes, hardLinked]) assert.equal(yield* read(file), userData);
        assert.equal((yield* fileSystem.lstat(symlinked)).type, "SymbolicLink");
        assert.deepEqual(Option.getOrUndefined((yield* fileSystem.lstat(elsewhere)).nlink), 2n);
        // The seed's own temporary files are gone: only the planted ones are left.
        const temporaries = (yield* names(shared)).filter((name) => name.startsWith(".t3-memory-"));
        assert.equal(temporaries.length, 4);
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
        yield* createTestLink(accountIndex, path.join(shared, "MEMORY.md"), "file");
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

  it.effect.each(folderLinkKinds)(
    "a shared folder that is a symlink to the account folder is never written (%s)",
    (kind) =>
      run(
        Effect.gen(function* () {
          const { path, memoryRoot, account, seed, write, tree } = yield* setup;
          const linked = path.join(memoryRoot, "linked-shared");
          yield* createTestLink(account, linked, kind);
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

  it.effect.each(folderLinkKinds)(
    "a shared subfolder symlinked into an account folder receives no copies (%s)",
    (kind) =>
      run(
        Effect.gen(function* () {
          const { fileSystem, path, root, shared, account, marker, seed, write, exists, tree } =
            yield* setup;
          const victim = path.join(root, "victim-account");
          yield* fileSystem.makeDirectory(victim);
          yield* write(path.join(victim, "keep.md"), memory("keep"));
          yield* createTestLink(victim, path.join(shared, "notes"), kind);
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
        const { path, shared, account, seed, write, read } = yield* setup;
        yield* write(path.join(account, "other.md"), memory("account"));
        yield* write(path.join(account, "topic.md"), memory("new"));
        yield* createTestLink(
          path.join(account, "other.md"),
          path.join(shared, "topic.md"),
          "file",
        );
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(account, "other.md")), memory("account"));
        assert.equal(yield* read(path.join(shared, "topic.conflict-work.md")), memory("new"));
      }),
    ),
  );
});

describe("shared memory: the seed marker means every file arrived (R2–R7, R11)", () => {
  // chmod 0500 does not stop writes on Windows; R2i below injects the denial instead.
  it.effect.skipIf(isWindows)(
    "R2 a shared folder that cannot be written leaves no marker; a retry copies",
    () =>
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
        const broken = withNewFileWrites(fileSystem, (file, bytes) => {
          if (!first) return Effect.fail(injected("write"));
          first = false;
          return file
            .writeAll(bytes.slice(0, 5))
            .pipe(Effect.andThen(Effect.fail(injected("write"))));
        });
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
        const short = withNewFileWrites(fileSystem, (file, bytes) =>
          file.writeAll(bytes.slice(0, 5)),
        );
        const failed = yield* seed({}, { ...memoryFs, fileSystem: short });
        assert.isTrue(Exit.isFailure(failed));
        assert.isFalse(yield* exists(marker));
        assert.deepEqual(yield* names(shared), []);
      }),
    ),
  );

  // chmod 0 does not stop reads on Windows; R4i below injects the denial instead.
  it.effect.skipIf(isWindows)(
    "R4 an account folder that cannot be read leaves no marker; a retry copies",
    () =>
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

  // chmod 0 does not stop reads on Windows; R6i below injects the denial instead.
  it.effect.skipIf(isWindows)(
    "R6 a memory file that cannot be read leaves no marker; a retry copies",
    () =>
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

  it.effect(
    "R2i/R4i/R6i a denied write, folder read or file read leaves no marker (all platforms)",
    () =>
      run(
        Effect.gen(function* () {
          const { fileSystem, path, shared, account, marker, memoryFs, seed, write, read, exists } =
            yield* setup;
          const file = path.join(account, "topic.md");
          yield* write(file, memory());
          const cases: ReadonlyArray<readonly [string, FileSystem.FileSystem]> = [
            [
              "R2i shared folder not writable",
              {
                ...fileSystem,
                open: (target, options) =>
                  options?.flag === "wx"
                    ? Effect.fail(denied("open", target))
                    : fileSystem.open(target, options),
              },
            ],
            [
              "R4i account folder not readable",
              {
                ...fileSystem,
                readDirectory: (target, options) =>
                  target === account
                    ? Effect.fail(denied("readDirectory", target))
                    : fileSystem.readDirectory(target, options),
              },
            ],
            [
              "R6i memory file not readable",
              {
                ...fileSystem,
                readFile: (target) =>
                  target === file
                    ? Effect.fail(denied("readFile", target))
                    : fileSystem.readFile(target),
              },
            ],
          ];
          for (const [label, deniedFs] of cases) {
            const failed = yield* seed({}, { ...memoryFs, fileSystem: deniedFs });
            assert.isTrue(Exit.isFailure(failed), label);
            assert.isFalse(yield* exists(marker), label);
            assert.isFalse(yield* exists(path.join(shared, "topic.md")), label);
          }
          assert.isTrue(Exit.isSuccess(yield* seed()));
          assert.equal(yield* read(path.join(shared, "topic.md")), memory());
          assert.isTrue(yield* exists(marker));
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
        const { path, root, shared, account, marker, seed, write, exists, names } = yield* setup;
        yield* write(path.join(root, "outside.md"), memory("outside"));
        yield* createTestLink(
          path.join(root, "outside.md"),
          path.join(account, "topic.md"),
          "file",
        );
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
        // The account whose index did not become MEMORY.md has it kept whole and linked.
        const kept = listed.filter((file) => file.startsWith("MEMORY.from-"));
        assert.equal(kept.length, 1);
        assert.oneOf(yield* read(path.join(shared, kept[0]!)), [
          "- [one](one.md)\n",
          "- [two](two.md)\n",
        ]);
        assert.deepEqual(listed.filter((file) => !kept.includes(file)).sort(), [
          "one.md",
          "two.md",
        ]);
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
  // Names valid on every platform, Windows included.
  it.effect("R12 a # and other special characters in file names link to the file", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, seed, write, read } = yield* setup;
        const files = [
          "a#b.md",
          "a#b%c.md",
          "with space.md",
          "paren (1).md",
          "100%.md",
          "semi;colon&amp.md",
        ];
        for (const file of files) yield* write(path.join(account, file), memory("hash [x]"));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        const index = yield* read(path.join(shared, "MEMORY.md"));
        assert.include(index, "](a%23b.md)");
        assert.include(index, "[hash \\[x\\]]");
        assert.deepEqual(linkedPaths(index).sort(), [...files].sort());
      }),
    ),
  );

  // `?` is not allowed in a Windows file name; the encoding of other names is checked above.
  it.effect.skipIf(isWindows)("R12 a ? in a file name links to the file (POSIX)", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, seed, write, read } = yield* setup;
        yield* write(path.join(account, "q?.md"), memory("question"));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        const index = yield* read(path.join(shared, "MEMORY.md"));
        assert.include(index, "](q%3F.md)");
        assert.deepEqual(linkedPaths(index), ["q?.md"]);
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

describe("SMS4-1: what an account writes during or after a seed reaches the shared folder (P2)", () => {
  /** Every Markdown file of the shared folder, joined: where a fact is does not matter here. */
  const sharedText = (
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    shared: string,
  ): Effect.Effect<string, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const texts: string[] = [];
      for (const name of yield* fileSystem.readDirectory(shared)) {
        if (name.endsWith(".md"))
          texts.push(yield* fileSystem.readFileString(path.join(shared, name)));
      }
      return texts.join("\n");
    });

  it.effect("N10 account writes while the seed publishes are copied before its marker", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, marker, memoryFs, seed, write, read, exists } =
          yield* setup;
        yield* write(path.join(account, "a.md"), "OLD");
        yield* write(path.join(account, "MEMORY.md"), "OLD INDEX");
        let wrote = false;
        // The seed has read the account and publishes a.md; the account session writes meanwhile.
        const racing: FileSystem.FileSystem = {
          ...fileSystem,
          link: (from, to) =>
            (to === path.join(shared, "a.md") && !wrote
              ? Effect.gen(function* () {
                  wrote = true;
                  yield* write(path.join(account, "a.md"), "NEW ACCOUNT FACT");
                  yield* write(path.join(account, "MEMORY.md"), "NEW INDEX FACT");
                  yield* write(path.join(account, "new.md"), "NEW FILE FACT");
                })
              : Effect.void
            ).pipe(Effect.andThen(fileSystem.link(from, to))),
        };
        assert.isTrue(Exit.isSuccess(yield* seed({}, { ...memoryFs, fileSystem: racing })));
        assert.isTrue(wrote);
        assert.isTrue(yield* exists(marker));
        const text = yield* sharedText(fileSystem, path, shared);
        assert.include(text, "NEW ACCOUNT FACT");
        assert.include(text, "NEW INDEX FACT");
        assert.equal(yield* read(path.join(shared, "new.md")), "NEW FILE FACT");
        // The first version stays as well; the account is unchanged by the seed.
        assert.equal(yield* read(path.join(shared, "a.md")), "OLD");
        assert.equal(yield* read(path.join(account, "a.md")), "NEW ACCOUNT FACT");
      }),
    ),
  );

  it.effect(
    "account writes after the marker (a session still on its own memory) arrive next time",
    () =>
      run(
        Effect.gen(function* () {
          const { path, shared, account, seed, write, read } = yield* setup;
          yield* write(path.join(account, "a.md"), "a\n");
          yield* write(path.join(account, "MEMORY.md"), "- [a](a.md)\n");
          assert.isTrue(Exit.isSuccess(yield* seed()));
          yield* write(path.join(account, "a.md"), "CHANGED FACT\n");
          yield* write(path.join(account, "new.md"), "NEW FILE FACT\n");
          yield* write(path.join(account, "MEMORY.md"), "- [a](a.md)\nFREE TEXT ONLY\n");
          const again = yield* seed();
          assert.isTrue(Exit.isSuccess(again) && again.value === true);
          assert.equal(yield* read(path.join(shared, "a.md")), "a\n");
          assert.equal(yield* read(path.join(shared, "a.conflict-work.md")), "CHANGED FACT\n");
          assert.equal(yield* read(path.join(shared, "new.md")), "NEW FILE FACT\n");
          assert.equal(yield* read(path.join(shared, "MEMORY.md")), "- [a](a.md)\n");
          assert.equal(
            yield* read(path.join(shared, "MEMORY.from-work.md")),
            "- [a](a.md)\nFREE TEXT ONLY\n",
          );
          const third = yield* seed();
          assert.isTrue(Exit.isSuccess(third) && third.value === false);
        }),
      ),
  );

  it.effect("an account that keeps changing during every pass leaves no marker", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, account, marker, memoryFs, seed, write, exists } = yield* setup;
        yield* write(path.join(account, "a.md"), "a\n");
        let writes = 0;
        const busy: FileSystem.FileSystem = {
          ...fileSystem,
          link: (from, to) =>
            write(path.join(account, `busy-${++writes}.md`), `busy ${writes}\n`).pipe(
              Effect.andThen(fileSystem.link(from, to)),
            ),
        };
        const result = yield* seed({}, { ...memoryFs, fileSystem: busy });
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
        // Quiet again, the next start finishes.
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );
});

describe("SMS4-1/2: a seed the session start gave up on records nothing (P2)", () => {
  it.effect("an abandoned seed keeps what it published but writes no marker", () =>
    run(
      Effect.gen(function* () {
        const { path, shared, account, marker, seed, write, read, exists } = yield* setup;
        yield* write(path.join(account, "a.md"), "a\n");
        const result = yield* seed({ abandoned: () => true });
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
        assert.equal(yield* read(path.join(shared, "a.md")), "a\n");
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.isTrue(yield* exists(marker));
      }),
    ),
  );

  it.effect("a marker call that returns after the start gave up leaves no marker", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, account, marker, memoryFs, seed, write, exists } = yield* setup;
        yield* write(path.join(account, "a.md"), "a\n");
        let abandoned = false;
        // The start gives up while the call that makes the marker visible is still running.
        const late: FileSystem.FileSystem = {
          ...fileSystem,
          link: (from, to) =>
            fileSystem.link(from, to).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (to === marker) abandoned = true;
                }),
              ),
            ),
        };
        const result = yield* seed(
          { abandoned: () => abandoned },
          { ...memoryFs, fileSystem: late },
        );
        assert.isTrue(abandoned);
        assert.isTrue(Exit.isFailure(result));
        assert.isFalse(yield* exists(marker));
        // No temporary file of the marker stays behind either.
        const leftovers = (yield* fileSystem.readDirectory(path.dirname(marker))).filter((name) =>
          name.startsWith(".t3-memory-"),
        );
        assert.deepEqual(leftovers, []);
      }),
    ),
  );
});

/**
 * Case-insensitive volumes (NTFS, APFS by default): an existing name that differs only in case is
 * taken, and the seed must find another name for its copy. On a case-sensitive volume both names
 * are distinct and both versions are kept as well. Set T3_EXPECT_CASE_INSENSITIVE=1 to require the
 * folded branch, so a native Windows or macOS run proves it.
 */
describe("SMS4-3: case-folded name collisions keep both versions", () => {
  const requireFolded = process.env.T3_EXPECT_CASE_INSENSITIVE === "1";
  const folds = (fileSystem: FileSystem.FileSystem, existing: string, other: string) =>
    Effect.gen(function* () {
      const folded = yield* fileSystem.exists(other);
      if (requireFolded) assert.isTrue(folded, `${existing} does not fold to ${other} here`);
      return folded;
    });

  it.effect("N6 Foo.md in the shared folder and foo.md in the account", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, seed, write, read } = yield* setup;
        yield* write(path.join(shared, "Foo.md"), "EXISTING");
        yield* write(path.join(account, "foo.md"), "ACCOUNT");
        const folded = yield* folds(fileSystem, "Foo.md", path.join(shared, "foo.md"));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "Foo.md")), "EXISTING");
        assert.equal(
          yield* read(path.join(shared, folded ? "foo.conflict-work.md" : "foo.md")),
          "ACCOUNT",
        );
      }),
    ),
  );

  it.effect("N7 an existing memory.md is kept and no second MEMORY.md appears", () =>
    run(
      Effect.gen(function* () {
        const { fileSystem, path, shared, account, seed, write, read, names } = yield* setup;
        yield* write(path.join(shared, "memory.md"), "SHARED LOWERCASE");
        yield* write(path.join(account, "topic.md"), memory());
        const folded = yield* folds(fileSystem, "memory.md", path.join(shared, "MEMORY.md"));
        assert.isTrue(Exit.isSuccess(yield* seed()));
        assert.equal(yield* read(path.join(shared, "memory.md")), "SHARED LOWERCASE");
        const listed = yield* names(shared);
        if (folded) {
          assert.isFalse(listed.includes("MEMORY.md"));
          assert.include(yield* read(path.join(shared, "SEEDED-FILES.md")), "](topic.md)");
        }
        assert.equal(yield* read(path.join(shared, "topic.md")), memory());
      }),
    ),
  );

  it.effect(
    "N8 an existing memory.from-work.md keeps its bytes; the account index goes elsewhere",
    () =>
      run(
        Effect.gen(function* () {
          const { fileSystem, path, shared, account, seed, write, read } = yield* setup;
          yield* write(path.join(shared, "MEMORY.md"), "SHARED");
          yield* write(path.join(shared, "memory.from-work.md"), "EXISTING");
          yield* write(path.join(account, "MEMORY.md"), "ACCOUNT");
          const folded = yield* folds(
            fileSystem,
            "memory.from-work.md",
            path.join(shared, "MEMORY.from-work.md"),
          );
          assert.isTrue(Exit.isSuccess(yield* seed()));
          assert.equal(yield* read(path.join(shared, "memory.from-work.md")), "EXISTING");
          assert.equal(
            yield* read(
              path.join(shared, folded ? "MEMORY.from-work-2.md" : "MEMORY.from-work.md"),
            ),
            "ACCOUNT",
          );
        }),
      ),
  );
});

/**
 * Device and inode numbers past 2^53 (as NTFS file ids are) are compared as BigInt: only a file with
 * exactly the identity the seed created is removed; a neighbouring, zero or missing one never is.
 */
describe("SMS4-3: temporary file identity is compared as BigInt", () => {
  const huge = 9007199254740992n;
  it.effect.each(["same", "neighbour", "zero", "missing"] as const)(
    "N9 a temporary file with %s identity",
    (identity) =>
      run(
        Effect.gen(function* () {
          const { fileSystem, path, shared, account, memoryFs, seed, write } = yield* setup;
          yield* write(path.join(account, "topic.md"), memory());
          let removed = 0;
          const relabelled: FileSystem.FileSystem = {
            ...fileSystem,
            open: (file, options) =>
              options?.flag !== "wx"
                ? fileSystem.open(file, options)
                : Effect.map(
                    fileSystem.open(file, options),
                    (handle) =>
                      Object.defineProperty(Object.create(handle), "stat", {
                        value: Effect.map(handle.stat, (info) => ({
                          ...info,
                          dev: huge,
                          ino: Option.some(huge),
                        })),
                      }) as FileSystem.File,
                  ),
            lstat: (file) =>
              Effect.map(fileSystem.lstat(file), (info) =>
                !file.endsWith(".tmp")
                  ? info
                  : {
                      ...info,
                      dev: huge,
                      ino:
                        identity === "missing"
                          ? Option.none()
                          : Option.some(
                              identity === "zero"
                                ? 0n
                                : identity === "neighbour"
                                  ? huge + 1n
                                  : huge,
                            ),
                    },
              ),
            remove: (file, options) => {
              if (file.endsWith(".tmp")) removed++;
              return fileSystem.remove(file, options);
            },
          };
          assert.isTrue(Exit.isSuccess(yield* seed({}, { ...memoryFs, fileSystem: relabelled })));
          // topic.md, MEMORY.md and the marker each had one temporary file.
          assert.equal(removed, identity === "same" ? 3 : 0);
          if (identity !== "same") {
            const left = (yield* fileSystem.readDirectory(shared)).filter((name) =>
              name.endsWith(".tmp"),
            );
            assert.lengthOf(left, 2);
          }
        }),
      ),
  );
});
