// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CentralSkillName } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

/**
 * Claude loads `<dir>/.claude/skills` from every `--add-dir`. T3 keeps mirrored copies of the
 * library there; unmarked folders in it are skills installed before the library moved to the root.
 */
export const centralSkillsClaudeDirectory = (path: Path.Path, skillsDir: string) =>
  path.join(skillsDir, ".claude", "skills");

export const centralSkillsDisabledDirectory = (path: Path.Path, skillsDir: string) =>
  path.join(skillsDir, "disabled");

export const CENTRAL_SKILL_METADATA_FILE = ".t3-skill.json";
/** Present only in copies T3 made; a skill folder without it belongs to the user. */
export const CENTRAL_SKILL_MIRROR_MARKER = ".t3-central-skill";

const isCentralSkillName = Schema.is(CentralSkillName);
/** Folder names in the skills dir that are not skills. */
const RESERVED_LIBRARY_NAMES: ReadonlySet<string> = new Set(["disabled"]);

/**
 * The enabled library: skill folders placed directly in the skills dir (where users drop them),
 * plus unmarked folders left in `.claude/skills` by older versions. A root folder wins a name clash.
 */
export const collectCentralSkillFolders = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  skillsDir: string,
) {
  const folders = new Map<string, string>();
  const hasSkillFile = (directory: string) =>
    fileSystem.exists(path.join(directory, "SKILL.md")).pipe(Effect.orElseSucceed(() => false));
  for (const name of yield* fileSystem
    .readDirectory(skillsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
    if (!isCentralSkillName(name) || RESERVED_LIBRARY_NAMES.has(name)) continue;
    const directory = path.join(skillsDir, name);
    if (yield* hasSkillFile(directory)) folders.set(name, directory);
  }
  const claudeDirectory = centralSkillsClaudeDirectory(path, skillsDir);
  for (const name of yield* fileSystem
    .readDirectory(claudeDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
    if (!isCentralSkillName(name) || folders.has(name)) continue;
    const directory = path.join(claudeDirectory, name);
    const marker = yield* readOptionalFile(
      fileSystem,
      path.join(directory, CENTRAL_SKILL_MIRROR_MARKER),
    );
    if (marker === undefined && (yield* hasSkillFile(directory))) folders.set(name, directory);
  }
  return folders;
});

const readOptionalFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => undefined));

/** Walking stops after this many entries; a larger folder still gets a revision, just a coarser one. */
const MAX_REVISION_ENTRIES = 4096;
const MAX_REVISION_DEPTH = 16;

/**
 * Identifies one state of a skill folder: every file's relative path, size and modification time,
 * so an edit to a script, reference or asset counts as much as one to SKILL.md. Undefined when the
 * folder has no SKILL.md.
 */
