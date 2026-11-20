// Accounts and the sign-up controls that exist from day one but are switched
// on later (`docs/02-domain-model-and-database.md` §3.1,
// `docs/06-auth-and-users.md` §3).

import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    githubId: integer("github_id").notNull().unique(),
    login: text("login").notNull(),
    /** The person's handle in spaces (`member:<space>:<handle>`): the GitHub
     * login in lower case when the account was made, and never changed after,
     * so a GitHub rename does not move their records (phase 2a). */
    handle: text("handle").notNull().unique(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    /** Set manually (`npm run db:admin -- <login>`); there is no in-app
     * promotion. Unlocks the gated models and the admin user list. */
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    /** GitHub account creation time, for the account-age minimum. */
    githubCreatedAt: integer("github_created_at"),
    /** Salted hash of the sign-up IP; the raw address is never stored. */
    signupIpHash: text("signup_ip_hash"),
    invitedBy: text("invited_by").references((): AnySQLiteColumn => users.id, {
      onDelete: "set null",
    }),
    invitesRemaining: integer("invites_remaining").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    lastLoginAt: integer("last_login_at").notNull(),
  },
  (table) => [index("users_login_idx").on(table.login)],
);

export const invites = sqliteTable("invites", {
  code: text("code").primaryKey(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
  usedAt: integer("used_at"),
});

/** Per-IP sign-up attempts, the input to sign-up throttling. Deliberately
 * without a user reference: the interesting rows are the ones that never
 * became an account. */
export const signupAttempts = sqliteTable(
  "signup_attempts",
  {
    id: text("id").primaryKey(),
    ipHash: text("ip_hash").notNull(),
    attemptedAt: integer("attempted_at").notNull(),
    outcome: text("outcome").notNull(),
  },
  (table) => [index("signup_attempts_ip_idx").on(table.ipHash, table.attemptedAt)],
);

/** A person's own weekly allowance of included tokens (Monday 00:00 UTC to
 * the next Monday), set by an administrator. Null means the deployment's
 * default (`SESSION_INCLUDED_TOKENS`). There are no daily limits. */
export const userLimits = sqliteTable("user_limits", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  weeklyTokens: integer("weekly_tokens"),
  updatedAt: integer("updated_at").notNull(),
});
