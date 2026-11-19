// The attacks of review round 2 (S1, S2, H1, H2, Q1, Q3, Q2, E1, R1, T1) and
// the mutations that survived it (N2, N3, N23, N28, N29, N30), each ported
// as a test that the server refuses or filters the attack. The invariant
// files hold the general cases; these keep each attack's own scenario.

import test from "ava";

import {
  MUTATORS,
  ReplicaClient,
  USE_PACKAGE,
  refuse,
  type Actor,
  type AnyMutator,
  type CountsRec,
  type ApplyResult,
  type LogId,
  type ServerHalf,
  type ThreadRec,
} from "../src/index.js";

import {
  DAY,
  HOUR,
  MINUTE,
  ManualClock,
  type World,
  actor,
  admit,
  cast,
  ok,
  refused,
  rng,
  thread,
} from "./harness.js";

const codes = (rs: ApplyResult[]) => rs.map((r) => (r.ok ? "ok" : r.error.code));
const notifsOf = async (w: World, u: string) =>
  (await w.server.snapshot(actor(u), `user:${u}`)).records.filter((r) => r.record.kind === "notif");

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
    await ok(t, w.as("eve", "likes.set", { thread: probe, on }));
    return (await w.server.snapshot(actor("eve"), `space:${mine}`)).cursor;
  };
  const tokens = [await sample(true)];
  await thread(t, w, "mel", closed, "post", "secret A");
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "mel",
      role: "mod",
      base: w.member(closed, "mel"),
    }),
  );
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
  back.queue("likes.set", { thread: th, on: true });
  t.deepEqual(codes(await back.flush()), ["ok"]);
  t.deepEqual(
    (await Promise.all(back.sent.map((e) => w.resend("otto", e)))).map((r) =>
      r.ok ? "ok" : r.error.code,
    ),
    ["WRONG_CLIENT", "ok"],
  );
  t.not(back.clientId, old.clientId);
  t.is((w.get(`counts:${th}`) as CountsRec).likes, 1);
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
  mel.queue("likes.set", { thread: th, on: true });
  t.deepEqual(codes(await mel.flush()), ["SERVICE_UNAVAILABLE"]);
  t.is((w.get(`counts:${th}`) as CountsRec).likes, 2);
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
  t.is((w.get(`counts:${th}`) as CountsRec).likes, 2);
  // the new client used no seq for the replayed answer
  t.is(await w.nextSeq("mel", moved.clientId ?? ""), 1);
});

