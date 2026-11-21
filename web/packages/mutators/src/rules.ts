// Rules the mutators of several areas share: reading a target the actor may
// read, the stored counts, the owner acting on others, node references,
// moderation keys and erasure.

import { MODEL_REGISTRY, spaces, type ReasoningEffort } from "@session/shared";
import type { z } from "zod";

import { canRead, isClosed, spaceRec } from "./access.js";
import { refuse, Refusal } from "./errors.js";
import { ULID_RE } from "./ids.js";
import {
  countsKey,
  keyOf,
  memberKey,
  nodeKey,
  saveKey,
  threadKey,
  type CommentRec,
  type CountsRec,
  type Kind,
  type NodeRec,
  type RecordOf,
  type NotifRec,
  type ReplyRec,
  type RunRec,
  type SaveRec,
  type SpaceRec,
  type SpaceRole,
  type ThreadRec,
  type TurnRec,
} from "./records.js";
import type { PreCtx, PreLimit, ServerValues, Tx } from "./tx.js";

/** The contract's mutators: names, inputs, `who` and `online`. */
export const M = spaces.spaceMutators;

export const bad = (path: string, expected: string) =>
  refuse("BAD_REQUEST", undefined, [`input.${path}: expected ${expected}`]);
/** The one answer for a missing target and for a target the actor may not read. */
export const notFound = () => refuse("NOT_FOUND");
export const stale = () => refuse("STALE");
export const removed = () => refuse("PRECONDITION_FAILED", "This item was removed.");
export const deleted = () => refuse("PRECONDITION_FAILED", "This item was deleted.");
/** A write under a thread its author deleted while nothing was under it
 * (`gone`): nothing more is added to it (M1b review 10). */
export const threadDeleted = () => refuse("PRECONDITION_FAILED", "This thread was deleted.");
export function notGone(p: ThreadRec): void {
  if (p.gone) throw threadDeleted();
}
export const notAuthor = () => refuse("FORBIDDEN", "Only the person who wrote this can change it.");

/** The shared id schema, narrowed to ULIDs whose time fits 48 bits. */
export const ulidS = spaces.spaceUlidSchema.regex(ULID_RE);

/** Every id field of an input (a dotted path for a nested one), narrowed to
 * `ULID_RE`; `r` passes, as the root of a thread. */
export const ulidFields = <I>(schema: z.ZodType<I>, fields: string[]) =>
  schema.refine(
    (i) =>
      fields.every((f) => {
        let v: unknown = i;
        for (const k of f.split(".")) v = (v as Record<string, unknown> | undefined)?.[k];
        return v === undefined || v === "r" || (typeof v === "string" && ULID_RE.test(v));
      }),
    { message: "expected a ULID" },
  );

/** Text as stored: trimmed, and not empty. */
export const text = (v: string, path: string) => {
  const s = v.trim();
  if (!s) throw bad(path, "some text");
  return s;
};

/** A record the actor may read, or NOT_FOUND. */
export function readable<K extends Kind>(tx: Tx, key: string, kind: K): RecordOf<K> {
  const r = tx.byKey(key);
  if (!r || r.kind !== kind || !canRead(tx, r, tx.me)) throw notFound();
  return r as RecordOf<K>;
}

export const readableThread = (tx: Tx, id: string) => readable(tx, threadKey(id), "thread");

/** A record the actor wrote, read or not: a person removed from a private
 * space can still delete what they wrote there (AGENTS.md). NOT_FOUND when
 * it does not exist, or is someone else's and the actor may not read it. */
export function ownOrReadable<K extends "thread" | "node" | "reply" | "comment">(
  tx: Tx,
  key: string,
  kind: K,
): RecordOf<K> {
  const r = tx.byKey(key);
  if (r?.kind !== kind) throw notFound();
  return r.u === tx.me ? (r as RecordOf<K>) : readable(tx, key, kind);
}

export function needSpace(tx: Tx, sp: string): SpaceRec {
  const s = spaceRec(tx, sp);
  if (!s) throw notFound();
  return s;
}

/** Write a space's stored member count after its member records changed by
 * `delta`. The server counts the member records; a client's replica of a
 * private space it is joining holds none of them, so a prediction adds
 * `delta` to the stored count (server-only read, `Tx.server`). */
export function refreshSpace(tx: Tx, sp: string, delta: number): void {
  const s = needSpace(tx, sp);
  const members = tx.server ? tx.count("member", { sp }) : Math.max(1, s.members + delta);
  tx.put({ ...s, members });
}

