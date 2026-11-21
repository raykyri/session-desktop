// Moderation by the owner (`01` C12; `04` §6), invite links (`04` §5),
// saves (`01` C1) and preferences (`01` C13).

import { spaces } from "@session/shared";
import test from "ava";

import { DAY, World, ask, cast, fork, ok, post, refused } from "./world.js";

test("shown compares the item's rev; hidden and removed act on it as it is", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const item = `p:${p}`;
  refused(t, w.apply("mona", "moderation.decide", { item, decision: "hidden" }), "FORBIDDEN");
  ok(t, w.apply("olga", "moderation.decide", { item, decision: "hidden", base: { rev: 0 } }));
  const rev = w.rev(`thread:${p}`);
  ok(t, w.apply("mel", "threads.update", { id: p, q: "edited while hidden", base: { rev } }));
  refused(
    t,
    w.apply("olga", "moderation.decide", { item, decision: "shown", base: { rev } }),
    "STALE",
  );
  refused(t, w.apply("olga", "moderation.decide", { item, decision: "shown" }), "BAD_REQUEST");
  ok(
    t,
    w.apply("olga", "moderation.decide", {
      item,
      decision: "shown",
      base: { rev: w.rev(`thread:${p}`) },
    }),
  );
  t.like(w.get(`thread:${p}`), { mod: null });
});

test("removing a thread erases everything under it, logs the removal and notifies the author with the reason only", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const n = fork(t, w, "mona", th);
  ok(t, w.apply("otto", "comments.create", { id: w.id(), thread: th, node: n, t: "@mona" }));
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: th, on: true }));
  ok(
    t,
    w.apply("olga", "moderation.decide", { item: `a:${th}`, decision: "removed", note: " Spam " }),
  );
  t.like(w.get(`thread:${th}`), { mod: "removed", modBy: "olga", modNote: "Spam" });
  // the placeholder keeps nothing else of the removed content (C12)
  const placeholder = spaces.removedThreadRecordSchema.safeParse(w.get(`thread:${th}`));
  t.true(placeholder.success, JSON.stringify(placeholder.error?.issues));
  for (const kind of ["node", "answer", "comment", "run", "save"] as const)
    t.deepEqual(
      w.all(kind).filter((r) => "th" in r && r.th === th),
      [],
      kind,
    );
  t.false(w.all("notif").some((x) => x.type === "mention" && x.th === th));
  t.like(w.get(`counts:${th}`), { r: 0, saves: 0 });
  t.deepEqual(
    w.all("modlog").map((m) => [m.act, m.item, m.author, m.note]),
    [["remove", `a:${th}`, "mel", "Spam"]],
  );
  const removed = w.notifs("mel").filter((x) => x.type === "removed");
  t.deepEqual(
    removed.map((x) => [x.item, x.actor, x.note]),
    [[`thread:${th}`, null, "Spam"]],
  );
  refused(
    t,
    w.apply("olga", "moderation.decide", { item: `a:${th}`, decision: "hidden" }),
    "PRECONDITION_FAILED",
  );
  // the author may still delete it
  ok(t, w.apply("mel", "threads.delete", { id: th }));
});

test("an invite link's code comes from the server, and it expires within 1 to 30 days", (t) => {
  const { w, closed } = cast(t);
  const id = w.id();
  const r = ok(t, w.apply("olga", "invites.create", { id, space: closed, days: 30 })) as {
    code: string;
  };
  t.regex(r.code, /^[0-9a-hjkmnp-tv-z]{26}$/);
  t.like(w.get(`invite:${id}`), {
    code: r.code,
    by: "olga",
    dead: null,
    expiresAt: "2026-12-16T10:00:00Z",
  });
  for (const days of [0, 31, 1.5])
    refused(
      t,
      w.apply("olga", "invites.create", { id: w.id(), space: closed, days }),
      "BAD_REQUEST",
    );
  refused(
    t,
    w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7, code: "x" }),
    "BAD_REQUEST",
  );
});

