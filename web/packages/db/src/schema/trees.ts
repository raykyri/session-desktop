// Research threads (`docs/02-domain-model-and-database.md` §3.3).
//
// `root_node_id` carries no foreign key. The reference is circular —
// `nodes.tree_id` points back here — and SQLite can only break such a cycle
// with a `DEFERRABLE INITIALLY DEFERRED` constraint, which Drizzle cannot
// express. `trees.admitRoot` writes both rows in one transaction and is the
// only way a tree is created, so the invariant holds where it is enforced.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const trees = sqliteTable(
  "trees",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    rootNodeId: text("root_node_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
    lastViewedAt: integer("last_viewed_at"),
    followed: integer("followed", { mode: "boolean" }).notNull().default(false),
    bookmarked: integer("bookmarked", { mode: "boolean" }).notNull().default(false),
    /** Rank in the workspace's starred list, or 0 when not starred. A rank
     * rather than a flag because `ResearchFolderState.starred` is one ordered
     * sequence interleaving tree and folder ids, which two booleans cannot
     * round-trip; `folders.starred` uses the same numbering. */
    starred: integer("starred").notNull().default(0),
    /** Sidebar order within (`workspace_id`, `archived_at IS NULL`). New roots
     * insert at 0. */
    position: integer("position").notNull(),
  },
  (table) => [
    index("trees_sidebar_idx").on(
      table.userId,
      table.workspaceId,
      table.archivedAt,
      table.position,
    ),
    index("trees_updated_idx").on(table.userId, table.updatedAt),
  ],
);
