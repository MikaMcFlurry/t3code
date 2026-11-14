import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

/**
 * Shared Claude auto memory (`shareProjectMemory`): seeding the shared folder from an account's own
 * project memory, and keeping its `MEMORY.md` index complete. Nothing here overwrites or deletes a
 * memory file or an index line; a file two accounts hold in different versions is kept twice.
 */

const MEMORY_INDEX = "MEMORY.md";

// One writer at a time in this server, across Claude instances that share a project folder.
const sharedMemoryWrites = Semaphore.makeUnsafe(1);

interface MemoryFs {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/** Claude Code's folder name for a project path: every character but [A-Za-z0-9] becomes `-`. */
function claudeProjectFolderName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The project paths Claude Code may have filed this cwd's memory under: the git repository (the
 * main checkout for a worktree), as Claude Code keys auto memory, and the cwd itself.
 */
export const claudeMemoryProjectPaths = Effect.fn("claudeSharedMemory.projectPaths")(function* (
  { fileSystem, path }: MemoryFs,
  cwd: string,
) {
  const paths = new Set<string>();
  let directory = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(directory, ".git");
    const info = yield* fileSystem.stat(dotGit).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type === "Directory") {
      paths.add(directory);
      break;
    }
    if (info?.type === "File") {
      const pointer = yield* fileSystem.readFileString(dotGit).pipe(Effect.orElseSucceed(() => ""));
      const gitDir = pointer.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      const main = gitDir?.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/)?.[1];
      paths.add(main === undefined ? directory : path.resolve(directory, main));
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  paths.add(path.resolve(cwd));
  return [...paths];
});

/** Existing `<config dir>/projects/<project>/memory` folders for these project paths. */
export const claudeAccountMemoryDirectories = Effect.fn("claudeSharedMemory.accountDirectories")(
  function* (memoryFs: MemoryFs, configDir: string, projectPaths: readonly string[]) {
    const { fileSystem, path } = memoryFs;
    const projectsDir = path.join(configDir, "projects");
    const folders = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): string[] => []));
    const wanted = projectPaths.map(claudeProjectFolderName);
    // Claude Code shortens names past 200 characters and appends a hash.
    const matches = (folder: string) =>
      wanted.some(
        (name) =>
          folder === name || (name.length > 200 && folder.startsWith(`${name.slice(0, 200)}-`)),
      );
    const directories: string[] = [];
    for (const folder of folders.filter(matches).sort()) {
      const memory = path.join(projectsDir, folder, "memory");
      const info = yield* fileSystem.stat(memory).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type === "Directory") directories.push(memory);
    }
    return directories;
  },
);

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const conflictPattern = /^(.+)\.conflict-[A-Za-z0-9_-]+\.md$/;

const fileNames = Effect.fn("claudeSharedMemory.fileNames")(function* (
  { fileSystem, path }: MemoryFs,
  directory: string,
) {
  const names: string[] = [];
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): string[] => []));
  for (const name of entries.sort()) {
    const info = yield* fileSystem
      .stat(path.join(directory, name))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type === "File") names.push(name);
  }
  return names;
});

/** Appends lines to the index, starting on a fresh line. Never rewrites what is there. */
const appendIndexLines = Effect.fn("claudeSharedMemory.appendIndexLines")(function* (
  { fileSystem, path }: MemoryFs,
  directory: string,
  lines: readonly string[],
) {
  if (lines.length === 0) return;
  const indexPath = path.join(directory, MEMORY_INDEX);
  const current = yield* fileSystem.readFileString(indexPath).pipe(Effect.orElseSucceed(() => ""));
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  yield* fileSystem.writeFileString(indexPath, `${separator}${lines.join("\n")}\n`, {
    flag: "a",
  });
});

