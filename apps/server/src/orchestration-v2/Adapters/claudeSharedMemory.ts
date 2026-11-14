// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

// Shared Claude auto memory: a one-time, additive seed from each account's own memory, which is
// only read. Nothing existing in the shared folder is changed, MEMORY.md included, except own crash
// leftovers. New files are verified, then hard-linked into place, which never replaces a file;
// without hard links nothing is published and the session keeps the account's own memory.

const MEMORY_INDEX = "MEMORY.md";
/** Notes for files a seed copied while `MEMORY.md` already existed and was left alone. */
const SEEDED_FILES_NOTE = "SEEDED-FILES";
const SEED_CONFLICTS_NOTE = "SEED-CONFLICTS";
/**
 * Seed markers live in `<memory root>/.seeded-v2/<project>/<account>`. Markers of the earlier
 * `.seeded/` layout are ignored on purpose: some were written after incomplete seeds.
 */
const MARKER_FOLDER = ".seeded-v2";
const MARKER_TEXT = "seeded v2\n";

const TEMPORARY_PREFIX = ".t3-memory-";
const temporaryPattern = /^\.t3-memory-[0-9a-f-]{36}\.tmp$/;
/** Temporary files older than this are left from a crash and are removed at a session start. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

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
  /** How much of the shared `MEMORY.md` is read to see which files it links to. */
  maxIndexBytes: 4 * 1024 * 1024,
  /** How much of a memory file is read for its frontmatter. */
  frontmatterBytes: 64 * 1024,
  /** Names tried for one file: itself, then conflict copies; likewise for the notes. */
  maxNames: 100,
} as const;

/** Longest file name, in UTF-8 bytes, that common file systems accept. */
const NAME_MAX_BYTES = 255;

class ClaudeSharedMemoryError extends Schema.TaggedError<ClaudeSharedMemoryError>()(
  "ClaudeSharedMemoryError",
  {
    reason: Schema.String,
    path: Schema.String,
    /** The path is a link or resolves elsewhere: writing it could change a file outside the folder. */
    alias: Schema.Boolean,
  },
) {
  override get message(): string {
    return `${this.reason}: ${this.path}`;
  }
}

