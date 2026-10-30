import {
  type CentralSkill,
  type CentralSkillInstallInput,
  type CentralSkillInstallSource,
  CentralSkillName,
  CentralSkillsError,
  type CentralSkillsListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import { parseSkillFrontmatter } from "../provider/Drivers/ClaudeSkills.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  CENTRAL_SKILL_METADATA_FILE,
  CENTRAL_SKILL_MIRROR_MARKER,
  centralSkillsDisabledDirectory,
  centralSkillsEnabledDirectory,
} from "./CentralSkillsMirror.ts";

const GIT_CLONE_TIMEOUT_MS = 120_000;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const isCentralSkillName = Schema.is(CentralSkillName);
const isCentralSkillsError = Schema.is(CentralSkillsError);

const SkillMetadata = Schema.fromJsonString(
  Schema.Struct({
    source: Schema.optional(Schema.String),
    installedAt: Schema.optional(Schema.String),
  }),
);
const decodeSkillMetadata = Schema.decodeUnknownOption(SkillMetadata);
const encodeSkillMetadata = Schema.encodeSync(SkillMetadata);

export class CentralSkills extends Context.Service<
  CentralSkills,
  {
    readonly list: Effect.Effect<CentralSkillsListResult, CentralSkillsError>;
    readonly install: (
      input: CentralSkillInstallInput,
    ) => Effect.Effect<CentralSkillsListResult, CentralSkillsError>;
    readonly remove: (name: string) => Effect.Effect<CentralSkillsListResult, CentralSkillsError>;
    readonly setEnabled: (
      name: string,
      enabled: boolean,
    ) => Effect.Effect<CentralSkillsListResult, CentralSkillsError>;
  }
>()("t3/skills/CentralSkills") {}

/** `https://github.com/<owner>/<repo>/tree/<ref>/<path>` names a ref and folder in the URL itself. */
export function parseGitSkillUrl(source: Extract<CentralSkillInstallSource, { kind: "git" }>) {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+?))?\/?$/i.exec(
      source.url,
    );
  if (!match) {
    return { url: source.url, ref: source.ref, subdirectory: source.subdirectory };
  }
  const [, owner, repo, ref, subdirectory] = match;
  return {
    url: `https://github.com/${owner}/${repo}.git`,
    ref: source.ref ?? ref,
    subdirectory: source.subdirectory ?? subdirectory,
  };
}

function describeSource(source: CentralSkillInstallSource): string {
  switch (source.kind) {
    case "path":
      return source.path;
    case "git": {
      const parsed = parseGitSkillUrl(source);
      return [
        parsed.url,
        parsed.ref ? `#${parsed.ref}` : "",
        parsed.subdirectory ? `:${parsed.subdirectory}` : "",
      ].join("");
    }
    case "url":
      return source.url;
  }
}

