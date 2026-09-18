#!/usr/bin/env tsx
// `npm run db:admin -- <github login> [--revoke]` — the only way an account
// becomes an admin (`docs/06-auth-and-users.md` §3). Admin unlocks the gated
// model and the user list; there is no in-app promotion, so this runs against
// the volume.

import { resolve } from "node:path";

import { closeDatabase, openDatabase, users } from "../src/index.js";

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const login = args.find((argument) => !argument.startsWith("--"));
if (login === undefined) {
  process.stderr.write("usage: npm run db:admin -- <github login> [--revoke]\n");
  process.exit(1);
}

const dataDir = process.env["SESSION_DATA_DIR"];
const path = dataDir ? resolve(dataDir, "session.db") : resolve(".data/session.db");
const db = openDatabase(path);
try {
  const user = users.setAdmin(db, login, !revoke);
  process.stdout.write(
    `${user.login} is ${user.isAdmin ? "now an admin" : "no longer an admin"}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  closeDatabase(db);
}
