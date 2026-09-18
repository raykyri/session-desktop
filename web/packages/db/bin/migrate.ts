#!/usr/bin/env tsx
// `npm run db:migrate [path]` — applies the committed migrations to a
// database. `openDatabase()` does this at boot as well
// (`docs/02-domain-model-and-database.md` §4); this is for a volume an
// operator is preparing by hand, and for CI checking that the migrations
// apply from empty.
//
// The path is the argument, else `$SESSION_DATA_DIR/session.db`, else
// `.data/session.db` beside the package.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { UnknownMigrationError, closeDatabase, openDatabase } from "../src/index.js";

function databasePath(): string {
  const [argument] = process.argv.slice(2);
  if (argument !== undefined && argument !== "") {
    return resolve(argument);
  }
  const dataDir = process.env["SESSION_DATA_DIR"];
  return dataDir ? resolve(dataDir, "session.db") : resolve(".data/session.db");
}

const path = databasePath();
mkdirSync(dirname(path), { recursive: true });
try {
  const db = openDatabase(path);
  closeDatabase(db);
  process.stdout.write(`migrated ${path}\n`);
} catch (error) {
  if (error instanceof UnknownMigrationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  throw error;
}
