// The attacks of review round 1 (R1 to R15), each ported as a test that the
// server refuses or filters it. The invariant files hold the general cases;
// these keep each attack's own scenario.

import test from "ava";

import {
  MUTATORS,
  PROTOCOL_VERSION,
  ReplicaClient,
  type AnyMutator,
  type ApplyResult,
  type ServerHalf,
  type ThreadRec,
} from "../src/index.js";

import {
  DAY,
  HOUR,
  MINUTE,
  World,
  actor,
  cast,
  ok,
  refused,
  rng,
  thread,
} from "./harness.js";

const codes = (rs: ApplyResult[]) => rs.map((r) => (r.ok ? "ok" : r.error.code));

test("R1: an approval queued for a request that was approved, then reopened by asking again, is STALE", async (t) => {
  const { w, closed } = await cast(t);
  await ok(
    t,
    w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true, answers: ["first"] }),
  );
  const mona = w.client("mona");
  mona.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "approve",
    base: w.requests(closed, ["otto"]),
  });
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "approve",
      base: w.requests(closed, ["otto"]),
    }),
  );
  await ok(
    t,
    w.as("olga", "members.remove", { space: closed, user: "otto", base: w.member(closed, "otto") }),
  );
  // otto asks again: the same request record is open again, with a new rev
  const before = w.rev(`request:${closed}:otto`);
  await ok(
    t,
    w.as("otto", "joinRequests.create", {
      space: closed,
      rulesAccepted: true,
      answers: ["second"],
    }),
  );
  t.true(w.rev(`request:${closed}:otto`) > before);
  w.clock.advance(HOUR);
  const [r] = await mona.flush();
  t.is(r?.ok ? "ok" : r?.error.code, "STALE");
  t.is(w.get(`member:${closed}:otto`), undefined);
  // a decline queued from the first request is STALE too
  const olga = w.client("olga");
  olga.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "decline",
    base: { otto: before },
  });
  const [d] = await olga.flush();
  t.is(d?.ok ? "ok" : d?.error.code, "STALE");
  // a decision on the request as it is now applies
  await ok(
    t,
    w.as("mona", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "approve",
      base: w.requests(closed, ["otto"]),
    }),
  );
  t.truthy(w.get(`member:${closed}:otto`));
});

test("R1: reopening a declined request bumps its rev, so a decision made before the reopening is STALE", async (t) => {
  const { w, closed } = await cast(t);
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "decline",
      base: w.requests(closed, ["otto"]),
    }),
  );
  const declined = w.requests(closed, ["otto"]);
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "reopen",
      base: declined,
    }),
  );
  t.true(w.rev(`request:${closed}:otto`) > (declined["otto"] ?? 0));
  await refused(
    t,
    w.as("mona", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "reopen",
      base: declined,
    }),
    "STALE",
  );
  // base must name every person decided on, and no one else
  for (const base of [{}, { otto: 1, mel: 1 }, { mel: 1 }])
    await refused(
      t,
      w.as("mona", "joinRequests.decide", {
        space: closed,
        users: ["otto"],
        decision: "approve",
        base,
      }),
      "BAD_REQUEST",
    );
});

test("R1b: a removal queued before a person was removed and let in again is STALE", async (t) => {
  const { w, closed } = await cast(t);
  const mona = w.client("mona");
  mona.queue("members.remove", { space: closed, user: "mel", base: w.member(closed, "mel") });
  mona.queue("members.ban", { space: closed, user: "mel", base: w.member(closed, "mel") });
  const ada = w.client("ada");
  ada.queue("members.setRole", {
    space: closed,
    user: "mel",
    role: "mod",
    base: w.member(closed, "mel"),
  });
  await ok(
    t,
    w.as("olga", "members.remove", { space: closed, user: "mel", base: w.member(closed, "mel") }),
  );
  await ok(t, w.as("mel", "joinRequests.create", { space: closed, rulesAccepted: true }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["mel"],
      decision: "approve",
      base: w.requests(closed, ["mel"]),
    }),
  );
  const results = [...(await mona.flush()), ...(await ada.flush())];
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["STALE", "STALE", "STALE"],
  );
  t.is((w.get(`member:${closed}:mel`) as { role: string } | undefined)?.role, "member");
  t.is(w.get(`ban:${closed}:mel`), undefined);
  // a ban of a person with no member record carries rev 0
  await ok(t, w.as("mona", "members.ban", { space: closed, user: "eve", base: { rev: 0 } }));
  await refused(
    t,
    w.as("mona", "members.ban", { space: closed, user: "otto", base: { rev: 1 } }),
    "STALE",
  );
});

