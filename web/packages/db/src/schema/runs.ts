// The run pipeline's own tables (phase 2a). A run itself (its status, its
// answer, its turns) is a record of `@session/sync`'s store; these tables
// hold what only the server's job runner needs: the queue of runs a server
// job will run, and one row per attempt of it. No text is kept here, so a
// removal in the sync store erases everything of a run's text.

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { AttemptUsage } from "../json.js";

import { users } from "./users.js";

/** Admission control: a row exists from the moment the effect worker hands
 * the run to the job runner until the run ends. `claimed_at` is set while an
 * attempt runs; `not_before` holds a run back after a 429; `resumes` counts
 * the automatic resumes after a restart; `seq` is the last in-flight event
 * number written, so a resumed attempt continues past it. */
export const runQueue = sqliteTable(
  "run_queue",
  {
    runId: text("run_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    enqueuedAt: integer("enqueued_at").notNull(),
    claimedAt: integer("claimed_at"),
    notBefore: integer("not_before"),
    resumes: integer("resumes").notNull().default(0),
    seq: integer("seq").notNull().default(0),
  },
  (table) => [index("run_queue_claim_idx").on(table.claimedAt, table.enqueuedAt)],
);

/** One attempt of a server job's run: when it ran, how it ended, what it
 * used and who paid. */
export const runAttempts = sqliteTable(
  "run_attempts",
  {
    runId: text("run_id").notNull(),
    n: integer("n").notNull(),
    kind: text("kind", { enum: ["fresh", "resume"] }).notNull(),
    model: text("model").notNull(),
    /** `session` (the included tokens) or an API key id. */
    payer: text("payer"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    outcome: text("outcome"),
    errorClass: text("error_class"),
    steps: integer("steps").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    usageJson: text("usage_json", { mode: "json" }).$type<AttemptUsage>(),
    costEstimateMicros: integer("cost_estimate_micros"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.n] })],
);
