// Saved passages of an answer (`docs/02-domain-model-and-database.md` §3.3,
// §5.5).

import type { ResearchHighlightAnchor } from "@session/shared";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { nodes } from "./nodes.js";
import { users } from "./users.js";

export const highlights = sqliteTable(
  "highlights",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    index("highlights_user_idx").on(table.userId, table.createdAt),
  ],
);
