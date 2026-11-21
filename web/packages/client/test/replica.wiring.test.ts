// The sync replica's wiring (02 §9.1, §9.2; 01 R3, R4, R5, Y3, Y7) against
// the sync routes on the in-memory server half (`syncFake.ts`): retries and
// backoff, reads of logs the replica stopped reading, summary rows fetched
// together, the session changing person, the text of "Not sent" writes kept
// for a reload, lookups and fetches that fail, the event stream refused or
// down, and reads that must stay unknown until their logs arrive.

import { claimClientId, type RegisterOptions } from "@session/sync/client";
import test from "ava";

import { HttpSyncTransport, type HttpTransportOptions } from "../src/replica/http.js";
import { channelByName, feedOf, repliesOf } from "../src/replica/queries.js";
import { UNKNOWN, runQuery, type DraftRef } from "../src/replica/source.js";
import { SyncReplica, type SyncReplicaOptions } from "../src/replica/syncReplica.js";
import {
  UPGRADE_RELOAD_KEY,
  beforeUpgradeReload,
  resetUpgradeForTests,
  upgradeRequired,
} from "../src/replica/upgrade.js";

import { FakeLocks, FakeStorage, FakeSync, until } from "./syncFake.js";

const OLGA = "olga";
const MONA = "mona";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** olga's open #lounge (mona joined) with one post, and her private #lab. */
function world(o: ConstructorParameters<typeof FakeSync>[0] = {}) {
  const f = new FakeSync(o);
  const lounge = f.id();
  const lab = f.id();
  f.ok(OLGA, "spaces.create", { id: lounge, name: "lounge" });
  f.ok(OLGA, "spaces.create", { id: lab, name: "lab", vis: "private" });
  f.ok(MONA, "spaces.join", { space: lounge });
  const post = f.id();
  f.ok(OLGA, "threads.create", { id: post, space: lounge, kind: "post", q: "Welcome" });
  return { f, lounge, lab, post };
}

/** mona joins olga's private #lab by an invite. */
function joinLab(f: FakeSync, lab: string) {
  const link = f.ok(OLGA, "invites.create", { id: f.id(), space: lab, days: 7 }) as {
    code: string;
  };
  f.ok(MONA, "spaces.join", { space: lab, invite: link.code });
}

type Fetch = typeof globalThis.fetch;

interface Made {
  r: SyncReplica;
  restored: DraftRef[];
  left: string[];
  kept: { userId: string; clientId: string }[];
  unsent: Map<string, DraftRef>;
  changedSession: number[];
  storage: FakeStorage;
  locks: FakeLocks;
}

function replicaOf(
  f: FakeSync,
  u: string | null,
  o: {
    wrap?: (base: Fetch) => Fetch;
    fetch?: Fetch;
    transport?: HttpTransportOptions;
    replica?: Partial<SyncReplicaOptions>;
    activate?: boolean;
  } = {},
): Made {
  const storage = new FakeStorage();
  const locks = new FakeLocks();
  const restored: DraftRef[] = [];
  const left: string[] = [];
  const kept: { userId: string; clientId: string }[] = [];
  const unsent = new Map<string, DraftRef>();
  const changedSession: number[] = [];
  const base = o.fetch ?? f.fetchFor(u);
  const transport = new HttpSyncTransport({
    fetch: o.wrap ? o.wrap(base) : base,
    readRetryMs: 20,
    ...o.transport,
  });
  const r = new SyncReplica({
    me: u,
    writer: u !== null,
    userId: u,
    transport,
    directory: f.directory,
    byName: f.byName,
    claim: (userId, register) => claimClientId({ userId, storage, locks, register }),
    keepClientId: (userId, clientId) => kept.push({ userId, clientId }),
    restoreDraft: (d) => restored.push(d),
    unsentDrafts: {
      keep: (local, d) => unsent.set(local, d),
      drop: (local) => unsent.delete(local),
    },
    onLeft: (n) => left.push(n),
    onSessionChanged: () => changedSession.push(Date.now()),
    clock: f.clock,
    maxBackoffMs: 50,
    gatherMs: 20,
    ...o.replica,
  });
  if (o.activate !== false) r.activate();
  return { r, restored, left, kept, unsent, changedSession, storage, locks };
}

