// Accounts (`docs/06-auth-and-users.md` §1, §3).

import type { User } from "@session/shared";
import { asc, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { users } from "../schema/users.js";
import { now } from "../time.js";

export type UserRow = typeof users.$inferSelect;

/** The fields the GitHub profile endpoint supplies that we keep. */
export interface GitHubProfile {
  githubId: number;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  /** `created_at` of the GitHub account, for the account-age minimum. */
  githubCreatedAt?: number | null;
}

export interface SignupContext {
  /** Salted hash of the sign-up IP. Recorded once, on the row's creation. */
  signupIpHash?: string | null;
  invitedBy?: string | null;
  invitesRemaining?: number;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatarUrl,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
  };
}

/**
 * Creates or refreshes the account behind a GitHub identity.
 *
 * `github_id` is the identity, not `login`: a user may rename their GitHub
 * account, and the rename must follow their data rather than fork it. The
 * sign-up context is written only on creation — the IP and inviter of an
 * existing account are historical facts.
 */
export function upsertFromGitHub(
  db: SessionDatabase,
  profile: GitHubProfile,
  context: SignupContext = {},
): { user: User; created: boolean } {
  return transact(db, (tx) => {
    const at = now();
    const existing = tx.select().from(users).where(eq(users.githubId, profile.githubId)).get();
    if (existing) {
      const updated = tx
        .update(users)
        .set({
          login: profile.login,
          name: profile.name ?? null,
          avatarUrl: profile.avatarUrl ?? null,
          githubCreatedAt: profile.githubCreatedAt ?? existing.githubCreatedAt,
          lastLoginAt: at,
        })
        .where(eq(users.id, existing.id))
        .returning()
        .get();
      return { user: toUser(updated), created: false };
    }
    const inserted = tx
      .insert(users)
      .values({
        id: newId(),
        githubId: profile.githubId,
        login: profile.login,
        name: profile.name ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        isAdmin: false,
        githubCreatedAt: profile.githubCreatedAt ?? null,
        signupIpHash: context.signupIpHash ?? null,
        invitedBy: context.invitedBy ?? null,
        invitesRemaining: context.invitesRemaining ?? 0,
        createdAt: at,
        lastLoginAt: at,
      })
      .returning()
      .get();
    return { user: toUser(inserted), created: true };
  });
}

export function findById(db: SessionDatabase, userId: string): User | null {
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  return row ? toUser(row) : null;
}

export function findByLogin(db: SessionDatabase, login: string): User | null {
  const row = db.select().from(users).where(eq(users.login, login)).get();
  return row ? toUser(row) : null;
}

export function findByGitHubId(db: SessionDatabase, githubId: number): User | null {
  const row = db.select().from(users).where(eq(users.githubId, githubId)).get();
  return row ? toUser(row) : null;
}

/** Flips `is_admin` by GitHub login, which is what an operator has in hand
 * (`npm run db:admin -- <login>`). */
export function setAdmin(db: SessionDatabase, login: string, isAdmin: boolean): User {
  const row = db.update(users).set({ isAdmin }).where(eq(users.login, login)).returning().get();
  if (!row) {
    throw new Error(`no account with the GitHub login ${login}`);
  }
  return toUser(row);
}

export function listUsers(db: SessionDatabase): User[] {
  return db.select().from(users).orderBy(asc(users.createdAt)).all().map(toUser);
}

/** Removes the account. Foreign keys cascade everything it owns; the caller
 * still has to delete the user's documents from the volume. */
export function removeUser(db: SessionDatabase, userId: string): boolean {
  const row = db.delete(users).where(eq(users.id, userId)).returning({ id: users.id }).get();
  return row !== undefined;
}

/** Grants invite codes to spend. Codes themselves live in `invites`. */
export function setInvitesRemaining(
  db: SessionDatabase,
  userId: string,
  invitesRemaining: number,
): void {
  db.update(users).set({ invitesRemaining }).where(eq(users.id, userId)).run();
}
