// Account invites, redemption and the invite tree (plan `04` I1-I4, `01` C8).
//
// A code is stored as the SHA-256 of its canonical form (`code_hash`, the
// lookup key) and, for its creator, encrypted (`code_enc`, made by the
// caller's `encrypt`, since the key is the server's). Nothing stores the
// plain code. An invite is open while it is neither used nor revoked; every
// failure to find an open invite is the same answer, so a probe cannot tell
// a used code from a revoked or made-up one (04 §13).
//
// Redemption is two steps. The code is checked and remembered on the waiting
// account (`users.pending_invite_id`, set by the OAuth callback or by
// `setPendingInvite`); `activate` then marks the invite used, sets the
// handle and makes the account active in one immediate transaction, with the
// invite's update conditional on it still being open. Two accounts holding
// the same pending invite race on that update and exactly one wins.

import { createHash, randomInt } from "node:crypto";

import type { Inviter, InviteCheck, User } from "@session/shared";
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  cleanDisplayName,
  formatInviteCode,
  isAccountHandle,
  parseInviteCode,
} from "@session/shared";
import { and, asc, count, desc, eq, isNotNull, isNull, or } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { invites, users } from "../schema/users.js";
import { now } from "../time.js";

import { toUser } from "./users.js";

/** Open links a member may hold at once (04 I2, Z1). */
export const DEFAULT_OPEN_INVITE_LIMIT = 3;

/** How a root invite's creator is shown: it has none. */
export const ROOT_INVITER: Inviter = { name: "Session", handle: null };

