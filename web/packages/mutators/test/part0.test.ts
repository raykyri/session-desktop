// The mutator changes of phase 1b, Part 0 (brief-1b.md), one test or more
// each: invite notifications carry their link, device records, hide records,
// STALE's `current`, and skill records.

import test from "ava";

import {
  ID_KINDS,
  MUTATORS,
  apply,
  logsOf,
  view,
  viewDependents,
  withOwnIds,
  type Reader,
  type StoredRecord,
} from "../src/index.js";

import { admit, cast, ok, refused, thread, type World } from "./world.js";

const rec = <K extends StoredRecord["kind"]>(w: World, key: string, kind: K) => {
  const r = w.get(key);
  if (r?.kind !== kind) throw new Error(`${key}: no ${kind}`);
  return r as Extract<StoredRecord, { kind: K }>;
};
const reader = (w: World): Reader => ({
  get: (kind, id) => w.store.records.get(`${kind}:${id}`) as never,
});

/** An invite notification the server wrote for `to`, carrying link `link`. */
function inviteNote(w: World, to: string, sp: string, link: string | null): string {
  const n = w.id();
  w.store.commit([
    [
      `notif:${n}`,
      {
        kind: "notif",
        id: n,
        to,
        type: "invite",
        sp,
        report: null,
        item: null,
        outcome: null,
        response: null,
        actor: "olga",
        thread: null,
        node: null,
        invite: link,
        read: false,
        createdAt: "2026-11-15T00:00:00Z",
      },
    ],
  ]);
  return n;
}

test("1. an invite notification carries its link: joining from it uses the link", (t) => {
  const { w, vault } = cast(t);
  const link = w.id();
  ok(t, w.run("olga", "invites.create", { id: link, space: vault }));
  const n = inviteNote(w, "eve", vault, link);
  // a notification without a link admits nobody (phase 0)
  const bare = inviteNote(w, "eve", vault, null);
  refused(t, w.run("eve", "spaces.join", { space: vault, notification: bare }), "FORBIDDEN");
  // another person's notification is not found
  refused(t, w.run("mel", "spaces.join", { space: vault, notification: n }), "NOT_FOUND");
  ok(t, w.run("eve", "spaces.join", { space: vault, notification: n }));
  t.like(rec(w, `member:${vault}:eve`, "member"), { role: "member" });
  t.like(rec(w, `notif:${n}`, "notif"), { read: true, response: "accepted" });
  t.like(rec(w, `invite:${link}`, "invite"), { dead: "Used", usedBy: "eve" });
  // the link is used up: a second notification with it admits nobody
  const again = inviteNote(w, "otto", vault, link);
  refused(t, w.run("otto", "spaces.join", { space: vault, notification: again }), "FORBIDDEN");
  // a revoked link's notification admits nobody
  const l2 = w.id();
  ok(t, w.run("olga", "invites.create", { id: l2, space: vault }));
  ok(t, w.run("olga", "invites.revoke", { id: l2 }));
  const revoked = inviteNote(w, "mel", vault, l2);
  refused(t, w.run("mel", "spaces.join", { space: vault, notification: revoked }), "FORBIDDEN");
});

test("2. a device record is its person's, without a token; `can` checks a device run's device", (t) => {
  const { w, open } = cast(t);
  t.true(ID_KINDS.has("device"));
  w.device("mel", "MAC1");
  const d = rec(w, "device:MAC1", "device");
  t.deepEqual(logsOf(d), ["user:mel"]);
  t.false(Object.keys(d).some((k) => /token|secret|hash/i.test(k)));
  t.truthy(view(reader(w), d, "mel"));
  t.is(view(reader(w), d, "otto"), null);
  const mac = { kind: "device", cli: "claude", device: "MAC1" } as const;
  const input = { id: w.id(), space: open, kind: "ask", q: "Q", executor: mac };
  // otto may not run on mel's device: refused by `can`, which a client predicts
  const otto = apply(
    MUTATORS,
    w.store,
    { u: "otto" },
    { mutationId: w.id(), name: "threads.create", input, clientTime: w.now },
    { now: w.now },
  );
  t.is(otto.status === "refused" ? otto.error.code : otto.status, "FORBIDDEN");
  // mel's own: `can` passes; only the hourly limit (the pre-check) is the server's
  const mel = apply(
    MUTATORS,
    w.store,
    { u: "mel" },
    { mutationId: w.id(), name: "threads.create", input, clientTime: w.now },
    { now: w.now },
  );
  t.is(mel.status, "unknown");
  ok(t, w.run("mel", "threads.create", input));
  // a revoked device (the record deleted) runs nothing
  w.store.commit([["device:MAC1", null]]);
  refused(t, w.run("mel", "threads.create", { ...input, id: w.id() }), "FORBIDDEN");
});

