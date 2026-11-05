// Counts T3 runs that are running or waiting to run (statev2.sqlite, read-only). Prints the count.
// Runs are what a restart would interrupt; turn items or provider sessions can stay "running"
// after an interruption and would block updates forever, so they are not counted.
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(process.argv[2], { readOnly: true });
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const table = d
  .prepare("select 1 from sqlite_master where type='table' and name='orchestration_v2_projection_runs'")
  .get();
if (!table) {
  console.log("fehler");
} else {
  const row = d
    .prepare(
      "select count(*) n from orchestration_v2_projection_runs where status in ('running','queued','starting','pending') and requested_at >= ?",
    )
    .get(since);
  console.log(row.n);
}
