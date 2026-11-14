#!/usr/bin/env node
// Native probe of the file-system primitives claudeSharedMemory.ts relies on (wx, no-clobber hard
// links, link/junction detection). Creates and removes only its own fresh temporary folder.
// Usage: node apps/server/scripts/memory-platform-probe.mjs [--temp-parent=DIR] [--require-hardlinks]
// --temp-parent must be on the volume of T3's data directory; exit 1 when a required check fails.

import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const argument = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const requireHardlinks = process.argv.includes("--require-hardlinks");
const parent = argument("temp-parent") ?? NodeOS.tmpdir();

const report = {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- A standalone probe of the actual host; no Effect runtime.
  platform: NodeOS.platform(),
  // oxlint-disable-next-line t3code/no-global-process-runtime -- A standalone probe of the actual host; no Effect runtime.
  arch: NodeOS.arch(),
  node: process.version,
  libuv: process.versions.uv,
  tempParent: parent,
  checks: {},
  failures: [],
};
const fail = (check, message) => report.failures.push(`${check}: ${message}`);
const errorCode = async (operation) => {
  try {
    await operation();
    return null;
  } catch (error) {
    return error.code ?? String(error);
  }
};
const identity = async (file) => {
  const info = await NodeFSP.stat(file, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino), nlink: String(info.nlink) };
};