test("3. hiding writes a hide record and leaves the item's rev; an author's queued edit is not STALE", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const seen = w.rev(`thread:${th}`);
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
  t.is(w.rev(`thread:${th}`), seen);
  const h = rec(w, `hide:thread:${th}`, "hide");
  t.like(h, { item: `thread:${th}`, s: open, ed: 0 });
  t.deepEqual(logsOf(h), [`space:${open}`]);
  t.deepEqual(viewDependents(h), [`thread:${th}`]);
  // the text is the author's and the moderators' only
  const r = reader(w);
  const p = rec(w, `thread:${th}`, "thread");
  t.is((view(r, p, "otto") as typeof p).q, "");
  t.is((view(r, p, null) as typeof p).q, "");
  t.is((view(r, p, "mel") as typeof p).q, p.q);
  t.is((view(r, p, "mona") as typeof p).q, p.q);
  // mel's edit, made before the hide, applies (the thread's rev did not move)
  ok(t, w.run("mel", "threads.update", { id: th, q: "Edited", base: { rev: seen } }));
  // and moves the hide record: a "shown" decided on the earlier text is STALE
  const after = rec(w, `hide:thread:${th}`, "hide");
  t.is(after.ed, 1);
  t.is(after.rev, h.rev + 1);
  refused(
    t,
    w.run("mona", "moderation.decide", {
      item: `a:${th}`,
      decision: "shown",
      base: { rev: h.rev },
    }),
    "STALE",
  );
  ok(
    t,
    w.run("mona", "moderation.decide", {
      item: `a:${th}`,
      decision: "shown",
      base: { rev: after.rev },
    }),
  );
  t.is(w.get(`hide:thread:${th}`), undefined);
  t.is((view(r, rec(w, `thread:${th}`, "thread"), "otto") as typeof p).q, "Edited");
  // hiding again continues the hide record's rev
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
  t.is(rec(w, `hide:thread:${th}`, "hide").rev, after.rev + 1);
  // a removal erases the item and drops the hide records of it and below it
  const f = w.id();
  ok(t, w.run("otto", "followups.ask", { id: f, thread: th, q: "F" }));
  ok(t, w.run("mona", "moderation.decide", { item: `f:${th}:${f}`, decision: "hidden" }));
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  t.is(w.get(`hide:thread:${th}`), undefined);
  t.is(w.get(`hide:followup:${f}`), undefined);
  t.like(rec(w, `thread:${th}`, "thread"), { mod: "removed", q: "" });
});

test("3. replies and follow-ups: hide records, and a deleted reply takes its hide record", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "otto", open, "post");
  const r1 = w.id();
  ok(t, w.run("mel", "research.createPostFollowUp", { id: r1, thread: th, t: "R" }));
  const rev = w.rev(`reply:${r1}`);
  ok(t, w.run("mona", "moderation.decide", { item: `r:${th}:${r1}`, decision: "hidden" }));
  t.is(w.rev(`reply:${r1}`), rev);
  ok(t, w.run("mel", "replies.update", { thread: th, reply: r1, t: "R2", base: { rev } }));
  t.is(rec(w, `hide:reply:${r1}`, "hide").ed, 1);
  ok(t, w.run("mel", "replies.delete", { thread: th, reply: r1 }));
  t.is(w.get(`hide:reply:${r1}`), undefined);
});

