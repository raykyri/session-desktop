// Sidebar folders: a purely organizational grouping of trees inside one
// workspace (`docs/02-domain-model-and-database.md` §3.2, §5.11).

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { trees } from "./trees.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    collapsed: integer("collapsed", { mode: "boolean" }).notNull().default(false),
    /** Rank in the workspace's starred list, or 0. See `trees.starred`. */
    starred: integer("starred").notNull().default(0),
    position: integer("position").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("folders_workspace_idx").on(table.userId, table.workspaceId, table.position)],
);

/** One folder per tree, as in the desktop's `membership: HashMap<treeId,
 * folderId>`. Tree deletion cascades the membership away. */
export const treeFolderMembership = sqliteTable("tree_folder_membership", {
  treeId: text("tree_id")
    .primaryKey()
    .references(() => trees.id, { onDelete: "cascade" }),
  folderId: text("folder_id")
    .notNull()
    .references(() => folders.id, { onDelete: "cascade" }),
});
