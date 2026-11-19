// Invariant 1: the server applies only a mutator's name and input. It runs
// the pre-checks, `can` and `run` itself, on its own state, and never accepts
// client-computed changes.

import test from "ava";

import { MUTATORS, PROTOCOL_VERSION, type CountsRec, type ThreadRec } from "../src/index.js";

import { World, actor, cast, ok, refused, thread } from "./harness.js";

test("a write the actor's role forbids is refused and changes nothing", async (t) => {
  const { w, closed } = await cast(t);
  const before = JSON.stringify([...w.server.dump()]);
  // mel is a plain member: admins change roles, moderators remove people
  await refused(
    t,
    w.as("mel", "members.setRole", {
      space: closed,
      user: "mel",
      role: "owner",
      base: w.member(closed, "mel"),
    }),
    "FORBIDDEN",
  );
  await refused(
    t,
    w.as("mel", "members.setRole", {
      space: closed,
      user: "mona",
      role: "member",
      base: w.member(closed, "mona"),
    }),
    "FORBIDDEN",
  );
  await refused(
    t,
    w.as("mel", "members.remove", { space: closed, user: "mona", base: w.admission(closed, "mona") }),
    "FORBIDDEN",
  );
  await refused(t, w.as("mel", "spaces.update", { id: closed, set: { vis: "open" } }), "FORBIDDEN");
  // a moderator cannot act on an admin, nor give a role above their own
  await refused(
    t,
    w.as("mona", "members.remove", { space: closed, user: "ada", base: w.admission(closed, "ada") }),
    "FORBIDDEN",
  );
  await refused(
    t,
    w.as("ada", "members.setRole", {
      space: closed,
      user: "mel",
      role: "owner",
      base: w.member(closed, "mel"),
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
  await refused(t, w.as("eve", "likes.set", { thread: th, on: true, likes: 999 }), "BAD_REQUEST");
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
    w.as("eve", "spaces.update", { id: open, set: { members: 999 } }),
    "BAD_REQUEST",
  );
  await refused(t, w.as("eve", "spaces.join", { space: open, role: "owner" }), "BAD_REQUEST");
  const p = w.get(`thread:${th}`) as ThreadRec;
  t.is((w.get(`counts:${th}`) as CountsRec).likes, 0);
  t.is(p.u, "mel");
  t.is(w.get(`member:${open}:eve`), undefined);
});

test("the server writes the author, the counts and the time from its own state", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  // two clients that each saw likes: 0 like the thread: the stored count is 2
  await ok(t, w.as("otto", "likes.set", { thread: th, on: true }));
  await ok(t, w.as("mona", "likes.set", { thread: th, on: true }));
  // a repeated like changes nothing
  await ok(t, w.as("mona", "likes.set", { thread: th, on: true }));
  const p = w.get(`thread:${th}`) as ThreadRec;
  t.is((w.get(`counts:${th}`) as CountsRec).likes, 2);
  t.is(p.u, "mel");
  t.is(p.createdAt, new Date(w.clock.now()).toISOString().replace(/\.\d{3}Z$/, "Z"));
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
    await refused(
      t,
      w.as("olga", "members.setRole", {
        space: open,
        user: u,
        role: "mod",
        base: w.member(open, u),
      }),
      "BAD_REQUEST",
    );
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
  try {
    globalThis.Date = Trapped;
    Math.random = trap("Math.random");
    Object.defineProperty(globalThis, "Intl", { value: undefined, configurable: true });
    await ok(t, w.as("mel", "threads.create", { id: th, space: closed, kind: "ask", q: "Q" }));
    await ok(t, w.as("mona", "followups.ask", { id: fu, thread: th, q: "F" }));
    await ok(t, w.as("mel", "threads.create", { id: post, space: open, kind: "post", q: "P" }));
    await ok(t, w.as("otto", "research.createPostFollowUp", { id: rep, thread: post, t: "R" }));
    await ok(t, w.as("otto", "likes.set", { thread: post, on: true }));
    await ok(t, w.as("otto", "saved.set", { kind: "thread", id: post, on: true }));
    const rev = (w.get(`thread:${th}`) as ThreadRec).rev;
    await ok(t, w.as("mel", "invites.create", { id: w.id(), space: closed, days: 3 }));
    await ok(t, w.as("mel", "reports.create", { id: w.id(), item: `p:${post}`, why: "spam" }));
    await ok(
      t,
      w.as("mona", "moderation.decide", {
        item: `p:${post}`,
        decision: "hidden",
        base: w.item(`p:${post}`),
      }),
    );
    await ok(t, w.as("mel", "threads.update", { id: th, q: "Q2", base: { rev } }));
    await ok(
      t,
      w.as("ada", "spaces.update", {
        id: closed,
        set: { rules: ["Be kind."] },
        base: { rulesRev: 0 },
      }),
    );
    await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
    await ok(
      t,
      w.as("mona", "joinRequests.decide", {
        space: closed,
        users: ["otto"],
        decision: "approve",
        base: w.requests(closed, ["otto"]),
      }),
    );
    await ok(
      t,
      w.as("mona", "members.ban", { space: closed, user: "otto" }),
    );
    await ok(t, w.as("mel", "threads.delete", { id: post }));
  } finally {
    globalThis.Date = RealDate;
    Math.random = realRandom;
    Object.defineProperty(globalThis, "Intl", { value: realIntl, configurable: true });
  }
  t.pass();
});

test("every ported mutator refuses a signed-out caller and extra input fields", async (t) => {
  const { w } = await cast(t);
  for (const name of Object.keys(MUTATORS)) {
    await refused(t, w.as(null, name, {}), "UNAUTHORIZED");
    await refused(t, w.as("eve", name, { forged: true }), "BAD_REQUEST");
  }
});
