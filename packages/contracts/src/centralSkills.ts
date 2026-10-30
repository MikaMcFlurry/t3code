import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const CENTRAL_SKILL_NAME_MAX_CHARS = 64;
// One path segment that both Claude and Codex accept as a skill directory name.
const CENTRAL_SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const CentralSkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CENTRAL_SKILL_NAME_MAX_CHARS),
  Schema.isPattern(CENTRAL_SKILL_NAME_PATTERN),
);
export type CentralSkillName = typeof CentralSkillName.Type;

export const CentralSkill = Schema.Struct({
  name: CentralSkillName,
  description: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  /** Where it was installed from, when T3 installed it. */
  source: Schema.optionalKey(Schema.String),
  path: Schema.String,
});
export type CentralSkill = typeof CentralSkill.Type;

export const CentralSkillsListResult = Schema.Struct({
  directory: Schema.String,
  skills: Schema.Array(CentralSkill),
});
export type CentralSkillsListResult = typeof CentralSkillsListResult.Type;

export const CentralSkillInstallSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("path"),
    /** A directory on the server's machine that contains SKILL.md. */
    path: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    /** A clonable URL, or a GitHub `/tree/<ref>/<path>` URL. */
    url: TrimmedNonEmptyString,
    ref: Schema.optionalKey(TrimmedNonEmptyString),
    /** Repository-relative directory that contains SKILL.md. */
    subdirectory: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    /** An http(s) URL that serves a single SKILL.md. */
    url: TrimmedNonEmptyString,
  }),
]);
export type CentralSkillInstallSource = typeof CentralSkillInstallSource.Type;

export const CentralSkillInstallInput = Schema.Struct({
  source: CentralSkillInstallSource,
  /** Defaults to the SKILL.md `name`, then the source directory name. */
  name: Schema.optionalKey(CentralSkillName),
  /** Replace an installed skill with the same name instead of failing. */
  replace: Schema.optionalKey(Schema.Boolean),
});
export type CentralSkillInstallInput = typeof CentralSkillInstallInput.Type;

export const CentralSkillNameInput = Schema.Struct({ name: CentralSkillName });
export type CentralSkillNameInput = typeof CentralSkillNameInput.Type;

export const CentralSkillSetEnabledInput = Schema.Struct({
  name: CentralSkillName,
  enabled: Schema.Boolean,
});
export type CentralSkillSetEnabledInput = typeof CentralSkillSetEnabledInput.Type;

export class CentralSkillsError extends Schema.TaggedError<CentralSkillsError>()(
  "CentralSkillsError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
