// The attacks of review round 2 (S1, S2, H1, Q1, Q3, Q2, E1, R1, T1) and
// the mutations that survived it (N2, N3, N23, N28, N29, N30), each ported
// as a test that the server refuses or filters the attack, and the envelope
// fields of protocol version 4 (Y1: `queuedAt`, `replaces`, TOO_LARGE). The
// invariant files hold the general cases; these keep each attack's own
// scenario. H2 (report notifications for staff) and the first E1 test (the
// effect worker's retries and dead letters) went with reporting and the
// effect queue (`01` U6).

import test from "ava";

import {
  PROTO_MUTATORS,
  ReplicaClient,
  refuse,
  type Actor,
  type AnyMutator,
  type CountsRec,
  type ApplyResult,
  type Envelope,
  type LogId,
  type ServerHalf,
  type ThreadRec,
} from "../src/index.js";

import {
  DAY,
  HOUR,
  MINUTE,
  MODEL,
  ManualClock,
  actor,
  admit,
  cast,
  forkInput,
  ok,
  refused,
  thread,
} from "./harness.js";

const codes = (rs: ApplyResult[]) => rs.map((r) => (r.ok ? "ok" : r.error.code));

test("S1: a read shows no version, and its token's length depends only on the log and the reader", async (t) => {
  const { w, open, closed } = await cast(t);
  await thread(t, w, "mel", open, "post", "public 1");
  const a = await w.server.snapshot(null, `space:${open}`);
  for (let k = 0; k < 5; k++) await thread(t, w, "mel", closed, "post", `secret ${k}`);
  await thread(t, w, "otto", open, "post", "public 2");
  const b = await w.server.snapshot(null, `space:${open}`);
  // nothing in a read is a version: a snapshot has records, a token and lastSeq
  t.deepEqual(Object.keys(b).sort(), ["cursor", "lastSeq", "records"]);
  t.is(a.cursor.length, b.cursor.length);
  // the token: a random IV, the sealed fixed-size head and [log, reader], a tag
  const log = `space:${open}`;
  const sealed = (cursor: string) => Buffer.from(cursor, "base64url");
  t.is(sealed(b.cursor).length, 12 + 29 + JSON.stringify([log, null]).length + 16);
  t.false(sealed(b.cursor).includes(Buffer.from(log)));
  // eve's own writes, sampled between others' commits, show nothing either
  const mine = w.id();
  await ok(t, w.as("eve", "spaces.create", { id: mine, name: "probe" }));
  const probe = await thread(t, w, "eve", mine, "post");
  const sample = async (on: boolean) => {
    await ok(t, w.as("eve", "saved.set", { kind: "thread", id: probe, on }));
    return (await w.server.snapshot(actor("eve"), `space:${mine}`)).cursor;
  };
  const tokens = [await sample(true)];
  await thread(t, w, "mel", closed, "post", "secret A");
  await ok(t, w.as("olga", "members.ban", { space: closed, user: "otto" }));
  tokens.push(await sample(false));
  w.clock.advance(HOUR);
  tokens.push(await sample(true));
  t.is(new Set(tokens.map((x) => x.length)).size, 1);
  t.is(new Set(tokens).size, 3);
});

test("S2: reads keep no state; client records expire after 90 idle days; 20 registrations a day", async (t) => {
  const { w, open } = await cast(t);
  const size = async () => {
    const s = await w.server.scanStorage();
    return JSON.stringify(
      Object.fromEntries(Object.entries(s).map(([k, v]) => [k, (v as unknown[]).length])),
    );
  };
  const before = await size();
  let cursor = (await w.server.snapshot(null, `space:${open}`)).cursor;
  for (let k = 0; k < 2000; k++) {
    await w.server.snapshot(null, `space:${open}`);
    const p = await w.server.pull(null, `space:${open}`, cursor);
    if (!("resync" in p)) cursor = p.cursor;
  }
  t.is(await size(), before);
  // registrations: 20 a day per person
  const regs: string[] = [];
  for (let k = 0; k < 25; k++) {
    const r = await w.server.register(actor("eve"));
    regs.push(r.ok ? "ok" : r.error.code);
  }
  t.is(regs.filter((x) => x === "ok").length, 20);
  t.is(regs.at(-1), "TOO_MANY_REQUESTS");
  t.true((await w.server.register(actor("otto"))).ok);
  w.clock.advance(DAY + 1);
  t.true((await w.server.register(actor("eve"))).ok);
  // a client record used within 90 days stays; one idle for 90 days goes
  const used = await w.clientId("mel");
  const clients = async () => (await w.server.scanStorage()).clients.length;
  t.true((await clients()) > 20);
  w.clock.advance(88 * DAY);
  await w.server.snapshot(actor("mel"), "user:mel", { clientId: used });
  w.clock.advance(2 * DAY);
  const left = (await w.server.scanStorage()).clients.map((x) => x.clientId);
  t.deepEqual(left, [used]);
  t.deepEqual((await w.server.scanStorage()).registrations, []);
});