test("H1: a restricting decision applies whatever the target does in between", async (t) => {
  const { w, open, closed } = await cast(t);
  await ok(t, w.as("eve", "spaces.join", { space: open }));
  // the author edits faster than the moderator decides
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
    const r = await w.as("mona", "moderation.decide", { item, decision: "hidden", base: seen });
    out.push(r.ok ? "ok" : r.error.code);
  }
  t.deepEqual(out, ["ok", "PRECONDITION_FAILED", "PRECONDITION_FAILED"]);
  const pub = (await w.server.snapshot(null, `space:${open}`)).records.find(
    (x) => x.key === `thread:${th}`,
  )?.record as ThreadRec;
  t.deepEqual([pub.q, pub.mod], ["", "hidden"]);
  // likes and follow-ups do not make a "shown" STALE: they change the counts
  const seen = w.item(item);
  for (let k = 0; k < 3; k++)
    await ok(t, w.as("otto", "likes.set", { thread: th, on: k % 2 === 0 }));
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: w.id(), thread: th, t: "hm" }));
  t.is(w.rev(`thread:${th}`), seen.rev);
  await ok(t, w.as("mona", "moderation.decide", { item, decision: "shown", base: seen }));
  // a removal with an old base applies
  const old = w.item(item);
  await ok(t, w.as("eve", "threads.update", { id: th, q: "ABUSE v9", base: { rev: old.rev } }));
  await ok(t, w.as("mona", "moderation.decide", { item, decision: "removed", base: old }));
  t.is((w.get(`thread:${th}`) as ThreadRec).q, "");
  // a ban, while the target leaves and joins again
  for (let k = 0; k < 2; k++) {
    await ok(t, w.as("eve", "spaces.leave", { space: open }));
    await ok(t, w.as("eve", "spaces.join", { space: open }));
  }
  await ok(t, w.as("mona", "members.ban", { space: open, user: "eve" }));
  t.truthy(w.get(`ban:${open}:eve`));
  await refused(
    t,
    w.as("eve", "threads.create", { id: w.id(), space: open, kind: "post", q: "ABUSE again" }),
    "FORBIDDEN",
  );
  // a removal names an admission: leaving and joining an open space again
  // makes a new one, so a removal decided before is STALE; the ban is the tool
  // for an open space. @session/mutators (phase 1a.2) takes no removal in an
  // open space at all (BAD_REQUEST); there the same admission rule is checked
  // in a closed space, where a person is let in again by an approval.
  if (USE_PACKAGE) {
    await refused(
      t,
      w.as("mona", "members.remove", {
        space: open,
        user: "otto",
        base: w.admission(open, "otto"),
      }),
      "BAD_REQUEST",
    );
    t.truthy(w.get(`member:${open}:otto`));
  }
  const sp = USE_PACKAGE ? closed : open;
  const again = async () => {
    await ok(t, w.as("otto", "spaces.leave", { space: sp }));
    if (USE_PACKAGE) await admit(t, w, closed, "otto");
    else await ok(t, w.as("otto", "spaces.join", { space: sp }));
  };
  if (USE_PACKAGE) await admit(t, w, closed, "otto");
  else await again();
  const adm = w.admission(sp, "otto");
  await again();
  await refused(t, w.as("mona", "members.remove", { space: sp, user: "otto", base: adm }), "STALE");
  await ok(
    t,
    w.as("mona", "members.remove", { space: sp, user: "otto", base: w.admission(sp, "otto") }),
  );
  // a person who is no longer a member: nothing to remove
  await ok(t, w.as("mona", "members.remove", { space: sp, user: "otto", base: adm }));
});

