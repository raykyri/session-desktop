// Replies to a post (`01` C5, C15): one level of nesting, a reply's parent
// is a top-level reply. The author edits (comparing the reply's rev) and
// deletes: a top-level reply with someone else's replies under it stays as
// an empty shell (`t: ""`, `del`); otherwise it is erased with the author's
// own replies under it (M1b review 9).

import { canRead } from "./access.js";
import { Notifier } from "./notify.js";
import { threadKey, type ThreadRec } from "./records.js";
import {
  M,
  bad,
  deleted,
  notAuthor,
  notFound,
  notGone,
  ownOrReadable,
  readable,
  readableThread,
  recount,
  removed,
  stale,
  text,
  ulidFields,
  ulidS,
} from "./rules.js";
import { define } from "./tx.js";

export const REPLIES = {
  /** A reply to a post (the mock's name for replies.create). */
  "research.createPostFollowUp": define({
    input: ulidFields(M["research.createPostFollowUp"].input, ["id", "thread", "parent"]),
    who: "member",
    intent: "none",
    space: (tx, i) => readableThread(tx, i.thread).s,
    ids: (i) => [i.id],
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      if (p.k !== "post") throw bad("thread", "a post");
      if (p.mod === "removed") throw removed();
      notGone(p);
      if (i.parent !== undefined) {
        const top = readable(tx, `reply:${i.parent}`, "reply");
        if (top.th !== p.id || top.parent !== null) throw notFound();
        if (top.mod === "removed") throw removed();
      }
      const t = text(i.t, "t");
      tx.create({
        kind: "reply",
        id: i.id,
        th: p.id,
        s: p.s,
        u: tx.me,
        t,
        parent: i.parent ?? null,
        edited: false,
        del: false,
        mod: null,
        createdAt: tx.now,
      });
      recount(tx, p);
      return { notified: [], notMembers: [] };
    },
    // the post's author gets a `reply` notification; mentioned accounts a
    // `mention`, named in the answer
    notify: (tx, i, _result, ctx) => {
      const p = tx.byKey(threadKey(i.thread)) as ThreadRec;
      const n = new Notifier(tx, ctx);
      n.send(p.u ?? "", "reply", p.s, p.id, `reply:${i.id}`);
      return n.mentions(i.t, p.s, p.id, `reply:${i.id}`);
    },
  }),

  "replies.update": define({
    input: M["replies.update"].input.extend({ id: ulidS }).strict(),
    who: "author",
    intent: "base.rev",
    space: (tx, i) => readable(tx, `reply:${i.id}`, "reply").s,
    can: (tx, i) => {
      if (readable(tx, `reply:${i.id}`, "reply").u !== tx.me) throw notAuthor();
    },
    run: (tx, i) => {
      const r = readable(tx, `reply:${i.id}`, "reply");
      if (r.mod === "removed") throw removed();
      if (r.del) throw deleted();
      if (r.rev !== i.base.rev) throw stale();
      const t = text(i.t, "t");
      tx.put({ ...r, t, edited: r.edited || t !== r.t });
      return null;
    },
  }),

  "replies.delete": define({
    input: M["replies.delete"].input.extend({ id: ulidS }).strict(),
    who: "author",
    intent: "as is",
    frozen: "allowed",
    space: (tx, i) => ownOrReadable(tx, `reply:${i.id}`, "reply").s,
    can: (tx, i) => {
      if (ownOrReadable(tx, `reply:${i.id}`, "reply").u !== tx.me) throw notAuthor();
    },
    run: (tx, i) => {
      const r = ownOrReadable(tx, `reply:${i.id}`, "reply");
      const reads = canRead(tx, r, tx.me);
      const under =
        r.parent === null ? tx.list("reply", { th: r.th }).filter((x) => x.parent === r.id) : [];
      const kept = under.some((x) => x.u !== tx.me);
      if (kept) tx.put({ ...r, t: "", del: true });
      else {
        for (const x of under) tx.del(`reply:${x.id}`);
        tx.del(`reply:${r.id}`);
        recount(tx, tx.byKey(threadKey(r.th)) as ThreadRec);
      }
      return reads ? { kept } : null;
    },
  }),
};
