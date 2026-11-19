// API keys (phase 2a). The key's record in `@session/sync`'s store (id, name,
// provider, status, cap) is what a client reads; this table holds the raw
// key, encrypted at rest with the configured key-encryption key
// (AES-256-GCM), and what the server shows with it. `fingerprint` is an HMAC
// of the raw key under the same configured key, so a duplicate is found
// without decrypting.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const apiKeys = sqliteTable(
  "api_keys",
  {
    /** The `apikey` record's id. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** base64url of iv (12 bytes), tag (16 bytes) and ciphertext. */
    rawEnc: text("raw_enc").notNull(),
    fingerprint: text("fingerprint").notNull(),
    mask: text("mask").notNull(),
    provider: text("provider").notNull(),
    /** Why the provider rejected it at the last check. */
    reason: text("reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    uniqueIndex("api_keys_fingerprint_idx").on(table.userId, table.fingerprint),
    index("api_keys_user_idx").on(table.userId, table.createdAt),
  ],
);