test("S2: a client whose id expired registers again and sends its write; a stored answer replays under the new id", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  // a device whose client id expired while it was off for 91 days
  const old = w.client("otto");
  await old.register();
  w.clock.advance(91 * DAY);
  const back = new ReplicaClient(
    w.server,
    actor("otto"),
    { clock: w.clock, random: w.random },
    old.state(),
  );
  back.queue("saved.set", { kind: "thread", id: th, on: true });
  t.deepEqual(codes(await back.flush()), ["ok"]);
  t.deepEqual(
    (await Promise.all(back.sent.map((e) => w.resend("otto", e)))).map((r) =>
      r.ok ? "ok" : r.error.code,
    ),
    ["WRONG_CLIENT", "ok"],
  );
  t.not(back.clientId, old.clientId);
  t.is((w.get(`counts:${th}`) as CountsRec).saves, 1);
  // a write whose answer was lost, sent again from a client id the server no
  // longer knows: the device registers again, and the stored answer replays
  let lose = true;
  const lossy: ServerHalf = {
    register: (a) => w.server.register(a),
    snapshot: (a, l, o) => w.server.snapshot(a, l, o),
    pull: (a, l, c, o) => w.server.pull(a, l, c, o),
    apply: async (a, e) => {
      const r = await w.server.apply(a, e);
      if (!lose) return r;
      lose = false;
      return { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "lost" } };
    },
  };
  const mel = new ReplicaClient(lossy, actor("mel"), { clock: w.clock, random: w.random });
  mel.queue("saved.set", { kind: "thread", id: th, on: true });
  t.deepEqual(codes(await mel.flush()), ["SERVICE_UNAVAILABLE"]);
  t.is((w.get(`counts:${th}`) as CountsRec).saves, 2);
  w.clock.advance(MINUTE);
  const moved = new ReplicaClient(
    w.server,
    actor("mel"),
    { clock: w.clock, random: w.random },
    { ...mel.state(), clientId: "01M7HWS780NOTKNOWNC11ENT1D" },
  );
  t.deepEqual(codes(await moved.flush()), ["ok"]);
  t.deepEqual(
    moved.sent.map((e) => e.mutationId),
    [mel.sent[0]?.mutationId, mel.sent[0]?.mutationId],
  );
  t.is((w.get(`counts:${th}`) as CountsRec).saves, 2);
  // the new client used no seq for the replayed answer
  t.is(await w.nextSeq("mel", moved.clientId ?? ""), 1);
});

