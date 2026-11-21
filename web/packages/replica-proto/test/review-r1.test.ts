// The attacks of review round 1 (R1 to R15), each ported as a test that the
// server refuses or filters it. The invariant files hold the general cases;
// these keep each attack's own scenario.

import test from "ava";

import {
  PROTO_MUTATORS,
  PROTOCOL_VERSION,
  ReplicaClient,
  type AnyMutator,
  type ApplyResult,
  type LogId,
  type ServerHalf,
  type CountsRec,
  type ThreadRec,
} from "../src/index.js";

import {
  DAY,
  HOUR,
  MINUTE,
  MODEL,
  World,
  actor,
  bare,
  cast,
  fork,
  forkInput,
  ok,
  refused,
  rng,
  thread,
} from "./harness.js";

const codes = (rs: ApplyResult[]) => rs.map((r) => (r.ok ? "ok" : r.error.code));

test("R1: an approval queued for a request that was approved, then reopened by asking again, is STALE", async (t) => {
  const { w, closed } = await cast(t);
  await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
  // the owner decides on two devices
  const phone = w.client("olga");
  phone.queue("joinRequests.decide", {
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
    w.as("olga", "members.remove", {
      space: closed,
      user: "otto",
      base: w.admission(closed, "otto"),
    }),
  );
  // otto asks again: the same request record is open again, with a new rev
  const before = w.rev(`request:${closed}:otto`);
  await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
  t.true(w.rev(`request:${closed}:otto`) > before);
  w.clock.advance(HOUR);
  const [r] = await phone.flush();
  t.is(r?.ok ? "ok" : r?.error.code, "STALE");
  t.is(w.get(`member:${closed}:otto`), undefined);
  // a decline queued from the first request restricts: it applies to the
  // request as it is now, whatever its rev (review round 2, finding 2)
  const olga = w.client("olga");
  olga.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "decline",
    base: { otto: before },
  });
  const [d] = await olga.flush();
  t.is(d?.ok ? "ok" : d?.error.code, "ok");
  t.is((w.get(`request:${closed}:otto`) as { st: string }).st, "declined");
  // a reopening and an approval of the request as it is now apply
  for (const decision of ["reopen", "approve"])
    await ok(
      t,
      w.as("olga", "joinRequests.decide", {
        space: closed,
        users: ["otto"],
        decision,
        base: w.requests(closed, ["otto"]),
      }),
    );
  t.truthy(w.get(`member:${closed}:otto`));
});

