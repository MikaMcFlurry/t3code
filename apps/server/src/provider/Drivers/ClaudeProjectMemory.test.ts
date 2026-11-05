import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeProjectSlug, syncClaudeProjectMemory } from "./ClaudeProjectMemory.ts";

it.layer(NodeServices.layer)("ClaudeProjectMemory", (it) => {
  it("names a project folder the way Claude Code does", () => {
    expect(claudeProjectSlug("C:\\Users\\mika\\work\\t3-test")).toBe("C--Users-mika-work-t3-test");
    expect(claudeProjectSlug("/home/mika/T3 code")).toBe("-home-mika-T3-code");
  });

  it.effect("brings over memory another Claude account wrote for the same project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = "/work/project";
      const web = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-web-" });
      const support = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-support-" });
      const memory = (home: string) =>
        path.join(home, "projects", claudeProjectSlug(cwd), "memory");
      const write = (home: string, name: string, text: string, mtimeMs: number) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(memory(home), { recursive: true });
          const file = path.join(memory(home), name);
          yield* fileSystem.writeFileString(file, text);
          yield* fileSystem.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
        });
      const read = (home: string, name: string) =>
        fileSystem.readFileString(path.join(memory(home), name));

      yield* write(web, "MEMORY.md", "- [Fork](fork.md) — fork setup\n", 1_000);
      yield* write(web, "fork.md", "fork notes from web", 1_000);
      yield* write(web, "shared.md", "older shared note", 1_000);
      yield* write(support, "MEMORY.md", "- [Shared](shared.md) — shared note\n", 2_000);
      yield* write(support, "shared.md", "newer shared note", 2_000);
      yield* write(support, "notes.txt", "not memory", 2_000);

      const written = yield* syncClaudeProjectMemory({
        cwd,
        homePath: support,
        otherHomePaths: [web, support],
      });

      expect(written).toEqual(["MEMORY.md", "fork.md"]);
      // A file only the other account has is copied; the index gains its line, keeping ours.
      expect(yield* read(support, "fork.md")).toBe("fork notes from web");
      expect(yield* read(support, "MEMORY.md")).toBe(
        "- [Shared](shared.md) — shared note\n- [Fork](fork.md) — fork setup\n",
      );
      // A newer local copy is kept.
      expect(yield* read(support, "shared.md")).toBe("newer shared note");
      // Running it again changes nothing.
      expect(
        yield* syncClaudeProjectMemory({ cwd, homePath: support, otherHomePaths: [web] }),
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("creates the memory folder for an account that never worked on the project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = "/work/fresh";
      const web = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-web-" });
      const gmail = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-gmail-" });
      const source = path.join(web, "projects", claudeProjectSlug(cwd), "memory");
      yield* fileSystem.makeDirectory(source, { recursive: true });
      yield* fileSystem.writeFileString(path.join(source, "MEMORY.md"), "- [A](a.md) — a\n");

      expect(
        yield* syncClaudeProjectMemory({ cwd, homePath: gmail, otherHomePaths: [web] }),
      ).toEqual(["MEMORY.md"]);
      // An account without any memory for the project is skipped quietly.
      expect(
        yield* syncClaudeProjectMemory({
          cwd: "/work/other",
          homePath: gmail,
          otherHomePaths: [web],
        }),
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