test("H2: report notifications are served only while their person is staff of the space", async (t) => {
  const { w, open, closed } = await cast(t);
  const th = await thread(t, w, "mel", open, "post", "reported post");
  await ok(t, w.as("otto", "reports.create", { id: w.id(), item: `p:${th}`, why: "spam" }));
  await w.work();
  t.is((await notifsOf(w, "mona")).length, 1);
  const mona = w.client("mona");
  await mona.sync("user:mona");
  await ok(t, w.as("olga", "members.ban", { space: open, user: "mona" }));
  t.deepEqual(await notifsOf(w, "mona"), []);
  t.is(await mona.sync("user:mona"), "resync");
  t.false([...mona.records("user:mona").values()].some((r) => r.kind === "notif"));
  // a demotion: the notification is not served, and the user log resyncs
  const c = await thread(t, w, "mel", closed, "post", "closed post");
  await ok(t, w.as("mona", "reports.create", { id: w.id(), item: `p:${c}`, why: "off topic" }));
  await w.work();
  const ada = w.client("ada");
  await ada.sync("user:ada");
  t.is([...ada.records("user:ada").values()].filter((r) => r.kind === "notif").length, 1);
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "ada",
      role: "member",
      base: w.member(closed, "ada"),
    }),
  );
  t.deepEqual(await notifsOf(w, "ada"), []);
  t.is(await ada.sync("user:ada"), "resync");
  t.false([...ada.records("user:ada").values()].some((r) => r.kind === "notif"));
  // made staff again, she gets it again
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "ada",
      role: "mod",
      base: w.member(closed, "ada"),
    }),
  );
  t.is(await ada.sync("user:ada"), "resync");
  t.is([...ada.records("user:ada").values()].filter((r) => r.kind === "notif").length, 1);
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
  const m = new ReplicaClient(w.server, actor("mona"), { clock: dev2, random: w.random });
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
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
  const s1 = new ReplicaClient(w.server, actor("mona"), { clock: slow, random: w.random });
  const t4 = await thread(t, w, "mel", open, "post");
  s1.queue("saved.set", { kind: "thread", id: t4, on: true });
  t.deepEqual(codes(await s1.flush()), []);
  t.deepEqual(
    s1.problems().map((p) => [p.name, p.reason, p.sent]),
    [["saved.set", "DROPPED", false]],
  );
  s1.queue("likes.set", { thread: t4, on: true });
  t.deepEqual(codes(await s1.flush()), ["ok"]);
  t.is(s1.sent.length, 2);
  await ok(t, w.as("eve", "joinRequests.create", { space: closed, rulesAccepted: true }));
  s1.queue("joinRequests.decide", {
    space: closed,
    users: ["eve"],
    decision: "approve",
    base: w.requests(closed, ["eve"]),
  });
  const kept = s1.state();
  t.is(Math.round(kept.offset / DAY), 10);
  w.clock.advance(12 * DAY);
  const s2 = new ReplicaClient(w.server, actor("mona"), { clock: slow, random: w.random }, kept);
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
    ...(MUTATORS["likes.set"] as AnyMutator),
    run: () => {
      throw new TypeError("a server bug that this input always hits");
    },
  };
  const { w, open } = await cast(t, 7, { mutators: { ...MUTATORS, "likes.set": faulty } });
  const th = await thread(t, w, "mel", open, "post");
  const mel = w.client("mel");
  mel.queue("likes.set", { thread: th, on: true });
  const reply = mel.newId();
  mel.queue("research.createPostFollowUp", { id: reply, thread: th, t: "a reply behind it" });
  const seen: string[] = [];
  for (let k = 0; k < 40 && mel.pending().length; k++) {
    seen.push(...codes(await mel.flush()));
    w.clock.advance(k < 3 ? 100 : 20 * MINUTE);
  }
  // the first flushes find it waiting out its backoff
  t.is(mel.sent.filter((e) => e.name === "likes.set").length, 5);
  t.deepEqual(
    seen.filter((x) => x !== "INTERNAL_SERVER_ERROR"),
    ["ok"],
  );
  t.deepEqual(
    mel.problems().map((p) => [p.name, p.reason]),
    [["likes.set", "FAILED"]],
  );
  t.truthy(w.get(`reply:${reply}`));
  // the backoff doubles: 1 s, 2 s, 4 s, 8 s between the attempts
  const times = mel.sent.filter((e) => e.name === "likes.set").map((e) => e.clientTime);
  for (let k = 2; k < times.length; k++)
    t.true((times[k] ?? 0) - (times[k - 1] ?? 0) >= 2 ** (k - 1) * 1000);
});

test("N10: a pre-check that refuses with TOO_MANY_REQUESTS or SERVICE_UNAVAILABLE records nothing", async (t) => {
  // a limit in the pre-check stage (AGENTS.md: "server-only pre-checks that
  // may refuse (invite codes, limits)")
  const limits: ("TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE")[] = [];
  const create = MUTATORS["invites.create"] as AnyMutator;
  const limited: AnyMutator = {
    ...create,
    pre: (ctx, i) => {
      const code = limits.shift();
      if (code) throw refuse(code);
      return create.pre?.(ctx, i) ?? {};
    },
  };
  const { w, closed } = await cast(t, 1, { mutators: { ...MUTATORS, "invites.create": limited } });
  const e = await w.envelope("mona", "invites.create", { id: w.id(), space: closed });
  for (const code of ["TOO_MANY_REQUESTS", "SERVICE_UNAVAILABLE"] as const) {
    limits.push(code);
    await refused(t, Promise.resolve(w.server.apply(actor("mona"), e)), code);
    t.is(await w.nextSeq("mona", e.clientId), e.seq);
  }
  await ok(t, w.server.apply(actor("mona"), e));
  t.is(await w.nextSeq("mona", e.clientId), e.seq + 1);
});

