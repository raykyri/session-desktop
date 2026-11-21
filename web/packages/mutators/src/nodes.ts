// Ask nodes and their runs (`03` §2): Continue, Branch, Branch here and Look
// up (`research.forkNode`, G1, G2), the author's edit and delete of a node
// (G6), cancel and run again (G6, E4). A run is a `run` record; one with
// status `queued` is the run queue (`03` E2), which nothing dispatches until
// the server's run loop does.

import { canRead } from "./access.js";
import { refuse } from "./errors.js";
import { Notifier } from "./notify.js";
import {
  answerKey,
  nodeKey,
  threadKey,
  type NodeRec,
  type RunRec,
  type ThreadRec,
} from "./records.js";
import {
  M,
  active,
  authorOf,
  bad,
  checkModel,
  deleted,
  nodeOf,
  notAuthor,
  ownOrReadable,
  preRun,
  queueRun,
  readable,
  readableThread,
  recount,
  removed,
  runOf,
  stale,
  text,
  ulidFields,
} from "./rules.js";
import { define, type Tx } from "./tx.js";
import { LOOKUP_PROMPT_V1, lookPhrase, onWordBoundaries } from "./validate.js";

/** A node reference that must name a node, not the root (`r`): the root is
 * the thread, which `threads.*` edit and delete. */
function nodeRef(tx: Tx, thread: string, ref: string, kind: "read" | "own"): NodeRec {
  if (ref === "r") throw bad("node", "a node: the root is the thread");
  const n =
    kind === "own" ? ownOrReadable(tx, nodeKey(ref), "node") : readable(tx, nodeKey(ref), "node");
  if (n.th !== thread) throw refuse("NOT_FOUND");
  return n;
}

/** The node (or root) whose author a write needs. */
function authorAt(tx: Tx, thread: string, ref: string): string {
  const p = readableThread(tx, thread);
  return authorOf(nodeOf(tx, p, ref));
}

/** End an active run: `cancelled`, stopped by its asker (`03` E4, G6). */
function cancel(tx: Tx, run: RunRec | undefined): void {
  if (!run || !active(run)) return;
  tx.put({
    ...run,
    status: "cancelled",
    fail: { why: "stopped", at: null, cls: null },
    finishedAt: tx.now,
  });
}

