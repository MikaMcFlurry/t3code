import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Claude Code's folder name for a project: every character outside [A-Za-z0-9] becomes `-`. */
export const claudeProjectSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const INDEX_FILE = "MEMORY.md";

/**
 * Brings this account's auto-memory for `cwd` up to date with the other Claude accounts' copies,
 * so a thread that moves accounts keeps what it remembered. Files only another account has are
 * copied, a newer copy replaces an older one, and the `MEMORY.md` index gains the lines it lacks.
 * Nothing is deleted. Returns the names of the files it wrote.
 */
export const syncClaudeProjectMemory = Effect.fn("syncClaudeProjectMemory")(function* (input: {
  readonly cwd: string;
  readonly homePath: string;
  readonly otherHomePaths: ReadonlyArray<string>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const memoryDir = (home: string) =>
    path.join(home, "projects", claudeProjectSlug(input.cwd), "memory");
  const target = memoryDir(input.homePath);
  const modified = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? 0),
      Effect.orElseSucceed(() => null),
    );
  const written = new Set<string>();
  for (const home of input.otherHomePaths) {
    const source = memoryDir(home);
    if (path.resolve(source) === path.resolve(target)) continue;
    const names = yield* fileSystem
      .readDirectory(source)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of names.filter((entry) => entry.endsWith(".md"))) {
      const from = path.join(source, name);
      const to = path.join(target, name);
      const [fromTime, toTime] = yield* Effect.all([modified(from), modified(to)]);
      if (fromTime === null) continue;
      yield* fileSystem.makeDirectory(target, { recursive: true });
      if (toTime === null) {
        yield* fileSystem.copyFile(from, to);
      } else if (name === INDEX_FILE) {
        const [ours, theirs] = yield* Effect.all([
          fileSystem.readFileString(to),
          fileSystem.readFileString(from),
        ]);
        const known = new Set(ours.split(/\r?\n/));
        const missing = theirs
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0 && !known.has(line));
        if (missing.length === 0) continue;
        yield* fileSystem.writeFileString(
          to,
          `${ours.replace(/\s*$/, "")}\n${missing.join("\n")}\n`,
        );
      } else if (fromTime > toTime) {
        yield* fileSystem.copyFile(from, to);
      } else {
        continue;
      }
      written.add(name);
    }
  }
  return [...written].toSorted();
});
