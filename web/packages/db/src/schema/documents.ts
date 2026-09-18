// Attached documents: metadata, extracted text, and the join to the runs that
// carry them as context (`docs/02-domain-model-and-database.md` §3.6,
// `docs/04-agent-runtime.md` §8).

import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

import { nodes } from "./nodes.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    /** `/data/documents/<user_id>/<sha256>` on the volume. */
    storagePath: text("storage_path").notNull(),
    pageCount: integer("page_count"),
    extractionStatus: text("extraction_status", { enum: ["pending", "ok", "failed"] })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [unique("documents_user_sha_uq").on(table.userId, table.sha256)],
);

/** Extracted text, per page for PDFs and as page 0 for everything else. */
export const documentText = sqliteTable(
  "document_text",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    page: integer("page").notNull(),
    text: text("text").notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.page] })],
);

export const nodeDocuments = sqliteTable(
  "node_documents",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.nodeId, table.documentId] })],
);