test("R1: reopening a declined request bumps its rev, so a decision made before the reopening is STALE", async (t) => {
  const { w, closed } = await cast(t);
  await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
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
    w.as("olga", "joinRequests.decide", {
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
      w.as("olga", "joinRequests.decide", {
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
  const phone = w.client("olga");
  phone.queue("members.remove", { space: closed, user: "mel", base: w.admission(closed, "mel") });
  phone.queue("members.ban", { space: closed, user: "mel" });
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  await ok(t, w.as("mel", "joinRequests.create", { space: closed }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["mel"],
      decision: "approve",
      base: w.requests(closed, ["mel"]),
    }),
  );
  // the removal names the first admission: STALE. The ban restricts, and
  // applies to mel as he is now (review round 2, finding 2).
  const results = await phone.flush();
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["STALE", "ok"],
  );
  t.is(w.get(`member:${closed}:mel`), undefined);
  t.truthy(w.get(`ban:${closed}:mel`));
  // a ban of a person who is not a member applies too
  await ok(t, w.as("olga", "members.ban", { space: closed, user: "eve" }));
  await ok(t, w.as("olga", "members.ban", { space: closed, user: "otto" }));
});

test("R2: a queued 'shown' does not publish text the author changed after the owner read it", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "otto", open, "post", "borderline v1");
  await ok(
    t,
    w.as("olga", "moderation.decide", {
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
  // a queued "removed" restricts: it applies to the item as it is now,
  // whatever its rev, and erases the newer text (review round 2, finding 2)
  const tablet = w.client("olga");
  tablet.queue("moderation.decide", {
    item: `p:${th}`,
    decision: "removed",
    base: { rev: w.rev(`thread:${th}`) - 1 },
  });
  const [x] = await tablet.flush();
  t.is(x?.ok ? "ok" : x?.error.code, "ok");
  t.is(
    JSON.stringify(await w.server.snapshot(actor("otto"), `space:${open}`)).includes("ABUSE"),
    false,
  );
});

test("R6: a client whose clock is behind gets CLOCK_SKEW for an online-only write, corrects its clock and creates the space", async (t) => {
  const w = new World(3);
  const slow = { now: () => w.clock.now() - 5 * MINUTE };
  const c = new ReplicaClient(w.server, actor("eve"), { clock: slow, random: w.random });
  const first = await c.send("spaces.create", { id: c.newId(), name: "slow-0" });
  t.true(first.ok, JSON.stringify(first));
  t.true(Math.abs(c.now() - w.clock.now()) < 1000);
  // the envelope it sent first was refused with CLOCK_SKEW; the reminted
  // envelope names it in `replaces`, so sent again it gets the answer of the
  // write that replaced it and is not applied a second time (`01` Y1)
  const refusal = c.sent[0];
  if (!refusal) return t.fail("nothing sent");
  t.deepEqual(c.sent[1]?.replaces, [refusal.mutationId]);
  t.deepEqual(await w.server.apply(actor("eve"), { ...refusal, seq: 2 }), first);
  // with a mutation id the server has no answer for, the slow clock is
  // CLOCK_SKEW with the server's time
  const r = await w.server.apply(actor("eve"), { ...refusal, mutationId: w.id(), seq: 2 });
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
  // the dropped write is shown to the person, not discarded silently
  t.deepEqual(
    later.problems().map((p) => [p.local, p.reason, p.sent]),
    [[old.local, "DROPPED", false]],
  );
});

test("R7b: a reused mutation id's refusal is recorded, so the same envelope sent again gets it, not OUT_OF_ORDER", async (t) => {
  const { w, open } = await cast(t);
  const first = await w.envelope("mel", "saved.set", { kind: "thread", id: w.id(), on: false });
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
  t.deepEqual(bare(await w.server.apply(actor("mel"), first)), { ok: true, result: { on: false } });
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
    ...one,
    local: mel.newId(),
    mutationId: mel.newId(),
    input: { id: mel.newId(), space: open, kind: "post", q: "two" },
  };
  t.deepEqual(codes(await mel.flush()), ["ok"]);
  // the response was lost: the device kept both writes and registers a new client id
  const again = new ReplicaClient(w.server, actor("mel"), env, {
    owner: "mel",
    clientId: null,
    outbox: [{ ...one, sent: true }, two],
    acked: 0,
    offset: 0,
    problems: [],
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
  const olga = w.client("olga");
  olga.queue("invites.create", { id: olga.newId(), space: closed, days: 1e15 });
  olga.queue("invites.create", { id: olga.newId(), space: closed, days: 31 });
  olga.queue("moderation.decide", {
    item: `p:${await thread(t, w, "mel", closed, "post")}`,
    decision: "removed",
    note: "x".repeat(301),
  });
  olga.queue("invites.create", { id: olga.newId(), space: closed, days: 30 });
  t.deepEqual(codes(await olga.flush()), ["BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST", "ok"]);
  t.is(olga.pending().length, 0);
  // the refusal was recorded: the same envelope answers it again
  const sent = olga.sent[0];
  if (!sent) return t.fail("nothing sent");
  await refused(t, w.server.apply(actor("olga"), sent), "BAD_REQUEST");
});

test("R8: a fault that is not a refusal is INTERNAL_SERVER_ERROR, writes nothing and records nothing; the client keeps the write", async (t) => {
  let broken = true;
  const create = PROTO_MUTATORS["threads.create"] as AnyMutator;
  const faulty: AnyMutator = {
    ...create,
    // the real run stages its writes, then the server fails
    run: (tx, i, v) => {
      const result = create.run(tx, i, v);
      if (broken) throw new RangeError("the server failed after staging writes");
      return result;
    },
  };
  const { w, open } = await cast(t, 1, {
    mutators: { ...PROTO_MUTATORS, "threads.create": faulty },
  });
  const before = JSON.stringify([...w.server.dump()]);
  const jobs = w.server.jobs().length;
  const mel = w.client("mel");
  const id = mel.newId();
  mel.queue("threads.create", { id, space: open, kind: "ask", q: "x", ...MODEL });
  mel.queue("saved.set", { kind: "thread", id, on: true });
  t.deepEqual(codes(await mel.flush()), ["INTERNAL_SERVER_ERROR"]);
  // the client waits before it sends the write again
  t.deepEqual(codes(await mel.flush()), []);
  w.clock.advance(MINUTE);
  t.deepEqual(codes(await mel.flush()), ["INTERNAL_SERVER_ERROR"]);
  t.is(mel.pending().length, 2);
  t.is(JSON.stringify([...w.server.dump()]), before);
  t.is(w.server.jobs().length, jobs);
  t.is(await w.nextSeq("mel", mel.clientId ?? ""), 1);
  broken = false;
  w.clock.advance(MINUTE);
  t.deepEqual(codes(await mel.flush()), ["ok", "ok"]);
  t.is((w.get(`counts:${id}`) as CountsRec).saves, 1);
  // the ask's run was queued with the write: its record is the queue
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
  const e = await w.envelope("olga", "invites.create", { id: w.id(), space: closed, days: 7 });
  failing = true;
  await refused(t, w.server.apply(actor("olga"), e), "INTERNAL_SERVER_ERROR");
  t.false([...w.server.dump().values()].some((x) => x.kind === "invite"));
  failing = false;
  await ok(t, w.server.apply(actor("olga"), e));
});

test("R9: a write and its notifications commit together: a fault in the notify stage writes neither, and the write sent again writes both once", async (t) => {
  // there is no effect queue (`01` U6): notifications are written by the
  // mutator's `notify` stage in the write's transaction
  let broken = true;
  const reply = PROTO_MUTATORS["research.createPostFollowUp"] as AnyMutator;
  const faulty: AnyMutator = {
    ...reply,
    notify: (tx, i, result, ctx) => {
      const told = reply.notify?.(tx, i, result, ctx);
      if (broken) throw new RangeError("the server failed after staging the notifications");
      return told;
    },
  };
  const { w, open } = await cast(t, 1, {
    mutators: { ...PROTO_MUTATORS, "research.createPostFollowUp": faulty },
  });
  const th = await thread(t, w, "olga", open, "post", "x");
  const before = JSON.stringify([...w.server.dump()]);
  const id = w.id();
  const e = await w.envelope("mel", "research.createPostFollowUp", {
    id,
    thread: th,
    t: "@otto look",
  });
  await refused(t, w.server.apply(actor("mel"), e), "INTERNAL_SERVER_ERROR");
  t.is(JSON.stringify([...w.server.dump()]), before);
  t.is(await w.nextSeq("mel", e.clientId), e.seq);
  broken = false;
  const first = bare(await w.server.apply(actor("mel"), e));
  t.deepEqual(first, { ok: true, result: { notified: ["otto"], notMembers: [] } });
  const notifs = () =>
    [...w.server.dump().values()]
      .flatMap((x) => (x.kind === "notif" ? [`${x.to}:${x.type}:${x.item}`] : []))
      .sort();
  t.deepEqual(notifs(), [`olga:reply:reply:${id}`, `otto:mention:reply:${id}`]);
  // the same envelope again gets the stored answer, and writes nothing more
  t.deepEqual(bare(await w.server.apply(actor("mel"), e)), first);
  t.deepEqual(notifs(), [`olga:reply:reply:${id}`, `otto:mention:reply:${id}`]);
  // a refused write notifies nobody: its id is taken
  await refused(
    t,
    w.as("mel", "research.createPostFollowUp", { id, thread: th, t: "@otto again" }),
    "CONFLICT",
  );
  t.deepEqual(notifs(), [`olga:reply:reply:${id}`, `otto:mention:reply:${id}`]);
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
      if (code) return { ok: false, error: { code, message: "Try again later.", serverTime: 0 } };
      return w.server.apply(a, e);
    },
  };
  const mel = new ReplicaClient(front, actor("mel"), { clock: w.clock, random: w.random });
  const th = mel.newId();
  mel.queue("threads.create", { id: th, space: open, kind: "post", q: "typed offline" });
  for (const code of transient) {
    t.deepEqual(codes(await mel.flush()), [code]);
    t.is(mel.pending().length, 1);
    w.clock.advance(MINUTE);
  }
  t.deepEqual(codes(await mel.flush()), ["ok"]);
  t.is(mel.pending().length, 0);
  t.is((w.get(`thread:${th}`) as ThreadRec | undefined)?.q, "typed offline");
  t.true(mel.sent.every((e) => e.protocolVersion === PROTOCOL_VERSION && e.seq === 1));
});

test("R3: a signed-out caller reading a missing or a closed log sees nothing move when writes it may not read happen", async (t) => {
  const { w, open, closed } = await cast(t);
  const probe = `space:${w.id()}` as LogId;
  const reads = async () => {
    const out: unknown[] = [];
    for (const log of [probe, `space:${closed}` as LogId]) {
      const s = await w.server.snapshot(null, log);
      out.push(s.records, s.cursor.length);
    }
    return JSON.stringify(out);
  };
  const first = await w.server.snapshot(null, probe);
  const lab = await w.server.snapshot(null, `space:${closed}`);
  const before = await reads();
  const ids = [w.id(), w.id(), w.id()];
  for (const id of ids)
    await ok(t, w.as("mel", "threads.create", { id, space: closed, kind: "post", q: "private" }));
  await ok(t, w.as("ada", "saved.set", { kind: "thread", id: ids[0], on: true }));
  t.is(await reads(), before);
  for (const [log, s] of [
    [probe, first],
    [`space:${closed}`, lab],
  ] as const) {
    const p = await w.server.pull(null, log, s.cursor);
    if ("resync" in p) return t.fail("unexpected resync");
    t.deepEqual([p.changes, p.lastSeq, p.cursor.length], [[], null, s.cursor.length]);
  }
  // the open space's public records did not change either
  const o = await w.server.snapshot(null, `space:${open}`);
  t.false(JSON.stringify(o).includes("private"));
});

test("R4a: a removed member's user log gets no deletions of saves in the private space", async (t) => {
  const { w, closed } = await cast(t);
  const log: LogId = "user:mel";
  const t1 = await thread(t, w, "ada", closed, "post", "ada's");
  await ok(t, w.as("mel", "saved.set", { kind: "thread", id: t1, on: true }));
  const mel = w.client("mel");
  await mel.sync(log);
  t.true(mel.records(log).has(`save:mel:${t1}`));
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  // the removal resyncs mel's user log: the saves there are no longer served
  t.is(await mel.sync(log), "resync");
  t.false(mel.records(log).has(`save:mel:${t1}`));
  const cursor = mel.cursor(log);
  if (!cursor) return t.fail("no cursor");
  w.clock.advance(HOUR);
  // the private space goes on: ada deletes her thread, which deletes mel's save
  await ok(t, w.as("ada", "threads.delete", { id: t1 }));
  t.false(w.server.dump().has(`save:mel:${t1}`));
  const p = await w.server.pull(actor("mel"), log, cursor);
  t.deepEqual("resync" in p ? null : p.changes, []);
});

test("R4b: a removed author's delete answers null, not whether the thread got replies after they left", async (t) => {
  const { w, closed } = await cast(t);
  const t2 = await thread(t, w, "mel", closed, "post", "mel's");
  const t3 = await thread(t, w, "mel", closed, "post", "mel's other");
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  await ok(
    t,
    w.as("ada", "research.createPostFollowUp", { id: w.id(), thread: t2, t: "after mel left" }),
  );
  const a = await w.as("mel", "threads.delete", { id: t2 });
  const b = await w.as("mel", "threads.delete", { id: t3 });
  t.deepEqual(
    [bare(a), bare(b)],
    [
      { ok: true, result: null },
      { ok: true, result: null },
    ],
  );
  // the delete itself happened: kept as a shell, and gone
  t.true((w.get(`thread:${t2}`) as ThreadRec).del);
  t.false((w.get(`thread:${t2}`) as ThreadRec).gone);
  t.true((w.get(`thread:${t3}`) as ThreadRec).gone);
  // a member who may read the thread is told
  const t4 = await thread(t, w, "ada", closed, "post");
  t.deepEqual(bare(await w.as("ada", "threads.delete", { id: t4 })), {
    ok: true,
    result: { kept: false },
  });
});

test("R4c: notifications leave a member's user log when the member is removed from the private space", async (t) => {
  // review round 1's R4c was about report notifications to a moderator who
  // left; there is no reporting and the owner cannot leave (`01` U6). The
  // rule stays for every notification: served only while its person may
  // read its space.
  const { w, closed } = await cast(t);
  const th = await thread(t, w, "olga", closed, "post", "x");
  await ok(
    t,
    w.as("ada", "research.createPostFollowUp", { id: w.id(), thread: th, t: "@mona see this" }),
  );
  const notifsOf = async (u: string) =>
    (await w.server.snapshot(actor(u), `user:${u}`)).records.filter(
      (r) => r.record.kind === "notif",
    );
  t.is((await notifsOf("mona")).length, 1);
  const mona = w.client("mona");
  await mona.sync("user:mona");
  await ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mona",
      base: w.admission(closed, "mona"),
    }),
  );
  t.deepEqual(await notifsOf("mona"), []);
  t.is(await mona.sync("user:mona"), "resync");
  t.false([...mona.records("user:mona").values()].some((r) => r.kind === "notif"));
  // the record is kept; she gets it again if she is let in again
  t.true([...w.server.dump().values()].some((r) => r.kind === "notif" && r.to === "mona"));
  await ok(t, w.as("mona", "joinRequests.create", { space: closed }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["mona"],
      decision: "approve",
      base: w.requests(closed, ["mona"]),
    }),
  );
  t.is((await notifsOf("mona")).length, 1);
});