test("H1: a restricting decision applies whatever the target does in between", async (t) => {
  const { w, open } = await cast(t);
  await ok(t, w.as("eve", "spaces.join", { space: open }));
  // the author edits faster than the owner decides
  const th = await thread(t, w, "eve", open, "post", "ABUSE v0");
  const item = `p:${th}`;
  const out: string[] = [];
  for (let k = 1; k <= 3; k++) {
    const seen = w.item(item);
    w.clock.advance(1000);
    await ok(
      t,
      w.as("eve", "threads.update", {
        id: th,
        q: `ABUSE v${k}`,
        base: { rev: w.rev(`thread:${th}`) },
      }),
    );
    const r = await w.as("olga", "moderation.decide", { item, decision: "hidden", base: seen });
    out.push(r.ok ? "ok" : r.error.code);
  }
  t.deepEqual(out, ["ok", "PRECONDITION_FAILED", "PRECONDITION_FAILED"]);
  const pub = (await w.server.snapshot(null, `space:${open}`)).records.find(
    (x) => x.key === `thread:${th}`,
  )?.record as ThreadRec;
  t.deepEqual([pub.q, pub.mod], ["", "hidden"]);
  // saves and replies do not make a "shown" STALE: they change the counts
  const seen = w.item(item);
  for (let k = 0; k < 3; k++)
    await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: k % 2 === 0 }));
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: w.id(), thread: th, t: "hm" }));
  t.is(w.rev(`thread:${th}`), seen.rev);
  await ok(t, w.as("olga", "moderation.decide", { item, decision: "shown", base: seen }));
  // a removal with an old base applies
  const old = w.item(item);
  await ok(t, w.as("eve", "threads.update", { id: th, q: "ABUSE v9", base: { rev: old.rev } }));
  await ok(t, w.as("olga", "moderation.decide", { item, decision: "removed", base: old }));
  t.is((w.get(`thread:${th}`) as ThreadRec).q, "");
  // a ban, while the target leaves and joins again
  for (let k = 0; k < 2; k++) {
    await ok(t, w.as("eve", "spaces.leave", { space: open }));
    await ok(t, w.as("eve", "spaces.join", { space: open }));
  }
  await ok(t, w.as("olga", "members.ban", { space: open, user: "eve" }));
  t.truthy(w.get(`ban:${open}:eve`));
  await refused(
    t,
    w.as("eve", "threads.create", { id: w.id(), space: open, kind: "post", q: "ABUSE again" }),
    "FORBIDDEN",
  );
  // a removal names an admission: leaving and joining an open space again
  // makes a new one, so a removal decided before is STALE; the ban is the tool
  // for an open space
  await ok(t, w.as("otto", "spaces.leave", { space: open }));
  await ok(t, w.as("otto", "spaces.join", { space: open }));
  const adm = w.admission(open, "otto");
  await ok(t, w.as("otto", "spaces.leave", { space: open }));
  await ok(t, w.as("otto", "spaces.join", { space: open }));
  await refused(
    t,
    w.as("olga", "members.remove", { space: open, user: "otto", base: adm }),
    "STALE",
  );
  await ok(
    t,
    w.as("olga", "members.remove", { space: open, user: "otto", base: w.admission(open, "otto") }),
  );
  // a person who is no longer a member: nothing to remove
  await ok(t, w.as("olga", "members.remove", { space: open, user: "otto", base: adm }));
});

