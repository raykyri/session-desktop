// The server half (`01` Y1-Y6, Y8, Y13) on the in-memory store: what the
// plan adds to the prototype's suite (which runs on this server too).

import { randomBytes } from "node:crypto";

import { MUTATORS, refuse, type AnyMutator } from "@session/mutators";
import test from "ava";

import {
  CLIENT_IDLE_TTL,
  MAX_ENVELOPE_BYTES,
  MemoryStore,
  PROTOCOL_VERSION,
  REGISTRATIONS_PER_DAY,
  SyncServer,
  type Envelope,
} from "../src/server/index.js";

import { DAY, MINUTE, MODEL, World, actor, cast, ok, post, refused } from "./world.js";

test("Y1: an envelope with another field, nested too deep, too large or of an old protocol is refused, unrecorded", (t) => {
  const { w, open } = cast(t);
  const e = w.envelope("mel", "saved.set", {
    kind: "thread",
    id: post(t, w, "mel", open),
    on: true,
  });
  refused(t, w.server.apply(actor("mel"), { ...e, extra: 1 }), "BAD_REQUEST");
  let deep: unknown = 1;
  for (let k = 0; k < 40; k++) deep = [deep];
  refused(t, w.server.apply(actor("mel"), { ...e, input: deep }), "BAD_REQUEST");
  const big = { ...e, input: { x: "a".repeat(MAX_ENVELOPE_BYTES) } };
  refused(t, w.server.apply(actor("mel"), big), "TOO_LARGE");
  refused(t, w.server.apply(actor("mel"), { ...e, protocolVersion: 3 }), "UPGRADE_REQUIRED");
  // none of them used the seq: the same seq applies
  ok(t, w.server.apply(actor("mel"), e));
  refused(t, w.as("mel", "nope.nope", {}), "NOT_FOUND");
});

test("Y2: every answer carries the server's time; a queue_full refusal is recorded with its reason", (t) => {
  const { w, open } = cast(t);
  for (let k = 0; k < 20; k++)
    ok(
      t,
      w.as("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: `q${k}`, ...MODEL }),
    );
  const e = w.envelope("mel", "threads.create", {
    id: w.id(),
    space: open,
    kind: "ask",
    q: "one more",
    ...MODEL,
  });
  const r = w.server.apply(actor("mel"), e);
  t.like(r, { ok: false, error: { code: "PRECONDITION_FAILED", reason: "queue_full" } });
  t.is(r.ok ? 0 : r.error.serverTime, w.clock.now());
  w.clock.advance(MINUTE);
  const again = w.server.apply(actor("mel"), { ...e, clientTime: w.clock.now() });
  t.like(again, { ok: false, error: { reason: "queue_full", serverTime: w.clock.now() } });
});

test("Y3: register re-attaches the caller's id with its lastSeq, uncounted; the 51st new id a day is refused", (t) => {
  const { w, open } = cast(t);
  const first = w.server.register(actor("mel"));
  if (!first.ok) return t.fail();
  const transport = w.transport("mel");
  const p = post(t, w, "mel", open);
  const e: Envelope = {
    clientId: first.clientId,
    seq: 1,
    mutationId: w.id(),
    name: "saved.set",
    input: { kind: "thread", id: p, on: true },
    protocolVersion: PROTOCOL_VERSION,
    clientTime: w.clock.now(),
    queuedAt: w.clock.now(),
  };
  ok(t, transport.apply(e) as ReturnType<SyncServer["apply"]>);
  // re-attached 100 times, counted never
  for (let k = 0; k < 100; k++)
    t.like(w.server.register(actor("mel"), { clientId: first.clientId }), {
      ok: true,
      clientId: first.clientId,
      lastSeq: 1,
      reattached: true,
    });
  // mel registered 2 ids today (w's default client and `first`)
  const news: string[] = [];
  for (let k = 0; k < REGISTRATIONS_PER_DAY; k++) {
    const r = w.server.register(actor("mel"));
    news.push(r.ok ? "ok" : r.error.code);
  }
  t.is(news.filter((x) => x === "ok").length, REGISTRATIONS_PER_DAY - 2);
  t.is(news.at(-1), "TOO_MANY_REQUESTS");
  // a re-attach is still answered
  t.true(w.server.register(actor("mel"), { clientId: first.clientId }).ok);
  // another user's id, an unknown one: WRONG_CLIENT
  t.like(w.server.register(actor("otto"), { clientId: first.clientId }), {
    ok: false,
    error: { code: "WRONG_CLIENT" },
  });
  t.like(w.server.register(actor("mel"), { clientId: w.id() }), {
    ok: false,
    error: { code: "WRONG_CLIENT" },
  });
  // a day later new ids are taken again
  w.clock.advance(DAY);
  t.true(w.server.register(actor("mel")).ok);
});

test("Y3: an id idle for 7 days is not re-attached; a waiting account is FORBIDDEN", (t) => {
  const w = new World({ expireEveryCall: false });
  const r = w.server.register(actor("mel"));
  if (!r.ok) return t.fail();
  w.clock.advance(CLIENT_IDLE_TTL - 1);
  t.true(w.server.register(actor("mel"), { clientId: r.clientId }).ok);
  w.clock.advance(CLIENT_IDLE_TTL);
  // not pruned yet (no retention ran), and still refused
  t.truthy(w.store.client(r.clientId));
  t.like(w.server.register(actor("mel"), { clientId: r.clientId }), {
    ok: false,
    error: { code: "WRONG_CLIENT" },
  });
  w.store.setAccount("wanda", "waiting");
  t.like(w.server.register(actor("wanda")), { ok: false, error: { code: "FORBIDDEN" } });
});

test("Y4: a reminted envelope's answer is stored under the ids it replaces; the delayed original gets it", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const original = w.envelope("mel", "saved.set", { kind: "thread", id: p, on: true });
  const reminted = { ...original, mutationId: w.id(), replaces: [original.mutationId] };
  const a = ok(t, w.server.apply(actor("mel"), reminted));
  const late = w.server.apply(actor("mel"), { ...original, seq: original.seq + 1 });
  t.deepEqual(late.ok ? late.result : null, a);
  t.like(w.get(`counts:${p}`), { saves: 1 });
});

