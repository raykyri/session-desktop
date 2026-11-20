// Server-side sessions and the short-lived OAuth handshake state
// (`docs/06-auth-and-users.md` §1, §2).

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the cookie value, hex. The cookie itself is 32 random bytes
     * and is never stored, so a database read cannot impersonate anyone. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    /** Absolute expiry: 90 days from creation, never extended. */
    expiresAt: integer("expires_at").notNull(),
    /** Sliding idle expiry is `last_seen_at + 30 days`, written at most once
     * every 5 minutes so a busy tab does not write on every request. */
    lastSeenAt: integer("last_seen_at").notNull(),
    userAgent: text("user_agent"),
  },
  (table) => [index("sessions_user_idx").on(table.userId, table.lastSeenAt)],
);

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  createdAt: integer("created_at").notNull(),
  /** Same-origin path the callback returns to. */
  returnTo: text("return_to"),
});
