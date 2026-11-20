// Invariant 1: the server applies only a mutator's name and input. It runs
// the pre-checks, `can` and `run` itself, on its own state, and never accepts
// client-computed changes.

import { spaces } from "@session/shared";
import test from "ava";

import { PROTO_MUTATORS, PROTOCOL_VERSION, type CountsRec, type ThreadRec } from "../src/index.js";

import { MODEL, World, actor, answer, cast, forkInput, ok, refused, thread } from "./harness.js";

test("a write the actor's role forbids is refused and changes nothing", async (t) => {
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "ada", closed, "post");
  const before = JSON.stringify([...w.server.dump()]);
  // mel is a member: only the owner removes, bans, edits About, makes
  // invite links and moderates (`01` C18)
  for (const [name, input] of [
    ["members.remove", { space: closed, user: "mona", base: w.admission(closed, "mona") }],
    ["members.ban", { space: closed, user: "mona" }],
    ["members.unban", { space: closed, user: "mona" }],
    ["spaces.update", { id: closed, desc: "Mine now." }],
    ["invites.create", { id: w.id(), space: closed, days: 7 }],
    ["moderation.decide", { item: `p:${th}`, decision: "removed" }],
    ["moderation.decide", { item: `p:${th}`, decision: "hidden" }],
    [
      "joinRequests.decide",
      { space: closed, users: ["mel"], decision: "decline", base: { mel: 0 } },
    ],
  ] as const)
    await refused(t, w.as("mel", name, input), "FORBIDDEN");
  // the owner acts on anyone but themselves
  await refused(t, w.as("olga", "members.ban", { space: closed, user: "olga" }), "FORBIDDEN");
  await refused(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "olga",
      base: w.admission(closed, "olga"),
    }),
    "FORBIDDEN",
  );
  // nobody outside the space writes in it
  await refused(
    t,
    w.as("eve", "threads.create", { id: w.id(), space: closed, kind: "post", q: "hi" }),
    "FORBIDDEN",
  );
  t.is(JSON.stringify([...w.server.dump()]), before);
});

test("client-computed fields in an input are refused, not stored", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  await refused(
    t,
    w.as("eve", "saved.set", { kind: "thread", id: th, on: true, saves: 999 }),
    "BAD_REQUEST",
  );
  await refused(
    t,
    w.as("eve", "threads.create", { id: w.id(), space: open, kind: "post", q: "x", u: "olga" }),
    "BAD_REQUEST",
  );
  await refused(
    t,
    w.as("eve", "threads.create", {
      id: w.id(),
      space: open,
      kind: "post",
      q: "x",
      author: "olga",
    }),
    "BAD_REQUEST",
  );
  await refused(
    t,
    w.as("eve", "threads.create", {
      id: w.id(),
      space: open,
      kind: "post",
      q: "x",
      createdAt: "2020-01-01T00:00:00Z",
    }),
    "BAD_REQUEST",
  );
  await refused(
    t,
    w.as("olga", "spaces.update", { id: open, desc: "x", members: 999 }),
    "BAD_REQUEST",
  );
  await refused(
    t,
    w.as("olga", "spaces.update", { id: open, desc: "x", owner: "eve" }),
    "BAD_REQUEST",
  );
  await refused(t, w.as("eve", "spaces.join", { space: open, role: "owner" }), "BAD_REQUEST");
  const p = w.get(`thread:${th}`) as ThreadRec;
  t.is((w.get(`counts:${th}`) as CountsRec).saves, 0);
  t.is(p.u, "mel");
  t.is(w.get(`member:${open}:eve`), undefined);
});

test("the server writes the author, the counts and the time from its own state", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  // two clients that each saw saves: 0 save the thread: the stored count is 2
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: true }));
  await ok(t, w.as("mona", "saved.set", { kind: "thread", id: th, on: true }));
  // a repeated save changes nothing
  await ok(t, w.as("mona", "saved.set", { kind: "thread", id: th, on: true }));
  const p = w.get(`thread:${th}`) as ThreadRec;
  t.is((w.get(`counts:${th}`) as CountsRec).saves, 2);
  t.is(p.u, "mel");
  t.is(p.createdAt, new Date(w.clock.now()).toISOString().replace(/\.\d{3}Z$/, "Z"));
});

test("a private space serves a save count of 3 or more only; an open space every count", async (t) => {
  // `01` C1, decision S6: with few members a count of 1 could name the saver
  const { w, open, closed } = await cast(t);
  const th = await thread(t, w, "ada", closed, "post");
  const counts = () => w.get(`counts:${th}`) as CountsRec;
  const rev = counts().rev;
  const save = (u: string, on: boolean) =>
    ok(t, w.as(u, "saved.set", { kind: "thread", id: th, on }));
  await save("mel", true);
  await save("mona", true);
  // below 3 the counts record is not written: no change reaches a reader
  t.deepEqual([counts().saves, counts().rev], [0, rev]);
  await save("olga", true);
  t.is(counts().saves, 3);
  await save("mel", false);
  t.is(counts().saves, 0);
  const snap = await w.server.snapshot(actor("ada"), `space:${closed}`);
  t.is((snap.records.find((x) => x.key === `counts:${th}`)?.record as CountsRec).saves, 0);
  const post = await thread(t, w, "mel", open, "post");
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: post, on: true }));
  t.is((w.get(`counts:${post}`) as CountsRec).saves, 1);
});

