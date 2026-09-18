// Data migrations that SQL cannot express run as versioned TypeScript steps
// after `migrate()` and record themselves here
// (`docs/02-domain-model-and-database.md` §4).

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const backfills = sqliteTable("backfills", {
  id: text("id").primaryKey(),
  appliedAt: integer("applied_at").notNull(),
});