test("Q1: a write whose answer was lost is never applied a second time, whatever the device's clock does", async (t) => {
  const { w, open, closed } = await cast(t, 7);
  const dev = new ManualClock(w.clock.now());
  let lose = true;
  const lossy: ServerHalf = {
    register: (a) => w.server.register(a),
    snapshot: (a, l, o) => w.server.snapshot(a, l, o),
    pull: (a, l, c, o) => w.server.pull(a, l, c, o),
    apply: async (a, e) => {
      const r = await w.server.apply(a, e);
      if (!lose) return r;
      lose = false; // the server applied it; the answer never arrived
      return { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "lost" } };
    },
  };
  const env = { clock: dev, random: w.random };
  const c1 = new ReplicaClient(lossy, actor("mel"), env);
  c1.queue("threads.create", { id: c1.newId(), space: open, kind: "post", q: "posted once" });
  t.deepEqual(codes(await c1.flush()), ["SERVICE_UNAVAILABLE"]);
  const count = () =>
    [...w.server.dump().values()].filter((r) => r.kind === "thread" && r.q === "posted once")
      .length;
  t.is(count(), 1);
  // 2 days later, the device's clock reset (years in the past), restarted
  w.clock.advance(2 * DAY);
  dev.ms = Date.parse("2020-01-01T00:00:00Z");
  const c2 = new ReplicaClient(w.server, actor("mel"), env, c1.state());
  // CLOCK_SKEW, the clock corrected, the same mutation id: the stored answer
  t.deepEqual(codes(await c2.flush()), ["ok"]);
  t.is(new Set(c2.sent.map((e) => e.mutationId)).size, 1);
  t.is(c2.sent[0]?.mutationId, c1.sent[0]?.mutationId);
  t.is(count(), 1);
  // the same, 8 days later: the stored answer is gone, and the write is too
  // old on the device's (corrected) clock: EXPIRED, and shown to the person
  lose = true;
  const c3 = new ReplicaClient(lossy, actor("mel"), env);
  dev.ms = w.clock.now();
  c3.queue("threads.create", { id: c3.newId(), space: open, kind: "post", q: "posted twice?" });
  t.deepEqual(codes(await c3.flush()), ["SERVICE_UNAVAILABLE"]);
  const saved = c3.state();
  w.clock.advance(2 * DAY);
  dev.ms = Date.parse("2020-01-01T00:00:00Z");
  // the device keeps its outbox entry (queued 2 days ago in server time)
  // and comes back after 8 days in all
  w.clock.advance(6 * DAY);
  const c4 = new ReplicaClient(w.server, actor("mel"), env, {
    ...saved,
    outbox: saved.outbox.map((p) => ({ ...p, queuedAt: w.clock.now() - 2 * DAY })),
  });
  t.deepEqual(codes(await c4.flush()), ["EXPIRED"]);
  t.deepEqual(
    c4.problems().map((p) => [p.reason, p.sent]),
    [["EXPIRED", true]],
  );
  t.is(new Set([...c3.sent, ...c4.sent].map((e) => e.mutationId)).size, 1);
  t.is(
    [...w.server.dump().values()].filter((r) => r.kind === "thread" && r.q === "posted twice?")
      .length,
    1,
  );
  // an approval queued 20 days ago, device clock reset: dropped at 3 days of
  // server time, and shown; never applied
  const dev2 = new ManualClock(w.clock.now());
  const m = new ReplicaClient(w.server, actor("olga"), { clock: dev2, random: w.random });
  await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
  m.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "approve",
    base: w.requests(closed, ["otto"]),
  });
  w.clock.advance(20 * DAY);
  dev2.ms = Date.parse("2020-01-01T00:00:00Z");
  t.deepEqual(codes(await m.flush()), []);
  t.deepEqual(
    m.problems().map((p) => p.reason),
    ["DROPPED"],
  );
  t.is(w.get(`member:${closed}:otto`), undefined);
  // a device 10 days slow: corrected once, and the offset survives a restart.
  // A write it queued before its clock was corrected is 10 days old by the
  // corrected clock: dropped and shown (a design finding of round 2's fixes)
  const slow = { now: () => w.clock.now() - 10 * DAY };
  const s1 = new ReplicaClient(w.server, actor("olga"), { clock: slow, random: w.random });
  const t4 = await thread(t, w, "mel", open, "post");
  s1.queue("saved.set", { kind: "thread", id: t4, on: true });
  t.deepEqual(codes(await s1.flush()), []);
  t.deepEqual(
    s1.problems().map((p) => [p.name, p.reason, p.sent]),
    [["saved.set", "DROPPED", false]],
  );
  s1.queue("saved.set", { kind: "thread", id: t4, on: true });
  t.deepEqual(codes(await s1.flush()), ["ok"]);
  t.is(s1.sent.length, 2);
  await ok(t, w.as("eve", "joinRequests.create", { space: closed }));
  s1.queue("joinRequests.decide", {
    space: closed,
    users: ["eve"],
    decision: "approve",
    base: w.requests(closed, ["eve"]),
  });
  const kept = s1.state();
  t.is(Math.round(kept.offset / DAY), 10);
  w.clock.advance(12 * DAY);
  const s2 = new ReplicaClient(w.server, actor("olga"), { clock: slow, random: w.random }, kept);
  t.deepEqual(codes(await s2.flush()), []);
  t.deepEqual(
    s2.problems().map((p) => p.reason),
    ["DROPPED", "DROPPED"],
  );
  t.is(s2.sent.length, 0);
  t.is(w.get(`member:${closed}:eve`), undefined);
});

test("Q3: a write that keeps getting INTERNAL_SERVER_ERROR backs off, fails after 5 answers and is shown; the writes behind it are sent", async (t) => {
  const faulty: AnyMutator = {
    ...(PROTO_MUTATORS["saved.set"] as AnyMutator),
    run: () => {
      throw new TypeError("a server bug that this input always hits");
    },
  };
  const { w, open } = await cast(t, 7, { mutators: { ...PROTO_MUTATORS, "saved.set": faulty } });
  const th = await thread(t, w, "mel", open, "post");
  const mel = w.client("mel");
  mel.queue("saved.set", { kind: "thread", id: th, on: true });
  const reply = mel.newId();
  mel.queue("research.createPostFollowUp", { id: reply, thread: th, t: "a reply behind it" });
  const seen: string[] = [];
  for (let k = 0; k < 40 && mel.pending().length; k++) {
    seen.push(...codes(await mel.flush()));
    w.clock.advance(k < 3 ? 100 : 20 * MINUTE);
  }
  // the first flushes find it waiting out its backoff
  t.is(mel.sent.filter((e) => e.name === "saved.set").length, 5);
  t.deepEqual(
    seen.filter((x) => x !== "INTERNAL_SERVER_ERROR"),
    ["ok"],
  );
  t.deepEqual(
    mel.problems().map((p) => [p.name, p.reason]),
    [["saved.set", "FAILED"]],
  );
  t.truthy(w.get(`reply:${reply}`));
  // the backoff doubles: 1 s, 2 s, 4 s, 8 s between the attempts
  const times = mel.sent.filter((e) => e.name === "saved.set").map((e) => e.clientTime);
  for (let k = 2; k < times.length; k++)
    t.true((times[k] ?? 0) - (times[k - 1] ?? 0) >= 2 ** (k - 1) * 1000);
});

