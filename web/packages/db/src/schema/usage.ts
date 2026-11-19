// Recorded provider usage (`docs/06-auth-and-users.md` §8), keyed by run
// (phase 2a): the daily limits, the admin's totals and the monthly usage by
// payer and space (`/api/me/usage`) are sums over it.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The run, or null for usage of no run. No foreign key: a run is a sync
     * record, and usage outlives a deleted thread. */
    runId: text("run_id"),
    /** The space of the run, for the usage by space. */
    spaceId: text("space_id"),
    /** Who paid: `session` (the included tokens) or an API key id. */
    payer: text("payer"),
    /** `run` marks an attempt's start, for the daily run limit; the others
     * record tokens. */
    kind: text("kind", { enum: ["research", "metadata", "search", "fetch", "run"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costEstimateMicros: integer("cost_estimate_micros").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("usage_events_user_idx").on(table.userId, table.createdAt),
    index("usage_events_payer_idx").on(table.userId, table.payer, table.createdAt),
  ],
);
