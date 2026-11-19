// Threads, follow-ups (the nodes of an ask's tree) and replies, and the
// likes and saves that mark them.
//
// Stale intent: an author's edit carries `base.rev` of the record it edits
// (replica-proto's `threads.update`; here also follow-ups and replies) and is
// STALE when the rev differs.

import { spaces } from "@session/shared";
import { z } from "zod";

import { canRead, isClosed } from "../access.js";
import { defineMutator, inSpace, personal, type PreCtx, type Tx } from "../engine.js";
import { bad, notFound, refuse, stale } from "../errors.js";
import type { FollowUpRec, ThreadRec } from "../records.js";
import {
  countsOf,
  needSpace,
  ownMarkSpace,
  readable,
  readableThread,
  removed,
  text,
  writable,
} from "../rules.js";
import { baseS, nodeS, ulidS } from "../schemas.js";

const payS = z.string().nullable();

/** A payer other than the included tokens is an API key, which must be the
 * actor's (TODO(limits): the one check the mock makes). API keys are account
 * state no replica holds, so this is a server pre-check. */
const paidByKey = (pay: string | null | undefined) =>
  pay !== undefined && pay !== null && pay !== "session";

function ownPayer(ctx: PreCtx, pay: string | null | undefined) {
  if (paidByKey(pay) && !ctx.ownsKey(ctx.me, pay as string))
    throw refuse("FORBIDDEN", "This API key isn’t one of yours.");
  return {};
}

const deleted = (what: string) => refuse("PRECONDITION_FAILED", `This ${what} was deleted.`);

/** The author of a record, which they may still read. */
function author(tx: Tx, u: string) {
  if (u !== tx.me) throw refuse("FORBIDDEN", "Only the person who wrote this can change it.");
}

/** A follow-up of `thread` the actor may read, or NOT_FOUND. */
function followUpOf(tx: Tx, thread: string, id: string): FollowUpRec {
  const f = readable(tx, "followup", id);
  if (f.th !== thread) throw notFound();
  return f;
}

/** A reply of `thread` the actor may read, or NOT_FOUND. */
function replyOf(tx: Tx, thread: string, id: string) {
  const r = readable(tx, "reply", id);
  if (r.th !== thread) throw notFound();
  return r;
}

/** The text of an answer, clipped to `n` characters at a word (the mock's
 * `clipText`). */
const clip = (s: string, n: number) =>
  s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;

/** A topic of the space's FAQ landing, or null. */
const topicIn = (tx: Tx, sp: string, topic: string | null | undefined) => {
  const s = needSpace(tx, sp);
  return topic && s.faq && s.topics.some((x) => x[0] === topic) ? topic : null;
};

function startRun(tx: Tx, p: ThreadRec, attempt: number, pay: string | null, model: string | null) {
  const run = tx.id(1);
  tx.create({
    kind: "run",
    id: run,
    th: p.id,
    s: p.s,
    u: tx.me,
    node: "r",
    status: "queued",
    attempt,
    pay,
    model,
    createdAt: tx.now,
  });
  return run;
}

const threadInputS = spaces.createThreadInputSchema
  .pick({ kind: true, q: true, title: true, topic: true, model: true, skill: true, branch: true })
  .extend({
    id: ulidS,
    space: ulidS,
    pay: payS.optional(),
    about: spaces.askAboutSchema.strict().optional(),
    from: z.strictObject({ th: ulidS, node: nodeS }).optional(),
  })
  .strict();

