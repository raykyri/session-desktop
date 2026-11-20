// `01` U1: notifications commit with the write that causes them, and a
// refused or failed apply commits neither. Client prediction (`predict`)
// stops at a read the replica cannot answer.

import test from "ava";

import { MUTATORS, type AnyMutator } from "../src/index.js";

import { MODEL, ask, cast, fork, ok, post, refused, type World } from "./world.js";

/** For each mutator with a notify stage: a write that notifies someone. */
const CASES: Record<
  string,
  (w: World, th: { ask: string; node: string; post: string }) => [string, unknown]
> = {
  "threads.create": (w, x) => [
    "mel",
    { id: w.id(), space: postSpace(w, x.post), kind: "post", q: "@mona hi" },
  ],
  "research.forkNode": (w, x) => [
    "otto",
    { id: w.id(), thread: x.ask, parent: x.node, kind: "ask", q: "?", ...MODEL },
  ],
  "research.createPostFollowUp": (w, x) => ["otto", { id: w.id(), thread: x.post, t: "a reply" }],
  "comments.create": (w, x) => [
    "otto",
    { id: w.id(), thread: x.ask, node: x.node, t: "a comment" },
  ],
  "moderation.decide": (_w, x) => ["olga", { item: `p:${x.post}`, decision: "removed", note: "x" }],
};
const postSpace = (w: World, p: string) => (w.get(`thread:${p}`) as { s: string }).s;

test("every mutator with a notify stage is covered here", (t) => {
  t.deepEqual(
    Object.entries(MUTATORS)
      .filter(([, d]) => d.notify)
      .map(([n]) => n)
      .sort(),
    Object.keys(CASES).sort(),
  );
});

for (const [name, make] of Object.entries(CASES))
  test(`${name}: its notifications commit with the write, and with nothing after a refusal or a fault`, (t) => {
    const setup = () => {
      const { w, open } = cast(t);
      const a = ask(t, w, "mel", open);
      const node = fork(t, w, "mona", a);
      const p = post(t, w, "mel", open);
      return { w, x: { ask: a, node, post: p } };
    };
    // applied: the notification is there, written in the same commit
    {
      const { w, x } = setup();
      const before = w.all("notif").length;
      const [u, input] = make(w, x);
      ok(t, w.apply(u, name, input));
      t.true(w.all("notif").length > before || w.all("notif").some((n) => n.n > 1));
    }
    // a fault after `notify` wrote: nothing of the write is kept
    {
      const { w, x } = setup();
      const before = JSON.stringify([...w.store.records]);
      const def = MUTATORS[name] as AnyMutator;
      const faulty: AnyMutator = {
        ...def,
        notify: (tx, i, r) => {
          def.notify?.(tx, i, r);
          throw new TypeError("the commit failed");
        },
      };
      const [u, input] = make(w, x);
      refused(
        t,
        w.apply(u, name, input, { defs: { ...MUTATORS, [name]: faulty } }),
        "INTERNAL_SERVER_ERROR",
      );
      t.is(JSON.stringify([...w.store.records]), before);
    }
    // a refusal: the actor is banned, so no stage writes
    {
      const { w, x } = setup();
      const [u, input] = make(w, x);
      if (u !== "olga") {
        ok(t, w.apply("olga", "members.ban", { space: postSpace(w, x.post), user: u }));
        const before = JSON.stringify([...w.store.records]);
        refused(t, w.apply(u, name, input), "FORBIDDEN");
        t.is(JSON.stringify([...w.store.records]), before);
      } else {
        const before = JSON.stringify([...w.store.records]);
        refused(t, w.apply("mona", name, input), "FORBIDDEN");
        t.is(JSON.stringify([...w.store.records]), before);
      }
    }
  });

test("a client's prediction stops at a read its replica cannot answer", (t) => {
  const { w, open, closed } = cast(t);
  const p = post(t, w, "mel", open);
  // a replica that holds everything predicts the server's answer
  const save = w.predict("otto", "saved.set", { kind: "thread", id: p, on: true }).prediction;
  t.deepEqual(save, { ok: true, result: { on: true } });
  const no = w.predict("eve", "spaces.update", { id: open, desc: "x" }).prediction;
  t.like(no, { ok: false, error: { code: "FORBIDDEN" } });
  // an invite code is made by `pre`, on the server only
  t.deepEqual(
    w.predict("olga", "invites.create", { id: w.id(), space: closed, days: 7 }).prediction,
    { unknown: true },
  );
  // a joiner's replica has no invite links: the link's read is unknown
  t.deepEqual(
    w.predict("eve", "spaces.join", { space: closed, invite: "x" }, (k) => !k.startsWith("invite:"))
      .prediction,
    { unknown: true },
  );
  // a replica without the thread's saves cannot count them
  t.deepEqual(
    w.predict(
      "mona",
      "saved.set",
      { kind: "thread", id: p, on: true },
      (k) => !k.startsWith("save:"),
    ).prediction,
    { unknown: true },
  );
});
