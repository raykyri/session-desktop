// Workspaces: the desktop's research-scoped `GroupInfo`
// (`docs/02-domain-model-and-database.md` §3.2).

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("workspaces_user_idx").on(table.userId, table.position)],
);
