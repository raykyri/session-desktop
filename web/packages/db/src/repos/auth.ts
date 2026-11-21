// Sessions, the OAuth handshake, sign-up attempts, and per-user limits
// (`docs/06-auth-and-users.md` §1, §2, §3, §8). Account invites are
// `accountInvites.ts`.

import { createHash, randomBytes } from "node:crypto";

import { and, count, eq, gte, lt, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { oauthStates, sessions } from "../schema/sessions.js";
import { signupAttempts, userLimits } from "../schema/users.js";
import { now } from "../time.js";

/** Inactivity timeout duration after which a session is invalidated. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Maximum session lifetime regardless of user activity. */
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/** Minimum interval between updates to `last_seen_at` to throttle write frequency during active reads. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** Time-to-live for single-use OAuth state parameters. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Generates a 32-byte base64url session token for the cookie value. Never persisted in plaintext. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Computes the SHA-256 hash of a session token for storage in the `sessions` table. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreatedSession {
  /** The session ID (SHA-256 token hash). The caller sets the cookie to `token`. */
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
 * Resolves a session by cookie value, checking idle and absolute expiration and refreshing activity timestamps. Expired sessions are deleted inline during lookup.
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

/**
 * Checks whether session `sessionId` exists and is within both idle and
 * absolute expiration limits at `at`. Read-only: does not update
 * `last_seen_at` or delete expired rows.
 */
export function sessionIsLive(db: SessionDatabase, sessionId: string, at: number = now()): boolean {
  const row = db
    .select({ expiresAt: sessions.expiresAt, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  return row !== undefined && at < row.expiresAt && at - row.lastSeenAt < SESSION_IDLE_MS;
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

/** Deletes sessions that have exceeded either idle or absolute expiration limits. */
export function deleteExpiredSessions(db: SessionDatabase, at: number = now()): number {
  return db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} <= ${at} OR ${sessions.lastSeenAt} <= ${at - SESSION_IDLE_MS}`)
    .returning({ id: sessions.id })
    .all().length;
}

export interface OAuthStateInput {
  state: string;
  codeVerifier: string;
  returnTo?: string | null;
  /** The provider the handshake is for (`github`, `x`). */
  provider?: string | null;
  /** SHA-256 of the account invite code, never the code (04 §3.1). */
  codeHash?: string | null;
}

export function createOAuthState(db: SessionDatabase, input: OAuthStateInput): void {
  db.insert(oauthStates)
    .values({
      state: input.state,
      codeVerifier: input.codeVerifier,
      createdAt: now(),
      returnTo: input.returnTo ?? null,
      provider: input.provider ?? null,
      codeHash: input.codeHash ?? null,
    })
    .run();
}

export interface ConsumedOAuthState {
  codeVerifier: string;
  returnTo: string | null;
  provider: string | null;
  codeHash: string | null;
}

/**
 * Retrieves and atomically consumes an OAuth state record, returning null if missing or expired to prevent replay attacks.
 */
export function consumeOAuthState(db: SessionDatabase, state: string): ConsumedOAuthState | null {
  const at = now();
  return transact(db, (tx) => {
    const row = tx.delete(oauthStates).where(eq(oauthStates.state, state)).returning().get();
    if (!row || at - row.createdAt > OAUTH_STATE_TTL_MS) {
      return null;
    }
    return {
      codeVerifier: row.codeVerifier,
      returnTo: row.returnTo,
      provider: row.provider,
      codeHash: row.codeHash,
    };
  });
}

/** Deletes expired OAuth state records exceeding the TTL. */
export function deleteExpiredOAuthStates(db: SessionDatabase, at: number = now()): number {
  return db
    .delete(oauthStates)
    .where(lt(oauthStates.createdAt, at - OAUTH_STATE_TTL_MS))
    .returning({ state: oauthStates.state })
    .all().length;
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

/** Retention duration for sign-up attempt records used in abuse detection. */
export const SIGNUP_ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Deletes sign-up attempts recorded before timestamp `before`, returning the count of deleted rows. */
export function deleteSignupAttemptsBefore(db: SessionDatabase, before: number): number {
  return db
    .delete(signupAttempts)
    .where(lt(signupAttempts.attemptedAt, before))
    .returning({ id: signupAttempts.id })
    .all().length;
}

/** Returns the count of sign-up attempts from `ipHash` since timestamp
 * `since`, of one `outcome` when given, for rate-limiting. */
export function countSignupAttempts(
  db: SessionDatabase,
  ipHash: string,
  since: number,
  outcome?: string,
): number {
  const row = db
    .select({ value: count() })
    .from(signupAttempts)
    .where(
      and(
        eq(signupAttempts.ipHash, ipHash),
        gte(signupAttempts.attemptedAt, since),
        outcome === undefined ? undefined : eq(signupAttempts.outcome, outcome),
      ),
    )
    .get();
  return row?.value ?? 0;
}

export interface UserDailyLimits {
  dailyTokens: number | null;
  dailyRuns: number | null;
}

/** Returns user daily limit overrides, or null if deployment defaults apply. */
export function getUserLimits(db: SessionDatabase, userId: string): UserDailyLimits | null {
  const row = db.select().from(userLimits).where(eq(userLimits.userId, userId)).get();
  return row ? { dailyTokens: row.dailyTokens, dailyRuns: row.dailyRuns } : null;
}

/**
 * Updates specified user daily limits. Passing null resets a limit to
 * deployment defaults, while undefined preserves existing overrides.
 */
export function setUserLimits(
  db: SessionDatabase,
  userId: string,
  limits: Partial<UserDailyLimits>,
): UserDailyLimits {
  const at = now();
  const changed: Partial<UserDailyLimits> & { updatedAt: number } = { updatedAt: at };
  if (limits.dailyTokens !== undefined) changed.dailyTokens = limits.dailyTokens;
  if (limits.dailyRuns !== undefined) changed.dailyRuns = limits.dailyRuns;
  const row = db
    .insert(userLimits)
    .values({
      userId,
      dailyTokens: limits.dailyTokens ?? null,
      dailyRuns: limits.dailyRuns ?? null,
      updatedAt: at,
    })
    .onConflictDoUpdate({ target: userLimits.userId, set: changed })
    .returning()
    .get();
  return { dailyTokens: row.dailyTokens, dailyRuns: row.dailyRuns };
}