export const NODES = {
  // Continue, Branch, Branch here and Look up (`03` §2.1): a node and its
  // run, in one write. The node id is in the input, the run's is `tx.id(1)`.
  // The parent must exist, be readable, not be removed, and have an answer
  // to build on: a parent whose run is still queued or running is
  // PRECONDITION_FAILED (the mockup hides Continue and Branch while a node is
  // pending).
  "research.forkNode": define({
    input: ulidFields(M["research.forkNode"].input, ["id", "thread", "parent"]),
    who: "member",
    intent: "none",
    space: (tx, i) => readableThread(tx, i.thread).s,
    ids: (i) => [i.id],
    can: (_tx, i) => checkModel(i.model, i.effort),
    pre: preRun,
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      if (p.k !== "ask") throw bad("thread", "an ask thread");
      if (p.mod === "removed") throw removed();
      const parent = nodeOf(tx, p, i.parent);
      if (parent.mod === "removed") throw removed();
      if (active(runOf(tx, parent)))
        throw refuse("PRECONDITION_FAILED", "This ask is still running: wait for its answer.");
      let q: string;
      let look: string | null = null;
      if (i.kind === "ask") q = text(i.q, "q");
      else {
        look = lookPhrase(i.look);
        if (look === null) throw bad("look", "1 to 4 words");
        if (!onWordBoundaries(look, i.quote)) throw bad("look", "whole words of the quote");
        q = LOOKUP_PROMPT_V1(look);
      }
      const run = tx.id(1);
      tx.create({
        kind: "node",
        id: i.id,
        th: p.id,
        s: p.s,
        par: i.parent,
        k: i.kind,
        u: tx.me,
        q,
        look,
        quote: i.quote ?? null,
        b: i.b ?? null,
        tpl: i.kind === "lookup" ? 1 : null,
        model: i.model,
        effort: i.effort,
        run,
        promoted: null,
        mod: null,
        del: false,
        createdAt: tx.now,
      });
      queueRun(tx, run, p, i.id, i.model, i.effort);
      recount(tx, p);
      return { id: i.id, run };
    },
    // the parent's author gets a `branch` notification
    notify: (tx, i, _result, ctx) => {
      const p = tx.byKey(threadKey(i.thread)) as ThreadRec;
      const parent = i.parent === "r" ? p : (tx.byKey(nodeKey(i.parent)) as NodeRec);
      new Notifier(tx, ctx).send(authorOf(parent), "branch", p.s, p.id, nodeKey(i.id));
      return undefined;
    },
  }),

  // The author edits an ask's question (not a look-up's prompt, which the
  // client never shows); like `threads.update`, it compares the node's rev.
  "followups.update": define({
    input: ulidFields(M["followups.update"].input, ["thread", "node"]),
    who: "author",
    intent: "base.rev",
    space: (tx, i) => nodeRef(tx, i.thread, i.node, "read").s,
    can: (tx, i) => {
      if (nodeRef(tx, i.thread, i.node, "read").u !== tx.me) throw notAuthor();
    },
    run: (tx, i) => {
      const n = nodeRef(tx, i.thread, i.node, "read");
      if (n.mod === "removed") throw removed();
      if (n.del) throw deleted();
      if (n.k !== "ask") throw bad("node", "an ask: a look-up's prompt is not edited");
      if (n.rev !== i.base.rev) throw stale();
      tx.put({ ...n, q: text(i.q, "q") });
      return null;
    },
  }),

  // The author deletes a node (`03` G6): a run still queued or running is
  // cancelled first. A node with nodes or comments under it stays as a shell
  // without text (`del`), as a thread does; one without is erased with its
  // answer. The author may delete without read access, and in a frozen space.
  "followups.delete": define({
    input: ulidFields(M["followups.delete"].input, ["thread", "node"]),
    who: "author",
    intent: "as is",
    frozen: "allowed",
    space: (tx, i) => nodeRef(tx, i.thread, i.node, "own").s,
    can: (tx, i) => {
      if (nodeRef(tx, i.thread, i.node, "own").u !== tx.me) throw notAuthor();
    },
    run: (tx, i) => {
      const n = nodeRef(tx, i.thread, i.node, "own");
      const reads = canRead(tx, n, tx.me);
      const th = { th: n.th };
      const kept =
        tx.list("node", th).some((x) => x.par === n.id) ||
        tx.list("comment", th).some((x) => x.node === n.id);
      cancel(tx, runOf(tx, n));
      if (kept) tx.put({ ...n, q: "", look: null, quote: null, del: true });
      else {
        tx.del(answerKey(n.id));
        tx.del(nodeKey(n.id));
        recount(tx, tx.byKey(threadKey(n.th)) as ThreadRec);
      }
      return reads ? { kept } : null;
    },
  }),

  // Stop a run (`03` E4): `cancelled`, `fail.why: "stopped"`. A run that
  // already ended is left as it is.
  "research.cancelNode": define({
    input: ulidFields(M["research.cancelNode"].input, ["thread", "node"]),
    who: "author",
    intent: "as is",
    space: (tx, i) => readableThread(tx, i.thread).s,
    can: (tx, i) => {
      if (authorAt(tx, i.thread, i.node) !== tx.me) throw notAuthor();
    },
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      const n = nodeOf(tx, p, i.node);
      const run = runOf(tx, n);
      if (!active(run)) return null;
      cancel(tx, run);
      if (n.kind === "thread") tx.put({ ...p, running: false });
      return null;
    },
  }),

  // Run again (`03` E4): a run that ended `failed`, `cancelled` or
  // `interrupted` gets a new attempt, queued, with the model and effort the
  // person picks. `base.attempt` is the attempt the person saw stop: a run
  // retried since is STALE (M1b review 3).
  "research.retryNode": define({
    input: ulidFields(M["research.retryNode"].input, ["thread", "node"]),
    who: "author",
    intent: "base.attempt",
    space: (tx, i) => readableThread(tx, i.thread).s,
    can: (tx, i) => {
      if (authorAt(tx, i.thread, i.node) !== tx.me) throw notAuthor();
      checkModel(i.model, i.effort);
    },
    pre: preRun,
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      if (p.mod === "removed") throw removed();
      const n = nodeOf(tx, p, i.node);
      if (n.mod === "removed") throw removed();
      if (n.del) throw deleted();
      const run = runOf(tx, n);
      if (!run) throw refuse("PRECONDITION_FAILED", "This ask has no run.");
      if (run.attempt !== i.base.attempt) throw stale();
      if (run.status !== "failed" && run.status !== "cancelled" && run.status !== "interrupted")
        throw refuse("PRECONDITION_FAILED", "Only a run that stopped can run again.");
      tx.put({
        ...run,
        model: i.model,
        effort: i.effort,
        status: "queued",
        attempt: run.attempt + 1,
        step: 0,
        fail: null,
        tok: null,
        bill: null,
        note: null,
        startedAt: null,
        finishedAt: null,
      });
      if (n.kind === "thread") tx.put({ ...n, model: i.model, effort: i.effort, running: true });
      else tx.put({ ...n, model: i.model, effort: i.effort });
      return null;
    },
  }),
};
