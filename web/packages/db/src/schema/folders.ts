// Folders and the per-person Home state around them
// (`docs/02-domain-model-and-database.md` §3.2, §5.11). Together these hold
// the desktop's `ResearchFolderState`: `folders`, `membership`, `collapsed`,
// `parents` (in `trees.parent_tree_id`) and `collapsedGroups`.

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { trees } from "./trees.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Set while the folder is in the Trash. Its trees keep their membership
     * and show as Unfiled until it is restored. */
    trashedAt: integer("trashed_at"),
  },
  (table) => [index("folders_workspace_idx").on(table.ownerId, table.workspaceId, table.position)],
);

/** Where a tree is filed: a folder, or a system place (`drafts`, the desktop's
 * `system:drafts`). One place per tree; a tree with no row is Unfiled. Tree
 * and folder deletion cascade the row away. */
export const treeFolderMembership = sqliteTable(
  "tree_folder_membership",
  {
    treeId: text("tree_id")
      .primaryKey()
      .references(() => trees.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => folders.id, { onDelete: "cascade" }),
    systemPlace: text("system_place", { enum: ["drafts"] }),
  },
  (table) => [
    index("tree_folder_membership_folder_idx").on(table.folderId),
    check(
      "tree_folder_membership_place_ck",
      sql`(${table.folderId} IS NULL) <> (${table.systemPlace} IS NULL)`,
    ),
  ],
);

/** Home trays a person has collapsed: a folder id or a `system:*` tray id. */
export const collapsedPlaces = sqliteTable(
  "collapsed_places",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    placeId: text("place_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.workspaceId, table.placeId] })],
);

/** Parent trees whose nested children a person has hidden on Home. */
export const collapsedGroups = sqliteTable(
  "collapsed_groups",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.treeId] }),
    index("collapsed_groups_tree_idx").on(table.treeId),
  ],
);