test("an envelope that carries changes or other extra fields is refused", async (t) => {
  const { w, open } = await cast(t);
  const env = {
    ...(await w.envelope("eve", "threads.create", {
      id: w.id(),
      space: open,
      kind: "post",
      q: "x",
    })),
    changes: [{ key: `space:${open}`, op: "put", record: { members: 999 } }],
  };
  const r = await w.server.apply(actor("eve"), env);
  t.false(r.ok);
  t.is(r.ok ? null : r.error.code, "BAD_REQUEST");
  t.is(w.server.dump().get(`member:${open}:eve`), undefined);
});

test("an unknown mutator name is refused, including names on Object.prototype", async (t) => {
  const w = new World();
  for (const name of [
    "spaces.destroyAll",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "",
  ])
    await refused(t, w.as("eve", name, {}), "NOT_FOUND");
  t.is(w.server.dump().size, 0);
});

test("a malformed or missing input is refused", async (t) => {
  const { w, open } = await cast(t);
  for (const input of [undefined, null, 1, "x", [], { space: open }])
    await refused(t, w.as("eve", "threads.create", input), "BAD_REQUEST");
});

test("a signed-out caller and an old protocol version are refused", async (t) => {
  const { w, open } = await cast(t);
  await refused(t, w.as(null, "spaces.join", { space: open }), "UNAUTHORIZED");
  const old = {
    ...(await w.envelope("eve", "spaces.join", { space: open })),
    protocolVersion: PROTOCOL_VERSION - 1,
  };
  // "Update Session" has its own code, apart from a refusal on the item's state
  await refused(t, w.server.apply(actor("eve"), old), "UPGRADE_REQUIRED");
  t.is(w.server.dump().get(`member:${open}:eve`), undefined);
  // nothing was recorded: the same seq and mutation id work once the client is current
  await ok(t, w.server.apply(actor("eve"), { ...old, protocolVersion: PROTOCOL_VERSION }));
});

test("the handles null and undefined are reserved, and a signed-out caller has no user log", async (t) => {
  const { w, open } = await cast(t);
  for (const u of ["null", "undefined"]) {
    await refused(t, w.as(u, "spaces.join", { space: open }), "UNAUTHORIZED");
    t.false((await w.server.register(actor(u))).ok);
    await refused(t, w.as("olga", "members.ban", { space: open, user: u }), "BAD_REQUEST");
  }
  t.false([...w.server.dump().keys()].some((k) => k.endsWith(":null") || k.endsWith(":undefined")));
  for (const log of ["user:null", "user:undefined"] as const) {
    const s = await w.server.snapshot(null, log);
    t.deepEqual(s.records, []);
    const p = await w.server.pull(null, log, s.cursor);
    t.deepEqual("resync" in p ? null : p.changes, []);
  }
});

