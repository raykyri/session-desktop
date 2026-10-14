// The follow-up queue: questions asked at the end of an inline chain while
// it could not take one, sent in order as the chain frees up. It replaces the
// desktop's client-side queue (`state.rs` `ResearchQueueItem`), so it
// survives a reload and is shared by every tab.

import type { UserMessage } from "@session/shared";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { nodes } from "./nodes.js";
import { trees } from "./trees.js";
import { users } from "./users.js";

export const followupQueue = sqliteTable(
  "followup_queue",
  {
    id: text("id").primaryKey(),
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    /** The first node of the inline chain the item continues. */
    headNodeId: text("head_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** Who asked; the run is billed to them when the item is sent. */
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Attachments are resolved when the item is queued, not when it is sent. */
    messageJson: text("message_json", { mode: "json" }).$type<UserMessage>().notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    position: integer("position").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Why the last send was refused (a daily limit, an archived thread). The
     * queue waits on this item until it is retried or cancelled. */
    failedReason: text("failed_reason"),
  },
  (table) => [index("followup_queue_head_idx").on(table.headNodeId, table.position)],
);