const skillRevision = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
) {
  const skillFile = yield* fileSystem
    .stat(path.join(directory, "SKILL.md"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (skillFile === undefined) return undefined;
  const hash = NodeCrypto.createHash("sha256");
  let entries = 0;
  // Directories still to read, as paths relative to the skill folder; deterministic order.
  const pending: Array<ReadonlyArray<string>> = [[]];
  while (pending.length > 0 && entries < MAX_REVISION_ENTRIES) {
    const relative = pending.pop() ?? [];
    const names = yield* fileSystem
      .readDirectory(path.join(directory, ...relative))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const subdirectories: Array<ReadonlyArray<string>> = [];
    for (const name of names.toSorted()) {
      if (entries >= MAX_REVISION_ENTRIES) break;
      if (relative.length === 0 && name === CENTRAL_SKILL_MIRROR_MARKER) continue;
      const child = [...relative, name];
      const info = yield* fileSystem
        .stat(path.join(directory, ...child))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (info === undefined) continue;
      entries++;
      const modified = Option.getOrUndefined(info.mtime)?.getTime() ?? 0;
      hash.update(`${child.join("/")}\0${info.type}\0${info.size}\0${modified}\n`);
      if (info.type === "Directory" && child.length < MAX_REVISION_DEPTH)
        subdirectories.push(child);
    }
    pending.push(...subdirectories.toReversed());
  }
  return `tree:${hash.digest("hex")}`;
});

export interface CentralSkillsMirrorResult {
  readonly mirrored: ReadonlyArray<string>;
  /** Names a user-owned skill in the target already uses; the user's copy wins. */
  readonly shadowed: ReadonlyArray<string>;
}

const STAGING_PREFIX = ".t3-staging-";
const BACKUP_PREFIX = ".t3-backup-";

/** One sync per target folder at a time within this server; see `mirrorCentralSkills`. */
const targetLocks = Effect.runSync(KeyedLock.make<string>());

const targetLockKey = (path: Path.Path, targetSkillsDir: string, windows: boolean) => {
  const resolved = path.resolve(targetSkillsDir);
  return windows ? resolved.toLowerCase() : resolved;
};

/**
 * Replaces `destination` with `staging`. The old copy is renamed aside first and renamed back
 * when the new one cannot be moved in, so a failed swap leaves the previous version in place.
 */
const swapIntoPlace = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  staging: string,
  destination: string,
  backup: string,
) {
  const hadPrevious = yield* fileSystem.exists(destination);
  if (hadPrevious) {
    yield* fileSystem.remove(backup, { recursive: true }).pipe(Effect.ignore);
    yield* fileSystem.rename(destination, backup);
  }
  yield* fileSystem
    .rename(staging, destination)
    .pipe(
      Effect.onError(() =>
        hadPrevious ? fileSystem.rename(backup, destination).pipe(Effect.ignore) : Effect.void,
      ),
    );
  if (hadPrevious) yield* fileSystem.remove(backup, { recursive: true }).pipe(Effect.ignore);
});

/**
 * Finishes what an interrupted sync left behind: a backup whose skill folder is missing goes
 * back into place, any other backup or staging folder is deleted.
 */
const recoverInterruptedSwaps = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  targetSkillsDir: string,
  entries: ReadonlyArray<string>,
) {
  for (const entry of entries) {
    const entryPath = path.join(targetSkillsDir, entry);
    if (entry.startsWith(BACKUP_PREFIX)) {
      const name = entry.slice(BACKUP_PREFIX.length);
      const destination = path.join(targetSkillsDir, name);
      const restorable =
        isCentralSkillName(name) &&
        !(yield* fileSystem.exists(destination).pipe(Effect.orElseSucceed(() => true)));
      yield* (
        restorable
          ? fileSystem.rename(entryPath, destination)
          : fileSystem.remove(entryPath, { recursive: true })
      ).pipe(Effect.ignore);
    } else if (entry.startsWith(STAGING_PREFIX)) {
      yield* fileSystem.remove(entryPath, { recursive: true }).pipe(Effect.ignore);
    }
  }
});