/** Add `u` to a space, with `adm` as the admission id (a derived id of the
 * write that admits them). */
export function addMember(tx: Tx, sp: string, u: string, role: SpaceRole, adm: string): void {
  if (tx.byKey(memberKey(sp, u))) return;
  tx.put({ kind: "member", sp, u, role, adm, joinedAt: tx.now });
}

/** A thread's counts record (written with the thread). */
export function countsOf(tx: Tx, th: ThreadRec): CountsRec {
  const c = tx.byKey(countsKey(th.id));
  if (c?.kind !== "counts") throw refuse("INTERNAL_SERVER_ERROR");
  return c;
}

/** Write a thread's `r` (`01` C5): every ask node under an ask's root, every
 * reply of a post, placeholders included. */
export function recount(tx: Tx, th: ThreadRec): void {
  const c = countsOf(tx, th);
  const r = th.k === "ask" ? tx.count("node", { th: th.id }) : tx.count("reply", { th: th.id });
  tx.put({ ...c, r });
}

/** A private space serves a save count only from this many saves (`01` C1,
 * decision S6). */
export const PRIVATE_SAVES_MIN = 3;

/** Write a thread's served save count (`01` C1) after the actor's save
 * changed by `delta`: the number of save records; in a private space 0 below
 * `PRIVATE_SAVES_MIN`. The true count is the save records, which only the
 * server reads (`Tx.server`): a client predicts the served count ± 1 in an
 * open space, and leaves a private space's count to the server. */
export function countSaves(tx: Tx, th: string, delta: 1 | -1): void {
  const c = tx.byKey(countsKey(th));
  if (c?.kind !== "counts") return;
  const s = spaceRec(tx, c.s);
  const closed = s !== undefined && isClosed(s);
  if (!tx.server) {
    if (!closed) tx.put({ ...c, saves: Math.max(0, c.saves + delta) });
    return;
  }
  const n = tx.count("save", { th });
  const saves = closed && n < PRIVATE_SAVES_MIN ? 0 : n;
  tx.put({ ...c, saves });
}

/** The records of `kind` about thread `th` in people's user logs (saves,
 * notifications). The server reads everyone's; a client only the actor's
 * own, the others' being server-only reads (`Tx.server`). */
export function userLogRecords<K extends "save" | "notif">(
  tx: Tx,
  kind: K,
  th: string,
): RecordOf<K>[] {
  if (tx.server) return tx.list(kind, { th });
  return tx.list(kind, { u: tx.me }).filter((x) => (x as SaveRec | NotifRec).th === th);
}

/** The owner acts on anyone but themselves (`01` C18): the target of a
 * removal or a ban is never the owner. */
export function actsOn(tx: Tx, u: string): void {
  if (u === tx.me) throw refuse("FORBIDDEN", "You can’t change your own membership here.");
}

/** The node a reference names in a thread: `r` (the root: the thread) or a
 * node of the thread the actor may read. */
export function nodeOf(tx: Tx, th: ThreadRec, ref: string): ThreadRec | NodeRec {
  if (ref === "r") return th;
  const n = readable(tx, nodeKey(ref), "node");
  if (n.th !== th.id) throw notFound();
  return n;
}

/** The author of the node a reference names: the thread's for `r`. */
export const authorOf = (n: ThreadRec | NodeRec) => n.u ?? "";

/** The run of an ask: a node's current run, or the root's (the thread's run
 * with `node: "r"`). */
export function runOf(tx: Tx, n: ThreadRec | NodeRec): RunRec | undefined {
  if (n.kind === "node") {
    const r = tx.byKey(`run:${n.run}`);
    return r?.kind === "run" ? r : undefined;
  }
  return tx.list("run", { th: n.id }).find((r) => r.node === "r");
}

/** Whether a run has not ended. */
export const active = (r: RunRec | undefined) =>
  r !== undefined && (r.status === "queued" || r.status === "running");

/** The record a moderation key names (`a:<thread>`, `p:<thread>`,
 * `f:<thread>:<node>`, `r:<thread>:<reply>`, `c:<thread>:<comment>`), if the
 * actor may read it. The mock's reply keys use reply paths; here they use
 * reply ids. */