test("mutators read no clock, no random source and no Intl while the server applies them", async (t) => {
  const { w, open, closed } = await cast(t);
  const RealDate = Date;
  const realRandom = Math.random;
  const realIntl = globalThis.Intl;
  const trap = (what: string) => () => {
    throw new Error(`a mutator read ${what}`);
  };
  // `new Date(ms)` and `Date.parse` are pure; `new Date()` and `Date.now()` read the clock
  const Trapped = new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      if (args.length === 0) trap("the clock")();
      return new target(...(args as [number]));
    },
    apply: trap("the clock"),
    get(target, prop, recv) {
      if (prop === "now") return trap("the clock");
      return Reflect.get(target, prop, recv) as unknown;
    },
  });
  const th = w.id();
  const fu = w.id();
  const rep = w.id();
  const post = w.id();
  const look = w.id();
  try {
    globalThis.Date = Trapped;
    Math.random = trap("Math.random");
    Object.defineProperty(globalThis, "Intl", { value: undefined, configurable: true });
    await ok(
      t,
      w.as("mel", "threads.create", { id: th, space: closed, kind: "ask", q: "Q", ...MODEL }),
    );
    // the runs finish (the server's run loop, outside the mutators)
    await answer(w, `thread:${th}`);
    await ok(t, w.as("mona", "research.forkNode", forkInput(fu, th, "F")));
    await answer(w, `node:${fu}`, "F's answer");
    await ok(
      t,
      w.as("ada", "research.forkNode", {
        id: look,
        thread: th,
        parent: fu,
        kind: "lookup",
        look: "“tide gauge”,",
        quote: "Each tide gauge records the sea level.",
        b: 2,
        ...MODEL,
      }),
    );
    await ok(
      t,
      w.as("mel", "comments.create", { id: w.id(), thread: th, node: fu, t: "@mona why?" }),
    );
    await ok(
      t,
      w.as("mel", "threads.create", { id: post, space: open, kind: "post", q: "P @otto" }),
    );
    await ok(t, w.as("otto", "research.createPostFollowUp", { id: rep, thread: post, t: "R" }));
    await ok(t, w.as("otto", "saved.set", { kind: "thread", id: post, on: true }));
    const rev = (w.get(`thread:${th}`) as ThreadRec).rev;
    await ok(t, w.as("olga", "invites.create", { id: w.id(), space: closed, days: 3 }));
    await ok(
      t,
      w.as("olga", "moderation.decide", {
        item: `p:${post}`,
        decision: "hidden",
        base: w.item(`p:${post}`),
      }),
    );
    await ok(
      t,
      w.as("olga", "moderation.decide", {
        item: `r:${post}:${rep}`,
        decision: "removed",
        note: "x",
      }),
    );
    await ok(t, w.as("mel", "threads.update", { id: th, q: "Q2", base: { rev } }));
    await ok(t, w.as("olga", "spaces.update", { id: closed, desc: "Be kind." }));
    await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
    await ok(
      t,
      w.as("olga", "joinRequests.decide", {
        space: closed,
        users: ["otto"],
        decision: "approve",
        base: w.requests(closed, ["otto"]),
      }),
    );
    await ok(t, w.as("olga", "members.ban", { space: closed, user: "otto" }));
    await ok(t, w.as("olga", "members.unban", { space: closed, user: "otto" }));
    await ok(t, w.as("mel", "threads.delete", { id: post }));
    await ok(t, w.as("mel", "prefs.set", { layout: "wide" }));
    const n = w.notifs("mona")[0];
    await ok(t, w.as("mona", "notifications.markRead", { id: n?.id ?? "" }));
    await ok(t, w.as("mona", "notifications.markAllRead", {}));
    // the nodes, replies, comments, runs and links the plan adds (`01` U5)
    const node = w.rev(`node:${fu}`);
    await ok(
      t,
      w.as("mona", "followups.update", { thread: th, node: fu, q: "F2", base: { rev: node } }),
    );
    await ok(t, w.as("ada", "research.cancelNode", { thread: th, node: look }));
    await ok(t, w.as("ada", "research.retryNode", { thread: th, node: look, ...MODEL }));
    await ok(t, w.as("mel", "threads.create", { id: w.id(), from: { th, node: fu } }));
    const c = w.id();
    await ok(t, w.as("ada", "comments.create", { id: c, thread: th, node: fu, t: "C" }));
    await ok(
      t,
      w.as("ada", "comments.update", { id: c, t: "C2", base: { rev: w.rev(`comment:${c}`) } }),
    );
    await ok(t, w.as("ada", "comments.delete", { id: c }));
    const r2 = w.id();
    await ok(t, w.as("mona", "research.createPostFollowUp", { id: r2, thread: post, t: "R2" }));
    await ok(
      t,
      w.as("mona", "replies.update", { id: r2, t: "R3", base: { rev: w.rev(`reply:${r2}`) } }),
    );
    await ok(t, w.as("mona", "replies.delete", { id: r2 }));
    const link = w.id();
    await ok(t, w.as("olga", "invites.create", { id: link, space: closed, days: 1 }));
    await ok(t, w.as("olga", "invites.revoke", { id: link }));
    await ok(t, w.as("olga", "invites.restore", { id: link }));
    await ok(t, w.as("ada", "followups.delete", { thread: th, node: look }));
  } finally {
    globalThis.Date = RealDate;
    Math.random = realRandom;
    Object.defineProperty(globalThis, "Intl", { value: realIntl, configurable: true });
  }
  // every record a mutator wrote has the shared contract's stored shape, with
  // no per-viewer field (`01` U3); join requests are the prototype's own kind
  const kinds = new Set<string>();
  for (const [k, r] of w.server.dump()) {
    kinds.add(r.kind);
    if (r.kind === "request") continue;
    const p = spaces.storedRecordSchema.safeParse(r);
    t.true(p.success, `${k}: ${JSON.stringify(p.error?.issues[0])}`);
    for (const f of ["mine", "saved", "liked", "likes"]) t.false(f in r, `${k} has ${f}`);
  }
  t.deepEqual([...kinds].sort(), [
    "answer",
    "comment",
    "counts",
    "invite",
    "member",
    "modlog",
    "node",
    "notif",
    "prefs",
    "reply",
    "request",
    "run",
    "save",
    "space",
    "stats",
    "thread",
  ]);
});

test("every ported mutator refuses a signed-out caller and extra input fields", async (t) => {
  const { w } = await cast(t);
  for (const name of Object.keys(PROTO_MUTATORS)) {
    await refused(t, w.as(null, name, {}), "UNAUTHORIZED");
    await refused(t, w.as("eve", name, { forged: true }), "BAD_REQUEST");
  }
});