test("Q3: a write that depends on a failed write gets its own refusal", async (t) => {
  const faulty: AnyMutator = {
    ...(MUTATORS["threads.create"] as AnyMutator),
    run: () => {
      throw new TypeError("a server bug that this input always hits");
    },
  };
  const { w, open } = await cast(t, 7, { mutators: { ...MUTATORS, "threads.create": faulty } });
  const mel = w.client("mel");
  const th = mel.newId();
  mel.queue("threads.create", { id: th, space: open, kind: "ask", q: "never saved" });
  mel.queue("followups.ask", { id: mel.newId(), thread: th, q: "under it" });
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
    [["followups.ask", "NOT_FOUND"]],
  );
});

test("Q2: every exception in apply is answered; a deep or large input is BAD_REQUEST before anything parses it", async (t) => {
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
    w.as("eve", "likes.set", { thread: w.id(), on: false, x: nested }),
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
    "BAD_REQUEST",
  );
  // unrecorded: the seq was not used
  t.is(await w.nextSeq("eve", e.clientId), e.seq);
  // 32 deep is parsed: refused by the schema, recorded
  let edge: unknown = 1;
  for (let k = 0; k < 31; k++) edge = [edge];
  await refused(t, w.as("eve", "likes.set", { thread: w.id(), on: false, x: edge }), "BAD_REQUEST");
  t.is(await w.nextSeq("eve", e.clientId), e.seq + 1);
  // an envelope whose input throws when read: INTERNAL_SERVER_ERROR, not a throw
  const trap = await w.envelope("eve", "likes.set", {});
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
      "members.setRole",
      { space: open, user: "constructor", role: "mod", base: { rev: 0 } },
    ],
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
    ["olga", "invites.create", { id: w.id(), space: open, days: 0 }],
    ["olga", "spaces.update", { id: open, set: { name: "#" } }],
  ];
  const got: string[] = [];
  for (const [u, name, input] of odd) {
    const r = await w.as(u, name, input);
    got.push(r.ok ? "ok" : r.error.code);
  }
  t.deepEqual(got, ["ok", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "ok", "BAD_REQUEST"]);
  t.true((await w.server.register(actor("constructor"))).ok);
  t.deepEqual(await w.server.pull(null, "space:x:y", "e"), { resync: true });
});