test("Y4: a fault in the store mid-commit writes nothing, and a resend is applied", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const e = w.envelope("mel", "saved.set", { kind: "thread", id: p, on: true });
  const before = JSON.stringify([[...w.store.records], [...w.store.logs], w.store.head()]);
  const putAnswer = w.store.putAnswer.bind(w.store);
  w.store.putAnswer = () => {
    throw new Error("the disk is full");
  };
  refused(t, w.server.apply(actor("mel"), e), "INTERNAL_SERVER_ERROR");
  t.is(JSON.stringify([[...w.store.records], [...w.store.logs], w.store.head()]), before);
  t.is(w.store.client(e.clientId)?.last, e.seq - 1);
  w.store.putAnswer = putAnswer;
  ok(t, w.server.apply(actor("mel"), e));
  t.like(w.get(`save:mel:${p}`), { u: "mel" });
});

test("Y4: a fault in notify writes nothing: no record, log row, answer or seq", (t) => {
  const def = MUTATORS["research.createPostFollowUp"] as AnyMutator;
  const faulty: AnyMutator = {
    ...def,
    notify: (tx, i, r, ctx) => {
      def.notify?.(tx, i, r, ctx);
      throw new TypeError("the notification write failed");
    },
  };
  const w = new World({ mutators: { ...MUTATORS, "research.createPostFollowUp": faulty } });
  const { open } = cast(t, w);
  const p = post(t, w, "mel", open);
  const before = JSON.stringify([[...w.store.records], [...w.store.answers], w.store.head()]);
  const e = w.envelope("otto", "research.createPostFollowUp", { id: w.id(), thread: p, t: "x" });
  refused(t, w.server.apply(actor("otto"), e), "INTERNAL_SERVER_ERROR");
  t.is(JSON.stringify([[...w.store.records], [...w.store.answers], w.store.head()]), before);
  t.is(w.store.client(e.clientId)?.last, e.seq - 1);
});

test("Y5: a reader outside a private space gets its landing only, in snapshots and pulls", (t) => {
  const { w, closed } = cast(t);
  const p = post(t, w, "ada", closed);
  const snap = w.server.snapshot(actor("eve"), `space:${closed}`);
  t.deepEqual(
    snap.records.map((x) => x.key),
    [`space:${closed}`],
  );
  ok(
    t,
    w.as("ada", "threads.update", { id: p, q: "edited", base: { rev: w.get(`thread:${p}`)?.rev } }),
  );
  const pull = w.server.pull(actor("eve"), `space:${closed}`, snap.cursor);
  t.deepEqual("changes" in pull ? pull.changes : null, []);
  const member = w.server.snapshot(actor("ada"), `space:${closed}`);
  t.true(member.records.some((x) => x.key === `thread:${p}`));
});

