// The embed asset cache behind tweet media
// (`docs/02-domain-model-and-database.md` §3.5).
//
// One row per remote image a hydrated snapshot points at — an avatar, a photo,
// a video poster, a link-card thumbnail. The row is the mapping from the hash
// in the snapshot's URL back to the origin URL, and it outlives the bytes: the
// sweep frees the volume by unlinking files and clearing `stored_at`, and the
// next request for that hash re-fetches from `source_url`. Shared across
// users, like `tweet_cache`, and holding nothing about who asked.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const embedAssets = sqliteTable(
  "embed_assets",
  {
    /** SHA-256 of `source_url`, hex. The path `/embeds/<hash>` a snapshot carries. */
    hash: text("hash").primaryKey(),
    sourceUrl: text("source_url").notNull(),
    /** The `Content-Type` the origin answered with; null until first fetched. */
    contentType: text("content_type"),
    /** Size of the stored file, 0 while nothing is on the volume. */
    bytes: integer("bytes").notNull(),
    /** When the bytes were written; null when they have never been fetched or
     * the sweep has since unlinked them. */
    storedAt: integer("stored_at"),
    /** Last time `/embeds/<hash>` served this asset. Drives eviction order. */
    lastAccessAt: integer("last_access_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("embed_assets_access_idx").on(table.lastAccessAt)],
);
