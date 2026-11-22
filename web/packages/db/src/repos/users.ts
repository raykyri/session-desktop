// Accounts (plan `04` §3.1, `01` C8; `docs/06-auth-and-users.md` §1, §3).
//
// An account is found by its sign-in identity, `(provider,
// provider_user_id)`, and by nothing else: not by login, not by email. An
// identity belongs to one account for its lifetime; there is no second
// identity per account and no merge. A new identity becomes a `waiting`
// account with no handle; it becomes `active` when it redeems an invite at
// the profile step (`accountInvites.activate`).

import type { SignInProvider, User } from "@session/shared";
import { isAccountHandle } from "@session/shared";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { users } from "../schema/users.js";
import { now } from "../time.js";

export type UserRow = typeof users.$inferSelect;

/** What a provider reports about the person signing in. */
export interface ProviderIdentity {
  provider: SignInProvider;
  /** The provider's stable user id. */
  providerUserId: string;
  /** The provider's username. */
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  /** The provider's address for the person, or null when it returns none. */
  email?: string | null;
  /** When the provider account was created, for the account-age minimum. */
  providerCreatedAt?: number | null;
}

export interface SignupContext {
  /** Salted hash of the sign-up IP key. Recorded once, on creation. */
  signupIpHash?: string | null;
  /** The open invite the account redeems at the profile step. */
  pendingInviteId?: string | null;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatarUrl,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
    handle: row.handle,
    displayName: row.displayName,
    status: row.status,
    provider: row.provider,
  };
}

function profileFields(identity: ProviderIdentity, at: number) {
  return {
    login: identity.login,
    name: identity.name ?? null,
    avatarUrl: identity.avatarUrl ?? null,
    email: identity.email ?? null,
    lastLoginAt: at,
  };
}

/** The live (not deleted) account behind a sign-in identity. */
export function findByIdentity(
  db: SessionDatabase,
  provider: SignInProvider,
  providerUserId: string,
): User | null {
  const row = db
    .select()
    .from(users)
    .where(
      and(
        eq(users.provider, provider),
        eq(users.providerUserId, providerUserId),
        isNull(users.deletedAt),
      ),
    )
    .get();
  return row ? toUser(row) : null;
}

/**
 * Signs in an existing identity: refreshes what the provider reports (the
 * email included, on every sign-in, 05 §6 Q7) and the sign-in time. Answers
 * null when the identity has no account.
 */
export function refreshIdentity(db: SessionDatabase, identity: ProviderIdentity): User | null {
  const at = now();
  const row = db
    .update(users)
    .set({
      ...profileFields(identity, at),
      ...(identity.providerCreatedAt != null
        ? { providerCreatedAt: identity.providerCreatedAt }
        : {}),
    })
    .where(
      and(
        eq(users.provider, identity.provider),
        eq(users.providerUserId, identity.providerUserId),
        isNull(users.deletedAt),
      ),
    )
    .returning()
    .get();
  return row ? toUser(row) : null;
}

/**
 * Creates the waiting account of a new identity. If the identity got an
 * account in the meantime (two callbacks racing), that account is refreshed
 * and answered with `created: false`.
 */
export function createWaiting(
  db: SessionDatabase,
  identity: ProviderIdentity,
  context: SignupContext = {},
): { user: User; created: boolean } {
  return transact(db, (tx) => {
    const existing = refreshIdentity(tx, identity);
    if (existing) return { user: existing, created: false };
    const at = now();
    const row = tx
      .insert(users)
      .values({
        id: newId(),
        provider: identity.provider,
        providerUserId: identity.providerUserId,
        ...profileFields(identity, at),
        isAdmin: false,
        providerCreatedAt: identity.providerCreatedAt ?? null,
        signupIpHash: context.signupIpHash ?? null,
        invitedBy: null,
        status: "waiting",
        handle: null,
        displayName: null,
        pendingInviteId: context.pendingInviteId ?? null,
        createdAt: at,
      })
      .returning()
      .get();
    return { user: toUser(row), created: true };
  });
}

/**
 * An active account made directly, without an invite: the test sign-in
 * (`SESSION_TEST_AUTH`) and the repository tests. Production accounts
 * become active only through `accountInvites.activate`.
 */
export function createActive(
  db: SessionDatabase,
  identity: ProviderIdentity,
  profile: { handle: string; displayName?: string | null; invitedBy?: string | null },
): User {
  if (!isAccountHandle(profile.handle)) {
    throw new Error(`${profile.handle} is not a valid handle`);
  }
  const at = now();
  const row = db
    .insert(users)
    .values({
      id: newId(),
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      ...profileFields(identity, at),
      isAdmin: false,
      providerCreatedAt: identity.providerCreatedAt ?? null,
      invitedBy: profile.invitedBy ?? null,
      status: "active",
      handle: profile.handle,
      displayName: profile.displayName ?? identity.name ?? null,
      activatedAt: at,
      createdAt: at,
    })
    .returning()
    .get();
  return toUser(row);
}

export function findById(db: SessionDatabase, userId: string): User | null {
  const row = db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .get();
  return row ? toUser(row) : null;
}

/** The account holding `handle`, a deleted one included (the handle stays
 * taken). */
export function findByHandle(db: SessionDatabase, handle: string): User | null {
  const row = db.select().from(users).where(eq(users.handle, handle)).get();
  return row ? toUser(row) : null;
}

/** The active, not deleted account holding `handle`, or null. */
export function findActiveByHandle(db: SessionDatabase, handle: string): User | null {
  const row = db
    .select()
    .from(users)
    .where(and(eq(users.handle, handle), eq(users.status, "active"), isNull(users.deletedAt)))
    .get();
  return row ? toUser(row) : null;
}

/** Whether `handle` is well-formed and held by no account, deleted ones
 * included: handles are never reused (04 §3.1). */
export function handleAvailable(db: SessionDatabase, handle: string): boolean {
  return isAccountHandle(handle) && findByHandle(db, handle) === null;
}

/**
 * Sets `is_admin` on the active account with `handle`
 * (`npm run db:admin -- <handle>`, 04 I1, 05 §3.5). Handles are unique;
 * logins are not, so the handle is what an operator names.
 */
export function setAdminByHandle(db: SessionDatabase, handle: string, isAdmin: boolean): User {
  const row = db
    .update(users)
    .set({ isAdmin })
    .where(and(eq(users.handle, handle), eq(users.status, "active"), isNull(users.deletedAt)))
    .returning()
    .get();
  if (!row) {
    throw new Error(`No active account has the handle @${handle}.`);
  }
  return toUser(row);
}

/** Every live account, oldest first. */
export function listUsers(db: SessionDatabase): User[] {
  return db
    .select()
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all()
    .map(toUser);
}
