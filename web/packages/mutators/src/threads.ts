// Threads: an ask (its root run queued), a post, or a node opened as its own
// thread (`03` G1, G5); the author's edit and delete (`01` C15).

import { canRead } from "./access.js";
import { refuse } from "./errors.js";
import { Notifier } from "./notify.js";
import {
  answerKey,
  keyOf,
  nodeKey,
  saveKey,
  statsKey,
  threadKey,
  type SpaceRec,
  type ThreadRec,
} from "./records.js";
import {
  M,
  checkModel,
  countsOf,
  deleted,
  needSpace,
  notAuthor,
  notGone,
  ownOrReadable,
  payOf,
  preRun,
  queueRun,
  readable,
  readableThread,
  removed,
  stale,
  text,
  turnsOf,
  ulidFields,
  ulidS,
  userLogRecords,
} from "./rules.js";
import { define, type Tx } from "./tx.js";

/** Write a new thread, its counts and its space's activity. */
function newThread(
  tx: Tx,
  s: SpaceRec,
  t: Omit<ThreadRec, "kind" | "s" | "rev" | "createdAt" | "updatedAt">,
) {
  tx.create({ kind: "thread", s: s.id, ...t, createdAt: tx.now, updatedAt: tx.now });
  tx.put({ kind: "counts", th: t.id, s: s.id, saves: 0, r: 0 });
  const stats = tx.byKey(statsKey(s.id));
  if (stats?.kind === "stats") tx.put({ ...stats, posts: stats.posts + 1, updatedAt: tx.now });
}

const blank = {
  t: null,
  sum: null,
  tok: 0,
  src: 0,
  edited: false,
  del: false,
  gone: false,
  mod: null,
  modBy: null,
  modNote: null,
  from: null,
} as const;