test("R2: a queued 'shown' does not publish text the author changed after the moderator read it", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "otto", open, "post", "borderline v1");
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th}`,
      decision: "hidden",
      base: w.item(`p:${th}`),
    }),
  );
  const olga = w.client("olga");
  olga.queue("moderation.decide", { item: `p:${th}`, decision: "shown", base: w.item(`p:${th}`) });
  // the author may still edit a hidden thread
  await ok(
    t,
    w.as("otto", "threads.update", { id: th, q: "ABUSE v2", base: { rev: w.rev(`thread:${th}`) } }),
  );
  const [r] = await olga.flush();
  t.is(r?.ok ? "ok" : r?.error.code, "STALE");
  t.is((w.get(`thread:${th}`) as ThreadRec).mod, "hidden");
  const s = await w.server.snapshot(null, `space:${open}`);
  t.false(JSON.stringify(s).includes("ABUSE"));
  const p = s.records.find((x) => x.key === `thread:${th}`)?.record as ThreadRec;
  t.is(p.q, "");
  // the same holds for a queued "removed" or "hidden" after a change of the item
  const mona = w.client("mona");
  mona.queue("moderation.decide", {
    item: `p:${th}`,
    decision: "removed",
    base: { rev: w.rev(`thread:${th}`) - 1 },
  });
  const [x] = await mona.flush();
  t.is(x?.ok ? "ok" : x?.error.code, "STALE");
  t.is(
    JSON.stringify(await w.server.snapshot(actor("otto"), `space:${open}`)).includes("ABUSE"),
    true,
  );
});

test("R6: a client whose clock is behind gets CLOCK_SKEW for an online-only write, corrects its clock and creates the space", async (t) => {
  const w = new World(3);
  const slow = { now: () => w.clock.now() - 5 * MINUTE };
  const c = new ReplicaClient(w.server, actor("eve"), { clock: slow, random: w.random });
  const first = await c.send("spaces.create", { id: c.newId(), name: "slow-0" });
  t.true(first.ok, JSON.stringify(first));
  t.true(Math.abs(c.now() - w.clock.now()) < 1000);
  // the envelope it sent first is refused with CLOCK_SKEW and the server's time
  const refusal = c.sent[0];
  if (!refusal) return t.fail("nothing sent");
  const r = await w.server.apply(actor("eve"), { ...refusal, seq: 2 });
  t.is(r.ok ? null : r.error.code, "CLOCK_SKEW");
  t.is(r.ok ? null : r.error.serverTime, w.clock.now());
  for (const name of ["slow-1", "slow-2"])
    await ok(t, c.send("spaces.create", { id: c.newId(), name }));
  t.is([...w.server.dump().values()].filter((x) => x.kind === "space").length, 3);
});

test("R7: dropping a write from the outbox does not block the writes after it", async (t) => {
  const { w, open } = await cast(t);
  const mel = w.client("mel");
  const queued = ["one", "two", "three", "four"].map((q) =>
    mel.queue("threads.create", { id: mel.newId(), space: open, kind: "post", q }),
  );
  await mel.register();
  // the person cancels the first write; the device restarts with the rest
  t.true(mel.drop(queued[0]?.mutationId ?? ""));
  const later = new ReplicaClient(
    w.server,
    actor("mel"),
    { clock: w.clock, random: w.random },
    mel.state(),
  );
  t.deepEqual(codes(await later.flush()), ["ok", "ok", "ok"]);
  t.is(later.pending().length, 0);
  // a write that expires in the outbox (3 days) does not block either
  const old = later.queue("threads.create", {
    id: later.newId(),
    space: open,
    kind: "post",
    q: "old",
  });
  w.clock.advance(2 * DAY);
  later.queue("threads.create", { id: later.newId(), space: open, kind: "post", q: "new" });
  w.clock.advance(DAY + 1);
  t.deepEqual(codes(await later.flush()), ["ok"]);
  const qs = [...w.server.dump().values()].flatMap((r) =>
    r.kind === "thread" && r.u === "mel" ? [r.q] : [],
  );
  t.deepEqual(qs.sort(), ["four", "new", "three", "two"]);
  t.false(later.sent.some((e) => e.mutationId === old.mutationId));
});

test("R7b: a reused mutation id's refusal is recorded, so the same envelope sent again gets it, not OUT_OF_ORDER", async (t) => {
  const { w, open } = await cast(t);
  const first = await w.envelope("mel", "likes.set", { thread: w.id(), on: false });
  await ok(t, w.server.apply(actor("mel"), first));
  const reuse = await w.envelope(
    "mel",
    "threads.create",
    { id: w.id(), space: open, kind: "post", q: "x" },
    first.mutationId,
  );
  const a = await refused(t, w.server.apply(actor("mel"), reuse), "BAD_REQUEST");
  const b = await refused(t, w.server.apply(actor("mel"), reuse), "BAD_REQUEST");
  t.is(a, b);
  // the first write's answer stays: its replay answers it
  t.deepEqual(await w.server.apply(actor("mel"), first), { ok: true, result: { on: false } });
  // a client whose queued write has a reused id gets the refusal, and the next write goes through
  const mel = w.client("mel");
  mel.queue("threads.create", { id: w.id(), space: open, kind: "post", q: "y" }, first.mutationId);
  mel.queue("threads.create", { id: w.id(), space: open, kind: "post", q: "z" });
  t.deepEqual(codes(await mel.flush()), ["BAD_REQUEST", "ok"]);
});

test("R7c: after the device registers again, a replayed answer uses no seq, and the next write goes with the seq the server expects", async (t) => {
  const { w, open } = await cast(t);
  const env = { clock: w.clock, random: w.random };
  const mel = w.client("mel");
  const one = mel.queue("threads.create", { id: mel.newId(), space: open, kind: "post", q: "one" });
  const two = {
    mutationId: mel.newId(),
    name: "threads.create",
    input: { id: mel.newId(), space: open, kind: "post", q: "two" },
    queuedAt: w.clock.now(),
  };
  t.deepEqual(codes(await mel.flush()), ["ok"]);
  // the response was lost: the device kept both writes and registers a new client id
  const again = new ReplicaClient(w.server, actor("mel"), env, {
    clientId: null,
    outbox: [{ ...one }, two],
  });
  t.deepEqual(codes(await again.flush()), ["ok", "ok"]);
  t.not(again.clientId, mel.clientId);
  const qs = [...w.server.dump().values()].flatMap((r) =>
    r.kind === "thread" && r.u === "mel" ? [r.q] : [],
  );
  t.deepEqual(qs.sort(), ["one", "two"]);
  // the replay used no seq: the server processed one write for the new client
  const s = await w.server.snapshot(actor("mel"), "user:mel", { clientId: again.clientId ?? "" });
  t.is(s.lastSeq, 1);
  // the protocol underneath: the first write not applied yet, sent under the
  // seq the client guessed, is OUT_OF_ORDER with the seq the server takes
  const e1 = await w.envelope("otto", "threads.create", {
    id: w.id(),
    space: open,
    kind: "post",
    q: "1",
  });
  await ok(t, w.server.apply(actor("otto"), e1));
  const reg = await w.server.register(actor("otto"));
  if (!reg.ok) return t.fail("register");
  await ok(t, w.server.apply(actor("otto"), { ...e1, clientId: reg.clientId, seq: 1 }));
  const e2 = {
    ...(await w.envelope("otto", "threads.create", {
      id: w.id(),
      space: open,
      kind: "post",
      q: "2",
    })),
    clientId: reg.clientId,
    seq: 2,
  };
  const r = await w.server.apply(actor("otto"), e2);
  t.is(r.ok ? null : r.error.code, "OUT_OF_ORDER");
  t.is(r.ok ? null : r.error.expectedSeq, 1);
  await ok(t, w.server.apply(actor("otto"), { ...e2, seq: 1 }));
});

test("R8: an input outside the bounds is a recorded BAD_REQUEST, and the writes after it go through", async (t) => {
  const { w, closed } = await cast(t);
  const mona = w.client("mona");
  mona.queue("invites.create", { id: mona.newId(), space: closed, days: 1e15 });
  mona.queue("invites.create", { id: mona.newId(), space: closed, days: 31 });
  mona.queue("invites.create", { id: mona.newId(), space: closed, days: 30 });
  t.deepEqual(codes(await mona.flush()), ["BAD_REQUEST", "BAD_REQUEST", "ok"]);
  t.is(mona.pending().length, 0);
  // the refusal was recorded: the same envelope answers it again
  const sent = mona.sent[0];
  if (!sent) return t.fail("nothing sent");
  await refused(t, w.server.apply(actor("mona"), sent), "BAD_REQUEST");
});

test("R8: a fault that is not a refusal is INTERNAL_SERVER_ERROR, writes nothing and records nothing; the client keeps the write", async (t) => {
  let broken = true;
  const create = MUTATORS["threads.create"] as AnyMutator;
  const faulty: AnyMutator = {
    ...create,
    // the real run stages its writes, then the server fails
    run: (tx, i, v) => {
      const result = create.run(tx, i, v);
      if (broken) throw new RangeError("the server failed after staging writes");
      return result;
    },
  };
  const { w, open } = await cast(t, 1, { mutators: { ...MUTATORS, "threads.create": faulty } });
  const before = JSON.stringify([...w.server.dump()]);
  const jobs = w.server.jobs().length;
  const mel = w.client("mel");
  const id = mel.newId();
  mel.queue("threads.create", { id, space: open, kind: "ask", q: "x" });
  mel.queue("likes.set", { thread: id, on: true });
  t.deepEqual(codes(await mel.flush()), ["INTERNAL_SERVER_ERROR"]);
  t.deepEqual(codes(await mel.flush()), ["INTERNAL_SERVER_ERROR"]);
  t.is(mel.pending().length, 2);
  t.is(JSON.stringify([...w.server.dump()]), before);
  t.is(w.server.jobs().length, jobs);
  t.is(await w.nextSeq("mel", mel.clientId ?? ""), 1);
  broken = false;
  t.deepEqual(codes(await mel.flush()), ["ok", "ok"]);
  t.is((w.get(`thread:${id}`) as ThreadRec).likes, 1);
  t.is(w.server.jobs().length, jobs + 1);
});

test("R8: a pre-check that fails because the server's random source failed is INTERNAL_SERVER_ERROR, unrecorded", async (t) => {
  let failing = false;
  const r = rng(77);
  const random = () => {
    if (failing) throw new Error("the random source is unavailable");
    return r();
  };
  const { w, closed } = await cast(t, 1, { random });
  const e = await w.envelope("mona", "invites.create", { id: w.id(), space: closed });
  failing = true;
  await refused(t, w.server.apply(actor("mona"), e), "INTERNAL_SERVER_ERROR");
  t.false([...w.server.dump().values()].some((x) => x.kind === "invite"));
  failing = false;
  await ok(t, w.server.apply(actor("mona"), e));
});

test("R9: a failing post-commit effect does not change the stored answer, and runs once it succeeds", async (t) => {
  let failing = false;
  const r = rng(5);
  const random = () => {
    if (failing) throw new Error("the notification service is down");
    return r();
  };
  const { w, open } = await cast(t, 1, { random });
  const th = await thread(t, w, "olga", open, "post", "x");
  const report = w.id();
  const e = await w.envelope("eve", "reports.create", { id: report, item: `p:${th}`, why: "spam" });
  failing = true;
  const first = await w.server.apply(actor("eve"), e);
  t.deepEqual(first, { ok: true, result: { id: report, sp: open } });
  t.true(w.server.dump().has(`report:${report}`));
  const notifs = () =>
    [...w.server.dump().values()].flatMap((x) => (x.kind === "notif" ? [x.to] : [])).sort();
  t.deepEqual(notifs(), []);
  // the retry of the same envelope gets the stored answer while the effect still fails
  t.deepEqual(await w.server.apply(actor("eve"), e), first);
  await w.server.snapshot(null, `space:${open}`);
  t.deepEqual(notifs(), []);
  failing = false;
  // the next call runs the queued effect: the space's staff get one notification each
  await w.server.snapshot(null, `space:${open}`);
  t.deepEqual(notifs(), ["mona", "olga"]);
  await w.server.snapshot(null, `space:${open}`);
  t.deepEqual(notifs(), ["mona", "olga"]);
  t.deepEqual(await w.server.apply(actor("eve"), e), first);
});

test("R15: TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE and INTERNAL_SERVER_ERROR keep the write queued, and it is sent again", async (t) => {
  const { w, open } = await cast(t);
  const transient = ["TOO_MANY_REQUESTS", "SERVICE_UNAVAILABLE", "INTERNAL_SERVER_ERROR"] as const;
  const answers: (typeof transient)[number][] = [...transient];
  // a rate limiter or proxy in front of the server answers each once
  const front: ServerHalf = {
    register: (a) => w.server.register(a),
    snapshot: (a, l, o) => w.server.snapshot(a, l, o),
    pull: (a, l, c, o) => w.server.pull(a, l, c, o),
    apply: (a, e) => {
      const code = answers.shift();
      if (code) return { ok: false, error: { code, message: "Try again later." } };
      return w.server.apply(a, e);
    },
  };
  const mel = new ReplicaClient(front, actor("mel"), { clock: w.clock, random: w.random });
  const th = mel.newId();
  mel.queue("threads.create", { id: th, space: open, kind: "post", q: "typed offline" });
  for (const code of transient) {
    t.deepEqual(codes(await mel.flush()), [code]);
    t.is(mel.pending().length, 1);
  }
  t.deepEqual(codes(await mel.flush()), ["ok"]);
  t.is(mel.pending().length, 0);
  t.is((w.get(`thread:${th}`) as ThreadRec | undefined)?.q, "typed offline");
  t.true(mel.sent.every((e) => e.protocolVersion === PROTOCOL_VERSION && e.seq === 1));
});
