// Counts T3 runs that are running or waiting to run (statev2.sqlite, read-only). Prints the count.
// Runs are what a restart would interrupt; turn items or provider sessions can stay "running"
// after an interruption and would block updates forever, so they are not counted.
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(process.argv[2], { readOnly: true });
// Threads whose own runs don't count, e.g. the agent thread that asked for this update.
const ignored = (process.argv[3] ?? "").split(",").filter(Boolean);
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const table = d
  .prepare("select 1 from sqlite_master where type='table' and name='orchestration_v2_projection_runs'")
  .get();
if (!table) {
  console.log("fehler");
} else {
  const row = d
    .prepare(
      `select count(*) n from orchestration_v2_projection_runs where status in ('running','queued','starting','pending') and requested_at >= ?${
        ignored.length === 0 ? "" : ` and thread_id not in (${ignored.map(() => "?").join(",")})`
      }`,
    )
    .get(since, ...ignored);
  console.log(row.n);
}
