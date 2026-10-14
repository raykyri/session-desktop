// Image attachments pasted or dropped into a composer (the desktop's research
// image store, `src-tauri/src/research_images.rs`). The bytes live on the
// volume under `storage_path`; the row is the owner check and the metadata a
// `ResearchImageAttachment` carries.

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { trees } from "./trees.js";
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

/** What a reference holds an image from: a node's message, a draft, or a
 * queued follow-up's message. */
export const IMAGE_HOLDER_KINDS = ["node", "draft", "queue"] as const;
export type ImageHolderKind = (typeof IMAGE_HOLDER_KINDS)[number];

/**
 * One row per image a node, draft or queued follow-up names, written in the
 * same transaction as the message or draft (`repos/images.ts` `setRefs`,
 * `dropRefs`). It replaces reading image ids out of `message_json` and
 * `attachments_json`: who may see an image goes through `tree_id`, and an
 * image is needed while any row names it.
 *
 * `holder_id` is the node, draft or queue item id and has no foreign key (it
 * names a row of one of three tables); the repositories delete a holder's
 * rows with it, and the maintenance sweep drops rows whose holder is gone.
 * `tree_id` is the thread of a node or queued item, null for a draft.
 */
export const imageRefs = sqliteTable(
  "image_refs",
  {
    imageId: text("image_id")
      .notNull()
      .references(() => researchImages.id, { onDelete: "cascade" }),
    holderKind: text("holder_kind", { enum: IMAGE_HOLDER_KINDS }).notNull(),
    holderId: text("holder_id").notNull(),
    treeId: text("tree_id").references(() => trees.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.imageId, table.holderKind, table.holderId] }),
    index("image_refs_holder_idx").on(table.holderKind, table.holderId),
    index("image_refs_tree_idx").on(table.treeId),
  ],
);