const query = <T>(f: () => T) => runQuery(f);
const readRequests = (f: FakeSync) => f.requests.filter((x) => x.path === "/api/sync/read");
const readsOf = (x: { body: unknown }) =>
  (x.body as { reads: { log: string; cursor?: string; tier?: string; threads?: string[] }[] })
    .reads;
const client = (r: SyncReplica) =>
  (r as unknown as { client: { logs(): string[]; clientId: string | null; unsent(): unknown[] } })
    .client;
const internals = (r: SyncReplica) =>
  r as unknown as { loadedLogs: Set<string>; streamed: Set<string>; drafts: Map<string, unknown> };

/** A gate on requests whose body includes `marker`. */
function gated(marker: () => string) {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  return {
    close: () => {
      gate = new Promise<void>((done) => (open = done));
    },
    open: () => {
      open();
      gate = null;
    },
    wrap:
      (base: Fetch): Fetch =>
      async (input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (gate && body.includes(marker())) await gate;
        return base(input, init);
      },
  };
}

// ---- Retry and Discard (item 2) ----

test("Retry: the write leaves Not sent while in flight; Discard then does nothing and keeps its text; failing again, Discard returns it", async (t) => {
  const { f, post } = world();
  const { r, restored, unsent } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  f.offline = true;
  const draft = { key: `reply:${post}:top`, text: "hi" };
  await r.mutate("research.createPostFollowUp", { id: f.id(), thread: post, t: "hi" }, { draft });
  const local = r.unsent()[0]?.local ?? "";
  t.deepEqual([...unsent.values()], [draft], "the text is kept for a reload");
  f.offline = false;
  let release: () => void = () => {};
  f.holdApply = new Promise<void>((done) => (release = done));
  const v0 = r.version();
  const first = r.retry(local);
  await sleep(20);
  t.deepEqual(r.unsent(), [], "the line goes while the request is in flight");
  t.not(r.version(), v0, "the screens hear of it");
  r.discard(local);
  t.deepEqual(restored, [], "a write in flight is not discarded");
  f.offline = true;
  release();
  f.holdApply = null;
  t.like(await first, { ok: true, unsent: true });
  t.is(r.unsent().length, 1);
  r.discard(r.unsent()[0]?.local ?? "");
  t.deepEqual(restored, [draft], "the text returns to its composer");
  t.is(unsent.size, 0, "and is no longer kept for a reload");
});

test("a second Retry waits for the same outcome; a Retry of a write that is not Not sent settles at once", async (t) => {
  const { f, post } = world();
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  f.offline = true;
  await r.mutate("saved.set", { kind: "thread", id: post, on: true });
  const local = r.unsent()[0]?.local ?? "";
  f.offline = false;
  const [a, b] = await Promise.all([r.retry(local), r.retry(local)]);
  t.deepEqual(a, b);
  t.true(a.ok);
  t.like(f.get(`save:${MONA}:${post}`), { u: MONA });
  t.deepEqual(await r.retry(local), { ok: true, result: undefined });
  t.deepEqual(await r.retry("no-such-write"), { ok: true, result: undefined });
});

// ---- summary rows fetched together (item 3) ----

test("40 summary rows of one channel load in one request", async (t) => {
  const { f, lounge, post } = world({ window: { days: 1, threads: 1, cap: 1 } });
  const ids = [post];
  for (let i = 0; i < 40; i++) {
    f.clock.offset += 1000;
    const id = f.id();
    ids.push(id);
    f.ok(OLGA, "threads.create", { id, space: lounge, kind: "post", q: `Post ${i}` });
  }
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  const summaries = ids.filter((id) => query(() => repliesOf(r, id)) === UNKNOWN);
  t.is(summaries.length, 40);
  const before = readRequests(f).length;
  for (const id of summaries) r.open(id);
  await until(() => summaries.every((id) => query(() => repliesOf(r, id)) !== UNKNOWN));
  const sent = readRequests(f).slice(before);
  t.is(sent.length, 1, "one request");
  t.deepEqual(
    sent.map((x) => readsOf(x).map((read) => [read.tier, read.threads?.length])),
    [[["threads", 40]]],
    "one threads read of the channel's log",
  );
  t.deepEqual(f.broken, []);
});