export const threadMutators = [
  defineMutator({
    name: "threads.create",
    input: threadInputS,
    ids: (i) => [i.id],
    can: (tx, i) => {
      const scope = inSpace(tx, i.space, "member");
      if (i.from) {
        const src = readableThread(tx, i.from.th);
        const s = needSpace(tx, src.s);
        if (isClosed(s) && src.s !== i.space)
          throw refuse(
            "FORBIDDEN",
            "A branch of a thread in a closed space can only become a thread in the same space.",
          );
        if (i.from.node !== "r") {
          // DESIGN: the mock makes the new thread the asker's (the node's
          // author). Here only the asker may start a thread from their ask.
          const n = followUpOf(tx, src.id, i.from.node);
          if (n.u !== tx.me)
            throw refuse("FORBIDDEN", "Only the person who asked this can start a thread from it.");
        }
      }
      return scope;
    },
    needsPre: (i) => !i.from && paidByKey(i.pay),
    pre: (ctx, i) => ownPayer(ctx, i.pay),
    run: (tx, i) => {
      const s = writable(tx, i.space);
      if (i.kind === "post" && s.postsOff)
        throw refuse("PRECONDITION_FAILED", "Posts are turned off in this space.");
      const topic = topicIn(tx, s.id, i.topic);
      if (i.from) return fromBranch(tx, i.id, s.id, topic, i.from, i.title, i.branch);
      const q = text(i.q, "q");
      const ask = i.kind === "ask";
      tx.create({
        kind: "thread",
        id: i.id,
        s: s.id,
        u: tx.me,
        k: i.kind,
        q,
        t: i.title ?? null,
        sum: null,
        tok: 0,
        running: ask,
        edited: false,
        del: false,
        gone: false,
        mod: null,
        topic,
        topicBy: topic ? "asker" : null,
        pay: i.pay ?? null,
        model: i.model ?? null,
        about: i.about ?? null,
        skill: i.skill ?? null,
        att: ask ? 1 : 0,
        from: null,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      tx.put({ kind: "counts", th: i.id, s: s.id, likes: 0, r: 0 });
      const stats = tx.get("stats", s.id);
      if (stats) tx.put({ ...stats, posts: stats.posts + 1, updatedAt: tx.now });
      if (!ask) return { id: i.id, run: null };
      const p = tx.get("thread", i.id) as ThreadRec;
      return { id: i.id, run: startRun(tx, p, 1, i.pay ?? null, i.model ?? null) };
    },
    effects: (_i, result) => (result.run ? [{ type: "job", kind: "run", id: result.run }] : []),
  }),

  defineMutator({
    name: "threads.update",
    input: spaces.updateThreadInputSchema
      .pick({ id: true, q: true, run: true, model: true })
      .extend({ id: ulidS, base: baseS, pay: payS.optional() })
      .strict(),
    can: (tx, i) => {
      const p = readableThread(tx, i.id);
      const scope = inSpace(tx, p.s, "user");
      author(tx, p.u);
      return scope;
    },
    needsPre: (i) => i.run === true && paidByKey(i.pay),
    pre: (ctx, i) => ownPayer(ctx, i.pay),
    run: (tx, i) => {
      const p = readableThread(tx, i.id);
      if (p.mod === "removed") throw removed();
      if (p.del || p.gone) throw deleted("thread");
      if (p.rev !== i.base.rev) throw stale();
      const q = text(i.q, "q");
      const changed = q !== p.q;
      const next: ThreadRec = {
        ...p,
        q,
        t: changed ? null : p.t,
        edited: p.edited || changed,
        updatedAt: tx.now,
      };
      if (!i.run) {
        tx.put(next);
        return null;
      }
      const pay = i.pay ?? null;
      const ran: ThreadRec = {
        ...next,
        running: true,
        sum: null,
        tok: 0,
        pay,
        model: i.model ?? p.model,
        att: p.att + 1,
      };
      tx.put(ran);
      return { run: startRun(tx, ran, ran.att, pay, ran.model) };
    },
    effects: (_i, result) => (result ? [{ type: "job", kind: "run", id: result.run }] : []),
  }),

  defineMutator({
    name: "threads.delete",
    input: z.strictObject({ id: ulidS }),
    // the author may delete their thread without read access: a person
    // removed from a closed space can still delete what they wrote there
    can: (tx, i) => {
      const p = tx.get("thread", i.id);
      if (!p) throw notFound();
      const sp = p.u === tx.me ? p.s : readableThread(tx, i.id).s;
      const scope = inSpace(tx, sp, "user");
      author(tx, p.u);
      return scope;
    },
    // Kept as the mock has it (review round 1, R11): a thread deleted while
    // it has follow-ups or replies stays as a shell (`del`). A thread with
    // none is `gone`; it leaves every Saved and every like. The author may
    // delete a thread a moderator removed: its count `r` is 0 then, so it is
    // gone, and other people's saves of it are deleted too.
    run: (tx, i) => {
      const p = tx.get("thread", i.id) as ThreadRec;
      const counts = countsOf(tx, p);
      const kept = counts.r > 0;
      // an author who may no longer read the thread learns nothing about it
      const reads = canRead(tx, p, tx.me);
      if (!kept) {
        for (const l of tx.scan("like.th", p.id)) tx.del("like", `${l.u}:${l.th}`);
        for (const x of tx.scan("save.th", p.id)) tx.del("save", `${x.u}:${x.th}`);
      }
      for (const r of tx.scan("run.th", p.id)) tx.del("run", r.id);
      if (!kept) tx.put({ ...counts, likes: 0 });
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

  // A moderator moves a thread to a topic of its space (null: Other).
  defineMutator({
    name: "threads.move",
    input: z.strictObject({ id: ulidS, topic: z.string().nullable() }),
    can: (tx, i) => inSpace(tx, readableThread(tx, i.id).s, "moderator"),
    run: (tx, i) => {
      const p = readableThread(tx, i.id);
      const s = needSpace(tx, p.s);
      if (i.topic !== null && !s.topics.some((x) => x[0] === i.topic))
        throw refuse("NOT_FOUND", "The space has no topic like this.");
      tx.put({ ...p, topic: i.topic, topicBy: "mod" });
      return null;
    },
  }),

  defineMutator({
    name: "likes.set",
    input: z.strictObject({ thread: ulidS, on: z.boolean() }),
    can: (tx, i) => {
      const has = tx.get("like", `${tx.me}:${i.thread}`) !== undefined;
      const sp = i.on ? readableThread(tx, i.thread).s : ownMarkSpace(tx, has, i.thread);
      if (sp === null) return personal();
      const scope = inSpace(tx, sp, "user");
      if (i.on && !has && readableThread(tx, i.thread).mod === "removed") throw removed();
      return scope;
    },
    run: (tx, i) => {
      const had = tx.get("like", `${tx.me}:${i.thread}`) !== undefined;
      if (i.on === had) return { on: i.on };
      const c = tx.get("counts", i.thread);
      if (i.on) tx.put({ kind: "like", u: tx.me, th: i.thread, createdAt: tx.now });
      else tx.del("like", `${tx.me}:${i.thread}`);
      if (c) tx.put({ ...c, likes: Math.max(0, c.likes + (i.on ? 1 : -1)) });
      return { on: i.on };
    },
  }),

  // The mock's likes.toggleReply, with a reply id in place of a path and a
  // required `on`. Replies have no like count (the mock keeps none).
  defineMutator({
    name: "likes.setReply",
    input: z.strictObject({ reply: ulidS, on: z.boolean() }),
    can: (tx, i) => {
      const has = tx.get("rlike", `${tx.me}:${i.reply}`);
      if (!i.on) {
        const sp = has ? ownMarkSpace(tx, true, has.th) : null;
        return sp === null ? personal() : inSpace(tx, sp, "user");
      }
      const r = readable(tx, "reply", i.reply);
      const scope = inSpace(tx, r.s, "user");
      if (!has && r.mod === "removed") throw removed();
      return scope;
    },
    run: (tx, i) => {
      const had = tx.get("rlike", `${tx.me}:${i.reply}`) !== undefined;
      if (i.on === had) return { on: i.on };
      if (!i.on) tx.del("rlike", `${tx.me}:${i.reply}`);
      else {
        const r = readable(tx, "reply", i.reply);
        tx.put({ kind: "rlike", u: tx.me, th: r.th, reply: r.id, createdAt: tx.now });
      }
      return { on: i.on };
    },
  }),

  // The mock's saved.toggle, with a required `on`: the result depends on what
  // the client saw, not on the server's state, so two devices that save the
  // same thread do not cancel out. `ask`: "<thread>:<node>", node "r" for the
  // thread's ask. `source`: a source's id.
  defineMutator({
    name: "saved.set",
    input: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("thread"), id: ulidS, on: z.boolean() }),
      z.strictObject({
        kind: z.literal("ask"),
        id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}:(r|[0-7][0-9A-HJKMNP-TV-Z]{25})$/),
        on: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("source"),
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        on: z.boolean(),
      }),
    ]),
    can: (tx, i) => {
      if (i.kind === "source") {
        if (i.on) sourceMeta(tx, i.id);
        return personal();
      }
      const [th = "", node = "r"] = i.id.split(":");
      const has =
        i.kind === "thread"
          ? tx.get("save", `${tx.me}:${th}`) !== undefined
          : tx.get("asksave", `${tx.me}:${th}:${node}`) !== undefined;
      const sp = i.on ? readableThread(tx, th).s : ownMarkSpace(tx, has, th);
      return sp === null ? personal() : inSpace(tx, sp, "user");
    },
    run: (tx, i) => {
      if (i.kind === "source") {
        const has = tx.get("srcsave", `${tx.me}:${i.id}`) !== undefined;
        if (i.on && !has) tx.put({ kind: "srcsave", u: tx.me, src: i.id, createdAt: tx.now });
        if (!i.on && has) tx.del("srcsave", `${tx.me}:${i.id}`);
        return { on: i.on };
      }
      if (i.kind === "ask") {
        const [th = "", node = "r"] = i.id.split(":");
        const has = tx.get("asksave", `${tx.me}:${th}:${node}`) !== undefined;
        if (i.on && !has) tx.put({ kind: "asksave", u: tx.me, th, node, createdAt: tx.now });
        if (!i.on && has) tx.del("asksave", `${tx.me}:${th}:${node}`);
        return { on: i.on };
      }
      const had = tx.get("save", `${tx.me}:${i.id}`) !== undefined;
      if (i.on && !had) tx.put({ kind: "save", u: tx.me, th: i.id, createdAt: tx.now });
      if (!i.on && had) tx.del("save", `${tx.me}:${i.id}`);
      return { on: i.on };
    },
  }),

  defineMutator({
    name: "followups.ask",
    input: z.strictObject({ id: ulidS, thread: ulidS, q: z.string() }),
    ids: (i) => [i.id],
    can: (tx, i) => inSpace(tx, readableThread(tx, i.thread).s, "member"),
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      writable(tx, p.s);
      if (p.k !== "ask") throw bad("thread", "an ask thread");
      if (p.mod === "removed") throw removed();
      const q = text(i.q, "q");
      tx.create(followUp(tx, i.id, p, null, q, null, null, null));
      const c = countsOf(tx, p);
      tx.put({ ...c, r: c.r + 1 });
      return null;
    },
  }),

  // An ask about an answer in a thread's ask tree: `parent` "r" for the
  // thread's ask, else a follow-up. It is a follow-up whose `par` names the
  // follow-up it asks about; the client makes its id, as for followups.ask.
  defineMutator({
    name: "research.forkNode",
    input: spaces.forkNodeInputSchema
      .pick({ q: true, uses: true, model: true })
      .extend({ id: ulidS, thread: ulidS, parent: nodeS, pay: payS.optional() })
      .strict(),
    ids: (i) => [i.id],
    can: (tx, i) => inSpace(tx, readableThread(tx, i.thread).s, "member"),
    needsPre: (i) => paidByKey(i.pay),
    pre: (ctx, i) => ownPayer(ctx, i.pay),
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      writable(tx, p.s);
      if (p.k !== "ask") throw bad("thread", "an ask thread");
      if (p.mod === "removed") throw removed();
      const par = i.parent === "r" ? null : followUpOf(tx, p.id, i.parent);
      if (par?.mod === "removed") throw removed();
      const q = text(i.q, "q");
      tx.create(
        followUp(tx, i.id, p, par?.id ?? null, q, i.uses ?? null, i.pay ?? null, i.model ?? null),
      );
      if (par === null) {
        const c = countsOf(tx, p);
        tx.put({ ...c, r: c.r + 1 });
      }
      return { id: i.id };
    },
  }),

  defineMutator({
    name: "followups.update",
    input: z.strictObject({
      thread: ulidS,
      node: ulidS,
      q: z.string(),
      run: z.boolean().optional(),
      pay: payS.optional(),
      base: baseS,
    }),
    can: (tx, i) => {
      const f = followUpOf(tx, i.thread, i.node);
      const scope = inSpace(tx, f.s, "user");
      author(tx, f.u);
      return scope;
    },
    needsPre: (i) => i.run === true && paidByKey(i.pay),
    pre: (ctx, i) => ownPayer(ctx, i.pay),
    run: (tx, i) => {
      const f = followUpOf(tx, i.thread, i.node);
      if (f.mod === "removed") throw removed();
      if (f.del) throw deleted("follow-up");
      if (f.rev !== i.base.rev) throw stale();
      const q = text(i.q, "q");
      const changed = q !== f.q;
      tx.put({
        ...f,
        q,
        edited: f.edited || changed,
        ...(i.run ? { a: null, pay: i.pay ?? null, att: f.att + 1 } : {}),
      });
      return null;
    },
  }),

  // A follow-up with asks below it keeps its place as a shell; one without
  // is removed.
  defineMutator({
    name: "followups.delete",
    input: z.strictObject({ thread: ulidS, node: ulidS }),
    can: (tx, i) => {
      const f = followUpOf(tx, i.thread, i.node);
      const scope = inSpace(tx, f.s, "user");
      author(tx, f.u);
      return scope;
    },
    run: (tx, i) => {
      const f = followUpOf(tx, i.thread, i.node);
      const kept = tx.scan("followup.par", f.id).length > 0;
      if (kept) tx.put({ ...f, del: true, q: "", a: null, edited: false });
      else {
        tx.del("followup", f.id);
        if (f.par === null) {
          const p = tx.get("thread", f.th);
          if (p) {
            const c = countsOf(tx, p);
            tx.put({ ...c, r: Math.max(0, c.r - 1) });
          }
        }
      }
      return { kept };
    },
  }),

  /** A reply to a post (the mock's name for replies.create). */
  defineMutator({
    name: "research.createPostFollowUp",
    input: z.strictObject({ id: ulidS, thread: ulidS, t: z.string(), parent: ulidS.optional() }),
    ids: (i) => [i.id],
    can: (tx, i) => inSpace(tx, readableThread(tx, i.thread).s, "member"),
    run: (tx, i) => {
      const p = readableThread(tx, i.thread);
      writable(tx, p.s);
      if (p.k !== "post") throw bad("thread", "a post");
      if (p.mod === "removed") throw removed();
      if (i.parent !== undefined) {
        const top = readable(tx, "reply", i.parent);
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
      if (i.parent === undefined) {
        const c = countsOf(tx, p);
        tx.put({ ...c, r: c.r + 1 });
      }
      return null;
    },
  }),

  defineMutator({
    name: "replies.update",
    input: z.strictObject({ thread: ulidS, reply: ulidS, t: z.string(), base: baseS }),
    can: (tx, i) => {
      const r = replyOf(tx, i.thread, i.reply);
      const scope = inSpace(tx, r.s, "user");
      author(tx, r.u);
      return scope;
    },
    run: (tx, i) => {
      const r = replyOf(tx, i.thread, i.reply);
      if (r.mod === "removed") throw removed();
      if (r.del) throw deleted("reply");
      if (r.rev !== i.base.rev) throw stale();
      const t = text(i.t, "t");
      tx.put({ ...r, t, edited: r.edited || t !== r.t });
      return null;
    },
  }),

  // A top-level reply with replies keeps its place as a shell; any other is
  // removed, with its likes.
  defineMutator({
    name: "replies.delete",
    input: z.strictObject({ thread: ulidS, reply: ulidS }),
    can: (tx, i) => {
      const r = replyOf(tx, i.thread, i.reply);
      const scope = inSpace(tx, r.s, "user");
      author(tx, r.u);
      return scope;
    },
    run: (tx, i) => {
      const r = replyOf(tx, i.thread, i.reply);
      const kept = r.parent === null && tx.scan("reply.parent", r.id).length > 0;
      if (kept) tx.put({ ...r, del: true, t: "", edited: false });
      else {
        for (const l of tx.scan("rlike.reply", r.id)) tx.del("rlike", `${l.u}:${l.reply}`);
        tx.del("reply", r.id);
        if (r.parent === null) {
          const p = tx.get("thread", r.th);
          if (p) {
            const c = countsOf(tx, p);
            tx.put({ ...c, r: Math.max(0, c.r - 1) });
          }
        }
      }
      return { kept };
    },
  }),
];