test("Y6: a token sealed with the previous key pulls within 30 days of the rotation, then resyncs", (t) => {
  const old = randomBytes(32);
  const store = new MemoryStore();
  const w1 = new World({ cursorKeys: { current: old } });
  const { open } = cast(t, w1);
  const token = w1.server.snapshot(null, `space:${open}`).cursor;
  // the same store behind a server with a rotated key
  const rotated = (rotatedAt: number) =>
    new SyncServer({
      store: w1.store,
      clock: w1.clock,
      mutators: MUTATORS,
      cursorKeys: { current: randomBytes(32), previous: { key: old, rotatedAt } },
    });
  t.true("changes" in rotated(w1.clock.now()).pull(null, `space:${open}`, token));
  // the previous key is removed, or 30 days have passed since the rotation
  const fresh = new SyncServer({
    store: w1.store,
    clock: w1.clock,
    mutators: MUTATORS,
    cursorKeys: { current: randomBytes(32) },
  });
  t.deepEqual(fresh.pull(null, `space:${open}`, token), { resync: true });
  t.deepEqual(rotated(w1.clock.now() - 30 * DAY).pull(null, `space:${open}`, token), {
    resync: true,
  });
  void store;
  // a token is not readable: its length depends only on the log and the reader
  const lengths = new Set<number>();
  for (let k = 0; k < 5; k++) {
    post(t, w1, "mel", open);
    lengths.add(w1.server.snapshot(null, `space:${open}`).cursor.length);
  }
  t.is(lengths.size, 1);
  t.throws(
    () =>
      new SyncServer({
        store,
        clock: w1.clock,
        mutators: MUTATORS,
        cursorKeys: { current: new Uint8Array(16) },
      }),
  );
});

test("Y8: retention prunes each table at its boundary millisecond", (t) => {
  const w = new World({ expireEveryCall: false });
  const { open } = cast(t, w);
  const p = post(t, w, "mel", open);
  ok(t, w.as("mel", "threads.delete", { id: p }));
  // the delete left a counts tombstone? the thread is a shell; delete a save
  ok(t, w.as("otto", "saved.set", { kind: "thread", id: post(t, w, "mel", open), on: true }));
  const saved = [...w.store.records.keys()].find((k) => k.startsWith("save:otto:")) ?? "";
  ok(t, w.as("otto", "saved.set", { kind: "thread", id: saved.split(":")[2], on: false }));
  const tomb = w.store.tombstone(saved);
  if (!tomb) return t.fail("no tombstone");
  // an answer under (client, seq): a malformed mutation id
  refused(t, w.as("otto", "prefs.set", { layout: "wide" }, "not-a-ulid"), "BAD_REQUEST");
  t.is(w.store.seqAnswers.size, 1);
  const answers = w.store.answers.size;
  const t0 = w.clock.now();
  // answers: 7 days; clients: 7 days idle; tombstones: 30 days
  w.server.retain(t0 + 7 * DAY - 1);
  t.is(w.store.answers.size, answers, "an answer recorded 1 ms less than 7 days ago is kept");
  w.server.retain(t0 + 7 * DAY);
  t.is(w.store.answers.size, 0);
  t.is(w.store.seqAnswers.size, 0);
  t.is(w.store.clients.size, 0);
  w.server.retain(tomb.at + 30 * DAY);
  t.truthy(w.store.tombstone(saved), "a tombstone committed exactly 30 days ago is kept");
  w.server.retain(tomb.at + 30 * DAY + 1);
  t.is(w.store.tombstone(saved), undefined);
  t.false(w.store.logRows("user:otto", 0).some((r) => r.key === saved));
  // the registry keeps every id
  t.true(w.store.idTaken(p));
});

test("Y8: moderation log entries over 180 days are deleted for every replica", (t) => {
  const w = new World({ expireEveryCall: false });
  const { open } = cast(t, w);
  ok(t, w.as("olga", "members.ban", { space: open, user: "otto" }));
  const key = [...w.store.records.keys()].find((k) => k.startsWith("modlog:")) ?? "";
  const at = w.clock.now();
  w.clock.ms = at + 180 * DAY;
  const owner = w.server.snapshot(actor("olga"), `space:${open}`);
  w.server.retain();
  t.truthy(w.get(key), "an entry made exactly 180 days ago is kept");
  w.clock.ms = at + 180 * DAY + 1000;
  w.server.retain();
  t.is(w.get(key), undefined);
  const pull = w.server.pull(actor("olga"), `space:${open}`, owner.cursor);
  t.true("changes" in pull && pull.changes.some((c) => c.key === key && c.op === "del"));
});

