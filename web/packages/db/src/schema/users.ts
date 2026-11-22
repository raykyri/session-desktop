// Accounts, account invites and the sign-up controls (plan `04` §3.1,
// `01` C8; `docs/06-auth-and-users.md` §1, §3).

import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** `github` or `x`; with `provider_user_id`, the sign-in identity. Both
     * are null once the account is deleted, so the identity can sign in
     * again as a new account (04 I1). */
    provider: text("provider", { enum: ["github", "x"] }),
    /** The provider's stable user id, as text (GitHub's numeric id, X's
     * snowflake). */
    providerUserId: text("provider_user_id"),
    /** The provider's username. Shown nowhere and unique nowhere. */
    login: text("login").notNull(),
    /** The provider's display name. */
    name: text("name"),
    avatarUrl: text("avatar_url"),
    /** The address the provider returned at the last sign-in; never used to
     * match or merge accounts (05 §6 Q7). */
    email: text("email"),
    /** Set by `npm run db:admin -- <handle>`; there is no in-app promotion. */
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    /** Creation time of the provider account, for the account-age minimum. */
    providerCreatedAt: integer("provider_created_at"),
    /** Salted hash of the sign-up IP key; the raw address is never stored. */
    signupIpHash: text("signup_ip_hash"),
    invitedBy: text("invited_by").references((): AnySQLiteColumn => users.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: ["waiting", "active"] })
      .notNull()
      .default("waiting"),
    /** Unique, `^[a-z0-9._]{3,20}$`, null while waiting, never reused: a
     * deleted account keeps it. */
    handle: text("handle"),
    /** The name chosen at the profile step. */
    displayName: text("display_name"),
    /** The open invite a waiting account redeems at the profile step. */
    pendingInviteId: text("pending_invite_id").references((): AnySQLiteColumn => invites.id, {
      onDelete: "set null",
    }),
    /** When the account redeemed its invite and became active ("Joined"). */
    activatedAt: integer("activated_at"),
    /** Set by the account-deletion operator job. */
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    lastLoginAt: integer("last_login_at").notNull(),
  },
  (table) => [
    index("users_login_idx").on(table.login),
    uniqueIndex("users_identity_unique").on(table.provider, table.providerUserId),
    uniqueIndex("users_handle_unique").on(table.handle),
    index("users_status_idx").on(table.status, table.createdAt),
    index("users_invited_by_idx").on(table.invitedBy),
    check("users_provider_ck", sql`${table.provider} IN ('github', 'x')`),
    check("users_status_ck", sql`${table.status} IN ('waiting', 'active')`),
  ],
);

/**
 * Account invites (04 §3.1). The code is never stored in plain text:
 * `code_hash` is the SHA-256 of its canonical form, for lookup, and
 * `code_enc` is the code under AES-256-GCM (`SESSION_SECRET_KEY`), readable
 * only by its creator and nulled when the link is used or revoked. Root
 * invites (`db:admin -- --invite`) have no creator and no `code_enc`.
 */
export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    codeEnc: text("code_enc"),
    createdBy: text("created_by").references((): AnySQLiteColumn => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at").notNull(),
    usedBy: text("used_by").references((): AnySQLiteColumn => users.id, { onDelete: "set null" }),
    usedAt: integer("used_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("invites_code_hash_unique").on(table.codeHash),
    index("invites_created_by_idx").on(table.createdBy, table.createdAt),
  ],
);

/** Per-IP sign-up attempts, the input to sign-up throttling. Deliberately
 * without a user reference: the interesting rows are the ones that never
 * became an account. `outcome = 'waiting'` rows count the waiting accounts
 * an IP key made (04 §3.1, Z1). */
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

/** Per-member overrides of the deployment's limits. `weekly_tokens`: the
 * member's weekly allowance of included tokens in place of
 * `SESSION_WEEKLY_TOKENS` (plan `03` K3: a larger allowance is a row here,
 * not a role exemption); null means the deployment's. `extra_invites`:
 * account invites site admins gave the member on top of
 * `SESSION_INVITES_PER_MEMBER` (plan `04` I2); it only grows. */
export const userLimits = sqliteTable("user_limits", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  weeklyTokens: integer("weekly_tokens"),
  extraInvites: integer("extra_invites").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});
