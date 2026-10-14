// Thread sharing. Phase 5 (collaboration) uses these tables; nothing reads or
// writes them yet. They are in the initial migration because the database is
// reset before the first deploy, which saves a second migration.

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { trees } from "./trees.js";
import { users } from "./users.js";

const MEMBER_ROLES = ["commenter", "viewer"] as const;

/** People a private thread is shared with. The owner is `trees.owner_id` and
 * has no row here. */
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
  },
  (table) => [
    primaryKey({ columns: [table.treeId, table.userId] }),
    index("tree_members_user_idx").on(table.userId),
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
  (table) => [index("tree_invites_tree_idx").on(table.treeId)],
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