test("R5: a removed thread's text is in no value at rest, tombstones included, now or later", async (t) => {
  const { w, closed } = await cast(t);
  const ask = await thread(t, w, "mel", closed, "ask", "SECRET-ASK");
  const post = w.id();
  await ok(
    t,
    w.as("mel", "threads.create", {
      id: post,
      space: closed,
      kind: "post",
      q: "SECRET-POST",
      title: "SECRET-TITLE",
    }),
  );
  const fu = w.id();
  await ok(t, w.as("mona", "research.forkNode", forkInput(fu, ask, "SECRET-FOLLOWUP")));
  t.true(await w.server.finishJob(`node:${fu}`, "SECRET-ANSWER"));
  t.true(await w.server.finishJob(`thread:${ask}`, "SECRET-SUMMARY"));
  await ok(
    t,
    w.as("mona", "research.createPostFollowUp", { id: w.id(), thread: post, t: "SECRET-REPLY" }),
  );
  await ok(
    t,
    w.as("ada", "comments.create", { id: w.id(), thread: ask, node: fu, t: "@mel SECRET-COMMENT" }),
  );
  await ok(t, w.as("ada", "saved.set", { kind: "thread", id: post, on: true }));
  const at = async () => JSON.stringify(await w.server.scanStorage());
  t.regex(await at(), /SECRET-ANSWER/);
  for (const item of [`a:${ask}`, `p:${post}`])
    await ok(
      t,
      w.as("olga", "moderation.decide", { item, decision: "removed", base: w.item(item) }),
    );
  t.deepEqual((await at()).match(/SECRET-[A-Z]+/g), null);
  // a tombstone keeps the key, kind and audience (the rev is in the registry)
  const scan = await w.server.scanStorage();
  t.true(scan.tombstones.length >= 3);
  for (const tomb of scan.tombstones)
    t.deepEqual(Object.keys(tomb).sort(), ["at", "by", "key", "kind", "person", "sp"]);
  w.clock.advance(29 * DAY);
  t.deepEqual((await at()).match(/SECRET-[A-Z]+/g), null);
  // and a job that finishes after the removal writes nothing
  t.false(await w.server.finishJob(`thread:${ask}`, "SECRET-LATE"));
  t.false(await w.server.finishJob(`node:${fu}`, "SECRET-LATE"));
  t.deepEqual((await at()).match(/SECRET-[A-Z]+/g), null);
});

