// Research threads (`docs/02-domain-model-and-database.md` §3.3).
//
// `root_node_id` carries no foreign key. The reference is circular —
// `nodes.tree_id` points back here — and SQLite can only break such a cycle
// with a `DEFERRABLE INITIALLY DEFERRED` constraint, which Drizzle cannot
// express. `trees.admitRoot` writes both rows in one transaction and is the
// only way a tree is created, so the invariant holds where it is enforced.

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const trees = sqliteTable(
  "trees",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
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
    /** Set while the thread is in the Trash. Every list but the Trash's own
     * leaves these threads out. */
    trashedAt: integer("trashed_at"),
    /** Who moved the thread to the Trash (its owner) while `trashed_at` is
     * set. */
    trashedBy: text("trashed_by").references(() => users.id, { onDelete: "set null" }),
    /** The thread this one is listed under on Home: the desktop folder
     * state's `parents` map. One level deep, enforced by the repository. */
    parentTreeId: text("parent_tree_id").references((): AnySQLiteColumn => trees.id, {
      onDelete: "set null",
    }),
    /** `public` threads are readable by anyone, guests included, and appear
     * in the All Users feed; `private` threads only by their owner and their
     * members (`repos/access.ts`). */
    visibility: text("visibility", { enum: ["private", "public"] })
      .notNull()
      .default("private"),
    /** Sidebar order within (`workspace_id`, `archived_at IS NULL`). New roots
     * insert at 0. */
    position: integer("position").notNull(),
    /** Set when the thread is deleted (Delete now, Empty Trash, removing its
     * workspace). From then on no query or access check sees it
     * (`repos/deletion.ts`), and the server's deletion job removes its rows
     * in bounded steps, then the row itself. */
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("trees_sidebar_idx").on(
      table.ownerId,
      table.workspaceId,
      table.archivedAt,
      table.trashedAt,
      table.position,
    ),
    index("trees_trash_idx").on(table.ownerId, table.trashedAt),
    index("trees_parent_idx").on(table.parentTreeId),
    index("trees_visibility_idx").on(table.visibility, table.updatedAt),
    index("trees_deleted_idx").on(table.deletedAt),
  ],
);

/** When each person last viewed each thread. A summary's unseen-update and
 * unseen-failure flags compare against this row, so they are per person
 * rather than per thread. */
export const treeViews = sqliteTable(
  "tree_views",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    lastViewedAt: integer("last_viewed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.treeId] }),
    index("tree_views_tree_idx").on(table.treeId),
  ],
);
