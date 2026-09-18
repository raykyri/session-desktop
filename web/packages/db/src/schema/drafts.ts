// Client-side interface state that has to survive a reload on another device:
// composer drafts, mostly (`docs/02-domain-model-and-database.md` §3.1).

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const interfaceDrafts = sqliteTable(
  "interface_drafts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Opaque to the server; ≤ 128 bytes. */
    key: text("key").notNull(),
    /** ≤ 1 MiB. The desktop allowed 12 MiB because the value never left the
     * machine. */
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);