test("R10 (kept): the CONFLICT for a taken name names only the name sent, a private space's included", async (t) => {
  const { w } = await cast(t);
  const a = await refused(
    t,
    w.as("eve", "spaces.create", { id: w.id(), name: "vault" }),
    "CONFLICT",
  );
  const b = await refused(
    t,
    w.as("eve", "spaces.create", { id: w.id(), name: "lounge" }),
    "CONFLICT",
  );
  t.deepEqual(JSON.parse(a), { code: "CONFLICT", message: "#vault already exists." });
  t.deepEqual(JSON.parse(b), { code: "CONFLICT", message: "#lounge already exists." });
  await ok(t, w.as("eve", "spaces.create", { id: w.id(), name: "vault-2" }));
});

test("R11 (kept): writes on a gone thread follow the mock, and an author may delete a removed thread", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "otto", open, "ask", "x");
  await ok(t, w.as("otto", "threads.delete", { id: th }));
  t.true((w.get(`thread:${th}`) as ThreadRec).gone);
  await ok(t, w.as("mel", "saved.set", { kind: "thread", id: th, on: true }));
  await fork(t, w, "mel", th, "hello?");
  const p = w.get(`thread:${th}`) as ThreadRec;
  const pCounts = w.get(`counts:${th}`) as CountsRec;
  t.deepEqual([p.gone, pCounts.saves, pCounts.r, p.q], [true, 1, 1, ""]);
  const th2 = await thread(t, w, "otto", open, "post", "x");
  await ok(t, w.as("mel", "saved.set", { kind: "thread", id: th2, on: true }));
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `p:${th2}`,
      decision: "removed",
      base: w.item(`p:${th2}`),
    }),
  );
  t.deepEqual(bare(await w.as("otto", "threads.delete", { id: th2 })), {
    ok: true,
    result: { kept: false },
  });
  t.is(w.get(`save:mel:${th2}`), undefined);
});