test("N10: a pre-check that refuses with TOO_MANY_REQUESTS or SERVICE_UNAVAILABLE records nothing", async (t) => {
  // a limit in the pre-check stage (AGENTS.md: "server-only pre-checks that
  // may refuse (invite codes, limits)")
  const limits: ("TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE")[] = [];
  const create = PROTO_MUTATORS["invites.create"] as AnyMutator;
  const limited: AnyMutator = {
    ...create,
    pre: (ctx, i) => {
      const code = limits.shift();
      if (code) throw refuse(code);
      return create.pre?.(ctx, i) ?? {};
    },
  };
  const { w, closed } = await cast(t, 1, {
    mutators: { ...PROTO_MUTATORS, "invites.create": limited },
  });
  const e = await w.envelope("olga", "invites.create", { id: w.id(), space: closed, days: 7 });
  for (const code of ["TOO_MANY_REQUESTS", "SERVICE_UNAVAILABLE"] as const) {
    limits.push(code);
    await refused(t, Promise.resolve(w.server.apply(actor("olga"), e)), code);
    t.is(await w.nextSeq("olga", e.clientId), e.seq);
  }
  await ok(t, w.server.apply(actor("olga"), e));
  t.is(await w.nextSeq("olga", e.clientId), e.seq + 1);
});

test("Q3: a write that depends on a failed write gets its own refusal", async (t) => {
  const faulty: AnyMutator = {
    ...(PROTO_MUTATORS["threads.create"] as AnyMutator),
    run: () => {
      throw new TypeError("a server bug that this input always hits");
    },
  };
  const { w, open } = await cast(t, 7, {
    mutators: { ...PROTO_MUTATORS, "threads.create": faulty },
  });
  const mel = w.client("mel");
  const th = mel.newId();
  mel.queue("threads.create", { id: th, space: open, kind: "ask", q: "never saved", ...MODEL });
  mel.queue("research.forkNode", forkInput(mel.newId(), th, "under it"));
  const seen: string[] = [];
  for (let k = 0; k < 10 && mel.pending().length; k++) {
    seen.push(...codes(await mel.flush()));
    w.clock.advance(MINUTE);
  }
  t.deepEqual(seen, [...Array<string>(5).fill("INTERNAL_SERVER_ERROR"), "NOT_FOUND"]);
  t.deepEqual(
    mel.problems().map((p) => [p.name, p.reason]),
    [["threads.create", "FAILED"]],
  );
  t.deepEqual(
    mel.answered.map((a) => [a.name, a.result.ok ? "ok" : a.result.error.code]),
    [["research.forkNode", "NOT_FOUND"]],
  );
});

