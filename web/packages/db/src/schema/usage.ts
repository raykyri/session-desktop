// Recorded provider usage, the input to the daily limits
// (`docs/02-domain-model-and-database.md` §3.7, `docs/06-auth-and-users.md`
// §8).

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null for usage not tied to a node (a metadata run for a workspace). The
     * reference is deliberately absent so deleting a thread does not erase the
     * account's usage history. */
    nodeId: text("node_id"),
    kind: text("kind", { enum: ["research", "metadata", "search", "fetch"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costEstimateMicros: integer("cost_estimate_micros").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("usage_events_user_idx").on(table.userId, table.createdAt)],
);
