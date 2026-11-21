// The privacy check after a removal (plan `04` P2, `05` M6;
// `runbooks/privacy-check.md`): `privacyCheck` over the server's database
// with its configured cursor keys. Prints one line per check and exits 1 when
// any fails.
//
// Usage, on the server's machine (`fly ssh console`), where the image holds
// the bundle:
//
//   node packages/server/dist/privacy-check.mjs --thread <id> --text "<removed text>"
//
// or from `web/packages/server` against a local database:
//
//   SESSION_DATA_DIR=<dir> npx tsx scripts/privacy-check.ts --thread <id> --text "<text>"
//
// The configuration is the server's (`loadConfig`): `SESSION_DATA_DIR` names
// the database, `SESSION_CURSOR_KEY` (and the previous key) seal the pull's
// cursor. `--db <path>` names another database file.

import { parseArgs } from "node:util";

import { loadConfig } from "../src/config.js";
import { privacyCheck } from "../src/ops/privacyCheck.js";

const { values } = parseArgs({
  options: {
    thread: { type: "string" },
    text: { type: "string" },
    db: { type: "string" },
    outsider: { type: "string" },
  },
});

if (!values.thread || !values.text) {
  process.stderr.write(
    'usage: privacy-check --thread <id> --text "<removed text>" [--db <path>] [--outsider <handle>]\n',
  );
  process.exit(2);
}

const config = loadConfig(process.env);
const report = privacyCheck({
  path: values.db ?? config.databasePath,
  thread: values.thread,
  text: values.text,
  cursorKeys: config.sync.cursorKeys,
  ...(values.outsider ? { outsider: values.outsider } : {}),
});
for (const c of report.checks)
  process.stdout.write(`${c.ok ? "pass" : "FAIL"}  ${c.name}${c.detail ? ` (${c.detail})` : ""}\n`);
process.stdout.write(report.ok ? "privacy check passed\n" : "privacy check FAILED\n");
process.exitCode = report.ok ? 0 : 1;
