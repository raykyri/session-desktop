// Saved passages of an answer (`docs/02-domain-model-and-database.md` §3.3,
// §5.5). Highlights belong to the node, not to the person who made them:
// everyone who can read a thread sees its highlights.

import type { ResearchHighlightAnchor } from "@session/shared";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { nodes } from "./nodes.js";
import { users } from "./users.js";

export const highlights = sqliteTable(
  "highlights",
  {
    id: text("id").primaryKey(),
    /** Who saved the highlight; the account-wide storage quota is charged to
     * them. `SET NULL` so deleting an account keeps highlights in other
     * people's threads. */
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    anchorJson: text("anchor_json", { mode: "json" }).$type<ResearchHighlightAnchor>().notNull(),
    /** Denormalized from the anchor so the feed and the revision guard do not
     * have to parse JSON per row. */
    responseRevision: text("response_revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("highlights_node_idx").on(table.nodeId),
    index("highlights_author_idx").on(table.authorId, table.createdAt),
  ],
);