test("Q2: every exception in apply is answered; a deep input is BAD_REQUEST and a large one TOO_LARGE before anything parses it", async (t) => {
  const { w, open } = await cast(t);
  let deep: unknown = [];
  for (let k = 0; k < 20_000; k++) deep = [deep];
  const e = await w.envelope("eve", "threads.create", {
    id: w.id(),
    space: open,
    kind: "post",
    q: deep,
  });
  await refused(t, Promise.resolve(w.server.apply(actor("eve"), e)), "BAD_REQUEST");
  let nested: unknown = 1;
  for (let k = 0; k < 33; k++) nested = [nested];
  await refused(
    t,
    w.as("eve", "saved.set", { kind: "thread", id: w.id(), on: false, x: nested }),
    "BAD_REQUEST",
  );
  await refused(
    t,
    w.as("eve", "threads.create", {
      id: w.id(),
      space: open,
      kind: "post",
      q: "x".repeat(300_000),
    }),
    "TOO_LARGE",
  );
  let wide: unknown[] = [];
  for (let k = 0; k < 300_000; k++) wide.push(0);
  await refused(t, w.as("eve", "saved.set", { x: wide }), "TOO_LARGE");
  wide = [];
  // unrecorded: the seq was not used
  t.is(await w.nextSeq("eve", e.clientId), e.seq);
  // 32 deep is parsed: refused by the schema, recorded
  let edge: unknown = 1;
  for (let k = 0; k < 31; k++) edge = [edge];
  await refused(
    t,
    w.as("eve", "saved.set", { kind: "thread", id: w.id(), on: false, x: edge }),
    "BAD_REQUEST",
  );
  t.is(await w.nextSeq("eve", e.clientId), e.seq + 1);
  // an envelope whose input throws when read: INTERNAL_SERVER_ERROR, not a throw
  const trap = await w.envelope("eve", "saved.set", {});
  Object.defineProperty(trap, "input", {
    enumerable: true,
    get: () => {
      throw new Error("a getter that fails");
    },
  });
  await refused(t, Promise.resolve(w.server.apply(actor("eve"), trap)), "INTERNAL_SERVER_ERROR");
  // odd but valid handles and keys get ordinary answers
  const odd: [string, string, unknown][] = [
    ["olga", "members.ban", { space: open, user: "constructor" }],
    [
      "olga",
      "joinRequests.decide",
      { space: open, users: ["constructor"], decision: "approve", base: { constructor: 0 } },
    ],
    [
      "olga",
      "moderation.decide",
      { item: `f:${w.id()}:__proto__`, decision: "hidden", base: { rev: 0 } },
    ],
    ["olga", "invites.create", { id: w.id(), space: open, days: 1 }],
    ["olga", "spaces.update", { id: open, desc: "x".repeat(301) }],
  ];
  const got: string[] = [];
  for (const [u, name, input] of odd) {
    const r = await w.as(u, name, input);
    got.push(r.ok ? "ok" : r.error.code);
  }
  t.deepEqual(got, ["ok", "NOT_FOUND", "NOT_FOUND", "ok", "BAD_REQUEST"]);
  t.true((await w.server.register(actor("constructor"))).ok);
  t.deepEqual(await w.server.pull(null, "space:x:y", "e"), { resync: true });
});

test("E1: a write that notifies several people commits all of their notifications or none, and a later one coalesces", async (t) => {
  // review round 2's E1 had an effect whose random source failed between two
  // recipients. Notifications are written in the write's transaction now
  // (`01` U1, C16), so a fault after the first one commits nothing at all.
  let fail = true;
  const create = PROTO_MUTATORS["research.createPostFollowUp"] as AnyMutator;
  const faulty: AnyMutator = {
    ...create,
    notify: (tx, i, result) => {
      create.notify?.(tx, i, result);
      if (fail) throw new Error("down once, after the notifications were staged");
    },
  };
  const { w, open } = await cast(t, 7, {
    mutators: { ...PROTO_MUTATORS, "research.createPostFollowUp": faulty },
  });
  const th = await thread(t, w, "eve", open, "post");
  const notifs = () =>
    [...w.server.dump().values()]
      .flatMap((r) => (r.kind === "notif" ? [`${r.to}:${r.type}:${r.n}`] : []))
      .sort();
  const input = { id: w.id(), thread: th, t: "@mona @mel @olga and @eve, @nobody" };
  await refused(t, w.as("otto", "research.createPostFollowUp", input), "INTERNAL_SERVER_ERROR");
  t.deepEqual(notifs(), []);
  t.false(w.server.dump().has(`reply:${input.id}`));
  fail = false;
  await ok(t, w.as("otto", "research.createPostFollowUp", input));
  // the post's author gets a reply; members of the space a mention; a
  // handle that names no member (eve posted without joining; nobody) gets
  // no mention
  t.deepEqual(notifs(), ["eve:reply:1", "mel:mention:1", "mona:mention:1", "olga:mention:1"]);
  // another reply to the same post: the unread reply notification counts it
  await ok(t, w.as("mel", "research.createPostFollowUp", { id: w.id(), thread: th, t: "me too" }));
  t.deepEqual(notifs(), ["eve:reply:2", "mel:mention:1", "mona:mention:1", "olga:mention:1"]);
});

