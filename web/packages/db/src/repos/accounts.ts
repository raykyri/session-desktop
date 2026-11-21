// Operator work on accounts (plan `04` §3.1, §8): the waiting-account sweep
// of the scheduled maintenance, and the account-deletion operator job.

import type { SyncServer } from "@session/sync/server";
import { and, eq, isNull, lt } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { sessions } from "../schema/sessions.js";
import { invites, users } from "../schema/users.js";
import { now } from "../time.js";

import {
  eraseAccountSpaces,
  localSyncServer,
  type AccountDeletionStep,
  type ErasedSpaces,
} from "./accountSpaces.js";

/** A waiting account is kept this long without redeeming an invite
 * (decision S4). */
export const WAITING_ACCOUNT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Deletes waiting accounts created more than 90 days before `at`. Run by the
 * server's scheduled maintenance (`sweepExpired`); there is no queue. A
 * waiting account owns no records, so the row and what cascades from it
 * (sessions, preferences) is everything there is. Answers how many went.
 */
export function sweepWaiting(db: SessionDatabase, at: number = now()): number {
  return db
    .delete(users)
    .where(
      and(
        eq(users.status, "waiting"),
        isNull(users.deletedAt),
        lt(users.createdAt, at - WAITING_ACCOUNT_TTL_MS),
      ),
    )
    .returning({ id: users.id })
    .all().length;
}

/**
 * Further steps every deletion runs inside its transaction, before the
 * identity is removed, after the spaces step (`accountSpaces.ts`).
 */
export const ACCOUNT_DELETION_STEPS: AccountDeletionStep[] = [];

export type { AccountDeletionStep, ErasedSpaces } from "./accountSpaces.js";
export { eraseFromSpaces } from "./accountSpaces.js";

export interface DeletedAccount {
  id: string;
  handle: string | null;
  sessions: number;
  revokedInvites: number;
  /** What went from the spaces; null for a waiting account. */
  spaces: ErasedSpaces | null;
}

export interface DeleteAccountOptions {
  /** The sync core the spaces step writes through: the running server's in
   * a test, otherwise one over `db` (the job runs while the server is
   * stopped, `web/docs/runbooks/delete-account.md`). */
  server?: SyncServer;
  /** Further steps; `ACCOUNT_DELETION_STEPS` by default. */
  steps?: readonly AccountDeletionStep[];
}

/**
 * The account-deletion operator job (04 §8, B6, `01` C8). In one
 * transaction it erases the person from the spaces and freezes the channels
 * they own (`accountSpaces.ts`), runs the registered steps, ends every
 * session, revokes the account's open invites, and deletes the provider
 * identity: `provider`, `provider_user_id`, the email, login, names and
 * avatar. The row stays with its handle, so the handle remains taken and the
 * account stays in the invite tree as "Deleted account". The same provider
 * identity can sign in again and gets a new waiting account with no link to
 * this one.
 */
export function deleteAccount(
  db: SessionDatabase,
  userId: string,
  options: DeleteAccountOptions = {},
): DeletedAccount {
  const server = options.server ?? localSyncServer(db);
  const steps = options.steps ?? ACCOUNT_DELETION_STEPS;
  return db.transaction(
    (raw) => {
      const tx = raw as unknown as SessionDatabase;
      const row = tx
        .select()
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .get();
      if (!row) throw new Error(`account ${userId} was not found`);
      const spaces = eraseAccountSpaces(server, tx, userId);
      for (const step of steps) step(tx, userId);
      const at = now();
      const ended = tx
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id })
        .all().length;
      const revoked = tx
        .update(invites)
        .set({ revokedAt: at, codeEnc: null })
        .where(
          and(eq(invites.createdBy, userId), isNull(invites.usedBy), isNull(invites.revokedAt)),
        )
        .returning({ id: invites.id })
        .all().length;
      tx.update(users)
        .set({
          provider: null,
          providerUserId: null,
          email: null,
          login: "",
          name: null,
          displayName: null,
          avatarUrl: null,
          isAdmin: false,
          pendingInviteId: null,
          deletedAt: at,
        })
        .where(eq(users.id, userId))
        .run();
      return { id: userId, handle: row.handle, sessions: ended, revokedInvites: revoked, spaces };
    },
    { behavior: "immediate" },
  );
}