/** SHA-256 of a canonical code, hex. */
export function hashInviteCode(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The lookup hash of whatever was typed or pasted, or null when it holds no
 * well-formed code. */
export function hashOfInput(input: string): string | null {
  const canonical = parseInviteCode(input);
  return canonical === null ? null : hashInviteCode(canonical);
}

/** A new code from the CSPRNG: `SESS-XXXX-XX`, 30 bits. */
export function newInviteCode(): string {
  let body = "";
  for (let index = 0; index < INVITE_CODE_LENGTH; index += 1) {
    body += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return formatInviteCode(body);
}

const isOpen = and(isNull(invites.usedBy), isNull(invites.revokedAt));

function inviterOf(creator: typeof users.$inferSelect | undefined): Inviter {
  if (!creator) return ROOT_INVITER;
  return {
    name: creator.displayName ?? creator.name ?? creator.handle ?? creator.login,
    handle: creator.handle,
  };
}

export interface OpenInvite {
  id: string;
  createdBy: string | null;
  inviter: Inviter;
}

/** The open invite with this hash, or null. An invite whose creator is no
 * longer an active account does not count as open. */
export function findOpenByHash(db: SessionDatabase, codeHash: string): OpenInvite | null {
  const row = db
    .select({ invite: invites, creator: users })
    .from(invites)
    .leftJoin(users, eq(users.id, invites.createdBy))
    .where(and(eq(invites.codeHash, codeHash), isOpen))
    .get();
  if (!row) return null;
  const { invite, creator } = row;
  if (invite.createdBy !== null && (!creator || creator.status !== "active" || creator.deletedAt)) {
    return null;
  }
  return { id: invite.id, createdBy: invite.createdBy, inviter: inviterOf(creator ?? undefined) };
}

/** `auth.checkInvite`: open with its creator, or the one unusable answer. */
export function checkCode(db: SessionDatabase, input: string): InviteCheck {
  const hash = hashOfInput(input);
  const open = hash === null ? null : findOpenByHash(db, hash);
  return open ? { status: "open", inviter: open.inviter } : { status: "unusable" };
}

export type CreateInviteResult =
  { ok: true; id: string; code: string; createdAt: number } | { ok: false; reason: "limit" };

/**
 * Makes an invite for `createdBy` (null: a root invite, `db:admin --
 * --invite`). The count of open links and the insert run in one immediate
 * transaction, so two concurrent creates at 2 open cannot reach 4.
 * `exempt` (site admins) skips the limit.
 */
export function create(
  db: SessionDatabase,
  input: {
    createdBy: string | null;
    exempt?: boolean;
    openLimit?: number;
    encrypt?: ((code: string) => string) | null;
  },
): CreateInviteResult {
  const limit = input.openLimit ?? DEFAULT_OPEN_INVITE_LIMIT;
  return db.transaction(
    (raw) => {
      const tx = raw as unknown as SessionDatabase;
      if (input.createdBy !== null && input.exempt !== true) {
        const open =
          tx
            .select({ value: count() })
            .from(invites)
            .where(and(eq(invites.createdBy, input.createdBy), isOpen))
            .get()?.value ?? 0;
        if (open >= limit) return { ok: false, reason: "limit" } as const;
      }
      const at = now();
      // 2^30 codes: a collision with a stored hash is rare but possible, and
      // the unique index refuses it; draw again.
      for (let attempt = 0; ; attempt += 1) {
        const code = newInviteCode();
        const codeHash = hashInviteCode(code);
        const taken = tx
          .select({ id: invites.id })
          .from(invites)
          .where(eq(invites.codeHash, codeHash))
          .get();
        if (taken && attempt < 20) continue;
        const id = newId();
        tx.insert(invites)
          .values({
            id,
            codeHash,
            codeEnc: input.createdBy !== null && input.encrypt ? input.encrypt(code) : null,
            createdBy: input.createdBy,
            createdAt: at,
          })
          .run();
        return { ok: true, id, code, createdAt: at } as const;
      }
    },
    { behavior: "immediate" },
  );
}

/** A root invite: no creator, no `code_enc` (04 I1, 05 §3.5). */
export function createRoot(db: SessionDatabase): { id: string; code: string } {
  const result = create(db, { createdBy: null });
  if (!result.ok) throw new Error("a root invite has no limit");
  return { id: result.id, code: result.code };
}

/** Open links of `userId` right now. */
export function openCount(db: SessionDatabase, userId: string): number {
  return (
    db
      .select({ value: count() })
      .from(invites)
      .where(and(eq(invites.createdBy, userId), isOpen))
      .get()?.value ?? 0
  );
}

export type InviteState = "open" | "used" | "revoked";

export interface InviteLink {
  id: string;
  state: InviteState;
  createdAt: number;
  usedAt: number | null;
  revokedAt: number | null;
  /** `code_enc`, still encrypted; the caller decrypts it for the creator. */
  codeEnc: string | null;
  usedBy: { handle: string | null; displayName: string | null } | null;
}

/** The creator's links, newest first. */
export function listForCreator(db: SessionDatabase, userId: string): InviteLink[] {
  const rows = db
    .select({ invite: invites, user: users })
    .from(invites)
    .leftJoin(users, eq(users.id, invites.usedBy))
    .where(eq(invites.createdBy, userId))
    .orderBy(desc(invites.createdAt), desc(invites.id))
    .all();
  return rows.map(({ invite, user }) => ({
    id: invite.id,
    state: invite.usedBy !== null ? "used" : invite.revokedAt !== null ? "revoked" : "open",
    createdAt: invite.createdAt,
    usedAt: invite.usedAt,
    revokedAt: invite.revokedAt,
    codeEnc: invite.usedBy === null && invite.revokedAt === null ? invite.codeEnc : null,
    usedBy: user
      ? user.deletedAt
        ? { handle: null, displayName: null }
        : { handle: user.handle, displayName: user.displayName }
      : null,
  }));
}

/** Accounts `userId` invited, newest first ("You invited"), with when each
 * joined. */
export function invitedBy(db: SessionDatabase, userId: string): { user: User; joinedAt: number }[] {
  return db
    .select()
    .from(users)
    .where(and(eq(users.invitedBy, userId), eq(users.status, "active"), isNull(users.deletedAt)))
    .orderBy(desc(users.activatedAt), desc(users.id))
    .all()
    .map((row) => ({ user: toUser(row), joinedAt: row.activatedAt ?? row.createdAt }));
}

/** Revokes the caller's own open link: frees the slot and nulls `code_enc`.
 * Answers false for a link that is not the caller's or not open. */
export function revoke(db: SessionDatabase, userId: string, inviteId: string): boolean {
  const row = db
    .update(invites)
    .set({ revokedAt: now(), codeEnc: null })
    .where(and(eq(invites.id, inviteId), eq(invites.createdBy, userId), isOpen))
    .returning({ id: invites.id })
    .get();
  return row !== undefined;
}

/**
 * `accountInvites.redeem` for a waiting account: when `input` is an open
 * code, remembers it on the account for the profile step and answers its
 * creator; otherwise the one unusable answer, and the account's pending
 * invite is left as it was.
 */
export function setPendingInvite(db: SessionDatabase, userId: string, input: string): InviteCheck {
  return transact(db, (tx) => {
    const hash = hashOfInput(input);
    const open = hash === null ? null : findOpenByHash(tx, hash);
    if (!open) return { status: "unusable" } as const;
    const row = tx
      .update(users)
      .set({ pendingInviteId: open.id })
      .where(and(eq(users.id, userId), eq(users.status, "waiting"), isNull(users.deletedAt)))
      .returning({ id: users.id })
      .get();
    return row
      ? ({ status: "open", inviter: open.inviter } as const)
      : ({ status: "unusable" } as const);
  });
}

/** The creator of a waiting account's pending invite while it is still
 * open; null otherwise. */
export function pendingInviter(db: SessionDatabase, userId: string): Inviter | null {
  const row = db
    .select({ inviteId: users.pendingInviteId, status: users.status })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .get();
  if (!row || row.status !== "waiting" || row.inviteId === null) return null;
  const invite = db
    .select({ codeHash: invites.codeHash })
    .from(invites)
    .where(eq(invites.id, row.inviteId))
    .get();
  return invite ? (findOpenByHash(db, invite.codeHash)?.inviter ?? null) : null;
}

export type ActivateResult =
  | { ok: true; user: User; inviter: Inviter; inviteId: string; invitedBy: string | null }
  | { ok: false; reason: "invalid_handle" | "invalid_name" | "taken" | "unusable" | "not_waiting" };

/** What `activate` hands `afterRedeem`: the new member, and the invite with
 * its creator (null for a root invite) and the code as it was sealed for the
 * creator before the redemption cleared it. */
export interface RedeemedInvite {
  userId: string;
  handle: string;
  invitedBy: string | null;
  inviterHandle: string | null;
  inviteId: string;
  codeEnc: string | null;
}

/**
 * The profile step (`account.create`): redeems the account's pending invite
 * and makes the account active with its handle and name, in one immediate
 * transaction. A used or revoked invite answers `unusable` and clears the
 * pending invite; a handle already held by any account, a deleted one
 * included, answers `taken`.
 *
 * `afterRedeem` runs inside the transaction, after the account is active:
 * the hook for the `invite_used` notification (01 C16), which commits with
 * the redemption. A throw from it rolls the redemption back.
 */
export function activate(
  db: SessionDatabase,
  input: {
    userId: string;
    handle: string;
    displayName: string;
    afterRedeem?: (tx: SessionDatabase, result: RedeemedInvite) => void;
  },
): ActivateResult {
  if (!isAccountHandle(input.handle)) return { ok: false, reason: "invalid_handle" };
  const displayName = cleanDisplayName(input.displayName);
  if (displayName === "") return { ok: false, reason: "invalid_name" };
  return db.transaction(
    (raw) => {
      const tx = raw as unknown as SessionDatabase;
      const account = tx
        .select()
        .from(users)
        .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
        .get();
      if (!account || account.status !== "waiting") return { ok: false, reason: "not_waiting" };
      if (account.pendingInviteId === null) return { ok: false, reason: "unusable" };
      const held = tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.handle, input.handle))
        .get();
      if (held) return { ok: false, reason: "taken" };
      const at = now();
      const unusable = () => {
        tx.update(users).set({ pendingInviteId: null }).where(eq(users.id, account.id)).run();
        return { ok: false, reason: "unusable" } as const;
      };
      // The creator is checked before the invite is marked used: a link of an
      // account that is no longer active is not open (`findOpenByHash`).
      const pending = tx
        .select({ createdBy: invites.createdBy, codeEnc: invites.codeEnc })
        .from(invites)
        .where(eq(invites.id, account.pendingInviteId))
        .get();
      const creator =
        pending?.createdBy != null
          ? tx.select().from(users).where(eq(users.id, pending.createdBy)).get()
          : undefined;
      if (
        !pending ||
        (pending.createdBy !== null &&
          (!creator || creator.status !== "active" || creator.deletedAt !== null))
      ) {
        return unusable();
      }
      // Conditional on the invite still being open: of two accounts holding
      // it, the second finds it used.
      const invite = tx
        .update(invites)
        .set({ usedBy: account.id, usedAt: at, codeEnc: null })
        .where(and(eq(invites.id, account.pendingInviteId), isOpen))
        .returning()
        .get();
      if (!invite) return unusable();
      const updated = tx
        .update(users)
        .set({
          status: "active",
          handle: input.handle,
          displayName,
          invitedBy: invite.createdBy,
          pendingInviteId: null,
          activatedAt: at,
        })
        .where(eq(users.id, account.id))
        .returning()
        .get();
      input.afterRedeem?.(tx, {
        userId: account.id,
        handle: input.handle,
        invitedBy: invite.createdBy,
        inviterHandle: creator?.handle ?? null,
        inviteId: invite.id,
        codeEnc: pending.codeEnc,
      });
      return {
        ok: true,
        user: toUser(updated),
        inviter: inviterOf(creator),
        inviteId: invite.id,
        invitedBy: invite.createdBy,
      };
    },
    { behavior: "immediate" },
  );
}

export interface TreeNode {
  id: string;
  /** Null for a deleted account, shown as "Deleted account". */
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  invitedBy: string | null;
  joinedAt: number;
  staff: "admin" | null;
}

/**
 * `members.tree` (04 I3): every account that became active, with its
 * inviter. A deleted account stays as a node with no handle, so its
 * invitees keep their place. Ordered by join time; the client walks it
 * depth-first from the roots.
 */
export function tree(db: SessionDatabase): TreeNode[] {
  return db
    .select()
    .from(users)
    .where(
      or(eq(users.status, "active"), and(isNotNull(users.deletedAt), isNotNull(users.activatedAt))),
    )
    .orderBy(asc(users.activatedAt), asc(users.id))
    .all()
    .map((row) => {
      const deleted = row.deletedAt !== null;
      return {
        id: row.id,
        handle: deleted ? null : row.handle,
        displayName: deleted ? null : row.displayName,
        avatarUrl: deleted ? null : row.avatarUrl,
        invitedBy: row.invitedBy,
        joinedAt: row.activatedAt ?? row.createdAt,
        staff: !deleted && row.isAdmin ? "admin" : null,
      };
    });
}