test("R1: a record written again at a deleted key continues from its last rev, after the tombstone is pruned too", async (t) => {
  const { w, closed } = await cast(t);
  await admit(t, w, closed, "otto");
  const seen = w.admission(closed, "otto");
  const rev = w.rev(`member:${closed}:otto`);
  await ok(t, w.as("olga", "members.remove", { space: closed, user: "otto", base: seen }));
  w.clock.advance(31 * DAY);
  t.false((await w.server.scanStorage()).tombstones.some((x) => x.key === `member:${closed}:otto`));
  await admit(t, w, closed, "otto");
  t.true(w.rev(`member:${closed}:otto`) > rev);
  t.not(w.admission(closed, "otto").adm, seen.adm);
  await refused(
    t,
    w.as("olga", "members.remove", { space: closed, user: "otto", base: seen }),
    "STALE",
  );
  const reg = (await w.server.scanStorage()).registry.find((x) => x.id === `member:${closed}:otto`);
  t.is(reg?.rev, w.rev(`member:${closed}:otto`));
});

test("N29: a deleted record's id is never used again, after its tombstone is pruned too", async (t) => {
  const { w, open } = await cast(t);
  const post = await thread(t, w, "mel", open, "post");
  const reply = w.id();
  await ok(
    t,
    w.as("otto", "research.createPostFollowUp", { id: reply, thread: post, t: "first text" }),
  );
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `p:${post}`,
      decision: "removed",
      base: w.item(`p:${post}`),
    }),
  );
  t.false(w.server.dump().has(`reply:${reply}`));
  const other = await thread(t, w, "eve", open, "post");
  await refused(
    t,
    w.as("eve", "research.createPostFollowUp", { id: reply, thread: other, t: "mine" }),
    "CONFLICT",
  );
  w.clock.advance(31 * DAY);
  const later = await thread(t, w, "eve", open, "post");
  // the id is older than 4 days now: a client that kept it gets EXPIRED; the
  // registry still holds it
  t.true((await w.server.scanStorage()).registry.some((x) => x.id === reply));
  await refused(
    t,
    w.as("eve", "research.createPostFollowUp", { id: reply, thread: later, t: "mine" }),
    "EXPIRED",
  );
});

test("N23: a decline's reason does not survive the person asking again", async (t) => {
  const { w, closed } = await cast(t);
  await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "decline",
      why: "not now",
      base: w.requests(closed, ["otto"]),
    }),
  );
  t.is((w.get(`request:${closed}:otto`) as { why: string | null }).why, "not now");
  await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
  const r = w.get(`request:${closed}:otto`) as { st: string; why: string | null };
  t.deepEqual([r.st, r.why], ["open", null]);
});

test("N28: a client that read its last seq sends its next write under the right seq the first time", async (t) => {
  const { w, open } = await cast(t);
  const mel = w.client("mel");
  await mel.register();
  mel.queue("spaces.join", { space: open });
  await mel.flush();
  // a second device restored from an old state, with a stale last seq
  const stale = { ...mel.state(), acked: 0 };
  const other = new ReplicaClient(
    w.server,
    actor("mel"),
    { clock: w.clock, random: w.random },
    stale,
  );
  await other.sync("user:mel");
  t.is(other.lastSeq, 1);
  other.queue("saved.set", { kind: "thread", id: w.id(), on: false });
  t.deepEqual(codes(await other.flush()), ["ok"]);
  t.deepEqual(
    other.sent.map((e) => e.seq),
    [2],
  );
});

test("T1: token cursors: another reader, a signed-out caller, another log, a changed byte and the 30-day boundary", async (t) => {
  const { w, open, closed } = await cast(t);
  await thread(t, w, "mel", closed, "post");
  const lab = `space:${closed}` as LogId;
  const mel = await w.server.snapshot(actor("mel"), lab);
  const eve = await w.server.snapshot(actor("eve"), lab);
  await thread(t, w, "mel", closed, "post", "after");
  const show = async (a: Actor | null, log: LogId, cursor: string) => {
    const p = await w.server.pull(a, log, cursor);
    return "resync" in p ? "resync" : `${p.changes.length} changes`;
  };
  t.is(await show(actor("eve"), lab, mel.cursor), "resync");
  t.is(await show(null, lab, mel.cursor), "resync");
  t.is(await show(actor("mel"), `space:${open}`, mel.cursor), "resync");
  t.is(await show(actor("mel"), lab, eve.cursor), "resync");
  const zero = (await w.server.snapshot(null, `space:${w.id()}`)).cursor;
  t.is(await show(actor("eve"), lab, zero), "resync");
  t.is(await show(actor("mel"), lab, mel.cursor), "3 changes");
  w.clock.advance(30 * DAY);
  t.is(await show(actor("mel"), lab, mel.cursor), "3 changes");
  w.clock.advance(1);
  t.is(await show(actor("mel"), lab, mel.cursor), "resync");
  // every table at rest is in the scan
  t.deepEqual(Object.keys(await w.server.scanStorage()).sort(), [
    "answers",
    "born",
    "clients",
    "epochs",
    "logRows",
    "records",
    "registrations",
    "registry",
    "tombstones",
  ]);
});

