// Recorded provider usage for daily limit tracking
// (`docs/02-domain-model-and-database.md` §3.7, `docs/06-auth-and-users.md`
// §8), and the usage ledger of the runs (`15-implementation-plan/
// 03-agents-and-research.md` K1): one row per provider call, opened when the
// call starts, checkpointed at most every 2 s and closed when it ends. The
// ledger columns are null on the per-call tool rows (`search`, `fetch`).

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Associated node ID, or null if not tied to a specific node. Foreign key is
     * omitted to preserve usage history upon thread deletion. */
    nodeId: text("node_id"),
    /** Event category. `run` tracks attempt starts for daily run limits; other
     * categories record token usage. */
    kind: text("kind", {
      enum: ["research", "metadata", "search", "fetch", "run", "title", "summary", "context"],
    }).notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costEstimateMicros: integer("cost_estimate_micros").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    /** The run and attempt a ledger row bills (`03` K1). */
    runId: text("run_id"),
    attempt: integer("attempt"),
    /** `included`, `key:anthropic` or `key:openai` (`03` K8). */
    payer: text("payer"),
    /** The ISO date of the Friday that starts the week the call counts in. */
    week: text("week"),
    /** `open` while the call streams; `closed` once it ended for any reason. */
    state: text("state", { enum: ["open", "closed"] }),
    /** How the call ended (`ledger.ts`, `CallEnding`); null while open. */
    ending: text("ending"),
    /** How much a cached input token counts (`03` K2). */
    cachedRatio: real("cached_ratio"),
    /** Input plus output, cached input at its ratio. */
    counted: integer("counted"),
    updatedAt: integer("updated_at"),
  },
  (table) => [
    index("usage_events_user_idx").on(table.userId, table.createdAt),
    index("usage_events_week_idx").on(table.userId, table.week, table.payer),
    index("usage_events_run_idx").on(table.runId, table.attempt),
    index("usage_events_state_idx").on(table.state),
  ],
);