test("R12: a snapshot and then pulls on a server quiet for more than 30 days do not loop on resync", async (t) => {
  const { w, open } = await cast(t);
  const mel = w.client("mel");
  t.is(await mel.sync(`space:${open}`), "snapshot");
  w.clock.advance(31 * DAY);
  // the cursor is older than 30 days: one resync, then pulls
  t.is(await mel.sync(`space:${open}`), "resync");
  for (let k = 0; k < 3; k++) {
    w.clock.advance(MINUTE);
    t.is(await mel.sync(`space:${open}`), "pull");
  }
  // a reader who keeps pulling on a quiet server never resyncs
  for (let k = 0; k < 4; k++) {
    w.clock.advance(20 * DAY);
    t.is(await mel.sync(`space:${open}`), "pull");
  }
});

test("R13: a list sorts by the server's creation time, then by commit, never by the client's id", async (t) => {
  const { w, open } = await cast(t);
  w.clock.advance(HOUR);
  const honest = w.id();
  const backdated = w.id(-3 * DAY);
  await ok(t, w.as("mel", "threads.create", { id: honest, space: open, kind: "post", q: "first" }));
  await ok(
    t,
    w.as("eve", "threads.create", { id: backdated, space: open, kind: "post", q: "second" }),
  );
  t.true(backdated < honest);
  const s = await w.server.snapshot(null, `space:${open}`);
  t.deepEqual(
    s.records.filter((r) => r.record.kind === "thread").map((r) => (r.record as ThreadRec).q),
    ["first", "second"],
  );
});