test("E1: effects run from the worker with backoff, end in the dead letters after 10 failures, and never from a request", async (t) => {
  let failing = 0;
  const { w, open } = await cast(t, 7, { failEffect: () => failing-- > 0 });
  const th = await thread(t, w, "eve", open, "post", "ABUSE");
  failing = 1000;
  const report = w.id();
  await ok(t, w.as("otto", "reports.create", { id: report, item: `p:${th}`, why: "abuse" }));
  const attempts = async () => (await w.server.scanStorage()).effects.map((x) => x.attempts);
  // requests do not run effects, signed-out reads included
  for (let k = 0; k < 50; k++) await w.server.pull(null, `space:${open}`, "x");
  t.deepEqual(await attempts(), [0]);
  // the worker tries, then waits 1 s, 2 s, 4 s, …, at most 10 minutes
  const at: number[] = [];
  for (let k = 0; k < 200 && (await w.server.scanStorage()).effects.length; k++) {
    const before = (await attempts())[0] ?? 0;
    await w.work();
    if (((await attempts())[0] ?? 10) > before) at.push(w.clock.now());
    w.clock.advance(500);
    if (k > 20) w.clock.advance(5 * MINUTE);
  }
  const scan = await w.server.scanStorage();
  t.deepEqual(scan.effects, []);
  t.is(scan.deadLetters.length, 1);
  t.is(scan.deadLetters[0]?.attempts, 10);
  t.deepEqual(scan.deadLetters[0]?.effect, {
    type: "notifyStaff",
    sp: open,
    report,
    item: `p:${th}`,
  });
  for (let k = 2; k < at.length; k++)
    t.true((at[k] ?? 0) - (at[k - 1] ?? 0) >= Math.min(10 * MINUTE, 2 ** (k - 1) * 1000) - 500);
  t.false([...w.server.dump().values()].some((r) => r.kind === "notif"));
  // an effect that runs after the item was removed and the staff changed
  // notifies the staff as they are when it runs
  failing = 1;
  const th2 = await thread(t, w, "eve", open, "post", "ABUSE 2");
  await ok(t, w.as("otto", "reports.create", { id: w.id(), item: `p:${th2}`, why: "abuse" }));
  await w.work();
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th2}`,
      decision: "removed",
      base: w.item(`p:${th2}`),
    }),
  );
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: open,
      user: "mona",
      role: "member",
      base: w.member(open, "mona"),
    }),
  );
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: open,
      user: "otto",
      role: "mod",
      base: w.member(open, "otto"),
    }),
  );
  w.clock.advance(2000);
  t.is(await w.work(), 1);
  const to = [...w.server.dump().values()]
    .flatMap((r) => (r.kind === "notif" ? [r.to] : []))
    .sort();
  t.deepEqual(to, ["olga", "otto"]);
});

test("E1: an effect whose random source fails between two recipients writes nothing, and once each on the retry", async (t) => {
  let n = 0;
  let arm = false;
  const inner = rng(12345);
  const random = () => {
    if (arm && ++n === 2) throw new Error("down once");
    return inner();
  };
  const { w, open } = await cast(t, 7, { random });
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: open,
      user: "mel",
      role: "admin",
      base: w.member(open, "mel"),
    }),
  );
  const th = await thread(t, w, "eve", open, "post");
  await ok(t, w.as("otto", "reports.create", { id: w.id(), item: `p:${th}`, why: "x" }));
  arm = true;
  t.is(await w.work(), 0);
  const notifs = () =>
    [...w.server.dump().values()].flatMap((r) => (r.kind === "notif" ? [r.to] : [])).sort();
  t.deepEqual(notifs(), []);
  w.clock.advance(1000);
  t.is(await w.work(), 1);
  t.deepEqual(notifs(), ["mel", "mona", "olga"]);
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
    w.as("mona", "members.remove", { space: closed, user: "otto", base: seen }),
    "STALE",
  );
  // and a role change made from the old record is STALE
  await refused(
    t,
    w.as("olga", "members.setRole", { space: closed, user: "otto", role: "mod", base: { rev } }),
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
    w.as("mona", "moderation.decide", {
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
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
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
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
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
    "deadLetters",
    "effects",
    "epochs",
    "jobs",
    "logRows",
    "records",
    "registrations",
    "registry",
    "tombstones",
  ]);
});

// N6 (phase 1a.2): the convergence seeds that killed it in both modes no longer
// reach the case in package mode (open-space removals answer BAD_REQUEST
// there), so the case has its own test.
test("N6: a space that closes takes a non-member's likes and saves out of their user log", async (t) => {
  const { w, open } = await cast(t);
  const log: LogId = "user:ada";
  const t1 = await thread(t, w, "mel", open, "post", "mel's");
  await ok(t, w.as("ada", "likes.set", { thread: t1, on: true }));
  await ok(t, w.as("ada", "saved.set", { kind: "thread", id: t1, on: true }));
  const ada = w.client("ada");
  await ada.sync(log);
  t.true(ada.records(log).has(`like:ada:${t1}`));
  w.clock.advance(MINUTE);
  await ok(t, w.as("olga", "spaces.update", { id: open, set: { vis: "listed" } }));
  // ada is no member of the closed space: her user log resyncs without them
  t.is(await ada.sync(log), "resync");
  t.false(ada.records(log).has(`like:ada:${t1}`));
  t.false(ada.records(log).has(`save:ada:${t1}`));
});
