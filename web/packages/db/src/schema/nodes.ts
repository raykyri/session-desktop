// Research nodes: one question and its answer
// (`docs/02-domain-model-and-database.md` §3.3).

import type {
  ResearchHighlightAnchor,
  ResearchMessageAttachment,
  ResearchRecap,
} from "@session/shared";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { trees } from "./trees.js";
import { users } from "./users.js";

export const nodes = sqliteTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    /** `RESTRICT` rather than `CASCADE`: a subtree is removed child-first by
     * `nodes.removeBranch`, so an accidental parent delete is an error rather
     * than a silent loss of every descendant. */
    parentNodeId: text("parent_node_id").references((): AnySQLiteColumn => nodes.id, {
      onDelete: "restrict",
    }),
    /** True when this follow-up continues its parent's answer in the same
     * document. At most one per parent, enforced by `nodes_inline_child_uq`. */
    inline: integer("inline", { mode: "boolean" }).notNull().default(false),
    /** The bare question; the launch messages are assembled by the runtime. */
    prompt: text("prompt").notNull(),
    queryAnchorJson: text("query_anchor_json", { mode: "json" }).$type<ResearchHighlightAnchor>(),
    attachmentsJson: text("attachments_json", { mode: "json" })
      .$type<ResearchMessageAttachment[]>()
      .notNull()
      .default(sql`'[]'`),
    title: text("title"),
    responsePreview: text("response_preview"),
    /** Registry id from `@session/shared`'s model registry. */
    model: text("model").notNull(),
    kind: text("kind", { enum: ["run", "document"] })
      .notNull()
      .default("run"),
    origin: text("origin", { enum: ["imported"] }),
    status: text("status", {
      enum: ["queued", "running", "complete", "failed", "cancelled", "interrupted"],
    }).notNull(),
    error: text("error"),
    /** 1 for the first run; incremented by Retry and by auto-resume. */
    attempt: integer("attempt").notNull().default(1),
    /** Last persisted sequence number of the current attempt. Every
     * `run_turns` write and every status change bumps it in the same
     * transaction. */
    runSeq: integer("run_seq").notNull().default(0),
    resumePending: integer("resume_pending", { mode: "boolean" }).notNull().default(false),
    responseSnapshotAt: integer("response_snapshot_at"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    recapJson: text("recap_json", { mode: "json" }).$type<ResearchRecap>(),
  },
  (table) => [
    index("nodes_tree_idx").on(table.treeId, table.createdAt, table.id),
    index("nodes_status_idx").on(table.userId, table.status),
    index("nodes_parent_idx").on(table.parentNodeId),
    // One inline child per parent regardless of the child's status. A partial
    // unique index makes the check atomic, so two concurrent submissions
    // cannot both pass a read-then-write guard.
    uniqueIndex("nodes_inline_child_uq")
      .on(table.parentNodeId)
      .where(sql`${table.inline} = 1`),
  ],
);
