// Research nodes (`docs/02-domain-model-and-database.md` §3.3). One row per
// node of the desktop's envelope: a post (a note or a saved link), an
// exchange (a question and the run that answers it), or a document (an
// imported report or an authored document). `repos/mappers.ts` turns a row
// into the wire `ResearchNode`.

import type { NodeAnchor, ResearchRecap, UserMessage } from "@session/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { trees } from "./trees.js";
import { users } from "./users.js";

const NODE_TYPES = ["post", "exchange", "document"] as const;

/** The statuses a run can be stored with: the wire `ResearchNodeStatus`.
 * The web loop never writes the desktop's `starting` (it has no process to
 * spawn); `interrupted` is the web's: a deploy or crash stopped an admitted
 * run that the server resumes. */
const NODE_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export const nodes = sqliteTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    /** `RESTRICT` rather than `CASCADE`: a subtree is removed child-first by
     * `nodes.removeBranch`, so an accidental parent delete is an error rather
     * than a silent loss of every descendant. */
    parentNodeId: text("parent_node_id").references((): AnySQLiteColumn => nodes.id, {
      onDelete: "restrict",
    }),
    /** Who wrote the node. Access goes through the tree's owner (and, from
     * phase 5, its members), not through this column. `SET NULL` so deleting
     * an account does not delete content in other people's threads. */
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    /** True when this follow-up continues its parent's conversation in the
     * same messages column. At most one per parent, enforced by
     * `nodes_inline_child_uq`. */
    inline: integer("inline", { mode: "boolean" }).notNull().default(false),
    type: text("type", { enum: NODE_TYPES }).notNull(),
    /** What the person wrote: a post's text, an exchange's question, or the
     * question an imported report answers. Null for an authored document. */
    messageJson: text("message_json", { mode: "json" }).$type<UserMessage>(),
    /** The passage of the parent this follow-up was asked about. */
    anchorJson: text("anchor_json", { mode: "json" }).$type<NodeAnchor>(),
    /** Posts only: `link` when the text is one http(s) URL. */
    format: text("format", { enum: ["text", "link"] }),
    /** Documents only. */
    source: text("source", { enum: ["imported", "authored", "transcript"] }),
    /** The AgentSpec: a registry model id and a reasoning effort. An
     * exchange's own agent, or the default for a post's or document's AI
     * follow-ups. A null effort means the model's default. */
    model: text("model"),
    effort: text("effort"),
    title: text("title"),
    responsePreview: text("response_preview"),
    /** Exchanges only; null for posts and documents (`nodes_status_ck`). */
    status: text("status", { enum: NODE_RUN_STATUSES }),
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
    /** When a post's text or a document's body was last replaced by an edit. */
    editedAt: integer("edited_at"),
    /** Who made that edit. Unused until phase 5 (collaboration). */
    editedBy: text("edited_by").references(() => users.id, { onDelete: "set null" }),
    /** On the first node of an inline chain: the display order of the chain's
     * node ids, set by reordering the messages column. Null: oldest first. */
    chainOrderJson: text("chain_order_json", { mode: "json" }).$type<string[]>(),
    recapJson: text("recap_json", { mode: "json" }).$type<ResearchRecap>(),
  },
  (table) => [
    index("nodes_tree_idx").on(table.treeId, table.createdAt, table.id),
    index("nodes_status_idx").on(table.status),
    index("nodes_parent_idx").on(table.parentNodeId),
    index("nodes_author_idx").on(table.authorId),
    // One inline child per parent regardless of the child's status. A partial
    // unique index makes the check atomic, so two concurrent submissions
    // cannot both pass a read-then-write guard.
    uniqueIndex("nodes_inline_child_uq")
      .on(table.parentNodeId)
      .where(sql`${table.inline} = 1`),
    check("nodes_status_ck", sql`(${table.type} = 'exchange') = (${table.status} IS NOT NULL)`),
    check("nodes_format_ck", sql`(${table.type} = 'post') = (${table.format} IS NOT NULL)`),
    check("nodes_source_ck", sql`(${table.type} = 'document') = (${table.source} IS NOT NULL)`),
    check("nodes_message_ck", sql`${table.type} = 'document' OR ${table.messageJson} IS NOT NULL`),
    check("nodes_model_ck", sql`${table.type} <> 'exchange' OR ${table.model} IS NOT NULL`),
  ],
);