const mirrorCentralSkillsLocked = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  input: { readonly skillsDir: string; readonly targetSkillsDir: string },
) {
  const folders = yield* collectCentralSkillFolders(fileSystem, path, input.skillsDir);
  const wanted = new Map<string, string>();
  for (const [name, directory] of folders) {
    const revision = yield* skillRevision(fileSystem, path, directory);
    if (revision !== undefined) wanted.set(name, revision);
  }

  const listTarget = fileSystem
    .readDirectory(input.targetSkillsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const leftovers = yield* listTarget;
  if (wanted.size === 0 && leftovers.length === 0) {
    return { mirrored: [], shadowed: [] } satisfies CentralSkillsMirrorResult;
  }
  yield* recoverInterruptedSwaps(fileSystem, path, input.targetSkillsDir, leftovers);
  const existing = yield* listTarget;
  yield* fileSystem.makeDirectory(input.targetSkillsDir, { recursive: true });

  for (const entry of existing) {
    if (wanted.has(entry)) continue;
    const marker = yield* readOptionalFile(
      fileSystem,
      path.join(input.targetSkillsDir, entry, CENTRAL_SKILL_MIRROR_MARKER),
    );
    if (marker === undefined) continue;
    yield* fileSystem
      .remove(path.join(input.targetSkillsDir, entry), { recursive: true })
      .pipe(Effect.ignore);
  }

  const mirrored: Array<string> = [];
  const shadowed: Array<string> = [];
  for (const [name, revision] of wanted) {
    const destination = path.join(input.targetSkillsDir, name);
    const exists = yield* fileSystem.exists(destination).pipe(Effect.orElseSucceed(() => false));
    const marker = exists
      ? yield* readOptionalFile(fileSystem, path.join(destination, CENTRAL_SKILL_MIRROR_MARKER))
      : undefined;
    if (exists && marker === undefined) {
      shadowed.push(name);
      continue;
    }
    mirrored.push(name);
    if (marker === revision) continue;
    yield* Effect.gen(function* () {
      const staging = yield* fileSystem.makeTempDirectory({
        directory: input.targetSkillsDir,
        prefix: STAGING_PREFIX,
      });
      yield* Effect.gen(function* () {
        yield* fileSystem.copy(folders.get(name) ?? "", staging, { overwrite: true });
        yield* fileSystem.writeFileString(
          path.join(staging, CENTRAL_SKILL_MIRROR_MARKER),
          revision,
        );
        yield* swapIntoPlace(
          fileSystem,
          staging,
          destination,
          path.join(input.targetSkillsDir, `${BACKUP_PREFIX}${name}`),
        );
      }).pipe(
        Effect.onError(() => fileSystem.remove(staging, { recursive: true }).pipe(Effect.ignore)),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not mirror a central skill.", { skill: name, cause }),
      ),
    );
  }
  return { mirrored, shadowed } satisfies CentralSkillsMirrorResult;
});

/**
 * Mirrors the enabled central skills into a provider home's skills folder (Codex cannot load an
 * extra root per session). Only folders carrying the mirror marker are replaced or deleted. One
 * sync per target folder runs at a time in this server; copies are staged and swapped in.
 */
export const mirrorCentralSkills = Effect.fn("CentralSkills.mirror")(function* (input: {
  readonly skillsDir: string;
  readonly targetSkillsDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* targetLocks.withLock(
    targetLockKey(path, input.targetSkillsDir, yield* HostProcess.isWindows),
    mirrorCentralSkillsLocked(fileSystem, path, input),
  );
});

/**
 * Codex has no per-session skills root (its app-server `skills/extraRoots/set`
 * is newer than the pinned protocol), so its home gets mirrored copies. Never fails.
 */
export const mirrorCentralSkillsToCodexHome = Effect.fn("CentralSkills.mirrorToCodexHome")(
  function* (input: {
    readonly skillsDir: string;
    readonly homePath: string | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const configured = input.homePath?.trim() || input.environment?.CODEX_HOME?.trim();
    const codexHome = configured
      ? path.resolve(expandHomePath(configured, home))
      : path.join(home, ".codex");
    return yield* mirrorCentralSkills({
      skillsDir: input.skillsDir,
      targetSkillsDir: path.join(codexHome, "skills"),
    });
  },
  Effect.catch((cause) =>
    Effect.logWarning("Could not mirror central skills into a Codex home.", { cause }).pipe(
      Effect.as({ mirrored: [], shadowed: [] } satisfies CentralSkillsMirrorResult),
    ),
  ),
);

/** Mirrors the library into the `.claude/skills` folder Claude loads. Never fails. */
export const mirrorCentralSkillsForClaude = Effect.fn("CentralSkills.mirrorForClaude")(
  function* (skillsDir: string) {
    const path = yield* Path.Path;
    return yield* mirrorCentralSkills({
      skillsDir,
      targetSkillsDir: centralSkillsClaudeDirectory(path, skillsDir),
    });
  },
  Effect.catch((cause) =>
    Effect.logWarning("Could not mirror central skills for Claude.", { cause }).pipe(
      Effect.as({ mirrored: [], shadowed: [] } satisfies CentralSkillsMirrorResult),
    ),
  ),
);
