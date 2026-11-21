// Comments on an ask node (`01` C4; `03` G4): a discussion under a branch
// that starts no run, nested like replies (a parent is a top-level comment on
// the same node). The author edits (comparing the comment's rev) and
// deletes: a top-level comment with comments under it stays as an empty
// shell (`t: ""`, `del`), one without is erased.

import { canRead } from "./access.js";
import { Notifier } from "./notify.js";
import { nodeKey, threadKey, type NodeRec, type ThreadRec } from "./records.js";
import {
  M,
  authorOf,
  bad,
  deleted,
  nodeOf,
  notAuthor,
  notFound,
  notGone,
  ownOrReadable,
  readable,
  readableThread,
  removed,
  stale,
  text,
  ulidFields,
  ulidS,
} from "./rules.js";
import { define } from "./tx.js";

export const COMMENTS = {
  "comments.create": define({
    input: ulidFields(M["comments.create"].input, ["id", "thread", "node", "parent"]),
    who: "member",
    intent: "none",
    space: (tx, i) => readableThread(tx, i.thread).s,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      if (p.k !== "ask") throw bad("thread", "an ask thread");
      if (p.mod === "removed") throw removed();
      notGone(p);
      const node = nodeOf(tx, p, i.node);
      if (node.mod === "removed") throw removed();
      if (i.parent !== undefined) {
        const top = readable(tx, `comment:${i.parent}`, "comment");
        if (top.th !== p.id || top.node !== i.node || top.parent !== null) throw notFound();
        if (top.mod === "removed") throw removed();
      }
      const t = text(i.t, "t");
      tx.create({
        kind: "comment",
        id: i.id,
        th: p.id,
        s: p.s,
        node: i.node,
        parent: i.parent ?? null,
        u: tx.me,
        t,
        edited: false,
        del: false,
        mod: null,
        createdAt: tx.now,
      });
      return { notified: [], notMembers: [] };
    },
    // the node's author gets a `comment` notification; mentioned accounts a
    // `mention`, named in the answer
    notify: (tx, i, _result, ctx) => {
      const p = tx.byKey(threadKey(i.thread)) as ThreadRec;
      const node = i.node === "r" ? p : (tx.byKey(nodeKey(i.node)) as NodeRec);
      const n = new Notifier(tx, ctx);
      n.send(authorOf(node), "comment", p.s, p.id, `comment:${i.id}`);
      return n.mentions(i.t, p.s, p.id, `comment:${i.id}`);
    },
  }),

  "comments.update": define({
    input: M["comments.update"].input.extend({ id: ulidS }).strict(),
    who: "author",
    intent: "base.rev",
    space: (tx, i) => readable(tx, `comment:${i.id}`, "comment").s,
    can: (tx, i) => {
      if (readable(tx, `comment:${i.id}`, "comment").u !== tx.me) throw notAuthor();
    },
    run: (tx, i) => {
      const c = readable(tx, `comment:${i.id}`, "comment");
      if (c.mod === "removed") throw removed();
      if (c.del) throw deleted();
      if (c.rev !== i.base.rev) throw stale();
      const t = text(i.t, "t");
      tx.put({ ...c, t, edited: c.edited || t !== c.t });
      return null;
    },
  }),

  "comments.delete": define({
    input: M["comments.delete"].input.extend({ id: ulidS }).strict(),
    who: "author",
    intent: "as is",
    frozen: "allowed",
    space: (tx, i) => ownOrReadable(tx, `comment:${i.id}`, "comment").s,
    can: (tx, i) => {
      if (ownOrReadable(tx, `comment:${i.id}`, "comment").u !== tx.me) throw notAuthor();
    },
    run: (tx, i) => {
      const c = ownOrReadable(tx, `comment:${i.id}`, "comment");
      const reads = canRead(tx, c, tx.me);
      const kept =
        c.parent === null && tx.list("comment", { th: c.th }).some((x) => x.parent === c.id);
      if (kept) tx.put({ ...c, t: "", del: true });
      else tx.del(`comment:${c.id}`);
      return reads ? { kept } : null;
    },
  }),
};
