// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/**
 * Shared Claude auto memory (`shareProjectMemory`): seeding and index repair. Account folders are
 * only read; links that could reach them are never written through. Files publish via hard link,
 * so nothing is replaced; MEMORY.md is replaced whole by rename only while unchanged since read.
 */

const MEMORY_INDEX = "MEMORY.md";

/** Bounds on the work one session start may do. Beyond them seeding stops without its marker. */
const sharedMemoryLimits = {
  /** Entries (files and folders) one account memory folder may hold for seeding. */
  maxEntries: 5_000,
  /** Folder depth below the memory folder. */
  maxDepth: 16,
  /** One file. */
  maxFileBytes: 32 * 1024 * 1024,
  /** All files of one account together. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** `MEMORY.md` itself; Claude reads only its start anyway. */
  maxIndexBytes: 4 * 1024 * 1024,
  /** How much of a memory file is read for its frontmatter. */
  frontmatterBytes: 64 * 1024,
  /** Files the index repair looks at. */
  maxRepairFiles: 5_000,
  /** Rereads of `MEMORY.md` when it changes while an update is prepared. */
  indexUpdateAttempts: 5,
} as const;

/** Longest file name, in UTF-8 bytes, that common file systems accept. */
const NAME_MAX_BYTES = 255;

class ClaudeSharedMemoryError extends Schema.TaggedError<ClaudeSharedMemoryError>()(
  "ClaudeSharedMemoryError",
  {
    reason: Schema.String,
    path: Schema.String,
    /** The path is a symbolic or hard link: writing it could change a file outside the folder. */
    alias: Schema.Boolean,
  },
) {
  override get message(): string {
    return `${this.reason}: ${this.path}`;
  }
}

const isClaudeSharedMemoryError = Schema.is(ClaudeSharedMemoryError);
const isAlias = (error: unknown) => isClaudeSharedMemoryError(error) && error.alias;

interface MemoryFs {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

// One writer at a time per shared folder in this server. Claude itself is coordinated with by
// comparing MEMORY.md before replacing it, not by this.
const folderPermits = new Map<string, Semaphore.Semaphore>();
const withFolderPermit = <A, E, R>(folder: string, effect: Effect.Effect<A, E, R>) => {
  let permit = folderPermits.get(folder);
  if (permit === undefined) {
    permit = Semaphore.makeUnsafe(1);
    folderPermits.set(folder, permit);
  }
  return permit.withPermit(effect);
};

/** Only a missing path counts as absent; every other error stays an error. */
const isMissing = (error: PlatformError) => error.reason._tag === "NotFound";
const unlessMissing = <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
  effect.pipe(Effect.catchIf(isMissing, () => Effect.undefined));

const isAlreadyExists = (error: PlatformError) => error.reason._tag === "AlreadyExists";

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
    const folders = (yield* unlessMissing(fileSystem.readDirectory(projectsDir))) ?? [];
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
      const info = yield* unlessMissing(fileSystem.stat(memory));
      if (info?.type === "Directory") directories.push(memory);
    }
    return directories;
  },
);

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const conflictPattern = /^(.+)\.conflict-[A-Za-z0-9_-]+\.md$/;