test("rows of 25 channels: threads requests of at most 20 logs and 100 ids, apart from other reads", async (t) => {
  const f = new FakeSync({ window: { days: 1, threads: 1, cap: 1 } });
  const rows: string[] = [];
  for (let c = 0; c < 25; c++) {
    const sp = f.id();
    f.ok(OLGA, "spaces.create", { id: sp, name: `room-${c}` });
    f.ok(MONA, "spaces.join", { space: sp });
    for (let i = 0; i < 6; i++) {
      f.clock.offset += 1000;
      const id = f.id();
      f.ok(OLGA, "threads.create", { id, space: sp, kind: "post", q: `Post ${i}` });
      if (i < 5) rows.push(id);
    }
  }
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready(), 10_000);
  const before = readRequests(f).length;
  for (const id of rows) r.open(id);
  await until(() => rows.every((id) => query(() => repliesOf(r, id)) !== UNKNOWN), 10_000);
  const sent = readRequests(f)
    .slice(before)
    .filter((x) => readsOf(x).some((read) => read.tier === "threads"));
  t.deepEqual(f.broken, [], "every request keeps the server's rules");
  t.true(sent.length >= 2);
  for (const x of sent) {
    const reads = readsOf(x);
    t.true(
      reads.every((read) => read.tier === "threads"),
      "threads reads only",
    );
    t.true(reads.length <= 20);
    t.true(reads.reduce((n, read) => n + (read.threads?.length ?? 0), 0) <= 100);
  }
});

// ---- a log dropped while a read is in flight (item 5) ----

test("a channel view closed before its snapshot answers: the log is not kept, nor polled", async (t) => {
  const { f } = world();
  const room = f.id();
  f.ok(OLGA, "spaces.create", { id: room, name: "room" });
  const g = gated(() => `space:${room}`);
  const { r } = replicaOf(f, MONA, { wrap: g.wrap, replica: { pollMs: 30 } });
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  g.close();
  const close = r.watch(room);
  await sleep(20);
  close();
  g.open();
  await sleep(50);
  t.false(client(r).logs().includes(`space:${room}`));
  t.false(internals(r).loadedLogs.has(`space:${room}`));
  const n = readRequests(f).length;
  await sleep(150);
  const polled = readRequests(f)
    .slice(n)
    .flatMap(readsOf)
    .filter((x) => x.log === `space:${room}`);
  t.is(polled.length, 0, "no pulls of the closed view's log");
  t.is(
    query(() => feedOf(r, { kind: "channel", id: room })),
    UNKNOWN,
  );
});

test("removed from a private channel while one of its rows is being fetched: the channel is not read again, and the person is told", async (t) => {
  const { f, lab } = world({ window: { days: 1, threads: 1, cap: 1 } });
  joinLab(f, lab);
  const old = f.id();
  f.ok(OLGA, "threads.create", { id: old, space: lab, kind: "post", q: "old" });
  f.clock.offset += 1000;
  f.ok(OLGA, "threads.create", { id: f.id(), space: lab, kind: "post", q: "new" });
  const g = gated(() => '"threads"');
  const { r, left } = replicaOf(f, MONA, { wrap: g.wrap });
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  g.close();
  r.open(old);
  await sleep(40);
  const m = f.get(`member:${lab}:${MONA}`) as { adm: string } | undefined;
  f.ok(OLGA, "members.remove", { space: lab, user: MONA, base: { adm: m?.adm } });
  await sleep(60);
  g.open();
  await sleep(150);
  t.false(client(r).logs().includes(`space:${lab}`), "the log is gone");
  t.false(internals(r).streamed.has(`space:${lab}`));
  t.false(internals(r).loadedLogs.has(`space:${lab}`));
  t.deepEqual(left, ["lab"], "You are no longer a member of #lab.");
  t.is(r.list("thread", { sp: lab }), UNKNOWN);
});

// ---- the resync loop (item 1) ----

