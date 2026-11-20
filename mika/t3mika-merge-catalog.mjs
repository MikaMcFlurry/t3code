#!/usr/bin/env node
// Git merge driver for the GT translation catalogs (apps/*/src/i18n/translations/*.json).
// Merges key by key: keys either side adds or changes are kept, and a key only conflicts when both
// sides changed it differently. Line-based merges collide whenever two branches add keys at
// neighbouring lines. Usage (git config): node mika/t3mika-merge-catalog.mjs %O %A %B %P
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [basePath, oursPath, theirsPath, targetPath] = process.argv.slice(2);
const read = (path) => {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const base = read(basePath) ?? {};
const ours = read(oursPath);
const theirs = read(theirsPath);
if (ours === null || theirs === null) process.exit(1);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (object, key) => Object.hasOwn(object, key);
const result = {};
let conflicts = 0;
for (const key of Object.keys(ours)) {
  if (!has(theirs, key)) {
    // Theirs removed it: drop it unless ours changed it since the base.
    if (has(base, key) && same(base[key], ours[key])) continue;
    result[key] = ours[key];
  } else if (same(ours[key], theirs[key]) || (has(base, key) && same(base[key], theirs[key]))) {
    result[key] = ours[key];
  } else if (has(base, key) && same(base[key], ours[key])) {
    result[key] = theirs[key];
  } else {
    conflicts += 1;
    result[key] = ours[key];
  }
}
// Keys only theirs has: add the new ones after their predecessor in theirs, skip ones ours removed.
const theirKeys = Object.keys(theirs);
const additions = new Map();
theirKeys.forEach((key, index) => {
  if (has(ours, key)) return;
  if (has(base, key) && same(base[key], theirs[key])) return;
  let anchor = null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (has(result, theirKeys[i])) {
      anchor = theirKeys[i];
      break;
    }
  }
  if (!additions.has(anchor)) additions.set(anchor, []);
  additions.get(anchor).push(key);
});
const merged = {};
for (const key of additions.get(null) ?? []) merged[key] = theirs[key];
for (const key of Object.keys(result)) {
  merged[key] = result[key];
  for (const added of additions.get(key) ?? []) merged[added] = theirs[added];
}
const text = NodeFS.readFileSync(oursPath, "utf8");
const output = JSON.stringify(merged, null, 2) + (text.endsWith("\n") ? "\n" : "");
// Format like the committed catalogs (oxfmt joins short arrays). A temp file beside the catalog
// picks up the repo's formatter config; without vp the output stays valid, unformatted JSON.
const formatted =
  targetPath && NodePath.join(NodePath.dirname(targetPath), `t3mika-merge-${process.pid}.json`);
try {
  if (!formatted) throw new Error("no target path");
  NodeFS.writeFileSync(formatted, output);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone git merge driver; no Effect runtime.
  const windows = process.platform === "win32";
  const vp = NodePath.join("node_modules", ".bin", windows ? "vp.cmd" : "vp");
  const run = NodeChildProcess.spawnSync(vp, ["fmt", formatted], {
    stdio: "ignore",
    shell: windows,
  });
  if (run.status !== 0) throw new Error("vp fmt failed");
  NodeFS.renameSync(formatted, oursPath);
} catch {
  if (formatted) NodeFS.rmSync(formatted, { force: true });
  NodeFS.writeFileSync(oursPath, output);
}
process.exit(conflicts > 0 ? 1 : 0);