test("revoking a link stops it, its Undo restores it, and a used link stays used", (t) => {
  const { w, closed } = cast(t);
  const id = w.id();
  const { code } = ok(t, w.apply("olga", "invites.create", { id, space: closed, days: 7 })) as {
    code: string;
  };
  refused(t, w.apply("ada", "invites.revoke", { id }), "NOT_FOUND");
  ok(t, w.apply("olga", "invites.revoke", { id }));
  refused(t, w.apply("eve", "spaces.join", { space: closed, invite: code }), "FORBIDDEN");
  ok(t, w.apply("olga", "invites.restore", { id }));
  ok(t, w.apply("eve", "spaces.join", { space: closed, invite: code }));
  refused(t, w.apply("olga", "invites.revoke", { id }), "PRECONDITION_FAILED");
  refused(t, w.apply("olga", "invites.restore", { id }), "PRECONDITION_FAILED");
});

test("saves are counted; a private space serves a count below 3 as 0; two devices saving do not cancel", (t) => {
  const { w, open, closed } = cast(t);
  const p = post(t, w, "mel", open);
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: true }));
  ok(t, w.apply("otto", "saved.set", { kind: "thread", id: p, on: true }));
  t.like(w.get(`counts:${p}`), { saves: 1 });
  const q = post(t, w, "olga", closed);
  ok(t, w.apply("ada", "saved.set", { kind: "thread", id: q, on: true }));
  ok(t, w.apply("olga", "saved.set", { kind: "thread", id: q, on: true }));
  t.like(w.get(`counts:${q}`), { saves: 0 });
  w.advance(DAY);
  ok(t, w.apply("ada", "saved.set", { kind: "thread", id: q, on: false }));
  ok(t, w.apply("ada", "saved.set", { kind: "thread", id: q, on: true }));
  t.like(w.get(`counts:${q}`), { saves: 0 });
  // taking back a save needs no read access
  ok(t, w.apply("eve", "saved.set", { kind: "thread", id: q, on: false }));
  refused(t, w.apply("eve", "saved.set", { kind: "thread", id: q, on: true }), "NOT_FOUND");
});

test("prefs.set keeps the layout in the person's user log", (t) => {
  const w = new World();
  ok(t, w.apply("mel", "prefs.set", { layout: "wide" }));
  const rev = w.rev("prefs:mel");
  ok(t, w.apply("mel", "prefs.set", { layout: "wide" }));
  t.is(w.rev("prefs:mel"), rev);
  t.like(w.get("prefs:mel"), { u: "mel", layout: "wide" });
  refused(t, w.apply("mel", "prefs.set", { layout: "narrow" }), "BAD_REQUEST");
});

test("removing a node or its thread also removes the threads opened from it (M1b review 14)", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open);
  const n = fork(t, w, "mona", th);
  const deep = fork(t, w, "otto", th, n);
  const copy = w.id();
  const deepCopy = w.id();
  ok(t, w.apply("otto", "threads.create", { id: copy, from: { th, node: n } }));
  ok(t, w.apply("mel", "threads.create", { id: deepCopy, from: { th, node: deep } }));
  // the node's removal: its copy, and the copy of a node under it
  ok(
    t,
    w.apply("olga", "moderation.decide", {
      item: `f:${th}:${n}`,
      decision: "removed",
      note: "spam",
    }),
  );
  for (const id of [copy, deepCopy]) {
    t.like(w.get(`thread:${id}`), { mod: "removed", q: "", from: null, modNote: "spam" });
    t.is(w.get(`answer:${id}`), undefined);
  }
  // the thread's removal: the copy of a node of it
  const th2 = ask(t, w, "mel", open);
  const m = fork(t, w, "mona", th2);
  const copy2 = w.id();
  ok(t, w.apply("otto", "threads.create", { id: copy2, from: { th: th2, node: m } }));
  ok(t, w.apply("olga", "moderation.decide", { item: `a:${th2}`, decision: "removed" }));
  t.like(w.get(`thread:${copy2}`), { mod: "removed", q: "", from: null });
  t.is(w.get(`answer:${copy2}`), undefined);
});
