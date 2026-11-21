// The database reset (`runbooks/reset-database.md`): `resetDatabase` over
// the data directory. Refuses, deleting nothing, while another process has
// `session.db` open or a server's heartbeat in `server_meta` is fresh.
// Without `--yes` it lists what it would delete.
//
// Usage, on a one-off machine with the app's volume (the image holds the
// bundle):
//
//   node /app/packages/server/dist/reset-database.mjs            # list
//   node /app/packages/server/dist/reset-database.mjs --yes      # delete
//
// or from `web/packages/server` against a local data directory:
//
//   npx tsx scripts/reset-database.ts --data-dir ../../.data --yes
//
// The data directory is `--data-dir`, else `SESSION_DATA_DIR` when it is not
// empty, else `./.data`. `--assume-stopped` lets it run on a database with
// no heartbeat to read (no `server_meta` table, as one made by an older
// build, or a file SQLite cannot read); the lock is taken all the same.
// `--no-database` lets `--yes` delete when there is no `session.db`.
//
// Exit codes: 0 done (or listed), 1 refused, 2 usage, 3 any other error.

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ResetRefusedError, resetDatabase, type ResetReport } from "../src/ops/resetDatabase.js";

const USAGE =
  "usage: reset-database [--data-dir <dir>] [--yes] [--assume-stopped] [--no-database]\n";

function readArgs() {
  try {
    return parseArgs({
      options: {
        "data-dir": { type: "string" },
        yes: { type: "boolean", default: false },
        "assume-stopped": { type: "boolean", default: false },
        "no-database": { type: "boolean", default: false },
      },
    }).values;
  } catch {
    process.stderr.write(USAGE);
    process.exit(2);
  }
}

function stoppedLine(report: ResetReport, database: string): string {
  if (report.stopped === "no database") return `no database at ${database}`;
  const lock = report.locked
    ? `the reset held an exclusive lock on ${database}: no other process had it open`
    : `SQLite could not lock ${database}: whether another process has it open was not checked`;
  if (report.stopped === "heartbeat") return `no server heartbeat in the last 90 s\n${lock}`;
  const why =
    report.unreadable !== undefined
      ? `${database} cannot be read as a SQLite database (${report.unreadable})`
      : "no server_meta table";
  return `${why}: the server is taken as stopped (--assume-stopped)\n${lock}`;
}

const values = readArgs();
// an empty SESSION_DATA_DIR is unset: resolved, it would name the current directory
const fromEnv = process.env["SESSION_DATA_DIR"] || undefined;
const dataDir = resolve(values["data-dir"] ?? fromEnv ?? ".data");
try {
  const report = resetDatabase({
    dataDir,
    apply: values.yes,
    assumeStopped: values["assume-stopped"],
    noDatabase: values["no-database"],
  });
  const verb = report.applied ? "deleted" : "would delete";
  process.stdout.write(`${stoppedLine(report, join(dataDir, "session.db"))}\n`);
  for (const path of report.paths) process.stdout.write(`${verb}  ${path}\n`);
  if (report.paths.length === 0) process.stdout.write(`nothing to delete in ${dataDir}\n`);
  if (!report.applied && report.paths.length > 0)
    process.stdout.write("run again with --yes to delete\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ResetRefusedError ? 1 : 3;
}
