// The spaces half of the account-deletion operator job (plan `04` B6, P2):
// what the person wrote goes through the author's delete path, their user
// log, member records, bans and channel invite links are deleted, and every
// channel they own is frozen. It runs through `serverApply`, so each change
// is a replicated write with its log rows and tombstones, in the job's
// transaction.

import {
  MUTATORS,
  Refusal,
  keyOf,
  refreshSpace,
  type Kind,
  type StoredRecord,
  type Tx,
} from "@session/mutators";
import { SyncServer } from "@session/sync/server";
import { eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { users } from "../schema/users.js";
import { SqliteStore } from "../sync/store.js";

/** A step of `deleteAccount` (`accounts.ts`): runs inside its transaction. */
export type AccountDeletionStep = (tx: SessionDatabase, userId: string) => void;

/** What the job did in the spaces, for its output. */
export interface ErasedSpaces {
  /** Threads, branches, replies and comments taken through the author's
   * delete path (a thread with other people's replies stays an empty
   * shell). */
  items: number;
  /** User-log, member, ban and invite link records deleted. */
  records: number;
  /** Channels the person owned, now frozen. */
  frozen: string[];
}

/** The author's delete path of each kind the person writes, leaves first,
 * so a thread whose replies were all the person's own goes whole. */
const DELETES: readonly [Kind, string, (r: StoredRecord) => unknown][] = [
  ["comment", "comments.delete", (r) => ({ id: (r as { id: string }).id })],
  ["reply", "replies.delete", (r) => ({ id: (r as { id: string }).id })],
  [
    "node",
    "followups.delete",
    (r) => ({ thread: (r as { th: string }).th, node: (r as { id: string }).id }),
  ],
  ["thread", "threads.delete", (r) => ({ id: (r as { id: string }).id })],
];

/** The person's own records that go with the account. */
const OWN_KINDS: readonly Kind[] = ["save", "notif", "prefs", "ban", "invite"];

/**
 * Erases `u` from the spaces over a server transaction whose actor is `u`
 * (`serverApply`): their items through each kind's delete mutator (its
 * `can` and `run`; the ban and frozen-channel checks of `authorize` do not
 * apply to the operator), their user log (saves, notifications, layout),
 * bans of them and links they made, and their member records, after setting
 * `frozen` on every space they own. The space records keep `owner`, and
 * moderation log entries naming them stay until retention.
 */
export function eraseFromSpaces(tx: Tx, u: string): ErasedSpaces {
  const out: ErasedSpaces = { items: 0, records: 0, frozen: [] };
  for (const [kind, name, input] of DELETES) {
    const def = MUTATORS[name];
    if (!def) throw new Error(`no mutator ${name}`);
    for (const r of tx.list(kind, { u })) {
      const now = tx.byKey(keyOf(r));
      if (!now || ("del" in now && now.del) || (now.kind === "thread" && now.gone)) continue;
      try {
        const i = def.input.parse(input(now));
        def.can?.(tx, i);
        def.run(tx, i, {});
        out.items += 1;
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
      }
    }
  }
  for (const kind of OWN_KINDS)
    for (const r of tx.list(kind, { u })) {
      // a ban of `u`, a link `u` made; not someone else's record in the index
      if (kind === "ban" && r.kind === "ban" && r.u !== u) continue;
      if (kind === "invite" && r.kind === "invite" && r.by !== u) continue;
      tx.del(keyOf(r));
      out.records += 1;
    }
  for (const m of tx.list("member", { u })) {
    if (m.u !== u) continue;
    if (m.role === "owner") {
      const s = tx.byKey(`space:${m.sp}`);
      if (s?.kind === "space" && !s.frozen) {
        tx.put({ ...s, frozen: true });
        out.frozen.push(s.name);
      }
    }
    tx.del(keyOf(m));
    refreshSpace(tx, m.sp, -1);
    out.records += 1;
  }
  return out;
}

/** The spaces step of the job, over `server`: the running server's own sync
 * core, or one over the job's connection (`localSyncServer`), inside the
 * job's transaction `tx`. Null for a waiting account, which has no handle
 * and owns no records. */
export function eraseAccountSpaces(
  server: SyncServer,
  tx: SessionDatabase,
  userId: string,
): ErasedSpaces | null {
  const row = tx.select({ handle: users.handle }).from(users).where(eq(users.id, userId)).get();
  const handle = row?.handle;
  if (!handle) return null;
  const done = server.serverApply({ me: handle }, (t) => eraseFromSpaces(t, handle));
  if (!done.ok) throw new Error(`erasing @${handle} from the spaces: ${done.error.code}`);
  return done.result;
}

/** A sync core over `db` for the operator job, which runs while the server
 * is stopped (`web/docs/runbooks/delete-account.md`). */
export function localSyncServer(db: SessionDatabase): SyncServer {
  return new SyncServer({
    store: new SqliteStore(db),
    clock: { now: Date.now },
    mutators: MUTATORS,
  });
}
