// Replies to a post (`01` C5, C15): one level of nesting, a reply's parent
// is a top-level reply. The author edits (comparing the reply's rev) and
// deletes: a top-level reply with replies under it stays as an empty shell
// (`t: ""`, `del`), one without is erased.

import { canRead } from "./access.js";
import { Notifier } from "./notify.js";
import { threadKey, type ThreadRec } from "./records.js";
import {
  M,
  bad,
  deleted,
  notAuthor,
  notFound,
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
      return null;
    },
    // the post's author gets a `reply` notification; mentioned members a `mention`
    notify: (tx, i) => {
      const p = tx.byKey(threadKey(i.thread)) as ThreadRec;
      const n = new Notifier(tx);
      n.send(p.u ?? "", "reply", p.s, p.id, `reply:${i.id}`);
      n.mentions(i.t, p.s, p.id, `reply:${i.id}`);
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
      const kept =
        r.parent === null && tx.list("reply", { th: r.th }).some((x) => x.parent === r.id);
      if (kept) tx.put({ ...r, t: "", del: true });
      else {
        tx.del(`reply:${r.id}`);
        recount(tx, tx.byKey(threadKey(r.th)) as ThreadRec);
      }
      return reads ? { kept } : null;
    },
  }),
};
