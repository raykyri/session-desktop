// Image attachments pasted or dropped into a composer (the desktop's research
// image store, `src-tauri/src/research_images.rs`). The bytes live on the
// volume under `storage_path`; the row is the owner check and the metadata a
// `ResearchImageAttachment` carries.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const researchImages = sqliteTable(
  "research_images",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    fileName: text("file_name"),
    storagePath: text("storage_path").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Null until a node, a queued follow-up or a draft uses the image; the
     * sweep deletes images that stay unattached. */
    attachedAt: integer("attached_at"),
  },
  (table) => [
    index("research_images_owner_idx").on(table.ownerId, table.sha256),
    index("research_images_unattached_idx").on(table.attachedAt, table.createdAt),
  ],
);
