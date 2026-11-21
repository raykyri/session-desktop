// The spaces half of the account-deletion operator job (plan `04` B6, P2):
// what the person wrote goes through the author's delete path, the shells
// kept for other people's content lose the person's handle and what the
// person's runs wrote, their user log, member records, bans and channel
// invite links are deleted, other people's records that name them as an
// actor or a link's user are rewritten, and every channel they own is
// frozen. It runs through `serverApply`, so each change is a replicated
// write with its log rows and tombstones, in the job's transaction.
//
// After it, no record carries the person's handle but the moderation log
// entries, which stay until their retention (180 days), and the `owner` of
// the channels they owned, which the frozen channel shows as "Deleted
// account".

import {
  MUTATORS,
  countSaves,
  keyOf,
  refreshSpace,
  turnsOf,
  type Kind,
  type RunRec,
  type StoredRecord,
  type Tx,
} from "@session/mutators";
import { SyncServer } from "@session/sync/server";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { records, runLive, runResumes } from "../schema/sync.js";
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
  /** Shells kept for other people's content, now without the person's
   * handle, and other people's records rewritten to no longer name them. */
  rewritten: number;
  /** User-log, member, ban and invite link records deleted. */
  records: number;
  /** Channels the person owned, now frozen. */
  frozen: string[];
  /** The ids of the person's runs, all deleted: their `run_live` and
   * `run_resumes` rows go with them (`eraseAccountSpaces`). */
  runs: string[];
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

/** Delete runs and their turns. */
function dropRuns(tx: Tx, th: string, runs: readonly RunRec[]): void {
  for (const x of turnsOf(tx, th, runs)) tx.del(keyOf(x));
  for (const x of runs) tx.del(`run:${x.id}`);
}

/**
 * Erases `u` from the spaces over a server transaction whose actor is `u`
 * (`serverApply`):
 * - their items through each kind's delete mutator (its `can` and `run`; the
 *   ban and frozen-channel checks of `authorize` do not apply to the
 *   operator), shells they deleted before included, so one with nothing
 *   left under it goes now. A refusal or any other error aborts the job;
 * - the shells that stay (others' content under them) and their gone
 *   threads get `u: null`; a kept branch loses its answer, runs and turns,
 *   a kept thread its root answer and summary;
 * - their user log (saves, with the threads' counts, notifications,
 *   layout), bans of them, links they made and their member records, after
 *   setting `frozen` on every space they own;
 * - `named`: keys of other people's records that name them, found by the
 *   caller: a notification whose `actor` they are and a link they used get
 *   null there.
 * The space records keep `owner`, and moderation log entries naming them
 * stay until retention.
 */
export function eraseFromSpaces(tx: Tx, u: string, named: readonly string[] = []): ErasedSpaces {
  const out: ErasedSpaces = { items: 0, rewritten: 0, records: 0, frozen: [], runs: [] };
  out.runs = tx.list("run", { u }).map((r) => r.id);
  for (const [kind, name, input] of DELETES) {
    const def = MUTATORS[name];
    if (!def) throw new Error(`no mutator ${name}`);
    for (const r of tx.list(kind, { u })) {
      const now = tx.byKey(keyOf(r));
      if (!now || (now.kind === "thread" && now.gone)) continue;
      const i = def.input.parse(input(now));
      def.can?.(tx, i);
      def.run(tx, i, {});
      out.items += 1;
    }
  }
  // what is left of the person's items: shells kept for other people's
  // content, and gone threads; they keep no author
  for (const kind of ["comment", "reply", "node", "thread"] as const)
    for (const r of tx.list(kind, { u })) {
      if (!r.del) throw new Error(`${keyOf(r)} was not deleted`);
      if (r.kind === "thread") tx.put({ ...r, u: null, sum: null });
      else tx.put({ ...r, u: null });
      out.rewritten += 1;
    }
  // what the person's runs wrote and the delete paths kept: the runs, turns
  // and answers of kept branches, and a kept thread's root answer (each
  // answer's `u` is its asker, the person)
  for (const r of tx.list("run", { u })) dropRuns(tx, r.th, [r]);
  for (const a of tx.list("answer", { u })) tx.del(keyOf(a));
  for (const kind of OWN_KINDS)
    for (const r of tx.list(kind, { u })) {
      // a ban of `u`, a link `u` made; not someone else's record in the index
      if (kind === "ban" && r.kind === "ban" && r.u !== u) continue;
      if (kind === "invite" && r.kind === "invite" && r.by !== u) continue;
      tx.del(keyOf(r));
      if (r.kind === "save") countSaves(tx, r.th, -1);
      out.records += 1;
    }
  for (const key of named) {
    const r = tx.byKey(key);
    if (r?.kind === "notif" && r.actor === u) tx.put({ ...r, actor: null });
    else if (r?.kind === "invite" && r.usedBy === u) tx.put({ ...r, usedBy: null });
    else continue;
    out.rewritten += 1;
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

/** The keys of other people's records that name `handle` outside the
 * person index: notifications whose actor they are, links they used. */
function namedIn(tx: SessionDatabase, handle: string): string[] {
  return tx
    .select({ key: records.key })
    .from(records)
    .where(
      and(
        inArray(records.kind, ["notif", "invite"]),
        or(
          sql`json_extract(${records.body}, '$.actor') = ${handle}`,
          sql`json_extract(${records.body}, '$.usedBy') = ${handle}`,
        ),
      ),
    )
    .all()
    .map((r) => r.key);
}

/** The spaces step of the job, over `server`: the running server's own sync
 * core, or one over the job's connection (`localSyncServer`), inside the
 * job's transaction `tx`. The checkpoints and resume counts of the
 * person's runs (`run_live`, `run_resumes`) go in the same transaction.
 * Null for a waiting account, which has no handle and owns no records. */
export function eraseAccountSpaces(
  server: SyncServer,
  tx: SessionDatabase,
  userId: string,
): ErasedSpaces | null {
  const row = tx.select({ handle: users.handle }).from(users).where(eq(users.id, userId)).get();
  const handle = row?.handle;
  if (!handle) return null;
  const named = namedIn(tx, handle);
  const done = server.serverApply({ me: handle }, (t) => eraseFromSpaces(t, handle, named));
  if (!done.ok)
    throw new Error(
      `erasing @${handle} from the spaces: ${done.error.code} ${done.error.message}; nothing was changed`,
    );
  const runs = done.result.runs;
  if (runs.length) {
    tx.delete(runLive).where(inArray(runLive.runId, runs)).run();
    tx.delete(runResumes).where(inArray(runResumes.runId, runs)).run();
  }
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