const fail = (detail: string, cause?: unknown): Effect.Effect<never, CentralSkillsError> =>
  Effect.fail(new CentralSkillsError({ detail, ...(cause === undefined ? {} : { cause }) }));

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { skillsDir } = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const httpClient = yield* HttpClient.HttpClient;
  const enabledDirectory = centralSkillsEnabledDirectory(path, skillsDir);
  const disabledDirectory = centralSkillsDisabledDirectory(path, skillsDir);
  // Installs, removals and toggles move whole folders; one at a time keeps them from interleaving.
  const mutations = yield* Semaphore.make(1);

  const readSkill = Effect.fnUntraced(function* (
    directory: string,
    name: string,
    enabled: boolean,
  ) {
    const skillPath = path.join(directory, name);
    const contents = yield* fileSystem
      .readFileString(path.join(skillPath, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) return undefined;
    const frontmatter = parseSkillFrontmatter(contents);
    const metadata = yield* fileSystem
      .readFileString(path.join(skillPath, CENTRAL_SKILL_METADATA_FILE))
      .pipe(Effect.orElseSucceed(() => ""));
    const source = Option.getOrUndefined(decodeSkillMetadata(metadata))?.source;
    return {
      name,
      enabled,
      path: skillPath,
      ...(frontmatter.kind === "parsed" && frontmatter.description
        ? { description: frontmatter.description }
        : {}),
      ...(source ? { source } : {}),
    } satisfies CentralSkill;
  });

  const readSkills = Effect.fnUntraced(function* (directory: string, enabled: boolean) {
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const skills: Array<CentralSkill> = [];
    for (const entry of entries) {
      if (!isCentralSkillName(entry)) continue;
      const skill = yield* readSkill(directory, entry, enabled);
      if (skill) skills.push(skill);
    }
    return skills;
  });

  const list = Effect.gen(function* () {
    const enabled = yield* readSkills(enabledDirectory, true);
    const enabledNames = new Set(enabled.map((skill) => skill.name));
    const disabled = (yield* readSkills(disabledDirectory, false)).filter(
      (skill) => !enabledNames.has(skill.name),
    );
    return {
      directory: skillsDir,
      skills: [...enabled, ...disabled].sort((left, right) => left.name.localeCompare(right.name)),
    } satisfies CentralSkillsListResult;
  }).pipe(Effect.withSpan("CentralSkills.list"));

  const locate = Effect.fnUntraced(function* (name: string) {
    for (const directory of [enabledDirectory, disabledDirectory]) {
      const candidate = path.join(directory, name);
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return { directory, path: candidate, enabled: directory === enabledDirectory };
      }
    }
    return undefined;
  });

  /** Resolves a source to a local folder holding SKILL.md, inside `scratch` when downloaded. */
  const stageSource = Effect.fnUntraced(function* (
    source: CentralSkillInstallSource,
    scratch: string,
  ) {
    switch (source.kind) {
      case "path": {
        const directory = path.resolve(source.path);
        const info = yield* fileSystem.stat(directory).pipe(Effect.orElseSucceed(() => undefined));
        if (info?.type !== "Directory") {
          return yield* fail(`'${directory}' is not a folder on this server.`);
        }
        return directory;
      }
      case "git": {
        const parsed = parseGitSkillUrl(source);
        if (!/^(https?:\/\/|ssh:\/\/|git@)/i.test(parsed.url)) {
          return yield* fail("Git installs need an https, ssh, or git@ URL.");
        }
        const checkout = path.join(scratch, "repository");
        yield* git
          .execute({
            operation: "CentralSkills.install.clone",
            cwd: scratch,
            args: [
              "clone",
              "--depth",
              "1",
              ...(parsed.ref ? ["--branch", parsed.ref] : []),
              "--",
              parsed.url,
              checkout,
            ],
            timeoutMs: GIT_CLONE_TIMEOUT_MS,
            env: { GIT_TERMINAL_PROMPT: "0" },
          })
          .pipe(Effect.catch((cause) => fail("The repository could not be cloned.", cause)));
        const directory = parsed.subdirectory
          ? path.resolve(checkout, parsed.subdirectory)
          : checkout;
        const relative = path.relative(checkout, directory);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return yield* fail("The skill folder must be inside the repository.");
        }
        yield* fileSystem
          .remove(path.join(checkout, ".git"), { recursive: true })
          .pipe(Effect.ignore);
        return directory;
      }
      case "url": {
        if (!/^https?:\/\//i.test(source.url)) {
          return yield* fail("URL installs need an http or https URL.");
        }
        const contents = yield* httpClient.get(source.url).pipe(
          Effect.filterOrFail(
            (response) => response.status >= 200 && response.status < 300,
            (response) =>
              new CentralSkillsError({
                detail: `The SKILL.md URL answered HTTP ${response.status}.`,
              }),
          ),
          Effect.flatMap((response) => response.text),
          Effect.scoped,
          Effect.timeout("30 seconds"),
          Effect.catchIf(
            (cause) => !isCentralSkillsError(cause),
            (cause) => fail("The SKILL.md could not be downloaded.", cause),
          ),
        );
        if (contents.length > MAX_SKILL_FILE_BYTES) {
          return yield* fail("The downloaded SKILL.md is too large.");
        }
        const directory = path.join(scratch, "download");
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
        return directory;
      }
    }
  });

  const install = Effect.fn("CentralSkills.install")(function* (input: CentralSkillInstallInput) {
    yield* Effect.annotateCurrentSpan({ "skill.source.kind": input.source.kind });
    yield* mutations.withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(enabledDirectory, { recursive: true });
          const scratch = yield* fileSystem.makeTempDirectoryScoped({
            directory: skillsDir,
            prefix: ".install-",
          });
          const sourceDirectory = yield* stageSource(input.source, scratch);
          const contents = yield* fileSystem
            .readFileString(path.join(sourceDirectory, "SKILL.md"))
            .pipe(Effect.orElseSucceed(() => undefined));
          if (contents === undefined) {
            return yield* fail("The skill folder has no SKILL.md.");
          }
          const frontmatter = parseSkillFrontmatter(contents);
          if (frontmatter.kind === "malformed") {
            return yield* fail("The SKILL.md frontmatter is not valid YAML.");
          }
          const declaredName = frontmatter.kind === "parsed" ? frontmatter.name : undefined;
          const name =
            input.name ??
            [declaredName, input.source.kind === "url" ? undefined : path.basename(sourceDirectory)]
              .map((candidate) => candidate?.trim())
              .find(
                (candidate): candidate is string => !!candidate && isCentralSkillName(candidate),
              );
          if (name === undefined) {
            return yield* fail(
              "Could not derive a skill name. Pass a name made of letters, digits, '-' or '_'.",
            );
          }
          const existing = yield* locate(name);
          if (existing && input.replace !== true) {
            return yield* fail(`A central skill named '${name}' is already installed.`);
          }

          const staged = path.join(scratch, "skill");
          yield* fileSystem.copy(sourceDirectory, staged, { overwrite: true });
          yield* fileSystem
            .remove(path.join(staged, CENTRAL_SKILL_MIRROR_MARKER), { recursive: true })
            .pipe(Effect.ignore);
          yield* fileSystem.writeFileString(
            path.join(staged, CENTRAL_SKILL_METADATA_FILE),
            `${encodeSkillMetadata({
              source: describeSource(input.source),
              installedAt: DateTime.formatIso(yield* DateTime.now),
            })}\n`,
          );
          const destinationDirectory =
            existing?.enabled === false ? disabledDirectory : enabledDirectory;
          if (existing) yield* fileSystem.remove(existing.path, { recursive: true });
          yield* fileSystem.makeDirectory(destinationDirectory, { recursive: true });
          yield* fileSystem.rename(staged, path.join(destinationDirectory, name));
        }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            fail("The skill could not be written to the central library.", cause),
        }),
      ),
    );
    return yield* list;
  });

  const remove = Effect.fn("CentralSkills.remove")(function* (name: string) {
    yield* mutations.withPermit(
      Effect.gen(function* () {
        const existing = yield* locate(name);
        if (!existing) return yield* fail(`No central skill named '${name}'.`);
        yield* fileSystem.remove(existing.path, { recursive: true }).pipe(
          Effect.catchTags({
            PlatformError: (cause) => fail(`Could not remove '${name}'.`, cause),
          }),
        );
      }),
    );
    return yield* list;
  });

  const setEnabled = Effect.fn("CentralSkills.setEnabled")(function* (
    name: string,
    enabled: boolean,
  ) {
    yield* mutations.withPermit(
      Effect.gen(function* () {
        const existing = yield* locate(name);
        if (!existing) return yield* fail(`No central skill named '${name}'.`);
        if (existing.enabled === enabled) return;
        const target = enabled ? enabledDirectory : disabledDirectory;
        yield* fileSystem.makeDirectory(target, { recursive: true }).pipe(
          Effect.andThen(fileSystem.rename(existing.path, path.join(target, name))),
          Effect.catchTags({
            PlatformError: (cause) => fail(`Could not move '${name}'.`, cause),
          }),
        );
      }),
    );
    return yield* list;
  });

  return CentralSkills.of({ list, install, remove, setEnabled });
});

export const layer = Layer.effect(CentralSkills, make);