const root = await NodeFSP.mkdtemp(NodePath.join(parent, "t3-memory-platform-"));
report.root = root;
try {
  // 1. `wx` creates only a new file and never follows a link planted at the name.
  {
    const check = "exclusiveCreate";
    const existing = NodePath.join(root, "existing.md");
    await NodeFSP.writeFile(existing, "EXISTING\n");
    const overExisting = await errorCode(() =>
      NodeFSP.writeFile(existing, "NEW\n", { flag: "wx" }),
    );
    const result = {
      overExisting,
      unchanged: (await NodeFSP.readFile(existing, "utf8")) === "EXISTING\n",
    };
    const dangling = NodePath.join(root, "dangling.md");
    const pointee = NodePath.join(root, "pointee-never-created.md");
    const symlinkError = await errorCode(() => NodeFSP.symlink(pointee, dangling, "file"));
    if (symlinkError === null) {
      result.overDanglingLink = await errorCode(() =>
        NodeFSP.writeFile(dangling, "NEW\n", { flag: "wx" }),
      );
      result.followedLink = await NodeFSP.access(pointee).then(
        () => true,
        () => false,
      );
      if (result.overDanglingLink !== "EEXIST" || result.followedLink) {
        fail(check, "a wx write went through a planted link");
      }
    } else {
      result.overDanglingLink = `skipped: cannot create a file symlink (${symlinkError})`;
    }
    if (overExisting !== "EEXIST" || !result.unchanged) fail(check, "wx replaced an existing file");
    report.checks[check] = result;
  }

  // 2. Hard links: the seed's only way to publish a file.
  {
    const check = "hardLinkPublication";
    const temporary = NodePath.join(root, `.t3-memory-${"0".repeat(36)}.tmp`);
    const target = NodePath.join(root, "topic.md");
    const result = {};
    await NodeFSP.writeFile(temporary, "ACCOUNT COPY\n", { flag: "wx" });
    const linkError = await errorCode(() => NodeFSP.link(temporary, target));
    if (linkError !== null) {
      result.linkError = linkError;
      result.consequence =
        "no hard links: the seed publishes nothing here and sessions keep each account's own memory";
      if (requireHardlinks) fail(check, `hard link failed with ${linkError}`);
    } else {
      result.temporary = await identity(temporary);
      result.target = await identity(target);
      result.sameFile =
        result.temporary.dev === result.target.dev && result.temporary.ino === result.target.ino;
      result.inoNonZero = result.target.ino !== "0";
      result.nlinkAfterLink = result.target.nlink;
      await NodeFSP.unlink(temporary);
      result.nlinkAfterRemovingTemporary = (await identity(target)).nlink;
      result.content = await NodeFSP.readFile(target, "utf8");
      // A second publication onto the now existing name must fail and leave it alone.
      const other = NodePath.join(root, `.t3-memory-${"1".repeat(36)}.tmp`);
      await NodeFSP.writeFile(other, "SECOND WRITER\n", { flag: "wx" });
      result.linkOntoExisting = await errorCode(() => NodeFSP.link(other, target));
      await NodeFSP.unlink(other);
      result.targetUnchanged = (await NodeFSP.readFile(target, "utf8")) === "ACCOUNT COPY\n";
      if (!result.sameFile) fail(check, "a hard link does not share dev/ino with its source");
      if (!result.inoNonZero) fail(check, "ino is 0");
      if (result.nlinkAfterLink !== "2" || result.nlinkAfterRemovingTemporary !== "1") {
        fail(check, "nlink did not go 2 -> 1");
      }
      if (result.content !== "ACCOUNT COPY\n") fail(check, "published content differs");
      if (result.linkOntoExisting !== "EEXIST" || !result.targetUnchanged) {
        fail(check, "a hard link replaced an existing file");
      }
    }
    report.checks[check] = result;
  }

  // 3. Many writers racing for one name: exactly one wins, every other gets EEXIST.
  if (report.checks.hardLinkPublication.linkError === undefined) {
    const check = "hardLinkRace";
    const target = NodePath.join(root, "race.md");
    const writers = 16;
    const sources = [];
    for (let index = 0; index < writers; index++) {
      const source = NodePath.join(root, `race-${index}.tmp`);
      await NodeFSP.writeFile(source, `WRITER ${index}\n`, { flag: "wx" });
      sources.push(source);
    }
    const outcomes = await Promise.all(
      sources.map((source) => errorCode(() => NodeFSP.link(source, target))),
    );
    const winners = outcomes.flatMap((code, index) => (code === null ? [index] : []));
    const content = await NodeFSP.readFile(target, "utf8");
    const result = {
      writers,
      winners: winners.length,
      otherErrors: [...new Set(outcomes.filter((code) => code !== null))],
      contentIsWinner: winners.length === 1 && content === `WRITER ${winners[0]}\n`,
    };
    if (result.winners !== 1 || !result.contentIsWinner) fail(check, "not exactly one winner");
    if (result.otherErrors.some((code) => code !== "EEXIST")) {
      fail(check, `losers saw ${result.otherErrors.join(", ")}`);
    }
    report.checks[check] = result;
  }

  // 4. COPYFILE_EXCL, for reference: no-clobber, but the copy becomes visible while incomplete.
  {
    const source = NodePath.join(root, "copy-source.md");
    const target = NodePath.join(root, "copy-target.md");
    await NodeFSP.writeFile(source, "SOURCE\n");
    await NodeFSP.writeFile(target, "TARGET\n");
    report.checks.copyFileExclusive = {
      ontoExisting: await errorCode(() =>
        NodeFSP.copyFile(source, target, NodeFS.constants.COPYFILE_EXCL),
      ),
      targetUnchanged: (await NodeFSP.readFile(target, "utf8")) === "TARGET\n",
      usedBySeed: false,
    };
  }

  // 5. Folder links and junctions must look like links to lstat, so the seed refuses them.
  {
    const check = "folderAliases";
    const real = NodePath.join(root, "account-memory");
    await NodeFSP.mkdir(real);
    const result = {};
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Junctions exist only on the actual Windows host.
    for (const type of NodeOS.platform() === "win32" ? ["junction", "dir"] : ["dir"]) {
      const alias = NodePath.join(root, `alias-${type}`);
      const created = await errorCode(() => NodeFSP.symlink(real, alias, type));
      if (created !== null) {
        result[type] = { skipped: `cannot create (${created})` };
        continue;
      }
      const info = await NodeFSP.lstat(alias);
      result[type] = {
        lstatIsSymbolicLink: info.isSymbolicLink(),
        lstatIsDirectory: info.isDirectory(),
        realPathLeaves: (await NodeFSP.realpath(alias)) === (await NodeFSP.realpath(real)),
      };
      if (!info.isSymbolicLink()) fail(check, `a ${type} link does not look like a link to lstat`);
    }
    report.checks[check] = result;
  }

  // 6. Plain rename replaces an existing file: why the seed never renames onto a name.
  {
    const target = NodePath.join(root, "MEMORY.md");
    const replacement = NodePath.join(root, "replacement.tmp");
    await NodeFSP.writeFile(target, "CLAUDE\n");
    await NodeFSP.writeFile(replacement, "SEED\n");
    const renameError = await errorCode(() => NodeFSP.rename(replacement, target));
    report.checks.renameReplaces = {
      renameError,
      replaced: renameError === null && (await NodeFSP.readFile(target, "utf8")) === "SEED\n",
      usedBySeed: false,
    };
  }

  // 7. Names: case folding and Unicode normalisation of this volume.
  {
    await NodeFSP.writeFile(NodePath.join(root, "MixedCase.md"), "CASE\n");
    const nfc = "caf\u00e9.md";
    const nfd = "cafe\u0301.md";
    await NodeFSP.writeFile(NodePath.join(root, nfc), "NFC\n");
    report.checks.names = {
      caseInsensitive: await NodeFSP.access(NodePath.join(root, "mixedcase.md")).then(
        () => true,
        () => false,
      ),
      nfdFindsNfc: await NodeFSP.access(NodePath.join(root, nfd)).then(
        () => true,
        () => false,
      ),
      listedAs: (await NodeFSP.readdir(root)).filter((name) => name.startsWith("caf")),
    };
  }

  // 8. Modification times, which the clean-up of stale temporary files relies on.
  {
    const file = NodePath.join(root, `.t3-memory-${"2".repeat(36)}.tmp`);
    await NodeFSP.writeFile(file, "LEFTOVER\n");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await NodeFSP.utimes(file, old, old);
    const mtime = (await NodeFSP.lstat(file)).mtimeMs;
    report.checks.mtime = { setTwoHoursBack: Math.abs(mtime - old.getTime()) < 2000 };
    if (!report.checks.mtime.setTwoHoursBack) fail("mtime", "utimes did not take effect");
  }
} catch (error) {
  fail("probe", error?.stack ?? String(error));
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
  report.cleaned = true;
}

report.ok = report.failures.length === 0;
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
