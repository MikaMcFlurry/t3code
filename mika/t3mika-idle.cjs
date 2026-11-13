// Counts T3 runs a restart would interrupt (statev2.sqlite, read-only). Prints the count.
// Turn items or provider sessions can stay "running" after an interruption and would block
// updates forever, so they are not counted. A queued run survives a restart, so it only counts
// while it may start any moment: one queued for more than an hour waits on something else,
// such as an account out of usage, and would otherwise block updates until it ages out.
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(process.argv[2], { readOnly: true });
// Threads whose own runs don't count, e.g. the agent thread that asked for this update.
const ignored = (process.argv[3] ?? "").split(",").filter(Boolean);
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const queuedSince = new Date(Date.now() - 3600 * 1000).toISOString();
const table = d
  .prepare("select 1 from sqlite_master where type='table' and name='orchestration_v2_projection_runs'")
  .get();
if (!table) {
  console.log("fehler");
} else {
  const row = d
    .prepare(
      `select count(*) n from orchestration_v2_projection_runs where requested_at >= ? and (status in ('preparing','starting','running','pending') or (status = 'queued' and requested_at >= ?))${
        ignored.length === 0 ? "" : ` and thread_id not in (${ignored.map(() => "?").join(",")})`
      }`,
    )
    .get(since, queuedSince, ...ignored);
  console.log(row.n);
}