export function itemOf(tx: Tx, key: string): ThreadRec | NodeRec | ReplyRec | CommentRec {
  const [k, th, sub, ...rest] = key.split(":");
  if (!th || rest.length) throw notFound();
  if (k === "a" || k === "p") {
    if (sub !== undefined) throw notFound();
    const p = readableThread(tx, th);
    if ((k === "a") !== (p.k === "ask")) throw notFound();
    return p;
  }
  const kinds = { f: "node", r: "reply", c: "comment" } as const;
  if ((k === "f" || k === "r" || k === "c") && sub) {
    const r = readable(tx, `${kinds[k]}:${sub}`, kinds[k]);
    if (r.th !== th) throw notFound();
    return r;
  }
  throw notFound();
}

/** The replies or comments under `id`, at any depth (not `id` itself). */
export function itemsUnder<T extends { id: string; parent: string | null }>(
  items: readonly T[],
  id: string,
): T[] {
  const under = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of items)
      if (x.parent !== null && !under.has(x.id) && under.has(x.parent)) {
        under.add(x.id);
        grew = true;
      }
  }
  return items.filter((x) => x.id !== id && under.has(x.id));
}

/** The ids of a node and every node under it, at any depth. */
export function nodesUnder(nodes: readonly NodeRec[], id: string): Set<string> {
  const under = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of nodes)
      if (!under.has(x.id) && under.has(x.par)) {
        under.add(x.id);
        grew = true;
      }
  }
  return under;
}

/** The committed turns of `runs` (every attempt), in the thread `th`. */
export function turnsOf(tx: Tx, th: string, runs: readonly RunRec[]): TurnRec[] {
  const ids = new Set(runs.map((x) => x.id));
  return tx.list("turn", { th }).filter((x) => ids.has(x.run));
}

/** Erase the thread a node was opened as (`promoted`), if it is not removed
 * already: removing a node removes its copies (M1b review 14). */
function erasePromoted(tx: Tx, n: NodeRec, note: string | null): void {
  if (n.promoted === null) return;
  const p = tx.byKey(threadKey(n.promoted));
  if (p?.kind === "thread" && p.mod !== "removed") erase(tx, p, note);
}

/** Remove a moderated item for good: its text is erased from storage, and so
 * is everything under it (a thread's nodes, answers, runs, replies,
 * comments, saves and the mention notifications about it; a node's answer
 * and comments; a reply's or comment's replies at any depth), and so is every
 * thread opened from an erased node (`from`), with the same placeholder
 * rules. The item stays as a placeholder; a thread's keeps who removed it
 * and the reason. */
export function erase(
  tx: Tx,
  r: ThreadRec | NodeRec | ReplyRec | CommentRec,
  note: string | null,
): void {
  /** The keys erased; mention notifications about them go too. */
  const gone = new Set<string>();
  const drop = (key: string) => {
    gone.add(key);
    tx.del(key);
  };
  switch (r.kind) {
    case "thread": {
      const th = { th: r.id };
      const nodes = tx.list("node", th);
      for (const x of nodes) drop(`node:${x.id}`);
      for (const x of tx.list("answer", th)) drop(keyOf(x));
      for (const x of tx.list("reply", th)) drop(`reply:${x.id}`);
      for (const x of tx.list("comment", th)) drop(`comment:${x.id}`);
      for (const x of tx.list("run", th)) drop(`run:${x.id}`);
      for (const x of tx.list("turn", th)) drop(keyOf(x));
      for (const x of userLogRecords(tx, "save", r.id)) drop(saveKey(x.u, x.th));
      for (const x of userLogRecords(tx, "notif", r.id).filter((y) => y.type === "mention"))
        drop(`notif:${x.id}`);
      tx.put({ ...countsOf(tx, r), r: 0, saves: 0 });
      // the placeholder keeps nothing else of the removed content
      // (`removedThreadRecordSchema`)
      tx.put({
        ...r,
        q: "",
        t: null,
        sum: null,
        tok: 0,
        src: 0,
        model: null,
        effort: null,
        running: false,
        edited: false,
        from: null,
        mod: "removed",
        modBy: tx.me,
        modNote: note,
        updatedAt: tx.now,
      });
      for (const x of nodes) erasePromoted(tx, x, note);
      return;
    }
    case "node": {
      // the node and every node under it, at any depth: the descendants go
      // with their answers, comments and runs, as everything under a removed
      // thread does, and so do the node's own answer, comments and runs (a
      // queued run would spend tokens on erased text; M1a review 13)
      const th = { th: r.th };
      const nodes = tx.list("node", th);
      const under = nodesUnder(nodes, r.id);
      for (const x of nodes) if (x.id !== r.id && under.has(x.id)) drop(nodeKey(x.id));
      for (const x of tx.list("answer", th).filter((y) => under.has(y.node))) drop(keyOf(x));
      for (const x of tx.list("comment", th).filter((y) => under.has(y.node)))
        drop(`comment:${x.id}`);
      const runs = tx.list("run", th).filter((y) => under.has(y.node));
      for (const x of runs) drop(`run:${x.id}`);
      for (const x of turnsOf(tx, r.th, runs)) drop(keyOf(x));
      tx.put({ ...r, q: "", look: null, quote: null, mod: "removed" });
      recount(tx, tx.byKey(threadKey(r.th)) as ThreadRec);
      for (const x of nodes) if (under.has(x.id)) erasePromoted(tx, x, note);
      break;
    }
    case "reply":
      // every reply under it, at any depth
      for (const x of itemsUnder(tx.list("reply", { th: r.th }), r.id)) drop(`reply:${x.id}`);
      tx.put({ ...r, t: "", mod: "removed" });
      recount(tx, tx.byKey(threadKey(r.th)) as ThreadRec);
      break;
    case "comment":
      for (const x of itemsUnder(tx.list("comment", { th: r.th }), r.id)) drop(`comment:${x.id}`);
      tx.put({ ...r, t: "", mod: "removed" });
      break;
  }
  gone.add(`${r.kind}:${r.id}`);
  for (const x of userLogRecords(tx, "notif", r.th).filter(
    (y) => y.type === "mention" && gone.has(y.item ?? ""),
  ))
    tx.del(`notif:${x.id}`);
}

