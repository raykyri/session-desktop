// drizzle-kit configuration (`docs/02-domain-model-and-database.md` §4). The
// schema barrel is the single entry point drizzle-kit reads, and `migrations/`
// holds the generated SQL plus `meta/_journal.json`, both committed.
//
// `dbCredentials` points at the development database under `.data/`; the
// deployed database lives on the Fly volume and is migrated by
// `openDatabase()` at boot, not by the CLI.

import { defineConfig } from "drizzle-kit";

const url = process.env.SESSION_DATA_DIR
  ? `${process.env.SESSION_DATA_DIR}/session.db`
  : "./.data/session.db";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