/** Copies one file, or keeps it beside a different version as `<name>.conflict-<account>.md`. */
const seedFile = Effect.fn("claudeSharedMemory.seedFile")(function* (
  memoryFs: MemoryFs,
  input: { readonly source: string; readonly target: string; readonly account: string },
) {
  const { fileSystem, path } = memoryFs;
  const bytes = yield* fileSystem.readFile(input.source);
  const name = path.basename(input.target);
  const stem = name.endsWith(".md") ? name.slice(0, -3) : name;
  for (let attempt = 1; attempt < 100; attempt++) {
    const candidate =
      attempt === 1
        ? input.target
        : path.join(
            path.dirname(input.target),
            `${stem}.conflict-${input.account}${attempt === 2 ? "" : `-${attempt - 1}`}.md`,
          );
    const existing = yield* fileSystem
      .readFile(candidate)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (existing !== undefined) {
      if (sameBytes(existing, bytes)) return;
      continue;
    }
    // `wx` never replaces a file another session wrote in the meantime.
    const written = yield* fileSystem.writeFile(candidate, bytes, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (written) return;
    const raced = yield* fileSystem.readFile(candidate).pipe(Effect.orElseSucceed(() => undefined));
    if (raced === undefined) {
      return yield* Effect.logWarning("Claude shared memory file could not be copied", {
        source: input.source,
        target: candidate,
      });
    }
    if (sameBytes(raced, bytes)) return;
  }
});

/**
 * Seeds the shared folder once per account from that account's project memory. Files only the
 * account has are copied; a different version of a file the folder already holds is kept beside it
 * as `<name>.conflict-<account>.md` and listed in the index; its `MEMORY.md` lines are added to the
 * shared index. The account's own files are only read.
 */
export const seedSharedClaudeMemory = Effect.fn("claudeSharedMemory.seed")(
  function* (
    memoryFs: MemoryFs,
    input: {
      readonly sharedDirectory: string;
      readonly sourceDirectories: readonly string[];
      readonly account: string;
      /** Records that the account was seeded; seeding is skipped while it exists. */
      readonly marker: string;
    },
  ) {
    const { fileSystem, path } = memoryFs;
    const account = input.account.replace(/[^A-Za-z0-9_-]/g, "-");
    if (yield* fileSystem.exists(input.marker).pipe(Effect.orElseSucceed(() => false))) return;
    for (const sourceDirectory of input.sourceDirectories) {
      if (path.resolve(sourceDirectory) === path.resolve(input.sharedDirectory)) continue;
      for (const name of yield* fileNames(memoryFs, sourceDirectory)) {
        const source = path.join(sourceDirectory, name);
        if (name === MEMORY_INDEX) {
          const shared = yield* fileSystem
            .readFileString(path.join(input.sharedDirectory, name))
            .pipe(Effect.orElseSucceed(() => ""));
          const present = new Set(shared.split("\n").map((line) => line.trim()));
          const missing = (yield* fileSystem.readFileString(source))
            .split("\n")
            .filter((line) => line.trim().length > 0 && !present.has(line.trim()));
          yield* appendIndexLines(memoryFs, input.sharedDirectory, missing);
          continue;
        }
        yield* seedFile(memoryFs, {
          source,
          target: path.join(input.sharedDirectory, name),
          account,
        });
      }
    }
    yield* fileSystem.makeDirectory(path.dirname(input.marker), { recursive: true });
    yield* fileSystem.writeFileString(input.marker, `${DateTime.formatIso(yield* DateTime.now)}\n`);
  },
  (effect) => sharedMemoryWrites.withPermit(effect),
);

/** `name` and `description` from a memory file's YAML frontmatter. */
export function memoryFrontmatter(
  text: string,
): { readonly name: string; readonly description: string | null } | null {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (block === undefined) return null;
  const field = (key: string) => {
    const raw = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim();
    if (!raw) return null;
    const quoted = raw.match(/^(["'])(.*)\1$/);
    return (quoted ? quoted[2]! : raw).trim() || null;
  };
  const name = field("name");
  return name === null ? null : { name, description: field("description") };
}

const indexes = (index: string, file: string) =>
  index.includes(`](${file})`) || index.includes(`](./${file})`) || index.includes(`](<${file}>)`);

/**
 * Adds an index line for every memory file `MEMORY.md` does not link to, such as an entry lost when
 * two sessions rewrote the index at once. Existing lines stay as they are. Idempotent.
 */
export const repairClaudeMemoryIndex = Effect.fn("claudeSharedMemory.repairIndex")(
  function* (memoryFs: MemoryFs, directory: string) {
    const { fileSystem, path } = memoryFs;
    const index = yield* fileSystem
      .readFileString(path.join(directory, MEMORY_INDEX))
      .pipe(Effect.orElseSucceed(() => ""));
    const lines: string[] = [];
    for (const name of yield* fileNames(memoryFs, directory)) {
      if (name === MEMORY_INDEX || !name.endsWith(".md") || indexes(index, name)) continue;
      const conflictOf = name.match(conflictPattern)?.[1];
      if (conflictOf !== undefined) {
        lines.push(
          `- [Conflict: ${conflictOf}.md](${name}): another account's different version of ${conflictOf}.md. Merge the two and delete one.`,
        );
        continue;
      }
      const text = yield* fileSystem
        .readFileString(path.join(directory, name))
        .pipe(Effect.orElseSucceed(() => ""));
      const frontmatter = memoryFrontmatter(text);
      if (frontmatter === null) continue;
      lines.push(
        `- [${frontmatter.name}](${name})${frontmatter.description === null ? "" : `: ${frontmatter.description}`}`,
      );
    }
    yield* appendIndexLines(memoryFs, directory, lines);
    return lines.length;
  },
  (effect) => sharedMemoryWrites.withPermit(effect),
);
