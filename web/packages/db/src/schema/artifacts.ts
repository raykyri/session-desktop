// Token-scoped access to a document from the artifact origin, which never
// sees the session cookie (`docs/11-artifacts-and-browser.md`).

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { documents } from "./documents.js";
import { users } from "./users.js";

export const artifactTokens = sqliteTable(
  "artifact_tokens",
  {
    /** 32 random bytes, hex. */
    token: text("token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("artifact_tokens_document_idx").on(table.documentId)],
);
