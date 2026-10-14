// The materialized Home feed: one row per root node of a thread that is not
// archived (`docs/02-domain-model-and-database.md` §5.9). Written by
// `repos/feedgen.ts`; the All Users feed joins `trees.visibility = 'public'`.

import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    occurredAt: integer("occurred_at").notNull(),
    sourceRank: integer("source_rank").notNull(),
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
    uniqueIndex("feed_items_node_uq").on(table.nodeId),
    index("feed_items_tree_idx").on(table.treeId),
  ],
);
