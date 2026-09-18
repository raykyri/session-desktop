// Everything about an attempt in flight: its committed turns, its per-attempt
// record, its canonical messages, its context summary, and its place in the
// admission queue (`docs/02-domain-model-and-database.md` §3.3,
// `docs/05-run-lifecycle-and-streaming.md` §2, §5, §8).

import type { Turn } from "@session/shared";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { AttemptUsage, NodeMessage } from "../json.js";

import { nodes } from "./nodes.js";
import { users } from "./users.js";

/** Live output of an active attempt. Deleted when the final snapshot commits,
 * so the table holds only what is streaming at this moment. */
export const runTurns = sqliteTable(
  "run_turns",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    turnId: text("turn_id").notNull(),
    position: integer("position").notNull(),
    turnJson: text("turn_json", { mode: "json" }).$type<Turn>().notNull(),
    /** 0 for the single in-flight checkpoint row of an attempt. */
    committed: integer("committed", { mode: "boolean" }).notNull(),
    /** Node sequence number at which this row was written. */
    seq: integer("seq").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.attempt, table.turnId] }),
    index("run_turns_order_idx").on(table.nodeId, table.attempt, table.position),
  ],
);

export const runAttempts = sqliteTable(
  "run_attempts",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    kind: text("kind", { enum: ["fresh", "resume"] }).notNull(),
    model: text("model").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    outcome: text("outcome"),
    errorClass: text("error_class"),
    steps: integer("steps").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    usageJson: text("usage_json", { mode: "json" }).$type<AttemptUsage>(),
    costEstimateMicros: integer("cost_estimate_micros"),
  },
  (table) => [primaryKey({ columns: [table.nodeId, table.attempt] })],
);

/** The canonical conversation the app owns (`docs/04-agent-runtime.md` §4).
 * Append-only: written once when a node completes, never updated. */
export const nodeMessages = sqliteTable(
  "node_messages",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    messageJson: text("message_json", { mode: "json" }).$type<NodeMessage>().notNull(),
    /** Which model produced an assistant message, so a cross-model fork knows
     * to drop its reasoning metadata. */
    model: text("model"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.nodeId, table.position] })],
);

/** Context compaction cache: one summary standing in for everything up to
 * `covers_through_node_id`. */
export const nodeSummaries = sqliteTable("node_summaries", {
  nodeId: text("node_id")
    .primaryKey()
    .references(() => nodes.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  coversThroughNodeId: text("covers_through_node_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Admission control. A row exists from the moment a node is queued until the
 * server claims it; `not_before` holds a re-queued node back after a 429. */
export const runQueue = sqliteTable(
  "run_queue",
  {
    nodeId: text("node_id")
      .primaryKey()
      .references(() => nodes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pool: text("pool", { enum: ["research", "metadata"] }).notNull(),
    provider: text("provider").notNull(),
    enqueuedAt: integer("enqueued_at").notNull(),
    claimedAt: integer("claimed_at"),
    notBefore: integer("not_before"),
  },
  (table) => [index("run_queue_claim_idx").on(table.pool, table.claimedAt, table.enqueuedAt)],
);
