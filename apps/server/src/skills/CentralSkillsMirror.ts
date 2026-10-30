import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CentralSkillName } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

/** Claude loads `<dir>/.claude/skills` from every `--add-dir`, so the library root is that dir. */
export const centralSkillsEnabledDirectory = (path: Path.Path, skillsDir: string) =>
  path.join(skillsDir, ".claude", "skills");

export const centralSkillsDisabledDirectory = (path: Path.Path, skillsDir: string) =>
  path.join(skillsDir, "disabled");

export const CENTRAL_SKILL_METADATA_FILE = ".t3-skill.json";
/** Present only in copies T3 made; a skill folder without it belongs to the user. */
export const CENTRAL_SKILL_MIRROR_MARKER = ".t3-central-skill";

const isCentralSkillName = Schema.is(CentralSkillName);

const readOptionalFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => undefined));

const skillRevision = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
) {
  const metadata = yield* readOptionalFile(
    fileSystem,
    path.join(directory, CENTRAL_SKILL_METADATA_FILE),
  );
  const modified = yield* fileSystem.stat(path.join(directory, "SKILL.md")).pipe(
    Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? 0),
    Effect.orElseSucceed(() => undefined),
  );
  return modified === undefined ? undefined : `${modified}:${metadata?.trim() ?? ""}`;
});

export interface CentralSkillsMirrorResult {
  readonly mirrored: ReadonlyArray<string>;
  /** Names a user-owned skill in the target already uses; the user's copy wins. */
  readonly shadowed: ReadonlyArray<string>;
}

/**
 * Mirrors the enabled central skills into a provider home's skills folder for
 * providers that cannot load an extra skills root per session (Codex). Only
 * folders carrying the mirror marker are replaced or deleted. Concurrent
 * syncs of one home are safe: each copy is staged and renamed into place.
 */
export const mirrorCentralSkills = Effect.fn("CentralSkills.mirror")(function* (input: {
  readonly skillsDir: string;
  readonly targetSkillsDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = centralSkillsEnabledDirectory(path, input.skillsDir);
  const wanted = new Map<string, string>();
  for (const name of yield* fileSystem
    .readDirectory(source)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
    if (!isCentralSkillName(name)) continue;
    const revision = yield* skillRevision(fileSystem, path, path.join(source, name));
    if (revision !== undefined) wanted.set(name, revision);
  }

  const existing = yield* fileSystem
    .readDirectory(input.targetSkillsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  if (wanted.size === 0 && existing.length === 0) return { mirrored: [], shadowed: [] };
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
        prefix: ".t3-staging-",
      });
      yield* Effect.gen(function* () {
        yield* fileSystem.copy(path.join(source, name), staging, { overwrite: true });
        yield* fileSystem.writeFileString(
          path.join(staging, CENTRAL_SKILL_MIRROR_MARKER),
          revision,
        );
        if (exists) yield* fileSystem.remove(destination, { recursive: true });
        yield* fileSystem.rename(staging, destination);
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