test("a resync whose read fails is read again after a backoff; the stream reopens only after it succeeds", async (t) => {
  const { f } = world();
  const room = f.id();
  f.ok(OLGA, "spaces.create", { id: room, name: "room" });
  let failReads = false;
  const wrap =
    (base: Fetch): Fetch =>
    (input, init) => {
      if (
        failReads &&
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes("/read")
      )
        return Promise.reject(new TypeError("Failed to fetch"));
      return base(input, init);
    };
  const { r } = replicaOf(f, MONA, { wrap });
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  failReads = true;
  const n = f.requests.length;
  // mona joins a channel on another device: her user log resyncs
  f.ok(MONA, "spaces.join", { space: room });
  await sleep(500);
  const later = f.requests.slice(n);
  t.is(later.filter((x) => x.path.endsWith("/events")).length, 0, "the stream is not reopened");
  t.true(later.filter((x) => x.path.endsWith("/read")).length <= 2, "reads back off");
  failReads = false;
  await until(() => query(() => feedOf(r, { kind: "channel", id: room })) !== UNKNOWN, 5000);
  await until(() => [...f.streams].some((s) => s.cursors.has(`space:${room}`)));
  t.pass();
});

// ---- the session changes person (item 4) ----

test("after the cookie changes person, a write of the old tab is not applied as the new person, and the tab reads the session again", async (t) => {
  const { f, post } = world();
  let who = MONA;
  const { r, kept, changedSession } = replicaOf(f, MONA, {
    fetch: (input, init) => f.fetchFor(who)(input, init),
    replica: { whoAmI: () => Promise.resolve(who) },
  });
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  who = OLGA;
  const reply = f.id();
  const out = await r.mutate("research.createPostFollowUp", {
    id: reply,
    thread: post,
    t: "typed by mona",
  });
  t.like(out, { ok: true, unsent: true });
  t.is(f.get(`reply:${reply}`), undefined, "nothing written as olga");
  t.deepEqual(kept, [], "olga's new id is not kept for mona's tab");
  t.true(changedSession.length >= 1, "the session is read again");
  t.is(r.unsent()[0]?.error?.code, "UNAUTHORIZED");
});

test("a register answer that names another person stops the tab without asking the session", async (t) => {
  const { f, post } = world();
  f.registerNamesUser = true;
  let who = MONA;
  let asked = 0;
  const { r, kept, changedSession } = replicaOf(f, MONA, {
    fetch: (input, init) => f.fetchFor(who)(input, init),
    replica: {
      whoAmI: () => {
        asked += 1;
        return Promise.resolve(who);
      },
    },
  });
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  who = OLGA;
  const reply = f.id();
  await r.mutate("research.createPostFollowUp", { id: reply, thread: post, t: "typed by mona" });
  t.is(f.get(`reply:${reply}`), undefined);
  t.deepEqual(kept, []);
  t.is(asked, 0, "the answer said whose id it is");
  t.is(changedSession.length, 1);
});

// ---- the event stream refused (item 8, and 15) ----

test("a stream refused with WRONG_CLIENT registers again, keeps the new id and reconnects with it", async (t) => {
  const { f } = world();
  const { r, kept } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  const old = client(r).clientId ?? "";
  // the server forgot the id (expired, pruned)
  (f.store as unknown as { clients: Map<string, unknown> }).clients.delete(old);
  f.closeStreams();
  await until(() => f.streams.size === 1 && client(r).clientId !== old, 5000);
  const fresh = client(r).clientId ?? "";
  t.deepEqual(kept, [{ userId: MONA, clientId: fresh }], "the tab keeps the new id");
  const events = f.requests.filter((x) => x.path === "/api/sync/events");
  t.true(
    new URL(`http://x${String(events.at(-1)?.path)}`).search === "" ||
      [...f.streams].every((s) => s.clientId === fresh),
    "the stream reconnects with the new id",
  );
});

test("a stream refused with 429 waits the Retry-After before it reconnects; the logs are pulled meanwhile", async (t) => {
  const { f, lounge } = world();
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  f.refuseEvents = { status: 429, code: "TOO_MANY_REQUESTS", retryAfter: 1 };
  f.closeStreams();
  // the stream is down: a post arrives by a pull
  const id = f.id();
  f.ok(OLGA, "threads.create", { id, space: lounge, kind: "post", q: "While away" });
  await until(() => feedOf(r, { kind: "home" }).includes(id), 5000);
  const refused = f.requests.filter((x) => x.path === "/api/sync/events" && x.status === 429);
  t.is(refused.length, 1);
  await sleep(500);
  t.is(
    f.requests.filter((x) => x.path === "/api/sync/events" && x.status === 429).length,
    1,
    "no reconnect before the second the server named",
  );
  f.refuseEvents = null;
  await until(() => f.streams.size === 1, 5000);
  const tries = f.requests.filter((x) => x.path === "/api/sync/events");
  const gap = (tries.at(-1)?.at ?? 0) - (refused[0]?.at ?? 0);
  t.true(gap >= 950, `waited ${gap} ms`);
});

