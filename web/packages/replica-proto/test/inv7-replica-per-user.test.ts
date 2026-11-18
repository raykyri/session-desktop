// Invariant 7: a replica belongs to one user. Pulls for A never contain data
// that B could read and A could not. (Storage on disk is out of scope.)

import test, { type ExecutionContext } from "ava";

import type { Actor, LogId, Pull, ServerHalf, Snapshot, StoredRecord } from "../src/index.js";
import { ReplicaClient } from "../src/index.js";

import { admit, cast, ok, thread, type Cast } from "./harness.js";
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
  await ok(t, w.as("mona", "members.ban", { space: open, user: "eve" }));
  for (const u of ["mona", "mel", "ada"])
    await ok(t, w.as(u, "likes.set", { thread: post, on: true }));
  await ok(t, w.as("ada", "saved.toggle", { kind: "thread", id: post }));
  await ok(t, w.as("mona", "moderation.decide", { item: `p:${post}`, decision: "hidden" }));
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
    apply: (a: Actor | null, e) => (seen.push(a?.u ?? null), c.w.server.apply(a, e)),
    snapshot: (a: Actor | null, log, tier): Snapshot | Promise<Snapshot> => (
      seen.push(a?.u ?? null),
      c.w.server.snapshot(a, log, tier)
    ),
    pull: (a: Actor | null, log, cursor): Pull | Promise<Pull> => (
      seen.push(a?.u ?? null),
      c.w.server.pull(a, log, cursor)
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