test("4. STALE carries `current`: the target as the actor reads it now, and the keys answered", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const old = w.rev(`thread:${th}`);
  ok(t, w.run("mel", "threads.update", { id: th, q: "Second", base: { rev: old } }));
  const e = refused(
    t,
    w.run("mel", "threads.update", { id: th, q: "x", base: { rev: old } }),
    "STALE",
  );
  t.like(e?.current ?? {}, { kind: "thread", id: th, q: "Second" });
  t.deepEqual(e?.reads, [`thread:${th}`]);
  // a hidden item's current is redacted for a reader who may not read its text
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
  const h = w.rev(`hide:thread:${th}`);
  ok(
    t,
    w.run("mel", "threads.update", { id: th, q: "Third", base: { rev: w.rev(`thread:${th}`) } }),
  );
  const s = refused(
    t,
    w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "shown", base: { rev: h } }),
    "STALE",
  );
  t.like(s?.current ?? {}, { q: "Third" });
  t.deepEqual(s?.reads, [`thread:${th}`, `hide:thread:${th}`]);
  // a role change on a person who is no longer a member: current null, the key answered
  const gone = refused(
    t,
    w.run("olga", "members.setRole", {
      space: open,
      user: "eve",
      role: "mod",
      base: { rev: 3 },
    }),
    "STALE",
  );
  t.is(gone?.current, null);
  t.deepEqual(gone?.reads, [`member:${open}:eve`]);
});

test("5. skills are records with ids in ID_KINDS; the order record's rev is the reorder's base", (t) => {
  const { w, open, closed } = cast(t);
  t.true(ID_KINDS.has("skill"));
  const [a, b] = [w.id(), w.id()];
  ok(t, w.run("mona", "skills.create", { id: a, space: open, name: "A", prompt: "a" }));
  ok(t, w.run("mona", "skills.create", { id: b, space: open, name: "B", prompt: "b" }));
  t.like(rec(w, `skill:${a}`, "skill"), { sp: open, name: "A", ver: 0 });
  t.deepEqual(rec(w, `skills:${open}`, "skills").order, [a, b]);
  // the id registry vouches for a skill's id: a replica predicts the create
  const c = w.id();
  const own = withOwnIds(
    { get: (k, id) => w.store.get(k, id), scan: (i, v) => w.store.scan(i, v), idUsed: () => false },
    { user: "mona", minted: new Set([c]), mutations: new Set() },
  );
  const guess = apply(
    MUTATORS,
    own,
    { u: "mona" },
    {
      mutationId: w.id(),
      name: "skills.create",
      input: { id: c, space: open, name: "C", prompt: "c" },
      clientTime: w.now,
    },
    { now: w.now },
  );
  t.is(guess.status, "ok");
  // an id used by any record is CONFLICT, here a thread's
  const th = thread(t, w, "mel", open);
  refused(
    t,
    w.run("mona", "skills.create", { id: th, space: open, name: "T", prompt: "t" }),
    "CONFLICT",
  );
  // an edit does not change the order: a reorder decided before it applies
  const seen = w.rev(`skills:${open}`);
  ok(t, w.run("mona", "skills.update", { space: open, id: a, name: "A", prompt: "a2" }));
  t.is(w.rev(`skills:${open}`), seen);
  ok(t, w.run("mona", "skills.reorder", { space: open, order: [b, a], base: { rev: seen } }));
  // a removal does: a reorder decided before it is STALE, with the order now
  const before = w.rev(`skills:${open}`);
  ok(t, w.run("mona", "skills.remove", { space: open, id: b }));
  const e = refused(
    t,
    w.run("mona", "skills.reorder", { space: open, order: [a, b], base: { rev: before } }),
    "STALE",
  );
  t.like(e?.current ?? {}, { kind: "skills", order: [a] });
  t.is(w.get(`skill:${b}`), undefined);
  // a skill of another space is not found by id
  admit(t, w, closed, "otto");
  refused(
    t,
    w.run("olga", "skills.update", { space: closed, id: a, name: "X", prompt: "x" }),
    "NOT_FOUND",
  );
  // deleting the space erases its skills and order
  ok(t, w.run("olga", "spaces.delete", { id: open }));
  t.is(w.get(`skill:${a}`), undefined);
  t.is(w.get(`skills:${open}`), undefined);
});
