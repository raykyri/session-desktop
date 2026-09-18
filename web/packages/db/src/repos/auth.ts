// Sessions, the OAuth handshake, invite codes, sign-up attempts, and per-user
// limits (`docs/06-auth-and-users.md` §1, §2, §3, §8).

import { createHash, randomBytes } from "node:crypto";

import { and, count, eq, gte, isNull, lt, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { oauthStates, sessions } from "../schema/sessions.js";
import { invites, signupAttempts, userLimits, users } from "../schema/users.js";
import { now } from "../time.js";

/** Inactivity timeout duration after which a session is invalidated. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Maximum session lifetime regardless of user activity. */
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/** `Minimum interval between updates to `last_seen_at` to throttle write frequency during active reads. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** An OAuth state is single-use and short-lived. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** The cookie value: 32 random bytes, base64url. Never stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the `sessions` table stores in place of the cookie. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreatedSession {
  /** The row id — the hash. The caller sets the cookie to `token`. */
  id: string;
  token: string;
  expiresAt: number;
}

export function createSession(
  db: SessionDatabase,
  userId: string,
  options: { token?: string; userAgent?: string | null } = {},
): CreatedSession {
  const token = options.token ?? newSessionToken();
  const at = now();
  const expiresAt = at + SESSION_ABSOLUTE_MS;
  db.insert(sessions)
    .values({
      id: hashSessionToken(token),
      userId,
      createdAt: at,
      expiresAt,
      lastSeenAt: at,
      userAgent: options.userAgent ?? null,
    })
    .run();
  return { id: hashSessionToken(token), token, expiresAt };
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  expiresAt: number;
  lastSeenAt: number;
}

/**
 * Resolves a session by cookie value, checking idle and absolute expiration and refreshing activity timestamps. Expired sessions are deleted immediately inline upon lookup.
 */
export function readSession(db: SessionDatabase, token: string): AuthenticatedSession | null {
  const id = hashSessionToken(token);
  const at = now();
  return transact(db, (tx) => {
    const row = tx.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) {
      return null;
    }
    if (at >= row.expiresAt || at - row.lastSeenAt >= SESSION_IDLE_MS) {
      tx.delete(sessions).where(eq(sessions.id, id)).run();
      return null;
    }
    let lastSeenAt = row.lastSeenAt;
    if (at - row.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
      lastSeenAt = at;
      tx.update(sessions).set({ lastSeenAt }).where(eq(sessions.id, id)).run();
    }
    return { sessionId: row.id, userId: row.userId, expiresAt: row.expiresAt, lastSeenAt };
  });
}

export function deleteSession(db: SessionDatabase, token: string): boolean {
  const row = db
    .delete(sessions)
    .where(eq(sessions.id, hashSessionToken(token)))
    .returning({ id: sessions.id })
    .get();
  return row !== undefined;
}

export function deleteUserSessions(db: SessionDatabase, userId: string): number {
  return db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id }).all()
    .length;
}

