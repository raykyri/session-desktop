// The database reset (`runbooks/reset-database.md`): `resetDatabase` over
// the data directory. Refuses, deleting nothing, while a server's heartbeat
// in `server_meta` is fresh. Without `--yes` it lists what it would delete.
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
// The data directory is `--data-dir`, else `SESSION_DATA_DIR`, else
// `./.data`. `--assume-stopped` lets it run on a database with no
// `server_meta` table (one made by an older build, which wrote no heartbeat).

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { ResetRefusedError, resetDatabase } from "../src/ops/resetDatabase.js";

const USAGE = "usage: reset-database [--data-dir <dir>] [--yes] [--assume-stopped]\n";

function readArgs() {
  try {
    return parseArgs({
      options: {
        "data-dir": { type: "string" },
        yes: { type: "boolean", default: false },
        "assume-stopped": { type: "boolean", default: false },
      },
    }).values;
  } catch {
    process.stderr.write(USAGE);
    process.exit(2);
  }
}

const values = readArgs();
const dataDir = resolve(values["data-dir"] ?? process.env["SESSION_DATA_DIR"] ?? ".data");
try {
  const report = resetDatabase({
    dataDir,
    apply: values.yes,
    assumeStopped: values["assume-stopped"],
  });
  const verb = report.applied ? "deleted" : "would delete";
  process.stdout.write(
    report.stopped === "heartbeat"
      ? "no server heartbeat in the last 90 s\n"
      : report.stopped === "assumed"
        ? "no server_meta table: the server is taken as stopped (--assume-stopped)\n"
        : `no database at ${dataDir}/session.db\n`,
  );
  for (const path of report.paths) process.stdout.write(`${verb}  ${path}\n`);
  if (report.paths.length === 0) process.stdout.write(`nothing to delete in ${dataDir}\n`);
  if (!report.applied && report.paths.length > 0)
    process.stdout.write("run again with --yes to delete\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ResetRefusedError ? 1 : 3;
}
