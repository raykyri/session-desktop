// Review round 1 of phase 2: the mutator rules from the 2b design findings
// (1: a declined request waits 14 days; 4: who may start a thread from a
// branch; 5: pages.move takes an absolute position) and an admin-only model
// in the server's pre-check (reviewer A's F1).

import test from "ava";

import { DECLINE_WAIT_DAYS } from "../src/defs/members.js";
import type { FollowUpRec, PagesRec, RequestRec, ThreadRec } from "../src/index.js";

import { DAY, World, admit, cast, ok, refused, thread } from "./world.js";

const rec = <T>(w: World, key: string) => w.get(key) as T;

test("a declined request: asked again or withdrawn only once 14 days passed; reopen and approve clear the wait", (t) => {
  const { w, closed } = cast(t);
  ok(t, w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }));
  ok(t, w.run("olga", "joinRequests.decide", { space: closed, users: ["eve"], decision: "decline" }));
  const r = rec<RequestRec>(w, `request:${closed}:eve`);
  t.is(r.st, "declined");
  t.is(r.retryAt, new Date(w.now + DECLINE_WAIT_DAYS * DAY).toISOString().replace(".000Z", "Z"));
  const again = refused(
    t,
    w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }),
    "PRECONDITION_FAILED",
  );
  t.is(again?.retryAt, r.retryAt ?? undefined);
  refused(t, w.run("eve", "joinRequests.withdraw", { space: closed }), "PRECONDITION_FAILED");
  w.advance(DECLINE_WAIT_DAYS * DAY - 1000);
  refused(
    t,
    w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }),
    "PRECONDITION_FAILED",
  );
  w.advance(1000);
  ok(t, w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }));
  t.like(rec<RequestRec>(w, `request:${closed}:eve`), { st: "open", retryAt: null });
  // reopen (Undo) clears the wait; so does an approval
  ok(t, w.run("olga", "joinRequests.decide", { space: closed, users: ["eve"], decision: "decline" }));
  ok(
    t,
    w.run("olga", "joinRequests.decide", {
      space: closed,
      users: ["eve"],
      decision: "reopen",
      base: w.requests(closed, ["eve"]),
    }),
  );
  t.like(rec<RequestRec>(w, `request:${closed}:eve`), { st: "open", retryAt: null });
  ok(t, w.run("eve", "joinRequests.withdraw", { space: closed }));
  t.is(w.get(`request:${closed}:eve`), undefined);
  // a request stored before retryAt existed has no wait
  ok(t, w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }));
  const old = { ...rec<RequestRec>(w, `request:${closed}:eve`), st: "declined" as const };
  delete old.retryAt;
  w.store.commit([[`request:${closed}:eve`, old]]);
  ok(t, w.run("eve", "joinRequests.create", { space: closed, rulesAccepted: true }));
});

test("a thread from a branch: the asker, the thread's owner or a moderator starts it, and it is the asker's", (t) => {
  const { w, open, closed } = cast(t);
  const th = thread(t, w, "otto", open, "ask", "Root?");
  const ask = (u: string, q: string, par = "r") => {
    const id = w.id();
    ok(t, w.run(u, "research.forkNode", { id, thread: th, parent: par, q }));
    return id;
  };
  const melAsk = ask("mel", "Mel's ask?");
  ask("mel", "Mel's next?", melAsk);
  const from = (u: string, node: string, extra: object = {}) =>
    w.run(u, "threads.create", {
      id: w.id(),
      space: open,
      kind: "ask",
      q: "",
      from: { th, node },
      ...extra,
    });
  // another member may not
  refused(t, from("eve", melAsk), "FORBIDDEN");
  ok(t, w.run("eve", "spaces.join", { space: open }));
  refused(t, from("eve", melAsk), "FORBIDDEN");
  // the thread's owner (otto), a moderator (mona) and the asker (mel) may
  for (const u of ["otto", "mona", "mel"]) {
    const o = from(u, melAsk, { branch: "all" });
    const id = (ok(t, o) as { id: string }).id;
    t.like(rec<ThreadRec>(w, `thread:${id}`), { u: "mel", q: "Mel's ask?" }, u);
    const copies = [...w.store.records.values()].filter(
      (r): r is FollowUpRec => r.kind === "followup" && r.th === id,
    );
    t.deepEqual(
      copies.map((c) => [c.u, c.q]),
      [["mel", "Mel's next?"]],
      u,
    );
  }
  // an asker banned from the space: nobody makes them a thread there
  ok(t, w.run("olga", "members.ban", { space: open, user: "mel" }));
  refused(t, from("mona", melAsk), "FORBIDDEN");
  // in a closed space the asker must still be a member
  const lab = thread(t, w, "olga", closed, "ask", "Lab?");
  const labAsk = w.id();
  admit(t, w, closed, "otto");
  ok(t, w.run("otto", "research.forkNode", { id: labAsk, thread: lab, parent: "r", q: "Otto?" }));
  ok(t, w.run("otto", "spaces.leave", { space: closed }));
  refused(
    t,
    w.run("olga", "threads.create", {
      id: w.id(),
      space: closed,
      kind: "ask",
      q: "",
      from: { th: lab, node: labAsk },
    }),
    "FORBIDDEN",
  );
});

test("pages.move puts a page at an absolute position; the same move twice is the same as once", (t) => {
  const { w, open } = cast(t);
  const ids = ["A", "B", "C"].map((title) => {
    const id = w.id();
    ok(t, w.run("mona", "pages.update", { space: open, id, title, text: [title] }));
    return id;
  });
  const order = () => rec<PagesRec>(w, `pages:${open}`).list.map((p) => p.t);
  t.deepEqual(order(), ["A", "B", "C"]);
  const move = (page: string | undefined, to: number) =>
    w.run("mona", "pages.move", { space: open, page, to });
  ok(t, move(ids[0], 2));
  t.deepEqual(order(), ["B", "C", "A"]);
  ok(t, move(ids[0], 2));
  t.deepEqual(order(), ["B", "C", "A"]);
  ok(t, move(ids[2], 0));
  t.deepEqual(order(), ["C", "B", "A"]);
  ok(t, move(ids[1], 1));
  t.deepEqual(order(), ["C", "B", "A"]);
  refused(t, move(ids[1], 3), "BAD_REQUEST");
  refused(t, move(ids[1], -1), "BAD_REQUEST");
  refused(t, move(w.id(), 0), "NOT_FOUND");
  refused(t, w.run("mel", "pages.move", { space: open, page: ids[1], to: 0 }), "FORBIDDEN");
});

test("an admin-only model on the included tokens needs the server's yes; a key of the asker's or a device does not", (t) => {
  const { w, open } = cast(t);
  const askWith = (extra: object) =>
    w.run("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "Q?", ...extra });
  // the world's server gives no answer: refused
  refused(t, askWith({ model: "claude-fable" }), "FORBIDDEN");
  refused(t, askWith({ model: "claude-fable", pay: "session" }), "FORBIDDEN");
  w.key("mel", "K1");
  ok(t, askWith({ model: "claude-fable", pay: "K1" }));
  w.device("mel", "D1");
  ok(t, askWith({ model: "claude-fable", executor: { kind: "device", cli: "claude", device: "D1" } }));
  ok(t, askWith({ model: "gemini-flash" }));
});