const inside = (path: Path.Path, root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
const overlaps = (path: Path.Path, left: string, right: string) =>
  inside(path, left, right) || inside(path, right, left);

const aliasError = (target: string, message: string) =>
  new ClaudeSharedMemoryError({ reason: message, path: target, alias: true });

interface SharedGuard {
  /** The shared folder as given. */
  readonly directory: string;
  /** Its real path; every written path must resolve inside it. */
  readonly real: string;
}

/**
 * Checks that the shared folder is a real folder of its own: not a symbolic link, and neither in,
 * nor holding, nor the same as one of the accounts' memory folders.
 */
const guardSharedDirectory = Effect.fn("claudeSharedMemory.guard")(function* (
  memoryFs: MemoryFs,
  directory: string,
  protectedDirectories: readonly string[],
) {
  const { fileSystem, path } = memoryFs;
  const info = yield* fileSystem.lstat(directory);
  if (info.type !== "Directory") {
    return yield* aliasError(directory, "The shared memory folder is not a plain folder");
  }
  const real = yield* fileSystem.realPath(directory);
  for (const account of protectedDirectories) {
    const accountReal = yield* unlessMissing(fileSystem.realPath(account));
    if (accountReal !== undefined && overlaps(path, real, accountReal)) {
      return yield* aliasError(
        directory,
        `The shared memory folder overlaps the account memory folder ${account}`,
      );
    }
  }
  return { directory, real } satisfies SharedGuard;
});

interface Snapshot {
  readonly dev: bigint;
  readonly ino: bigint | undefined;
  readonly size: bigint;
  readonly mtime: number | undefined;
  readonly mode: number;
}

const snapshotOf = (info: FileSystem.File.Info): Snapshot => ({
  dev: info.dev,
  ino: Option.getOrUndefined(info.ino),
  size: BigInt(info.size),
  mtime: Option.getOrUndefined(info.mtime)?.getTime(),
  mode: info.mode,
});

const sameSnapshot = (left: Snapshot | undefined, right: Snapshot | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtime === right.mtime;

/**
 * Checks a path this module may write: absent with its folder inside the shared folder, or a plain
 * file with one link whose real path is inside it. Returns its state for a later comparison.
 */
const writableTarget = Effect.fn("claudeSharedMemory.writableTarget")(function* (
  memoryFs: MemoryFs,
  guard: SharedGuard,
  target: string,
) {
  const { fileSystem, path } = memoryFs;
  const parent = yield* fileSystem.realPath(path.dirname(target));
  if (!inside(path, guard.real, parent)) {
    return yield* aliasError(target, "The memory file's folder resolves outside the shared folder");
  }
  const info = yield* unlessMissing(fileSystem.lstat(target));
  if (info === undefined) return undefined;
  if (info.type !== "File") {
    return yield* aliasError(target, "The memory file is a symbolic link or not a plain file");
  }
  if (Option.getOrElse(info.nlink, () => 1n) > 1n) {
    return yield* aliasError(target, "The memory file is hard-linked to another file");
  }
  return snapshotOf(info);
});

const temporaryPath = (path: Path.Path, target: string) =>
  path.join(path.dirname(target), `.t3-memory-${NodeCrypto.randomUUID()}.tmp`);

/**
 * Writes `bytes` to a new file beside `target` and reads it back. The caller publishes it; the
 * temporary file is removed when anything fails.
 */
const writeTemporary = (memoryFs: MemoryFs, target: string, bytes: Uint8Array, mode?: number) => {
  const { fileSystem, path } = memoryFs;
  const temporary = temporaryPath(path, target);
  return Effect.gen(function* () {
    // `wx` creates a new file and never follows a link planted at that name.
    yield* fileSystem.writeFile(temporary, bytes, {
      flag: "wx",
      ...(mode === undefined ? {} : { mode: mode & 0o777 }),
    });
    const written = yield* fileSystem.readFile(temporary);
    if (!sameBytes(written, bytes)) {
      return yield* new ClaudeSharedMemoryError({
        alias: false,
        reason: "A memory file was not written completely",
        path: temporary,
      });
    }
    return temporary;
  }).pipe(Effect.onError(() => fileSystem.remove(temporary).pipe(Effect.ignore)));
};

/**
 * Publishes `bytes` under `target` only if nothing has that name: written and verified beside it,
 * then hard-linked into place, which fails rather than replace a file another writer created.
 */
const publishNew = Effect.fn("claudeSharedMemory.publishNew")(function* (
  memoryFs: MemoryFs,
  target: string,
  bytes: Uint8Array,
) {
  const { fileSystem } = memoryFs;
  const temporary = yield* writeTemporary(memoryFs, target, bytes);
  const outcome = yield* Effect.gen(function* () {
    const linked = yield* fileSystem.link(temporary, target).pipe(
      Effect.as("published" as const),
      Effect.catchIf(isAlreadyExists, () => Effect.succeed("exists" as const)),
      // A file system without hard links: rename, after one more look that the name is free.
      Effect.catch((error) =>
        Effect.gen(function* () {
          if ((yield* unlessMissing(fileSystem.lstat(target))) !== undefined) return "exists";
          yield* Effect.logDebug("Claude shared memory publishes by rename", { target, error });
          yield* fileSystem.rename(temporary, target);
          return "published" as const;
        }),
      ),
    );
    return linked;
  }).pipe(Effect.ensuring(fileSystem.remove(temporary).pipe(Effect.ignore)));
  if (outcome === "exists") return false;
  const published = yield* fileSystem.readFile(target);
  if (!sameBytes(published, bytes)) {
    return yield* new ClaudeSharedMemoryError({
      alias: false,
      reason: "A copied memory file does not match its source",
      path: target,
    });
  }
  return true;
});

/** Cuts a string to at most `bytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, bytes: number): string {
  let out = "";
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > bytes) break;
    out += character;
    used += size;
  }
  return out;
}

/** `<stem>.conflict-<account>[-n].md`, shortened with a hash when the name would be too long. */
function conflictName(name: string, account: string, number: number): string {
  const stem = name.endsWith(".md") ? name.slice(0, -3) : name;
  const suffix = `.conflict-${account.slice(0, 64)}${number <= 1 ? "" : `-${number}`}.md`;
  if (Buffer.byteLength(stem + suffix) <= NAME_MAX_BYTES) return stem + suffix;
  const hash = NodeCrypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${truncateUtf8(stem, NAME_MAX_BYTES - Buffer.byteLength(suffix) - 9)}~${hash}${suffix}`;
}

/**
 * Copies one file into the shared folder, or keeps it beside a different version as a conflict
 * copy. An existing name is never written; a link there is treated as a different version.
 */
const seedFile = Effect.fn("claudeSharedMemory.seedFile")(function* (
  memoryFs: MemoryFs,
  guard: SharedGuard,
  input: { readonly source: string; readonly target: string; readonly account: string },
) {
  const { fileSystem, path } = memoryFs;
  const bytes = yield* fileSystem.readFile(input.source);
  const name = path.basename(input.target);
  for (let attempt = 1; attempt < 100; attempt++) {
    const candidate =
      attempt === 1
        ? input.target
        : path.join(path.dirname(input.target), conflictName(name, input.account, attempt - 1));
    const existing = yield* writableTarget(memoryFs, guard, candidate).pipe(
      Effect.catchIf(isAlias, () => Effect.succeed("alias" as const)),
    );
    if (existing === "alias") continue;
    if (existing !== undefined) {
      if (sameBytes(yield* fileSystem.readFile(candidate), bytes)) return candidate;
      continue;
    }
    if (yield* publishNew(memoryFs, candidate, bytes)) return candidate;
    // Another writer took the name meanwhile: the same file is fine, another goes on.
    const raced = yield* unlessMissing(fileSystem.readFile(candidate));
    if (raced !== undefined && sameBytes(raced, bytes)) return candidate;
  }
  return yield* new ClaudeSharedMemoryError({
    alias: false,
    reason: "No free name for a conflicting copy of a memory file",
    path: input.target,
  });
});

/** A folder in the shared folder for a folder of the account's memory: created, or a plain one. */
const ensureSharedFolder = Effect.fn("claudeSharedMemory.ensureFolder")(function* (
  memoryFs: MemoryFs,
  guard: SharedGuard,
  target: string,
) {
  const { fileSystem, path } = memoryFs;
  const parent = yield* fileSystem.realPath(path.dirname(target));
  if (!inside(path, guard.real, parent)) {
    return yield* aliasError(target, "A memory folder resolves outside the shared folder");
  }
  if ((yield* unlessMissing(fileSystem.lstat(target))) === undefined) {
    yield* fileSystem
      .makeDirectory(target)
      .pipe(Effect.catchIf(isAlreadyExists, () => Effect.void));
  }
  const info = yield* fileSystem.lstat(target);
  if (info.type !== "Directory") {
    return yield* aliasError(target, "A memory folder's name is taken by a link or a file");
  }
});

interface SourceEntry {
  readonly segments: readonly string[];
  readonly kind: "file" | "folder";
  readonly source: string;
}

/**
 * Every folder and file of an account's memory folder, parents first, within the limits. A link is
 * followed only to a plain file inside the same folder; anything else stops the seed.
 */
const listAccountMemory = Effect.fn("claudeSharedMemory.listAccount")(function* (
  memoryFs: MemoryFs,
  root: string,
) {
  const { fileSystem, path } = memoryFs;
  const rootReal = yield* unlessMissing(fileSystem.realPath(root));
  if (rootReal === undefined) return [];
  const entries: SourceEntry[] = [];
  let bytes = 0n;
  const fail = (message: string, at: string) =>
    Effect.fail(new ClaudeSharedMemoryError({ reason: message, path: at, alias: false }));
  const visit: (
    directory: string,
    segments: readonly string[],
  ) => Effect.Effect<void, PlatformError | ClaudeSharedMemoryError> = Effect.fn(
    "claudeSharedMemory.visitAccount",
  )(function* (directory: string, segments: readonly string[]) {
    if (segments.length > sharedMemoryLimits.maxDepth) {
      return yield* fail("The account memory folder is nested too deeply to copy", directory);
    }
    const names = (yield* unlessMissing(fileSystem.readDirectory(directory))) ?? [];
    for (const name of names.sort()) {
      const source = path.join(directory, name);
      const info = yield* unlessMissing(fileSystem.lstat(source));
      if (info === undefined) continue;
      if (entries.length >= sharedMemoryLimits.maxEntries) {
        return yield* fail("The account memory folder holds too many files to copy", root);
      }
      const here = [...segments, name];
      let fileInfo: FileSystem.File.Info | undefined;
      if (info.type === "Directory") {
        entries.push({ segments: here, kind: "folder", source });
        yield* visit(source, here);
        continue;
      } else if (info.type === "File") {
        fileInfo = info;
      } else if (info.type === "SymbolicLink") {
        const target = yield* fileSystem.realPath(source);
        const resolved = yield* fileSystem.stat(source);
        if (resolved.type !== "File" || !inside(path, rootReal, target)) {
          return yield* fail(
            "A link in the account memory folder points to a folder or outside it",
            source,
          );
        }
        fileInfo = resolved;
      } else {
        return yield* fail("The account memory folder holds a file that is not plain", source);
      }
      const size = BigInt(fileInfo.size);
      bytes += size;
      if (size > BigInt(sharedMemoryLimits.maxFileBytes)) {
        return yield* fail("A memory file is too large to copy", source);
      }
      if (bytes > BigInt(sharedMemoryLimits.maxTotalBytes)) {
        return yield* fail("The account memory folder is too large to copy", root);
      }
      entries.push({ segments: here, kind: "file", source });
    }
  });
  yield* visit(root, []);
  return entries;
});

interface IndexState {
  readonly text: string;
  readonly snapshot: Snapshot | undefined;
}

const readIndex = Effect.fn("claudeSharedMemory.readIndex")(function* (
  memoryFs: MemoryFs,
  guard: SharedGuard,
) {
  const { fileSystem, path } = memoryFs;
  const indexPath = path.join(guard.directory, MEMORY_INDEX);
  const snapshot = yield* writableTarget(memoryFs, guard, indexPath);
  if (snapshot === undefined) return { text: "", snapshot } satisfies IndexState;
  if (snapshot.size > BigInt(sharedMemoryLimits.maxIndexBytes)) {
    return yield* new ClaudeSharedMemoryError({
      alias: false,
      reason: "MEMORY.md is too large to update",
      path: indexPath,
    });
  }
  const text = yield* unlessMissing(fileSystem.readFileString(indexPath));
  return { text: text ?? "", snapshot: text === undefined ? undefined : snapshot };
});

/**
 * Replaces `MEMORY.md` with `next(current)` by a rename, only while it still holds what was read;
 * when another writer changed it meanwhile, reads it again. `next` returns `undefined` for no
 * change. Never appends or writes the index in place.
 */
const updateIndex = Effect.fn("claudeSharedMemory.updateIndex")(function* (
  memoryFs: MemoryFs,
  guard: SharedGuard,
  next: (current: string) => string | undefined,
) {
  const { fileSystem, path } = memoryFs;
  const indexPath = path.join(guard.directory, MEMORY_INDEX);
  for (let attempt = 0; attempt < sharedMemoryLimits.indexUpdateAttempts; attempt++) {
    const read = yield* readIndex(memoryFs, guard);
    const text = next(read.text);
    if (text === undefined) return false;
    const temporary = yield* writeTemporary(
      memoryFs,
      indexPath,
      new TextEncoder().encode(text),
      read.snapshot?.mode,
    );
    const replaced = yield* Effect.gen(function* () {
      const now = yield* readIndex(memoryFs, guard);
      if (!sameSnapshot(now.snapshot, read.snapshot) || now.text !== read.text) return false;
      yield* fileSystem.rename(temporary, indexPath);
      return true;
    }).pipe(Effect.ensuring(fileSystem.remove(temporary).pipe(Effect.ignore)));
    if (replaced) return true;
  }
  return yield* new ClaudeSharedMemoryError({
    alias: false,
    reason: "MEMORY.md kept changing while it was being updated",
    path: indexPath,
  });
});

/** Writes a small file outside the shared folder whole: written beside it, then renamed. */
const writeStateFile = Effect.fn("claudeSharedMemory.writeStateFile")(function* (
  memoryFs: MemoryFs,
  target: string,
  text: string,
) {
  const { fileSystem, path } = memoryFs;
  yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
  const temporary = yield* writeTemporary(memoryFs, target, new TextEncoder().encode(text));
  yield* fileSystem
    .rename(temporary, target)
    .pipe(Effect.onError(() => fileSystem.remove(temporary).pipe(Effect.ignore)));
});

const appendLines = (current: string, lines: readonly string[]) =>
  lines.length === 0
    ? undefined
    : `${current}${current.length === 0 || current.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`;

/**
 * Seeds the shared folder once per account from its project memory, folders included. A different
 * version of an existing file is kept as `<name>.conflict-<account>.md`; index lines are added.
 * Fails without writing the marker unless every file was published and verified.
 */
export const seedSharedClaudeMemory = Effect.fn("claudeSharedMemory.seed")(function* (
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
  return yield* withFolderPermit(
    path.resolve(input.sharedDirectory),
    Effect.gen(function* () {
      const account = input.account.replace(/[^A-Za-z0-9_-]/g, "-");
      if ((yield* unlessMissing(fileSystem.lstat(input.marker))) !== undefined) return false;
      const guard = yield* guardSharedDirectory(
        memoryFs,
        input.sharedDirectory,
        input.sourceDirectories.filter(
          (source) => path.resolve(source) !== path.resolve(input.sharedDirectory),
        ),
      );
      const indexLines: string[] = [];
      for (const sourceDirectory of input.sourceDirectories) {
        if (path.resolve(sourceDirectory) === path.resolve(input.sharedDirectory)) continue;
        for (const entry of yield* listAccountMemory(memoryFs, sourceDirectory)) {
          const target = path.join(guard.directory, ...entry.segments);
          if (entry.kind === "folder") {
            yield* ensureSharedFolder(memoryFs, guard, target);
          } else if (entry.segments.length === 1 && entry.segments[0] === MEMORY_INDEX) {
            indexLines.push(...(yield* fileSystem.readFileString(entry.source)).split("\n"));
          } else {
            yield* seedFile(memoryFs, guard, { source: entry.source, target, account });
          }
        }
      }
      // Index lines last, so they never point at a file that is not there yet.
      yield* updateIndex(memoryFs, guard, (current) => {
        const present = new Set(current.split("\n").map((line) => line.trim()));
        const missing: string[] = [];
        for (const line of indexLines) {
          const trimmed = line.trim();
          if (trimmed.length === 0 || present.has(trimmed)) continue;
          present.add(trimmed);
          missing.push(line);
        }
        return appendLines(current, missing);
      });
      yield* writeStateFile(memoryFs, input.marker, `${DateTime.formatIso(yield* DateTime.now)}\n`);
      return true;
    }),
  );
});

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

/** A relative memory path as a Markdown link target: every segment percent-encoded. */
function memoryLinkTarget(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

const escapeLabel = (label: string) => label.replace(/[\\[\]]/g, (character) => `\\${character}`);

/** The relative paths `MEMORY.md` links to, decoded, without fragments or `./`. */
function memoryIndexLinks(index: string): ReadonlySet<string> {
  const links = new Set<string>();
  for (const match of index.matchAll(/\]\(\s*(?:<([^>\n]*)>|([^)\s]+))/g)) {
    const raw = (match[1] ?? match[2] ?? "").replace(/[#?].*$/, "");
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // Not percent-encoded; the raw target is the path.
    }
    links.add(decoded.replace(/^(\.\/)+/, ""));
  }
  return links;
}

/** Up to `bytes` from the start of a file. */
const readHead = (memoryFs: MemoryFs, file: string, bytes: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* memoryFs.fileSystem.open(file, { flag: "r" });
      const buffer = new Uint8Array(bytes);
      let filled = 0;
      while (filled < bytes) {
        const read = Number(yield* handle.read(buffer.subarray(filled)));
        if (read === 0) break;
        filled += read;
      }
      return new TextDecoder().decode(buffer.subarray(0, filled));
    }),
  );

/** Memory files of the shared folder, as relative paths with `/`, folders included, links skipped. */
const listSharedMemory = Effect.fn("claudeSharedMemory.listShared")(function* (
  memoryFs: MemoryFs,
  guard: SharedGuard,
) {
  const { fileSystem, path } = memoryFs;
  const files: string[] = [];
  let truncated = false;
  const visit: (
    directory: string,
    prefix: string,
    depth: number,
  ) => Effect.Effect<void, PlatformError> = Effect.fn("claudeSharedMemory.visitShared")(function* (
    directory: string,
    prefix: string,
    depth: number,
  ) {
    const entries = (yield* unlessMissing(fileSystem.readDirectoryEntries(directory))) ?? [];
    for (const entry of [...entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (entry.name.startsWith(".")) continue;
      if (files.length >= sharedMemoryLimits.maxRepairFiles) {
        truncated = true;
        return;
      }
      const full = path.join(directory, entry.name);
      const type =
        entry.type === "Unknown"
          ? (yield* unlessMissing(fileSystem.lstat(full)))?.type
          : entry.type;
      if (type === "Directory" && depth < sharedMemoryLimits.maxDepth) {
        yield* visit(full, `${prefix}${entry.name}/`, depth + 1);
      } else if (type === "File" && entry.name.endsWith(".md")) {
        if (prefix === "" && entry.name === MEMORY_INDEX) continue;
        files.push(`${prefix}${entry.name}`);
      }
    }
  });
  yield* visit(guard.directory, "", 0);
  return { files, truncated };
});

const repairSignature = (index: IndexState, files: readonly string[]) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        index.snapshot === undefined
          ? null
          : [
              String(index.snapshot.dev),
              String(index.snapshot.ino),
              String(index.snapshot.size),
              index.snapshot.mtime,
            ],
        NodeCrypto.createHash("sha256").update(index.text).digest("hex"),
        files,
      ]),
    )
    .digest("hex");

/**
 * Adds an index line for every memory file `MEMORY.md` does not link to; never removes one. With a
 * `stateFile`, an unchanged index and file list skip the work. A folder overlapping one of
 * `protectedDirectories`, or an index that is a link, is left alone with a warning.
 */
export const repairClaudeMemoryIndex = Effect.fn("claudeSharedMemory.repairIndex")(function* (
  memoryFs: MemoryFs,
  directory: string,
  options: {
    readonly protectedDirectories?: readonly string[];
    readonly stateFile?: string;
  } = {},
) {
  const { fileSystem, path } = memoryFs;
  return yield* withFolderPermit(
    path.resolve(directory),
    Effect.gen(function* () {
      const guard = yield* guardSharedDirectory(
        memoryFs,
        directory,
        options.protectedDirectories ?? [],
      );
      const before = yield* readIndex(memoryFs, guard);
      const listing = yield* listSharedMemory(memoryFs, guard);
      if (listing.truncated) {
        yield* Effect.logWarning(
          "Claude shared memory index repair looked at the first files only",
          {
            directory,
            limit: sharedMemoryLimits.maxRepairFiles,
          },
        );
      }
      const signature = repairSignature(before, listing.files);
      if (options.stateFile !== undefined) {
        const last = yield* unlessMissing(fileSystem.readFileString(options.stateFile));
        if (last?.trim() === signature) return 0;
      }
      const linked = memoryIndexLinks(before.text);
      const entries: { readonly file: string; readonly line: string }[] = [];
      for (const file of listing.files) {
        if (linked.has(file)) continue;
        const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
        const conflictOf = path.basename(file).match(conflictPattern)?.[1];
        const target = memoryLinkTarget(file);
        if (conflictOf !== undefined) {
          const original = `${folder}${conflictOf}.md`;
          entries.push({
            file,
            line: `- [Conflict: ${escapeLabel(original)}](${target}): another account's different version of ${original}. Merge the two and delete one.`,
          });
          continue;
        }
        const head = yield* unlessMissing(
          readHead(
            memoryFs,
            path.join(guard.directory, ...file.split("/")),
            sharedMemoryLimits.frontmatterBytes,
          ),
        );
        const frontmatter = head === undefined ? null : memoryFrontmatter(head);
        if (frontmatter === null) continue;
        entries.push({
          file,
          line: `- [${escapeLabel(frontmatter.name)}](${target})${frontmatter.description === null ? "" : `: ${frontmatter.description}`}`,
        });
      }
      let added = 0;
      yield* updateIndex(memoryFs, guard, (current) => {
        const now = memoryIndexLinks(current);
        const lines = entries.filter((entry) => !now.has(entry.file)).map((entry) => entry.line);
        added = lines.length;
        return appendLines(current, lines);
      });
      if (options.stateFile !== undefined) {
        const after = yield* readIndex(memoryFs, guard);
        yield* writeStateFile(
          memoryFs,
          options.stateFile,
          `${repairSignature(after, listing.files)}\n`,
        );
      }
      return added;
    }).pipe(
      Effect.catchIf(isAlias, (error) =>
        Effect.logWarning("Claude shared memory index left unchanged: it is linked elsewhere", {
          directory,
          cause: error,
        }).pipe(Effect.as(0)),
      ),
    ),
  );
});