interface MemoryFs {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

// One seed at a time per shared folder in this server.
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

/** Where the seed of `account` into `sharedDirectory` is recorded. */
export function claudeSharedMemoryMarker(
  path: Path.Path,
  sharedDirectory: string,
  account: string,
): string {
  return path.join(
    path.dirname(sharedDirectory),
    MARKER_FOLDER,
    path.basename(sharedDirectory),
    sanitizeAccount(account),
  );
}

const sanitizeAccount = (account: string) => account.replace(/[^A-Za-z0-9_-]/g, "-");

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const inside = (path: Path.Path, root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

const aliasError = (target: string, message: string) =>
  new ClaudeSharedMemoryError({ reason: message, path: target, alias: true });

/** A folder this module writes below, and the account folders nothing it writes may reach. */
interface Guard {
  /** The folder's real path; every written path must resolve inside it. */
  readonly real: string;
  /** Real paths of the accounts' memory folders. */
  readonly accounts: readonly string[];
}

/**
 * Checks that `directory` is a plain folder, not a link, and returns its guard. With `exclusive`,
 * it may neither lie in, nor hold, nor be one of the accounts' memory folders; otherwise only
 * paths inside it that resolve into an account folder are refused, by `checkedFolder`.
 */
const guardDirectory = Effect.fn("claudeSharedMemory.guard")(function* (
  memoryFs: MemoryFs,
  directory: string,
  accountDirectories: readonly string[],
  exclusive: boolean,
) {
  const { fileSystem, path } = memoryFs;
  const info = yield* fileSystem.lstat(directory);
  if (info.type !== "Directory") {
    return yield* aliasError(directory, "A shared memory folder is not a plain folder");
  }
  const real = yield* fileSystem.realPath(directory);
  const accounts: string[] = [];
  for (const account of accountDirectories) {
    const accountReal = yield* unlessMissing(fileSystem.realPath(account));
    if (accountReal === undefined) continue;
    accounts.push(accountReal);
    if (inside(path, accountReal, real) || (exclusive && inside(path, real, accountReal))) {
      return yield* aliasError(
        directory,
        `A shared memory folder overlaps the account memory folder ${account}`,
      );
    }
  }
  return { real, accounts } satisfies Guard;
});

/** Refuses a real path outside the guarded folder or inside an account folder. */
const checkReal = (path: Path.Path, guard: Guard, real: string, at: string) =>
  !inside(path, guard.real, real) || guard.accounts.some((account) => inside(path, account, real))
    ? Effect.fail(aliasError(at, "A shared memory path resolves outside the shared folder"))
    : Effect.void;

/**
 * A folder below the guarded one: checked to be a plain folder (not a link or junction) that
 * resolves inside it, and, with `create`, created first when missing. Returns whether it exists.
 */
const checkedFolder = Effect.fn("claudeSharedMemory.checkedFolder")(function* (
  memoryFs: MemoryFs,
  guard: Guard,
  target: string,
  create: boolean,
) {
  const { fileSystem, path } = memoryFs;
  yield* checkReal(path, guard, yield* fileSystem.realPath(path.dirname(target)), target);
  let info = yield* unlessMissing(fileSystem.lstat(target));
  if (info === undefined) {
    if (!create) return false;
    yield* fileSystem
      .makeDirectory(target)
      .pipe(Effect.catchIf(isAlreadyExists, () => Effect.void));
    info = yield* fileSystem.lstat(target);
  }
  if (info.type !== "Directory") {
    return yield* aliasError(target, "A memory folder's name is taken by a link or a file");
  }
  yield* checkReal(path, guard, yield* fileSystem.realPath(target), target);
  return true;
});

/**
 * Publishes `bytes` under `target` only if nothing has that name: written to a new file beside it
 * (`wx`, so never through a planted link), read back, then hard-linked into place, which fails
 * rather than replace what another writer created meanwhile. Any other link failure, as on a file
 * system without hard links, fails the publication; there is deliberately no rename fallback.
 */
const publishNew = Effect.fn("claudeSharedMemory.publishNew")(function* (
  memoryFs: MemoryFs,
  guard: Guard,
  target: string,
  bytes: Uint8Array,
) {
  const { fileSystem, path } = memoryFs;
  yield* checkReal(path, guard, yield* fileSystem.realPath(path.dirname(target)), target);
  const temporary = path.join(
    path.dirname(target),
    `${TEMPORARY_PREFIX}${NodeCrypto.randomUUID()}.tmp`,
  );
  // Removed afterwards only if this call created it: a `wx` that found the name taken did not.
  let created = false;
  return yield* Effect.gen(function* () {
    yield* fileSystem.writeFile(temporary, bytes, { flag: "wx" }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          created = !isAlreadyExists(error);
        }),
      ),
    );
    created = true;
    const written = yield* fileSystem.readFile(temporary);
    if (!sameBytes(written, bytes)) {
      return yield* new ClaudeSharedMemoryError({
        alias: false,
        reason: "A memory file was not written completely",
        path: temporary,
      });
    }
    return yield* fileSystem.link(temporary, target).pipe(
      Effect.as("published" as const),
      Effect.catchIf(isAlreadyExists, () => Effect.succeed("exists" as const)),
      Effect.mapError(
        (cause) =>
          new ClaudeSharedMemoryError({
            alias: false,
            reason: `This file system cannot publish a file without risking replacing another (no hard link: ${cause.message}); nothing was published`,
            path: target,
          }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        created ? fileSystem.remove(temporary).pipe(Effect.ignore) : Effect.void,
      ),
    ),
  );
});

/**
 * Publishes `bytes` under the first of `names(1)`, `names(2)`, … that is free, unless one of them
 * already holds exactly these bytes. Existing files are only read; a link or folder there counts
 * as taken. Returns the path that holds the bytes.
 */
const publishUnique = Effect.fn("claudeSharedMemory.publishUnique")(function* (
  memoryFs: MemoryFs,
  guard: Guard,
  names: (attempt: number) => string,
  bytes: Uint8Array,
) {
  const { fileSystem } = memoryFs;
  for (let attempt = 1; attempt <= sharedMemoryLimits.maxNames; attempt++) {
    const candidate = names(attempt);
    let info = yield* unlessMissing(fileSystem.lstat(candidate));
    if (info === undefined) {
      if ((yield* publishNew(memoryFs, guard, candidate, bytes)) === "published") return candidate;
      // Another writer took the name meanwhile.
      info = yield* unlessMissing(fileSystem.lstat(candidate));
    }
    if (info?.type !== "File" || info.size !== BigInt(bytes.length)) continue;
    const existing = yield* unlessMissing(fileSystem.readFile(candidate));
    if (existing !== undefined && sameBytes(existing, bytes)) return candidate;
  }
  return yield* new ClaudeSharedMemoryError({
    alias: false,
    reason: "No free name for a copy of a memory file",
    path: names(1),
  });
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
      if (name.startsWith(TEMPORARY_PREFIX)) continue;
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

/**
 * Removes this module's temporary files that a crash left in the shared folder, once they are an
 * hour old. Links are not followed; only plain files with the exact temporary name are removed,
 * after their folder was checked to resolve inside the shared folder.
 */
const removeStaleTemporaries = Effect.fn("claudeSharedMemory.removeStaleTemporaries")(function* (
  memoryFs: MemoryFs,
  guard: Guard,
  directory: string,
) {
  const { fileSystem, path } = memoryFs;
  const cutoff = (yield* Clock.currentTimeMillis) - STALE_TEMPORARY_MS;
  let seen = 0;
  const visit: (
    folder: string,
    depth: number,
  ) => Effect.Effect<void, PlatformError | ClaudeSharedMemoryError> = Effect.fn(
    "claudeSharedMemory.visitTemporaries",
  )(function* (folder: string, depth: number) {
    const names = (yield* unlessMissing(fileSystem.readDirectory(folder))) ?? [];
    for (const name of names.sort()) {
      if (++seen > sharedMemoryLimits.maxEntries) return;
      const full = path.join(folder, name);
      const info = yield* unlessMissing(fileSystem.lstat(full));
      if (info?.type === "Directory" && depth < sharedMemoryLimits.maxDepth) {
        yield* visit(full, depth + 1);
      } else if (info?.type === "File" && temporaryPattern.test(name)) {
        const modified = Option.getOrUndefined(info.mtime)?.getTime();
        if (modified === undefined || modified > cutoff) continue;
        yield* checkReal(path, guard, yield* fileSystem.realPath(folder), full);
        yield* fileSystem.remove(full);
      }
    }
  });
  yield* visit(directory, 0);
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

/** The relative paths a Markdown text links to, decoded, without fragments or `./`. */
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

interface Seeded {
  /** Path relative to the shared folder, with `/`. */
  readonly file: string;
  /** For a conflict copy: the relative path of the version it differs from. */
  readonly conflictOf?: string;
}

const conflictLine = (seeded: Seeded, account: string) =>
  `- [Conflict: ${escapeLabel(seeded.conflictOf ?? seeded.file)}](${memoryLinkTarget(seeded.file)}): account ${account}'s different version of ${seeded.conflictOf}. Merge the two and delete one.`;

/**
 * Seeds the shared folder once per account, adding files only; a different version is kept as
 * `<name>.conflict-<account>.md`. Creates a missing MEMORY.md, else lists new files in new notes.
 * Writes the marker only after every file arrived; returns `false` when there was nothing to do.
 */
export const seedSharedClaudeMemory = Effect.fn("claudeSharedMemory.seed")(function* (
  memoryFs: MemoryFs,
  input: {
    /** `<memory root>/<project>`; the marker lives in the memory root. */
    readonly sharedDirectory: string;
    /** The account's memory folders; only read. */
    readonly sourceDirectories: readonly string[];
    readonly account: string;
  },
) {
  const { fileSystem, path } = memoryFs;
  const sharedDirectory = path.resolve(input.sharedDirectory);
  return yield* withFolderPermit(
    sharedDirectory,
    Effect.gen(function* () {
      const account = sanitizeAccount(input.account);
      const sources = input.sourceDirectories.filter(
        (source) => path.resolve(source) !== sharedDirectory,
      );
      // Without an account folder to read there is nothing to record: a later start may find one.
      if (sources.length === 0) return false;
      const guard = yield* guardDirectory(memoryFs, sharedDirectory, sources, true);
      yield* removeStaleTemporaries(memoryFs, guard, sharedDirectory).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Claude shared memory left temporary files in place", {
            directory: sharedDirectory,
            cause,
          }),
        ),
      );

      // The marker and every folder above it get the same checks as the shared files.
      const rootGuard = yield* guardDirectory(
        memoryFs,
        path.dirname(sharedDirectory),
        sources,
        false,
      );
      const marker = claudeSharedMemoryMarker(path, sharedDirectory, account);
      const markerFolders = [path.dirname(path.dirname(marker)), path.dirname(marker)];
      let markerFoldersExist = true;
      for (const folder of markerFolders) {
        if (!(yield* checkedFolder(memoryFs, rootGuard, folder, false))) {
          markerFoldersExist = false;
          break;
        }
      }
      if (markerFoldersExist) {
        const info = yield* unlessMissing(fileSystem.lstat(marker));
        if (info?.type === "File") return false;
        if (info !== undefined) {
          return yield* aliasError(marker, "The seed marker is not a plain file");
        }
      }

      const indexLines: string[] = [];
      const seeded: Seeded[] = [];
      for (const sourceDirectory of sources) {
        for (const entry of yield* listAccountMemory(memoryFs, sourceDirectory)) {
          const target = path.join(sharedDirectory, ...entry.segments);
          if (entry.kind === "folder") {
            yield* checkedFolder(memoryFs, guard, target, true);
            continue;
          }
          if (entry.segments.length === 1 && entry.segments[0] === MEMORY_INDEX) {
            indexLines.push(...(yield* fileSystem.readFileString(entry.source)).split("\n"));
            continue;
          }
          const bytes = yield* fileSystem.readFile(entry.source);
          const name = path.basename(target);
          const published = yield* publishUnique(
            memoryFs,
            guard,
            (attempt) =>
              attempt === 1
                ? target
                : path.join(path.dirname(target), conflictName(name, account, attempt - 1)),
            bytes,
          );
          const file = entry.segments.join("/");
          seeded.push(
            published === target
              ? { file }
              : {
                  file: path.relative(sharedDirectory, published).split(path.sep).join("/"),
                  conflictOf: file,
                },
          );
        }
      }

      // Lines for the copied files, last, so they never point at a file that is not there yet.
      const accountLineFor = new Map<string, string>();
      const accountLines: string[] = [];
      const seenLines = new Set<string>();
      for (const line of indexLines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || seenLines.has(trimmed)) continue;
        seenLines.add(trimmed);
        accountLines.push(line);
        for (const link of memoryIndexLinks(line)) {
          if (!accountLineFor.has(link)) accountLineFor.set(link, line);
        }
      }
      const fileLine = Effect.fn("claudeSharedMemory.fileLine")(function* (file: string) {
        const known = accountLineFor.get(file);
        if (known !== undefined) return known;
        const head = yield* unlessMissing(
          readHead(
            memoryFs,
            path.join(sharedDirectory, ...file.split("/")),
            sharedMemoryLimits.frontmatterBytes,
          ),
        );
        const frontmatter = head === undefined ? null : memoryFrontmatter(head);
        const label = escapeLabel(frontmatter?.name ?? file);
        const description = frontmatter?.description;
        return `- [${label}](${memoryLinkTarget(file)})${description ? `: ${description}` : ""}`;
      });
      const copies = seeded.filter((entry) => entry.conflictOf === undefined);
      const conflicts = seeded.filter((entry) => entry.conflictOf !== undefined);
      const isMemory = (file: string) => file.endsWith(".md");

      const accountLinks = memoryIndexLinks(accountLines.join("\n"));
      const newIndex = [...accountLines];
      for (const { file } of copies) {
        if (isMemory(file) && !accountLinks.has(file)) newIndex.push(yield* fileLine(file));
      }
      for (const conflict of conflicts) newIndex.push(conflictLine(conflict, account));
      const encode = (lines: readonly string[]) =>
        new TextEncoder().encode(`${lines.join("\n")}\n`);

      const indexPath = path.join(sharedDirectory, MEMORY_INDEX);
      const createdIndex =
        newIndex.length > 0 &&
        (yield* unlessMissing(fileSystem.lstat(indexPath))) === undefined &&
        (yield* publishNew(memoryFs, guard, indexPath, encode(newIndex))) === "published";
      if (!createdIndex) {
        // MEMORY.md exists and stays as it is: say in separate new files what arrived.
        const current = yield* readHead(memoryFs, indexPath, sharedMemoryLimits.maxIndexBytes).pipe(
          Effect.orElseSucceed(() => ""),
        );
        const linked = memoryIndexLinks(current);
        const unlistedCopies: string[] = [];
        for (const { file } of copies) {
          if (isMemory(file) && !linked.has(file)) unlistedCopies.push(yield* fileLine(file));
        }
        const unlistedConflicts = conflicts
          .filter((conflict) => !linked.has(conflict.file))
          .map((conflict) => conflictLine(conflict, account));
        const note = (stem: string, intro: string, lines: readonly string[]) =>
          lines.length === 0
            ? Effect.void
            : publishUnique(
                memoryFs,
                guard,
                (attempt) =>
                  path.join(
                    sharedDirectory,
                    attempt === 1 ? `${stem}.md` : `${stem}-${attempt}.md`,
                  ),
                encode([intro, "", ...lines]),
              ).pipe(Effect.asVoid);
        yield* note(
          SEEDED_FILES_NOTE,
          `# Memory copied from account ${account}\n\nT3 Code copied these files from this account's own memory for the project. MEMORY.md already existed and was left unchanged, so it does not list them. Add the ones worth keeping to MEMORY.md, then delete this note.`,
          unlistedCopies,
        );
        yield* note(
          SEED_CONFLICTS_NOTE,
          `# Conflicting memory from account ${account}\n\nThis account's version of these files differs from the shared one and was kept beside it. MEMORY.md already existed and was left unchanged. Merge each pair, keep one file, then delete this note.`,
          unlistedConflicts,
        );
      }

      for (const folder of markerFolders) yield* checkedFolder(memoryFs, rootGuard, folder, true);
      yield* publishNew(memoryFs, rootGuard, marker, new TextEncoder().encode(MARKER_TEXT));
      return true;
    }),
  );
});
