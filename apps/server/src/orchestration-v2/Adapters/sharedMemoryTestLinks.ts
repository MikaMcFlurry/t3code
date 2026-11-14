// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isWindows = HostProcess.Platform.defaultValue() === "win32";

class TestLinkError extends Schema.TaggedError<TestLinkError>()("TestLinkError", {
  link: Schema.String,
  needsDeveloperMode: Schema.Boolean,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.needsDeveloperMode
      ? `Creating a symbolic link needs Windows Developer Mode (or the SeCreateSymbolicLink right); enable it and run again. Link: ${this.link}`
      : `Could not create the test link ${this.link}`;
  }
}

/**
 * Creates a test link. Windows refuses symbolic links without Developer Mode (or the
 * SeCreateSymbolicLink right); that is a test prerequisite, reported as such instead of being
 * skipped. A junction needs neither, so folder aliases also run as junctions everywhere (on POSIX
 * a junction is an ordinary symbolic link).
 */
export const createTestLink = (target: string, at: string, kind: "file" | "dir" | "junction") =>
  Effect.tryPromise({
    try: () => NodeFSP.symlink(target, at, kind),
    catch: (cause) =>
      new TestLinkError({
        link: at,
        cause,
        needsDeveloperMode:
          isWindows &&
          kind !== "junction" &&
          typeof cause === "object" &&
          cause !== null &&
          Reflect.get(cause, "code") === "EPERM",
      }),
  }).pipe(Effect.orDie);

/** The ways a test makes a folder alias: a symbolic link, and a junction. */
export const folderLinkKinds = ["dir", "junction"] as const;
