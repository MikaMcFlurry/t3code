// Counts turns/sessions in statev2.sqlite that are running and were updated in the last 12 hours
// (read-only, metadata only). Prints the count. Same logic as ~/T3-Mika/bin/running-turns.cjs on the iMacs.
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(process.argv[2], { readOnly: true });
const since = Date.now() - 12 * 3600 * 1000;
let n = 0;
for (const { name: t } of d.prepare("select name from sqlite_master where type='table'").all()) {
  if (!/turn|session/i.test(t)) continue;
  const cols = d.prepare(`pragma table_info("${t}")`).all().map((c) => c.name);
  const st = cols.find((c) => /^(state|status)$/i.test(c));
  const ts = ["updated_at", "started_at", "created_at"].filter((c) => cols.includes(c));
  if (!st || !ts.length) continue;
  for (const r of d
    .prepare(
      `select ${ts.map((c) => `"${c}"`).join(",")} from "${t}" where lower("${st}") in ('running','starting','in_progress')`,
    )
    .all()) {
    const toMs = (v) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v ?? "") || 0);
    const last = Math.max(...ts.map((c) => toMs(r[c])));
    if (last >= since) n++;
  }
}
console.log(n);