// ---- the text of a Not sent write (item 6) ----

test("the text of a Not sent write is kept for a reload, and dropped once it is applied", async (t) => {
  const { f, post } = world();
  const { r, unsent } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  f.offline = true;
  const draft = { key: `reply:${post}:top`, text: "On my way" };
  await r.mutate(
    "research.createPostFollowUp",
    { id: f.id(), thread: post, t: "On my way" },
    { draft },
  );
  t.deepEqual([...unsent.values()], [draft]);
  f.offline = false;
  t.true((await r.retry(r.unsent()[0]?.local ?? "")).ok);
  t.is(unsent.size, 0);
});

// ---- channel lookups (item 7) ----

test("a channel lookup that fails stays unknown, and is asked again", async (t) => {
  const { f } = world();
  let fail = true;
  const { r } = replicaOf(f, null, {
    replica: {
      byName: (name) => (fail ? Promise.reject(new TypeError("Failed to fetch")) : f.byName(name)),
    },
  });
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  t.is(
    query(() => channelByName(r, "lab")),
    UNKNOWN,
  );
  await sleep(100);
  t.is(
    query(() => channelByName(r, "lab")),
    UNKNOWN,
    "not recorded as no such channel",
  );
  fail = false;
  await until(() => query(() => channelByName(r, "lab")) !== UNKNOWN, 5000);
  t.like(channelByName(r, "lab"), { name: "lab", private: true });
});

// ---- the upgrade reload (item 9) ----

test.serial(
  "a 426 within 60 s of a reload shows the message and keeps the writes Not sent, their text not copied to the composer",
  async (t) => {
    resetUpgradeForTests();
    t.teardown(() => resetUpgradeForTests());
    const { f, post } = world();
    const { r, restored } = replicaOf(f, MONA);
    t.teardown(() => r.dispose());
    await until(() => r.ready());
    const off = beforeUpgradeReload(() => r.keepDrafts());
    t.teardown(off);
    f.offline = true;
    await r.mutate(
      "research.createPostFollowUp",
      { id: f.id(), thread: post, t: "hi" },
      { draft: { key: "k", text: "hi" } },
    );
    const items = new Map([[UPGRADE_RELOAD_KEY, String(Date.now() - 5000)]]);
    let reloads = 0;
    const storage = {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    };
    t.is(upgradeRequired({ storage, now: () => Date.now(), reload: () => reloads++ }), "message");
    t.is(reloads, 0);
    t.deepEqual(restored, [], "no copy of the text while the write stays Not sent");
    t.is(r.unsent().length, 1);
    // a reload: the text is kept first
    resetUpgradeForTests();
    const off2 = beforeUpgradeReload(() => r.keepDrafts());
    t.teardown(off2);
    items.clear();
    t.is(upgradeRequired({ storage, now: () => Date.now(), reload: () => reloads++ }), "reload");
    t.deepEqual(restored, [{ key: "k", text: "hi" }]);
  },
);

// ---- fetches that fail (item 9) ----

test("a summary row that cannot load is unavailable, and is fetched again after a backoff", async (t) => {
  const { f, lounge, post } = world({ window: { days: 1, threads: 1, cap: 1 } });
  f.clock.offset += 1000;
  f.ok(OLGA, "threads.create", { id: f.id(), space: lounge, kind: "post", q: "Newer" });
  f.ok(OLGA, "research.createPostFollowUp", { id: f.id(), thread: post, t: "A reply" });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  f.offline = true;
  r.open(post);
  await until(() => r.unavailable(post));
  t.is(
    query(() => repliesOf(r, post)),
    UNKNOWN,
  );
  f.offline = false;
  await until(() => query(() => repliesOf(r, post)) !== UNKNOWN, 5000);
  t.false(r.unavailable(post));
  t.is(repliesOf(r, post).length, 1);
});