test("Y13: serverApply commits a run's writes with no answer and no seq; a refusal commits nothing", (t) => {
  const { w, open } = cast(t);
  const a = w.id();
  ok(t, w.as("mel", "threads.create", { id: a, space: open, kind: "ask", q: "Why?", ...MODEL }));
  const reader = w.server.snapshot(actor("mona"), `space:${open}`);
  const answers = w.store.answers.size;
  const r = w.server.serverApply({ me: "mel" }, (tx) => {
    const th = tx.byKey(`thread:${a}`);
    if (th?.kind !== "thread") throw refuse("NOT_FOUND");
    tx.put({ ...th, sum: "A summary.", running: false });
    return th.id;
  });
  t.like(r, { ok: true, result: a });
  t.is(w.store.answers.size, answers);
  const pull = w.server.pull(actor("mona"), `space:${open}`, reader.cursor);
  t.true("changes" in pull && pull.changes.some((c) => c.op === "put" && c.key === `thread:${a}`));
  const head = w.store.head();
  const no = w.server.serverApply({ me: "mel" }, (tx) => {
    const th = tx.byKey(`thread:${a}`);
    if (th?.kind === "thread") tx.put({ ...th, sum: "never" });
    throw refuse("PRECONDITION_FAILED");
  });
  t.like(no, { ok: false, error: { code: "PRECONDITION_FAILED" } });
  t.is(w.store.head(), head);
  t.like(w.get(`thread:${a}`), { sum: "A summary." });
});

test("R1, R2: a window snapshot serves in full the recent or newest threads, capped, the reader's own and saved ones and the opened ones; summaries back 2 years", (t) => {
  const w = new World({ window: { days: 30, threads: 3, cap: 4 } });
  const { open } = cast(t, w);
  const make = (u: string, q: string) => {
    const id = w.id();
    ok(t, w.as(u, "threads.create", { id, space: open, kind: "post", q }));
    w.clock.advance(1000);
    return id;
  };
  const ancient = make("mona", "3 years ago");
  w.clock.advance(400 * DAY);
  const yearOld = make("mona", "2 years ago, nearly");
  const mine = make("mel", "mel's, 300 days old");
  const saved = make("mona", "saved by mel");
  w.clock.advance(300 * DAY);
  ok(t, w.as("mel", "saved.set", { kind: "thread", id: saved, on: true }));
  const old = [make("mona", "old 1"), make("mona", "old 2"), make("mona", "old 3")];
  w.clock.advance(60 * DAY);
  ok(t, w.as("mona", "research.createPostFollowUp", { id: w.id(), thread: old[0], t: "a reply" }));
  const recent: string[] = [];
  for (let k = 0; k < 5; k++) recent.push(make("otto", `recent ${k}`));
  const snap = w.server.snapshot(actor("mel"), `space:${open}`, {
    tier: "window",
    threads: [old[1] ?? ""],
  });
  const full = new Set(snap.full);
  // the last 30 days (5 threads) cover more than the newest 3: capped at 4
  t.deepEqual(
    recent.filter((x) => full.has(x)),
    recent.slice(1),
  );
  t.true(full.has(old[1] ?? ""), "the opened thread is full");
  t.false(full.has(old[0] ?? ""));
  // saved 60 days ago: full; written 360 days ago: a summary
  t.true(full.has(saved));
  t.false(full.has(mine));
  // the replies of a summary thread are not served; its thread and counts are
  const keys = new Set(snap.records.map((x) => x.key));
  t.true(keys.has(`thread:${old[0]}`) && keys.has(`counts:${old[0]}`));
  t.false(snap.records.some((x) => x.record.kind === "reply"));
  t.true(keys.has(`thread:${yearOld}`), "a summary of a thread within 2 years");
  t.false(keys.has(`thread:${ancient}`), "nothing of a thread over 2 years old");
  // the reader's own (90 days) and saved (90 days) rules
  const w2 = new World({ window: { days: 30, threads: 1, cap: 1 } });
  const c2 = cast(t, w2);
  const own = w2.id();
  ok(t, w2.as("mel", "threads.create", { id: own, space: c2.open, kind: "post", q: "mine" }));
  const other = w2.id();
  ok(t, w2.as("mona", "threads.create", { id: other, space: c2.open, kind: "post", q: "saved" }));
  w2.clock.advance(31 * DAY);
  ok(t, w2.as("mel", "saved.set", { kind: "thread", id: other, on: true }));
  for (let k = 0; k < 3; k++)
    ok(
      t,
      w2.as("otto", "threads.create", { id: w2.id(), space: c2.open, kind: "post", q: `n${k}` }),
    );
  const s2 = w2.server.snapshot(actor("mel"), `space:${c2.open}`, { tier: "window" });
  t.true(s2.full?.includes(own), "the reader's own thread of the past 90 days");
  t.true(s2.full?.includes(other), "a thread the reader saved in the past 90 days");
  t.is(s2.full?.length, 3);
});