function followUp(
  tx: Tx,
  id: string,
  p: ThreadRec,
  par: string | null,
  q: string,
  uses: string[] | null,
  pay: string | null,
  model: string | null,
): Omit<FollowUpRec, "rev"> {
  return {
    kind: "followup",
    id,
    th: p.id,
    s: p.s,
    par,
    u: tx.me,
    q,
    a: null,
    uses,
    pay,
    model,
    att: 1,
    edited: false,
    del: false,
    promoted: null,
    mod: null,
    createdAt: tx.now,
  };
}

/** A thread started from a follow-up of another thread's ask tree (the mock's
 * threads.create with `from`): the follow-up's ask and answer, and with
 * branch "all" the asks below it, copied with new ids. Hidden and removed
 * follow-ups, and those below them, are not copied. The follow-up links to
 * the new thread. */
function fromBranch(
  tx: Tx,
  id: string,
  sp: string,
  topic: string | null,
  from: { th: string; node: string },
  title: string | null | undefined,
  branch: "all" | "one" | undefined,
) {
  if (from.node === "r") throw bad("from.node", "a follow-up, not the thread’s first ask");
  const src = readableThread(tx, from.th);
  const n = followUpOf(tx, src.id, from.node);
  if (n.mod === "removed") throw removed();
  if (n.mod === "hidden") throw refuse("PRECONDITION_FAILED", "This item is hidden.");
  if (n.del) throw deleted("follow-up");
  const nodes = tx.scan("followup.th", src.id);
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const path = (x: FollowUpRec) => {
    const out: FollowUpRec[] = [];
    for (let y: FollowUpRec | undefined = x; y; y = y.par === null ? undefined : byId.get(y.par))
      out.unshift(y);
    return out;
  };
  /** The nodes from `n` down to `x`, or [] when `x` is not below `n`. */
  const fromN = (x: FollowUpRec) => {
    const p = path(x);
    const k = p.findIndex((y) => y.id === n.id);
    return k < 0 ? [] : p.slice(k + 1);
  };
  const copied =
    branch === "all"
      ? nodes.filter((x) => {
          const down = fromN(x);
          return down.length > 0 && down.every((y) => y.mod === null);
        })
      : [];
  const newId = new Map<string, string>();
  copied.forEach((x, k) => newId.set(x.id, tx.id(k + 1)));
  tx.create({
    kind: "thread",
    id,
    s: sp,
    u: tx.me,
    k: "ask",
    q: n.q,
    t: (title || n.q).trim(),
    sum: clip(n.a ?? "", 170),
    tok: 0,
    running: false,
    edited: false,
    del: false,
    gone: false,
    mod: null,
    topic,
    topicBy: null,
    pay: null,
    model: null,
    about: null,
    skill: null,
    att: 0,
    from: { th: src.id, node: n.id, lv: path(n).length },
    createdAt: tx.now,
    updatedAt: tx.now,
  });
  const p = tx.get("thread", id) as ThreadRec;
  let first = 0;
  for (const x of copied) {
    const par = x.par === n.id ? null : (newId.get(x.par ?? "") ?? null);
    if (par === null) first++;
    tx.create({
      ...followUp(tx, newId.get(x.id) as string, p, par, x.q, null, null, null),
      u: x.u,
      a: x.a,
      del: x.del,
      createdAt: x.createdAt,
    });
  }
  tx.put({ kind: "counts", th: id, s: sp, likes: 0, r: first });
  const stats = tx.get("stats", sp);
  if (stats) tx.put({ ...stats, posts: stats.posts + 1, updatedAt: tx.now });
  tx.put({ ...n, promoted: id });
  return { id, run: null };
}

/** A source's metadata as the actor may read it: Session's catalog, or a
 * space's copy they may read. NOT_FOUND otherwise. */
export function sourceMeta(tx: Tx, id: string) {
  const c = tx.get("source", id);
  if (c) return c.meta;
  const e = tx.scan("spacesrc.src", id).find((x) => canRead(tx, x, tx.me));
  if (!e) throw notFound();
  return e.meta;
}
