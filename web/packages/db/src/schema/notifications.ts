// The notification inbox (`docs/02-domain-model-and-database.md` §3.5,
// `03-api-and-events.md` §2 `notifications`). Web only: every
// `notification.requested` the server sends is also stored here for its
// recipient, so it can be read after the toast is gone or when no
// connection was open.

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { trees } from "./trees.js";
import { users } from "./users.js";

export const NOTIFICATION_KINDS = ["runFinished", "followUp", "branch", "invite"] as const;

export const NOTIFICATION_TONES = ["info", "success", "warning", "error"] as const;

export const notifications = sqliteTable(
  "notifications",
  {
    /** The id the `notification.requested` event carried. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    tone: text("tone", { enum: NOTIFICATION_TONES }).notNull(),
    /** The thread it is about; deleting the thread deletes its
     * notifications, whose links would lead nowhere. */
    treeId: text("tree_id").references(() => trees.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** The in-app path it opens, or null. */
    href: text("href"),
    createdAt: integer("created_at").notNull(),
    /** Null while unread. */
    readAt: integer("read_at"),
  },
  (table) => [
    index("notifications_user_created_idx").on(table.userId, table.createdAt, table.id),
    index("notifications_user_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} IS NULL`),
    index("notifications_tree_idx").on(table.treeId),
  ],
);