/** Sweeps rows past either expiry. Safe to run at any time. */
export function deleteExpiredSessions(db: SessionDatabase, at: number = now()): number {
  return db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} <= ${at} OR ${sessions.lastSeenAt} <= ${at - SESSION_IDLE_MS}`)
    .returning({ id: sessions.id })
    .all().length;
}

export function createOAuthState(
  db: SessionDatabase,
  input: { state: string; codeVerifier: string; returnTo?: string | null },
): void {
  db.insert(oauthStates)
    .values({
      state: input.state,
      codeVerifier: input.codeVerifier,
      createdAt: now(),
      returnTo: input.returnTo ?? null,
    })
    .run();
}

/**
 * Retrieves and atomically consumes an OAuth state record, returning null if missing or expired to prevent replay attacks.
 */
export function consumeOAuthState(
  db: SessionDatabase,
  state: string,
): { codeVerifier: string; returnTo: string | null } | null {
  const at = now();
  return transact(db, (tx) => {
    const row = tx.delete(oauthStates).where(eq(oauthStates.state, state)).returning().get();
    if (!row || at - row.createdAt > OAUTH_STATE_TTL_MS) {
      return null;
    }
    return { codeVerifier: row.codeVerifier, returnTo: row.returnTo };
  });
}

/** Drops handshake rows abandoned past the TTL. */
export function deleteExpiredOAuthStates(db: SessionDatabase, at: number = now()): number {
  return db
    .delete(oauthStates)
    .where(lt(oauthStates.createdAt, at - OAUTH_STATE_TTL_MS))
    .returning({ state: oauthStates.state })
    .all().length;
}

/** Generates invite codes and decrements the creator's remaining invite quota within a single transaction to prevent race conditions. System operator codes (where `createdBy` is null) bypass quota limits. */
export function createInvites(
  db: SessionDatabase,
  createdBy: string | null,
  requested: number,
): string[] {
  if (requested <= 0) {
    return [];
  }
  return transact(db, (tx) => {
    let allowed = requested;
    if (createdBy !== null) {
      const owner = tx.select().from(users).where(eq(users.id, createdBy)).get();
      if (!owner) {
        throw new Error("the inviting account was not found");
      }
      allowed = Math.min(requested, owner.invitesRemaining);
      if (allowed <= 0) {
        return [];
      }
      tx.update(users)
        .set({ invitesRemaining: owner.invitesRemaining - allowed })
        .where(eq(users.id, createdBy))
        .run();
    }
    const at = now();
    const codes: string[] = [];
    for (let index = 0; index < allowed; index += 1) {
      const code = randomBytes(9).toString("base64url");
      tx.insert(invites)
        .values({ code, createdBy, createdAt: at, usedBy: null, usedAt: null })
        .run();
      codes.push(code);
    }
    return codes;
  });
}

/** Marks a code used by `userId`. Returns false when the code is unknown or
 * already spent; the update's `used_by IS NULL` predicate makes the check and
 * the claim one statement. */
export function redeemInvite(db: SessionDatabase, code: string, userId: string): boolean {
  const row = db
    .update(invites)
    .set({ usedBy: userId, usedAt: now() })
    .where(and(eq(invites.code, code), isNull(invites.usedBy)))
    .returning({ code: invites.code })
    .get();
  return row !== undefined;
}

export function listInvites(
  db: SessionDatabase,
  createdBy: string,
): (typeof invites.$inferSelect)[] {
  return db.select().from(invites).where(eq(invites.createdBy, createdBy)).all();
}

export function recordSignupAttempt(
  db: SessionDatabase,
  ipHash: string,
  outcome: string,
  at: number = now(),
): void {
  db.insert(signupAttempts)
    .values({ id: randomBytes(12).toString("hex"), ipHash, attemptedAt: at, outcome })
    .run();
}

/** Attempts from one IP since `since`, the input to per-IP throttling. */
export function countSignupAttempts(db: SessionDatabase, ipHash: string, since: number): number {
  const row = db
    .select({ value: count() })
    .from(signupAttempts)
    .where(and(eq(signupAttempts.ipHash, ipHash), gte(signupAttempts.attemptedAt, since)))
    .get();
  return row?.value ?? 0;
}

export interface UserDailyLimits {
  dailyTokens: number | null;
  dailyRuns: number | null;
}

/** Per-account overrides, or null when the deployment defaults apply. */
export function getUserLimits(db: SessionDatabase, userId: string): UserDailyLimits | null {
  const row = db.select().from(userLimits).where(eq(userLimits.userId, userId)).get();
  return row ? { dailyTokens: row.dailyTokens, dailyRuns: row.dailyRuns } : null;
}

export function setUserLimits(
  db: SessionDatabase,
  userId: string,
  limits: Partial<UserDailyLimits>,
): UserDailyLimits {
  const at = now();
  const row = db
    .insert(userLimits)
    .values({
      userId,
      dailyTokens: limits.dailyTokens ?? null,
      dailyRuns: limits.dailyRuns ?? null,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: userLimits.userId,
      set: {
        dailyTokens: limits.dailyTokens ?? null,
        dailyRuns: limits.dailyRuns ?? null,
        updatedAt: at,
      },
    })
    .returning()
    .get();
  return { dailyTokens: row.dailyTokens, dailyRuns: row.dailyRuns };
}
