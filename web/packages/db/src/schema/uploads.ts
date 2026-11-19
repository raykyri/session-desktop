// Uploaded images (phase 2a). An upload is its uploader's; one made for a
// space (`space_id`) is read by whoever may read that space's content, as the
// sync store's read rules decide (`server/src/uploads/route.ts`).

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The space it was uploaded for, or null: its uploader's only. */
    spaceId: text("space_id"),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    fileName: text("file_name"),
    storagePath: text("storage_path").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("uploads_user_idx").on(table.userId, table.createdAt)],
);
