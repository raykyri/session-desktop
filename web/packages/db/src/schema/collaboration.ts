// Thread sharing (`docs/02-domain-model-and-database.md` §3.5).

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { folders } from "./folders.js";
import { trees } from "./trees.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const MEMBER_ROLES = ["commenter", "viewer"] as const;

/** People a thread is shared with. The owner is `trees.owner_id` and has no
 * row here. A member's Archive, Trash and folder filing are per person and
 * live on the member's row; the owner's are the tree's own columns. */
export const treeMembers = sqliteTable(
  "tree_members",
  {
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    /** Set while the thread is in this member's Archive. */
    archivedAt: integer("archived_at"),
    /** Set while the thread is in this member's Trash: it is listed only
     * there for them, and nothing changes for anyone else. */
    trashedAt: integer("trashed_at"),
    /** The member's workspace whose Trash lists the thread while
     * `trashed_at` is set: the one they moved it to the Trash from. Null
     * (and a workspace since deleted) is their default workspace. */
    trashWorkspaceId: text("trash_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    /** The member's own folder the thread is filed in; null is unfiled. */
    folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.treeId, table.userId] }),
    index("tree_members_user_idx").on(table.userId),
    index("tree_members_folder_idx").on(table.folderId),
  ],
);

/** An invitation to a thread, by GitHub login or by link. Only the token's
 * hash is stored. */
export const treeInvites = sqliteTable(
  "tree_invites",
  {
    id: text("id").primaryKey(),
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    githubLogin: text("github_login"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: integer("accepted_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    index("tree_invites_tree_idx").on(table.treeId),
    index("tree_invites_created_by_idx").on(table.createdBy, table.createdAt),
    // One pending login invitation per account and thread: inviting the same
    // login again renews it (`sharing.createInvite`).
    uniqueIndex("tree_invites_login_pending_uq")
      .on(table.treeId, sql`lower(${table.githubLogin})`)
      .where(
        sql`${table.githubLogin} IS NOT NULL AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`,
      ),
  ],
);

/** Follow: the threads a person gets notifications for. */
export const treeSubscriptions = sqliteTable(
  "tree_subscriptions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.treeId] }),
    index("tree_subscriptions_tree_idx").on(table.treeId),
  ],
);

/** People the owner removed from a thread. A link invitation created at or
 * before `removed_at` no longer admits them; an invitation created after it,
 * or a login invitation addressed to them, does, and deletes the row. */
export const treeMemberRemovals = sqliteTable(
  "tree_member_removals",
  {
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    removedBy: text("removed_by").references(() => users.id, { onDelete: "set null" }),
    removedAt: integer("removed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.treeId, table.userId] })],
);