test("R14 (kept): hiding a thread blanks the thread's own text; its replies and nodes are moderated one by one", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "otto", open, "post", "the hidden post");
  const rp = w.id();
  await ok(
    t,
    w.as("otto", "research.createPostFollowUp", { id: rp, thread: th, t: "reply under it" }),
  );
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `p:${th}`,
      decision: "hidden",
      base: w.item(`p:${th}`),
    }),
  );
  const got = async () => {
    const s = await w.server.snapshot(null, `space:${open}`);
    return [
      (s.records.find((r) => r.key === `thread:${th}`)?.record as ThreadRec).q,
      (s.records.find((r) => r.key === `reply:${rp}`)?.record as { t: string }).t,
    ];
  };
  t.deepEqual(await got(), ["", "reply under it"]);
  await ok(
    t,
    w.as("olga", "moderation.decide", {
      item: `r:${th}:${rp}`,
      decision: "hidden",
      base: w.item(`r:${th}:${rp}`),
    }),
  );
  t.deepEqual(await got(), ["", ""]);
});

// Section 8 of the review: effects the suite did not check.

test("a ban takes the membership away, and neither an approval nor an invite link lets the banned person in", async (t) => {
  const { w, closed } = await cast(t);
  // otto asks to join; before anyone decides, he is banned
  await ok(t, w.as("otto", "joinRequests.create", { space: closed }));
  await ok(t, w.as("eve", "joinRequests.create", { space: closed }));
  await ok(t, w.as("olga", "members.ban", { space: closed, user: "otto" }));
  // a member who is banned loses the member record
  await ok(t, w.as("olga", "members.ban", { space: closed, user: "mel" }));
  t.is(w.get(`member:${closed}:mel`), undefined);
  t.truthy(w.get(`ban:${closed}:mel`));
  t.is((w.get(`space:${closed}`) as { members: number }).members, 3);
  // the approval of the banned requester is refused
  await refused(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "approve",
      base: w.requests(closed, ["otto"]),
    }),
    "PRECONDITION_FAILED",
  );
  t.is(w.get(`member:${closed}:otto`), undefined);
  // an invite link does not let a banned person in, and stays unused
  const link = (await ok(
    t,
    w.as("olga", "invites.create", { id: w.id(), space: closed, days: 7 }),
  )) as { code: string };
  for (const u of ["otto", "mel"])
    await refused(t, w.as(u, "spaces.join", { space: closed, invite: link.code }), "FORBIDDEN");
  await ok(t, w.as("eve", "spaces.join", { space: closed, invite: link.code }));
  t.truthy(w.get(`member:${closed}:eve`));
  // a ban and an unban are in the owner's moderation log, and an unban lets
  // the person back in by the usual routes
  await ok(t, w.as("olga", "members.unban", { space: closed, user: "mel" }));
  const log = [...w.server.dump().values()].flatMap((r) =>
    r.kind === "modlog" ? [`${r.act}:${r.author}:${String(r.item)}`] : [],
  );
  t.deepEqual(log.sort(), ["ban:mel:null", "ban:otto:null", "unban:mel:null"]);
  await ok(t, w.as("mel", "joinRequests.create", { space: closed }));
});