test("a threads read the server answers with TOO_MANY_REQUESTS in its place is asked again", async (t) => {
  const { f, lounge, post } = world({ window: { days: 1, threads: 1, cap: 1 } });
  f.clock.offset += 1000;
  f.ok(OLGA, "threads.create", { id: f.id(), space: lounge, kind: "post", q: "Newer" });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  let refusals = 0;
  f.readError = (read) => {
    if (read["tier"] !== "threads" || refusals >= 2) return null;
    refusals += 1;
    return refusals === 1 ? "TOO_MANY_REQUESTS" : "INTERNAL_SERVER_ERROR";
  };
  r.open(post);
  await until(() => query(() => repliesOf(r, post)) !== UNKNOWN, 5000);
  t.is(refusals, 2);
  t.false(r.unavailable(post));
  const threads = readRequests(f).filter((x) => readsOf(x)[0]?.tier === "threads");
  t.is(threads.length, 3, "asked again after each refusal");
});

test("a whole read refused with 429 waits its Retry-After before the next attempt", async (t) => {
  const { f, lounge } = world();
  const { r } = replicaOf(f, null, { activate: false });
  f.refuseReads = { status: 429, code: "TOO_MANY_REQUESTS", retryAfter: 1 };
  r.activate();
  t.teardown(() => r.dispose());
  await until(() => readRequests(f).length >= 1);
  await sleep(600);
  t.is(readRequests(f).length, 1, "no second attempt within the second named");
  f.refuseReads = null;
  await until(() => r.ready(), 5000);
  const [first, second] = readRequests(f);
  t.true((second?.at ?? 0) - (first?.at ?? 0) >= 950);
  t.true(query(() => feedOf(r, { kind: "channel", id: lounge })) !== UNKNOWN);
});

test("a thread address on Home is asked of the channels the replica holds", async (t) => {
  // the newest thread in full; the older post is outside the window
  const { f, lounge, post } = world({ window: { days: 1, threads: 1, cap: 1 } });
  f.clock.offset = 800 * 86_400_000;
  f.ok(OLGA, "threads.create", { id: f.id(), space: lounge, kind: "post", q: "Fresh" });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  t.is(r.get(`thread:${post}`), UNKNOWN);
  r.open(post);
  await until(() => r.get(`thread:${post}`) !== UNKNOWN);
  t.like(r.get(`thread:${post}`), { q: "Welcome" });
  const nowhere = f.id();
  r.open(nowhere);
  await until(() => r.get(`thread:${nowhere}`) !== UNKNOWN);
  t.is(r.get(`thread:${nowhere}`), undefined);
});

// ---- Leave (item 9) ----

test("a Leave that is discarded is not taken for this tab's: a later removal is told", async (t) => {
  const { f, lab } = world();
  joinLab(f, lab);
  const { r, left } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  f.offline = true;
  await r.mutate("spaces.leave", { space: lab });
  r.discard(r.unsent()[0]?.local ?? "");
  f.offline = false;
  await until(() => f.streams.size === 1, 5000);
  const m = f.get(`member:${lab}:${MONA}`) as { adm: string } | undefined;
  f.ok(OLGA, "members.remove", { space: lab, user: MONA, base: { adm: m?.adm } });
  await until(() => left.length === 1, 5000);
  t.deepEqual(left, ["lab"]);
});

// ---- the first read and dispose (item 9) ----

test("a replica disposed before its first read succeeded reads it when activated again", async (t) => {
  const { f, post } = world();
  f.offline = true;
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await sleep(30);
  r.dispose();
  f.offline = false;
  await sleep(1100);
  t.deepEqual([...internals(r).loadedLogs], [], "nothing recorded as loaded");
  r.activate();
  await until(() => r.ready(), 5000);
  t.deepEqual(feedOf(r, { kind: "home" }), [post]);
});

// ---- reads stay unknown until their logs arrive (review item 13) ----