test("Y1: an envelope's queuedAt is checked like a mutation id's age, and the answer is recorded", async (t) => {
  const { w, open } = await cast(t);
  const input = (q: string) => ({ id: w.id(), space: open, kind: "post", q });
  const send = async (q: string, queued: number) => {
    const e = await w.envelope("mel", "threads.create", input(q));
    return { e, r: await w.server.apply(actor("mel"), { ...e, queuedAt: e.clientTime + queued }) };
  };
  const old = await send("queued too long ago", -4 * DAY - 1);
  t.is(old.r.ok ? null : old.r.error.code, "EXPIRED");
  // recorded: the seq is used, and the same envelope gets the same answer
  t.is(await w.nextSeq("mel", old.e.clientId), old.e.seq + 1);
  const again = await w.server.apply(actor("mel"), {
    ...old.e,
    queuedAt: old.e.clientTime - 4 * DAY - 1,
  });
  t.deepEqual(again, old.r);
  const ahead = await send("queued in the future", MINUTE + 1);
  t.is(ahead.r.ok ? null : ahead.r.error.code, "EXPIRED");
  await ok(t, (await send("queued 4 days ago", -4 * DAY)).r);
  await ok(t, (await send("queued just now", MINUTE)).r);
  // an envelope without it is malformed, and records nothing
  const full = await w.envelope("mel", "threads.create", input("bare"));
  const bare: Record<string, unknown> = { ...full };
  delete bare["queuedAt"];
  await refused(
    t,
    Promise.resolve(w.server.apply(actor("mel"), bare as unknown as Envelope)),
    "BAD_REQUEST",
  );
  t.is(await w.nextSeq("mel", full.clientId), full.seq);
  const posts = [...w.server.dump().values()].flatMap((r) =>
    r.kind === "thread" && r.u === "mel" ? [r.q] : [],
  );
  t.deepEqual(posts.sort(), ["queued 4 days ago", "queued just now"]);
});

test("Y1: a reminted envelope's answer is stored under the ids it replaces: a delayed original gets it and is never applied", async (t) => {
  const { w, open } = await cast(t);
  const first = { id: w.id(), space: open, kind: "post", q: "typed once" };
  const original = await w.envelope("mel", "threads.create", first);
  // the client reminted the write (new ids) before it knew the original's fate
  const second = { ...first, id: w.id() };
  const reminted = {
    ...(await w.envelope("mel", "threads.create", second)),
    replaces: [original.mutationId],
  };
  const answer = await w.server.apply(actor("mel"), reminted);
  t.deepEqual(answer, { ok: true, result: { id: second.id, run: null } });
  // the original arrives late, under the client's next seq: it gets the
  // stored answer, uses no seq and writes nothing
  const seq = await w.nextSeq("mel", original.clientId);
  t.deepEqual(await w.server.apply(actor("mel"), { ...original, seq }), answer);
  t.is(await w.nextSeq("mel", original.clientId), seq);
  t.is(w.get(`thread:${first.id}`), undefined);
  t.is(
    [...w.server.dump().values()].filter((r) => r.kind === "thread" && r.q === "typed once").length,
    1,
  );
  // an id that has its own answer keeps it; another user's ids are their own
  const other = await w.envelope("mel", "spaces.leave", { space: open });
  await ok(t, w.server.apply(actor("mel"), { ...other, replaces: [reminted.mutationId] }));
  t.deepEqual(await w.resend("mel", reminted, true), answer);
  await ok(t, w.as("otto", "threads.create", first, original.mutationId));
  // `replaces` holds at most 16 ULIDs, or the envelope is malformed
  for (const replaces of [["not-a-ulid"], Array.from({ length: 17 }, () => w.id()), "x"]) {
    const e = await w.envelope("mel", "threads.create", { ...first, id: w.id() });
    await refused(
      t,
      Promise.resolve(w.server.apply(actor("mel"), { ...e, replaces } as unknown as Envelope)),
      "BAD_REQUEST",
    );
    t.is(await w.nextSeq("mel", e.clientId), e.seq);
  }
});