/** The space of the thread a save names, for taking it back: null when the
 * person has none (nothing is written), so taking back a save needs no read
 * access and answers the same whether or not the thread exists. */
export function ownMarkSpace(tx: Tx, key: string, thread: string): string | null {
  if (!tx.byKey(key)) return null;
  const p = tx.byKey(threadKey(thread));
  return p?.kind === "thread" ? p.s : null;
}

// ---- runs: the pre-checks that start or restart one (`03` G1, L1, K13) ----

/** The most runs one person may have queued (`03` L1). */
export const QUEUED_RUNS_MAX = spaces.QUEUED_RUNS_PER_USER;

/** The model must be a registry entry and the effort one it accepts (`03`
 * K11, K13): BAD_REQUEST otherwise. Every registry model is open to every
 * member (`03` K15). Deterministic, so it runs in `can` and a client
 * predicts it (M1b review 5). */
export function checkModel(model: string, effort: string): void {
  const entry = MODEL_REGISTRY.find((m) => m.id === model);
  if (!entry) throw bad("model", "a model of the registry");
  if (!entry.efforts.includes(effort as ReasoningEffort))
    throw bad("effort", `an effort ${model} accepts`);
}

/** The person may queue one more run: at most `QUEUED_RUNS_MAX` queued,
 * else PRECONDITION_FAILED with `reason: "queue_full"`, recorded (`03` L1).
 * `TOO_MANY_REQUESTS` stays for transport rate limits. */
export function checkQueue(ctx: PreCtx): void {
  if (ctx.queuedRuns() >= QUEUED_RUNS_MAX)
    throw new Refusal(
      "PRECONDITION_FAILED",
      `You have ${QUEUED_RUNS_MAX} asks waiting to run.`,
      undefined,
      "queue_full",
    );
}

/** Asks for one use of a `pre`-stage limit (`04` Z1), or refuses with
 * TOO_MANY_REQUESTS and the server's message, which the server does not
 * record. */
export function within(ctx: PreCtx, limit: PreLimit): void {
  const left = ctx.allow?.(limit) ?? true;
  if (left !== true) throw refuse("TOO_MANY_REQUESTS", left);
}

/** The pre-check of a write that queues a run: room in the person's queue
 * (server only; the model is checked in `can`). */
export const preRun = (ctx: PreCtx): ServerValues => {
  checkQueue(ctx);
  return {};
};

/** A new run of an ask, queued: the run record is the queue (`03` E2). */
export function queueRun(
  tx: Tx,
  id: string,
  th: ThreadRec,
  node: string,
  model: string,
  effort: RunRec["effort"],
): void {
  tx.create({
    kind: "run",
    id,
    th: th.id,
    s: th.s,
    node,
    u: tx.me,
    model,
    effort,
    status: "queued",
    attempt: 1,
    step: 0,
    fail: null,
    tok: null,
    bill: null,
    note: null,
    createdAt: tx.now,
    startedAt: null,
    finishedAt: null,
  });
}