test("before the user log and the directory arrive, reads are unknown; after, they are absent", async (t) => {
  const { f, lounge, lab, post } = world();
  const g = gated(() => `user:${MONA}`);
  g.close();
  let release: () => void = () => {};
  const directoryGate = new Promise<void>((done) => (release = done));
  const { r } = replicaOf(f, MONA, {
    wrap: g.wrap,
    replica: { directory: () => directoryGate.then(() => f.directory()) },
  });
  t.teardown(() => r.dispose());
  await sleep(50);
  const keys = [
    `save:${MONA}:${post}`,
    `prefs:${MONA}`,
    `member:${lab}:${MONA}`,
    `request:${lab}:${MONA}`,
    `ban:${lab}:${MONA}`,
    `space:${f.id()}`,
    `notif:${f.id()}`,
    `thread:${f.id()}`,
    `answer:${post}`,
    `reply:${f.id()}`,
  ];
  for (const key of keys) t.is(r.get(key), UNKNOWN, `${key} before`);
  t.false(r.complete("space"));
  t.is(
    query(() => channelByName(r, "lounge")),
    UNKNOWN,
    "a real name is unknown, not null",
  );
  g.open();
  release();
  await until(() => r.ready() && r.complete("space"));
  for (const key of keys.slice(0, 6)) t.is(r.get(key), undefined, `${key} after`);
  t.like(channelByName(r, "lounge"), { id: lounge });
});

// ---- the poll (review item 15) ----

test("signed out, the logs are pulled every pollMs: another person's post arrives", async (t) => {
  const { f, lounge } = world();
  const { r } = replicaOf(f, null, { replica: { pollMs: 20 } });
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  const id = f.id();
  f.ok(OLGA, "threads.create", { id, space: lounge, kind: "post", q: "Later" });
  await until(() => feedOf(r, { kind: "home" }).includes(id), 5000);
  t.pass();
});

test("a poll refused with 429 waits the Retry-After before polling again", async (t) => {
  const { f } = world();
  const { r } = replicaOf(f, null, { replica: { pollMs: 20 } });
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  f.refuseReads = { status: 429, code: "TOO_MANY_REQUESTS", retryAfter: 1 };
  const n = readRequests(f).length;
  await sleep(400);
  t.true(readRequests(f).length - n <= 2, "the poll pauses");
  f.refuseReads = null;
});

// ---- EXPIRED (review item 15) ----

test("an EXPIRED write returns its text to its composer", async (t) => {
  const { f, post } = world();
  const { r, restored } = replicaOf(f, MONA, {
    wrap:
      (base: Fetch): Fetch =>
      async (input, init) => {
        if (
          !(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          ).includes("/apply")
        )
          return base(input, init);
        return new Response(
          JSON.stringify({
            answers: [
              {
                ok: false,
                error: { code: "EXPIRED", message: "Too old.", serverTime: f.clock.now() },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
  });
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  const draft = { key: `reply:${post}:top`, text: "Late" };
  const out = await r.mutate(
    "research.createPostFollowUp",
    { id: f.id(), thread: post, t: "Late" },
    { draft },
  );
  t.false(out.ok);
  t.deepEqual(restored, [draft]);
});

// ---- batched reads (review item 17) ----

test("two logs read in one tick go in one request, and each answer is its own log's", async (t) => {
  const { f, lounge } = world();
  const other = f.id();
  f.ok(OLGA, "spaces.create", { id: other, name: "other" });
  f.ok(OLGA, "threads.create", { id: f.id(), space: other, kind: "post", q: "Other" });
  const transport = new HttpSyncTransport({ fetch: f.fetchFor(MONA) });
  const before = readRequests(f).length;
  const [a, b] = await Promise.all([
    transport.snapshot(`space:${lounge}`, { tier: "summary" }),
    transport.snapshot(`space:${other}`, { tier: "summary" }),
  ]);
  t.is(readRequests(f).length - before, 1);
  const spaceOf = (x: { record: { kind: string; s?: string; id?: string; sp?: string } }) =>
    x.record.kind === "space" ? x.record.id : (x.record.s ?? x.record.sp);
  t.true(a.records.length > 0 && b.records.length > 0);
  t.true(a.records.every((x) => spaceOf(x as never) === lounge));
  t.true(b.records.every((x) => spaceOf(x as never) === other));
});

// ---- the register wrapper of the claim (item 4) ----

test("the tab's claim keeps no id that register says is another person's", async (t) => {
  const { f } = world();
  f.registerNamesUser = true;
  const { r, changedSession, storage } = replicaOf(f, MONA, { fetch: f.fetchFor(OLGA) });
  t.teardown(() => r.dispose());
  await until(() => changedSession.length === 1);
  t.is(storage.getItem("session-client"), null);
  t.is(client(r)?.clientId ?? null, null);
  const unused: RegisterOptions = {};
  t.truthy(unused);
});