export const THREADS = {
  "threads.create": define({
    input: ulidFields(M["threads.create"].input, ["id", "space", "from.th", "from.node"]),
    who: "member",
    intent: "none",
    space: (tx, i) => ("from" in i ? readableThread(tx, i.from.th).s : i.space),
    ids: (i) => [i.id],
    // an ask's run: a registry model and effort (predicted), room in the
    // queue and a payer (server only)
    can: (_tx, i) => {
      if ("kind" in i && i.kind === "ask") checkModel(i.model, i.effort);
    },
    pre: (ctx, i) => ("kind" in i && i.kind === "ask" ? preRun(ctx, i.model) : {}),
    run: (tx, i, values) => {
      if ("from" in i) return promote(tx, i.id, i.from.th, i.from.node);
      const s = needSpace(tx, i.space);
      const q = text(i.q, "q");
      const ask = i.kind === "ask";
      newThread(tx, s, {
        ...blank,
        id: i.id,
        u: tx.me,
        k: i.kind,
        q,
        t: i.title ?? null,
        model: ask ? i.model : null,
        effort: ask ? i.effort : null,
        running: ask,
      });
      if (!ask) return { id: i.id, run: null, notified: [], notMembers: [] };
      // the run record with status `queued` is the run queue (`03` E2)
      const run = tx.id(1);
      queueRun(
        tx,
        run,
        tx.byKey(threadKey(i.id)) as ThreadRec,
        "r",
        i.model,
        i.effort,
        payOf(values, i.model),
      );
      return { id: i.id, run, notified: [], notMembers: [] };
    },
    // a post notifies the accounts it mentions, and says who in its answer
    notify: (tx, i, result, ctx) => {
      if (!("kind" in i) || i.kind !== "post") return undefined;
      const m = new Notifier(tx, ctx).mentions(i.q, i.space, i.id, threadKey(i.id));
      return { ...(result as object), ...m };
    },
  }),

  "threads.update": define({
    input: M["threads.update"].input.extend({ id: ulidS }).strict(),
    who: "author",
    intent: "base.rev",
    space: (tx, i) => readableThread(tx, i.id).s,
    can: (tx, i) => {
      if (readableThread(tx, i.id).u !== tx.me) throw notAuthor();
    },
    run: (tx, i) => {
      const p = readableThread(tx, i.id);
      if (p.mod === "removed") throw removed();
      if (p.del || p.gone) throw refuse("PRECONDITION_FAILED", "This thread was deleted.");
      if (p.rev !== i.base.rev) throw stale();
      const q = text(i.q, "q");
      const changed = q !== p.q;
      tx.put({ ...p, q, t: changed ? null : p.t, edited: p.edited || changed, updatedAt: tx.now });
      return null;
    },
  }),

  "threads.delete": define({
    input: M["threads.delete"].input.extend({ id: ulidS }).strict(),
    who: "author",
    intent: "as is",
    frozen: "allowed",
    // the author may delete their thread without read access: a person
    // removed from a private space can still delete what they wrote there
    space: (tx, i) => ownOrReadable(tx, threadKey(i.id), "thread").s,
    can: (tx, i) => {
      if ((tx.byKey(threadKey(i.id)) as ThreadRec).u !== tx.me) throw notAuthor();
    },
    // Kept as the mock has it (review round 1, R11; `01` C15): a thread
    // deleted while it has nodes, replies or comments stays as a shell
    // (`del`; comments count too, M1a review 12), and
    // nodes, replies and saves on it are taken as on any thread. A thread
    // with none is `gone`; it leaves every Saved. The author may delete a
    // thread the owner removed: its count `r` is 0 then, so it is gone.
    run: (tx, i) => {
      const p = tx.byKey(threadKey(i.id)) as ThreadRec;
      const counts = countsOf(tx, p);
      // nodes, replies or comments under it keep it as a shell
      const kept = counts.r > 0 || tx.count("comment", { th: p.id }) > 0;
      // an author who may no longer read the thread (removed from its private
      // space) learns nothing about it: whether it got nodes or replies after
      // they left is not in the answer (R4b)
      const reads = canRead(tx, p, tx.me);
      // a thread without nodes or replies is gone: it leaves Saved, and its
      // root answer goes
      if (!kept) {
        for (const x of userLogRecords(tx, "save", p.id)) tx.del(saveKey(x.u, x.th));
        tx.del(answerKey(p.id));
      }
      const roots = tx.list("run", { th: p.id }).filter((x) => x.node === "r");
      for (const r of roots) tx.del(`run:${r.id}`);
      for (const x of turnsOf(tx, p.id, roots)) tx.del(keyOf(x));
      if (!kept) tx.put({ ...counts, saves: 0 });
      tx.put({
        ...p,
        q: "",
        t: null,
        edited: false,
        running: false,
        del: true,
        gone: !kept,
        sum: kept ? p.sum : null,
        updatedAt: tx.now,
      });
      return reads ? { kept } : null;
    },
  }),
};

/** Open a node as its own thread (`03` G5): a new ask thread in the node's
 * space with the node's question, author, model and effort, and a copy of
 * its answer; the node's `promoted` names it. No run starts. Anyone who may
 * read the branch may open it (decision P14), once; the new thread is shown
 * with the branch's author. A node without an answer, or moderated, removed
 * or deleted, is PRECONDITION_FAILED: a hidden node's text is never copied
 * to a thread that is not hidden. */
function promote(tx: Tx, id: string, th: string, nodeId: string) {
  const p = readableThread(tx, th);
  const n = readable(tx, nodeKey(nodeId), "node");
  if (n.th !== p.id) throw refuse("NOT_FOUND");
  if (p.mod === "removed" || n.mod === "removed") throw removed();
  notGone(p);
  if (n.del) throw deleted();
  if (n.mod !== null) throw refuse("PRECONDITION_FAILED", "This branch is hidden.");
  if (n.promoted !== null)
    throw refuse("PRECONDITION_FAILED", "This branch is already its own thread.");
  const a = tx.byKey(answerKey(n.id));
  if (a?.kind !== "answer") throw refuse("PRECONDITION_FAILED", "This branch has no answer yet.");
  const s = needSpace(tx, p.s);
  newThread(tx, s, {
    ...blank,
    id,
    u: n.u,
    k: "ask",
    q: n.q,
    tok: a.tok,
    src: a.pages.length,
    model: n.model,
    effort: n.effort,
    running: false,
    from: { th: p.id, node: n.id },
  });
  tx.put({ ...a, node: "r", th: id, mod: null });
  tx.put({ ...n, promoted: id });
  return { id, run: null, notified: [], notMembers: [] };
}
