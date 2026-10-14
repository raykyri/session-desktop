// Widget artifacts: the revisions of each `session-widget` block an answer
// produced, and each reader's saved inputs for a revision (the desktop's
// research artifact store, `src-tauri/src/research_artifacts.rs`).

import { foreignKey, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { nodes } from "./nodes.js";
import { trees } from "./trees.js";
import { users } from "./users.js";

/** The desktop's `ArtifactState`: whether the saved inputs are applied, and
 * the value the widget reported. */
export interface WidgetStateValue {
  enabled: boolean;
  value?: unknown;
}

export const widgetRevisions = sqliteTable(
  "widget_revisions",
  {
    treeId: text("tree_id")
      .notNull()
      .references(() => trees.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id").notNull(),
    /** The revision's content hash, as the desktop names it. */
    revision: text("revision").notNull(),
    /** The node whose answer holds the block. */
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    title: text("title").notNull(),
    contentHash: text("content_hash").notNull(),
    parentRevision: text("parent_revision"),
    html: text("html").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.treeId, table.artifactId, table.revision] }),
    // The cascade from `nodes`: without it every node delete scans the table.
    index("widget_revisions_node_idx").on(table.nodeId),
  ],
);

/** Saved widget inputs, per person and per revision. */
export const widgetState = sqliteTable(
  "widget_state",
  {
    treeId: text("tree_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    revision: text("revision").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stateJson: text("state_json", { mode: "json" }).$type<WidgetStateValue>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.treeId, table.artifactId, table.revision, table.userId] }),
    foreignKey({
      columns: [table.treeId, table.artifactId, table.revision],
      foreignColumns: [
        widgetRevisions.treeId,
        widgetRevisions.artifactId,
        widgetRevisions.revision,
      ],
      name: "widget_state_revision_fk",
    }).onDelete("cascade"),
  ],
);