test("the owner is the only owner: nobody bans or removes the owner, and the owner cannot leave", async (t) => {
  const { w, open, closed } = await cast(t);
  await refused(t, w.as("olga", "spaces.leave", { space: closed }), "PRECONDITION_FAILED");
  await refused(t, w.as("olga", "members.ban", { space: open, user: "olga" }), "FORBIDDEN");
  await refused(t, w.as("mona", "members.ban", { space: open, user: "olga" }), "FORBIDDEN");
  const roles = [...w.server.dump().values()]
    .flatMap((r) => (r.kind === "member" && r.sp === closed ? [`${r.u}:${r.role}`] : []))
    .sort();
  t.deepEqual(roles, ["ada:member", "mel:member", "mona:member", "olga:owner"]);
  t.is((w.get(`space:${closed}`) as { owner: string }).owner, "olga");
  // a member leaves; the owner's record and the space's owner stay
  await ok(t, w.as("mona", "spaces.leave", { space: closed }));
  t.is((w.get(`member:${closed}:olga`) as { role: string }).role, "owner");
});

test("every tombstone is pruned after 30 days, whatever its kind", async (t) => {
  const { w, open, closed } = await cast(t);
  const ask = await thread(t, w, "mel", closed, "ask");
  const node = await fork(t, w, "mona", ask, "x");
  await ok(t, w.as("ada", "comments.create", { id: w.id(), thread: ask, node, t: "@mel" }));
  const post = await thread(t, w, "mel", open, "post");
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: w.id(), thread: post, t: "x" }));
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: post, on: true }));
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: post, on: false }));
  for (const item of [`a:${ask}`, `p:${post}`])
    await ok(
      t,
      w.as("olga", "moderation.decide", { item, decision: "removed", base: w.item(item) }),
    );
  await ok(t, w.as("mel", "spaces.leave", { space: open }));
  const kinds = async () =>
    [...new Set((await w.server.scanStorage()).tombstones.map((x) => x.kind))].sort();
  const all = ["answer", "comment", "member", "node", "notif", "reply", "run", "save"];
  t.deepEqual(await kinds(), all);
  w.clock.advance(30 * DAY);
  t.deepEqual(await kinds(), all);
  w.clock.advance(1);
  t.deepEqual(await kinds(), []);
  t.false((await w.server.scanStorage()).logRows.some((r) => r.op === "del"));
});

test("an author's delete keeps a thread with nodes or replies, and makes one without gone", async (t) => {
  const { w, open } = await cast(t);
  const ask = await thread(t, w, "mel", open, "ask");
  const post = await thread(t, w, "mel", open, "post");
  const lone = await thread(t, w, "mel", open, "post");
  await fork(t, w, "otto", ask, "x");
  const top = w.id();
  await ok(t, w.as("otto", "research.createPostFollowUp", { id: top, thread: post, t: "x" }));
  for (const th of [ask, post, lone])
    await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: true }));
  for (const [th, kept] of [
    [ask, true],
    [post, true],
    [lone, false],
  ] as const) {
    t.deepEqual(bare(await w.as("mel", "threads.delete", { id: th })), {
      ok: true,
      result: { kept },
    });
    const p = w.get(`thread:${th}`) as ThreadRec;
    const pCounts = w.get(`counts:${th}`) as CountsRec;
    t.deepEqual([p.del, p.gone, pCounts.saves], [true, !kept, kept ? 1 : 0]);
    t.is(w.server.dump().has(`save:otto:${th}`), kept);
  }
});
