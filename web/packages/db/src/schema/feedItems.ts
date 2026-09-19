import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { journalEntries } from "./journal.js";
import { nodes } from "./nodes.js";
import { trees } from "./trees.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const feedItems = sqliteTable(
  "feed_items",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["journal", "research"] }).notNull(),
    occurredAt: integer("occurred_at").notNull(),
    sourceRank: integer("source_rank").notNull(),
    journalId: text("journal_id").references(() => journalEntries.id, { onDelete: "cascade" }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    treeId: text("tree_id").references(() => trees.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("feed_items_order_idx").on(
      desc(table.occurredAt),
      desc(table.sourceRank),
      desc(table.id),
    ),
    index("feed_items_author_idx").on(table.authorId, desc(table.occurredAt)),
    uniqueIndex("feed_items_journal_uq").on(table.journalId),
    uniqueIndex("feed_items_node_uq").on(table.nodeId),
  ],
);
