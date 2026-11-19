// Invariant 7: a replica belongs to one user. Pulls for A never contain data
// that B could read and A could not. (Storage on disk is out of scope.)

import test, { type ExecutionContext } from "ava";

import type { Actor, LogId, Pull, ServerHalf, Snapshot, StoredRecord } from "../src/index.js";
import { ReplicaClient } from "../src/index.js";

import { actor, admit, cast, ok, thread, type Cast } from "./harness.js";
import { expected } from "./oracle.js";

const PEOPLE = ["olga", "ada", "mona", "mel", "otto", "rita", "eve"];

async function activity(t: ExecutionContext, c: Cast) {
  const { w, open, closed, vault } = c;
  await admit(t, w, closed, "rita");
  const ask = await thread(t, w, "rita", closed, "ask", "rita's question");
  await ok(t, w.as("mona", "followups.ask", { id: w.id(), thread: ask, q: "mona's follow-up" }));
  await ok(t, w.as("rita", "spaces.leave", { space: closed }));
  const post = await thread(t, w, "mel", closed, "post", "mel's post");
  await ok(
    t,
    w.as("ada", "research.createPostFollowUp", { id: w.id(), thread: post, t: "ada's reply" }),
  );
  await ok(t, w.as("mel", "reports.create", { id: w.id(), item: `p:${post}`, why: "spam" }));
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  await ok(t, w.as("mona", "invites.create", { id: w.id(), space: closed }));
  await ok(t, w.as("olga", "invites.create", { id: w.id(), space: vault }));
  await ok(
    t,
    w.as("mona", "members.ban", { space: open, user: "eve" }),
  );
  for (const u of ["mona", "mel", "ada"])
    await ok(t, w.as(u, "likes.set", { thread: post, on: true }));
  await ok(t, w.as("ada", "saved.set", { kind: "thread", id: post, on: true }));
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${post}`,
      decision: "hidden",
      base: w.item(`p:${post}`),
    }),
  );
}

/** Every log a hostile client might ask for. */
const allLogs = (c: Cast): LogId[] => [
  `space:${c.open}`,
  `space:${c.closed}`,
  `space:${c.vault}`,
  ...PEOPLE.map((u) => `user:${u}` as LogId),
];

test("no client holds a record another person could read and it could not", async (t) => {
  const c = await cast(t);
  const clients = new Map([...PEOPLE, null].map((u) => [u, c.w.client(u)]));
  for (const cl of clients.values()) for (const log of allLogs(c)) await cl.sync(log);
  await activity(t, c);
  for (const cl of clients.values()) for (const log of allLogs(c)) await cl.sync(log);
  const dump = c.w.server.dump();
  const may = (u: string | null) => {
    const m = new Map<string, StoredRecord>();
    for (const log of allLogs(c)) for (const [k, v] of expected(dump, u, log)) m.set(k, v);
    return m;
  };
  for (const [a, ca] of clients) {
    const mine = may(a);
    const held = ca.allRecords();
    for (const [k, v] of held) t.deepEqual(v, mine.get(k), `${a} holds ${k}`);
    for (const b of clients.keys()) {
      if (b === a) continue;
      for (const k of may(b).keys())
        if (!mine.has(k)) t.false(held.has(k), `${a} holds ${b}'s ${k}`);
    }
  }
});

test("other people's likes, saves, requests and notifications stay in their replicas", async (t) => {
  const c = await cast(t);
  await activity(t, c);
  const mel = c.w.client("mel");
  for (const log of allLogs(c)) await mel.sync(log);
  for (const [k, r] of mel.allRecords()) {
    if (r.kind === "like" || r.kind === "save" || r.kind === "notif")
      t.is(r.kind === "notif" ? r.to : r.u, "mel", k);
    if (r.kind === "request") t.is(r.u, "mel", k);
  }
  t.false(
    [...mel.allRecords().keys()].some((k) => k.startsWith("ban:") || k.startsWith("invite:")),
  );
});

test("a client reads only as its own actor", async (t) => {
  const c = await cast(t);
  await activity(t, c);
  const seen: (string | null)[] = [];
  const spy: ServerHalf = {
    register: (a: Actor | null) => (seen.push(a?.u ?? null), c.w.server.register(a)),
    apply: (a: Actor | null, e) => (seen.push(a?.u ?? null), c.w.server.apply(a, e)),
    snapshot: (a: Actor | null, log, o): Snapshot | Promise<Snapshot> => (
      seen.push(a?.u ?? null),
      c.w.server.snapshot(a, log, o)
    ),
    pull: (a: Actor | null, log, cursor, o): Pull | Promise<Pull> => (
      seen.push(a?.u ?? null),
      c.w.server.pull(a, log, cursor, o)
    ),
  };
  const mel = new ReplicaClient(spy, { u: "mel" }, { clock: c.w.clock, random: c.w.random });
  for (const log of allLogs(c)) await mel.sync(log);
  mel.queue("likes.set", { thread: c.w.id(), on: false });
  await mel.flush();
  for (const log of allLogs(c)) await mel.sync(log);
  t.true(seen.length > 0);
  t.deepEqual([...new Set(seen)], ["mel"]);
});

test("an outbox queued by one person and flushed after another signs in on the device is refused", async (t) => {
  const c = await cast(t);
  const { w, open, closed } = c;
  const th = await thread(t, w, "olga", closed, "post", "olga's");
  // mel's device queues writes, then mel signs out before they are sent
  const mel = w.client("mel");
  await mel.register();
  mel.queue("likes.set", { thread: th, on: true });
  mel.queue("threads.create", { id: mel.newId(), space: closed, kind: "post", q: "as mel" });
  mel.queue("spaces.leave", { space: open });
  // otto signs in on the same device; the stored outbox and client id are restored
  const otto = new ReplicaClient(
    w.server,
    { u: "otto" },
    { clock: w.clock, random: w.random },
    mel.state(),
  );
  const before = JSON.stringify([...w.server.dump()]);
  const results = await otto.flush();
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["WRONG_CLIENT"],
  );
  t.is(otto.pending().length, 3);
  t.is(JSON.stringify([...w.server.dump()]), before);
  // the refusal recorded nothing: mel's own device still sends them, in order
  const back = new ReplicaClient(
    w.server,
    { u: "mel" },
    { clock: w.clock, random: w.random },
    mel.state(),
  );
  t.deepEqual(
    (await back.flush()).map((r) => (r.ok ? "ok" : r.error.code)),
    ["ok", "ok", "ok"],
  );
  // and otto's reads with mel's client id carry nothing of mel's
  const s = await w.server.snapshot(actor("otto"), "user:mel", { clientId: mel.clientId ?? "" });
  t.deepEqual(s.records, []);
  t.is(s.lastSeq, null);
});
