// The sync replica (02 §9.1, §9.2, §9.5; 01 R1-R5, Y3, Y7) over the HTTP
// transport, against the sync routes on the sync package's in-memory server
// half (`syncFake.ts`): what a member, a signed-out reader and an unjoined
// channel view read; the event stream; "Not sent" with Retry and Discard;
// `UPGRADE_REQUIRED`; known versus unknown reads; threads outside the window.

import { DAY, threadKey } from "@session/mutators";
import { claimClientId } from "@session/sync/client";
import test from "ava";

import { HttpSyncTransport } from "../src/replica/http.js";
import { channelByName, channelsOf, feedOf, repliesOf } from "../src/replica/queries.js";
import { UNKNOWN, runQuery, type DraftRef } from "../src/replica/source.js";
import { SyncReplica } from "../src/replica/syncReplica.js";

import { FakeLocks, FakeStorage, FakeSync, until } from "./syncFake.js";

const OLGA = "olga";
const MONA = "mona";

/** olga's open #lounge (mona joined) with one post, and her private #lab. */
function world(o: ConstructorParameters<typeof FakeSync>[0] = {}) {
  const f = new FakeSync(o);
  const lounge = f.id();
  const lab = f.id();
  f.ok(OLGA, "spaces.create", { id: lounge, name: "lounge" });
  f.ok(OLGA, "spaces.create", { id: lab, name: "lab", vis: "private" });
  f.ok(MONA, "spaces.join", { space: lounge });
  const post = f.id();
  f.ok(OLGA, "threads.create", {
    id: post,
    space: lounge,
    kind: "post",
    q: "Welcome to the lounge",
  });
  return { f, lounge, lab, post };
}

function replicaOf(
  f: FakeSync,
  u: string | null,
  o: { onUpgrade?: () => void; storage?: FakeStorage; locks?: FakeLocks } = {},
) {
  const storage = o.storage ?? new FakeStorage();
  const locks = o.locks ?? new FakeLocks();
  const restored: DraftRef[] = [];
  const left: string[] = [];
  const transport = new HttpSyncTransport({
    fetch: f.fetchFor(u),
    ...(o.onUpgrade ? { onUpgrade: o.onUpgrade } : {}),
  });
  const r = new SyncReplica({
    me: u,
    writer: u !== null,
    userId: u,
    transport,
    directory: f.directory,
    byName: f.byName,
    claim: (userId, register) => claimClientId({ userId, storage, locks, register }),
    restoreDraft: (d) => restored.push(d),
    onLeft: (name) => left.push(name),
    clock: f.clock,
    maxBackoffMs: 50,
  });
  r.activate();
  return { r, restored, left, storage, locks };
}

const query = <T>(f: () => T) => runQuery(f);

/** A page that went away releases its lock once its promise settles. */
const tick = () => new Promise((done) => setImmediate(done));

test("a member reads their user log and joined channels; another person's post arrives on the stream", async (t) => {
  const { f, lounge, post } = world();
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  t.false(r.ready(), "nothing is read before the first snapshots");
  await until(() => r.ready());
  t.deepEqual(feedOf(r, { kind: "home" }), [post]);
  const names = channelsOf(r).map((c) => [c.name, c.joined]);
  t.deepEqual(names, [["lounge", true]], "the private channel is not read");
  await until(() => f.streams.size === 1);

  const second = f.id();
  f.ok(OLGA, "threads.create", { id: second, space: lounge, kind: "post", q: "A second post" });
  await until(() => feedOf(r, { kind: "home" }).includes(second));
  t.deepEqual(feedOf(r, { kind: "home" }), [second, post]);
});

test("a write is predicted at once and confirmed by the server", async (t) => {
  const { f, lounge } = world();
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  const id = f.id();
  const pending = r.mutate("threads.create", { id, space: lounge, kind: "post", q: "Mine" });
  t.true(feedOf(r, { kind: "home" }).includes(id), "the prediction renders before the answer");
  const outcome = await pending;
  t.true(outcome.ok);
  t.falsy(outcome.ok && outcome.unsent);
  t.is(f.get(threadKey(id))?.kind, "thread");
  t.deepEqual(r.unsent(), []);
});

test("a failed request is Not sent: the item stays, Retry reuses the mutation id, Discard rolls back and returns the text", async (t) => {
  const { f, lounge, post } = world();
  const { r, restored } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());

  // a reply while the connection is down
  f.offline = true;
  const reply = f.id();
  const draft = { key: `reply:${post}`, text: "On my way" };
  const outcome = await r.mutate(
    "research.createPostFollowUp",
    { id: reply, thread: post, t: "On my way" },
    { draft },
  );
  t.deepEqual(outcome, { ok: true, result: undefined, unsent: true });
  t.deepEqual(
    r.unsent().map((w) => [w.name, w.item]),
    [["research.createPostFollowUp", reply]],
  );
  t.deepEqual(
    (repliesOf(r, post) ?? []).map((x) => x.id),
    [reply],
    "the prediction stays rendered",
  );

  // Retry, online again: the same mutation id
  f.offline = false;
  const applies = () =>
    f.requests
      .filter((x) => x.path === "/api/sync/apply")
      .map((x) => (x.body as { envelopes: { mutationId: string }[] }).envelopes[0]?.mutationId);
  const retried = await r.retry(r.unsent()[0]?.local ?? "");
  t.true(retried.ok);
  const ids = applies();
  t.is(ids.length, 2);
  t.is(ids[0], ids[1]);
  t.is(f.get(`reply:${reply}`)?.kind, "reply");
  t.deepEqual(r.unsent(), []);

  // Discard: rolled back, the text back in its composer
  f.offline = true;
  const save = await r.mutate("saved.set", { kind: "thread", id: post, on: true });
  t.true(save.ok && save.unsent);
  const another = f.id();
  await r.mutate(
    "threads.create",
    { id: another, space: lounge, kind: "post", q: "Lost" },
    { draft: { key: "new-thread", text: "Lost" } },
  );
  t.deepEqual(
    r.unsent().map((w) => w.item),
    [null, another],
    "a save has no item; the post has its thread",
  );
  t.true(feedOf(r, { kind: "home" }).includes(another));
  r.discard(r.unsent()[1]?.local ?? "");
  t.false(feedOf(r, { kind: "home" }).includes(another));
  t.deepEqual(restored, [{ key: "new-thread", text: "Lost" }]);
  r.discard(r.unsent()[0]?.local ?? "");
  t.deepEqual(r.unsent(), []);
  t.is(r.get(`save:${MONA}:${post}`), undefined, "the save is rolled back");
});

test("a refusal rolls the prediction back and returns the text to its composer", async (t) => {
  const { f, lab } = world();
  const { r, restored } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  const id = f.id();
  const draft = { key: "new-thread", text: "Not a member" };
  const outcome = await r.mutate(
    "threads.create",
    { id, space: lab, kind: "post", q: "Not a member" },
    { draft },
  );
  t.false(outcome.ok);
  t.deepEqual(restored, [draft]);
  t.is(r.get(threadKey(id)), UNKNOWN);
});

test("UPGRADE_REQUIRED: the transport reports it, the write is Not sent, and its text is kept", async (t) => {
  const { f, lounge } = world();
  let upgrades = 0;
  const { r, restored } = replicaOf(f, MONA, { onUpgrade: () => (upgrades += 1) });
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  f.upgrade = true;
  const draft = { key: "new-thread", text: "Before the deploy" };
  const outcome = await r.mutate(
    "threads.create",
    { id: f.id(), space: lounge, kind: "post", q: "Before the deploy" },
    { draft },
  );
  t.true(outcome.ok && outcome.unsent);
  t.true(upgrades >= 1);
  t.is(r.unsent()[0]?.error?.code, "UPGRADE_REQUIRED");
  r.keepDrafts();
  t.deepEqual(restored, [draft]);
});

test("a summary thread's records are unknown until it is opened (01 R3)", async (t) => {
  // one thread per channel in full: the newest
  const { f, lounge, post } = world({ window: { days: 1, threads: 1, cap: 1 } });
  f.clock.offset += 1000;
  const newer = f.id();
  f.ok(OLGA, "threads.create", { id: newer, space: lounge, kind: "post", q: "Newer" });
  f.ok(OLGA, "research.createPostFollowUp", { id: f.id(), thread: post, t: "A reply" });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  t.deepEqual(feedOf(r, { kind: "home" }), [newer, post], "both threads are in the feed");
  t.is(
    query(() => repliesOf(r, post)),
    UNKNOWN,
    "a summary: its replies are not loaded",
  );
  t.deepEqual(repliesOf(r, newer), []);
  r.open(post);
  await until(() => query(() => repliesOf(r, post)) !== UNKNOWN);
  t.is(repliesOf(r, post).length, 1);
});

test("a thread address outside the window is fetched from its channel; one the server does not serve is absent", async (t) => {
  // the newest thread in full, and more than two years later: the window
  // serves no summary of the older post
  const { f, lounge, post } = world({ window: { days: 1, threads: 1, cap: 1 } });
  f.clock.offset = 800 * DAY;
  const fresh = f.id();
  f.ok(OLGA, "threads.create", { id: fresh, space: lounge, kind: "post", q: "Fresh" });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  t.deepEqual(feedOf(r, { kind: "channel", id: lounge }), [fresh]);
  t.is(r.get(threadKey(post)), UNKNOWN);
  r.open(post, lounge);
  await until(() => r.get(threadKey(post)) !== UNKNOWN);
  t.is((r.get(threadKey(post)) as { q?: string }).q, "Welcome to the lounge");
  t.deepEqual(feedOf(r, { kind: "channel", id: lounge }), [fresh, post]);
  const snapshots = f.requests.filter(
    (x) => x.path === "/api/sync/snapshot" && (x.body as { tier?: string }).tier === "threads",
  );
  t.deepEqual(
    snapshots.map((x) => (x.body as { threads: string[] }).threads),
    [[post]],
  );

  const nowhere = f.id();
  r.open(nowhere, lounge);
  await until(() => r.get(threadKey(nowhere)) !== UNKNOWN);
  t.is(r.get(threadKey(nowhere)), undefined);
});

test("signed out: every open channel through the same source, no private channel, no writes and no client id", async (t) => {
  const { f, post } = world();
  const { r } = replicaOf(f, null);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  t.deepEqual(
    channelsOf(r).map((c) => c.name),
    ["lounge"],
  );
  t.deepEqual(feedOf(r, { kind: "home" }), [post]);
  t.deepEqual(r.list("save", { u: "nobody" }), [], "no user log: nothing saved");
  const outcome = await r.mutate("saved.set", { kind: "thread", id: post, on: true });
  t.false(outcome.ok);
  t.false(f.requests.some((x) => x.path === "/api/sync/register" || x.path === "/api/sync/events"));
});

test("a private channel's address: its landing is looked up by name; a name of no channel is absent", async (t) => {
  const { f } = world();
  const { r } = replicaOf(f, null);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  t.is(
    query(() => channelByName(r, "lab")),
    UNKNOWN,
    "asked, not answered yet",
  );
  await until(() => query(() => channelByName(r, "lab")) !== UNKNOWN);
  const lab = channelByName(r, "lab");
  t.like(lab, { name: "lab", private: true, joined: false, owner: OLGA });
  t.is(
    query(() => channelByName(r, "nowhere")),
    UNKNOWN,
  );
  await until(() => query(() => channelByName(r, "nowhere")) !== UNKNOWN);
  t.is(channelByName(r, "nowhere"), null);
});

test("ten unjoined channels read while their views are open leave the joined logs unchanged (W9.1)", async (t) => {
  const { f, lounge } = world();
  const others = Array.from({ length: 10 }, (_, i) => {
    const id = f.id();
    f.ok(OLGA, "spaces.create", { id, name: `room-${i}` });
    f.ok(OLGA, "threads.create", { id: f.id(), space: id, kind: "post", q: `In room ${i}` });
    return id;
  });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  const client = (r as unknown as { client: { logs(): string[] } }).client;
  const joined = [...client.logs()].sort();
  t.deepEqual(joined, [`space:${lounge}`, `user:${MONA}`].sort());
  for (const sp of others) {
    const close = r.watch(sp);
    await until(() => query(() => feedOf(r, { kind: "channel", id: sp })) !== UNKNOWN);
    t.is(feedOf(r, { kind: "channel", id: sp }).length, 1);
    close();
    t.is(
      query(() => feedOf(r, { kind: "channel", id: sp })),
      UNKNOWN,
      "dropped with its view",
    );
  }
  t.deepEqual([...client.logs()].sort(), joined);
});

test("joining an open channel moves its log to the stream", async (t) => {
  const { f } = world();
  const room = f.id();
  f.ok(OLGA, "spaces.create", { id: room, name: "room" });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  const close = r.watch(room);
  await until(() => query(() => feedOf(r, { kind: "channel", id: room })) !== UNKNOWN);
  t.true((await r.mutate("spaces.join", { space: room })).ok);
  await until(() =>
    [...f.streams].some((s) => s.clientId !== "" && s.cursors.has(`space:${room}`)),
  );
  close();
  t.not(
    query(() => feedOf(r, { kind: "channel", id: room })),
    UNKNOWN,
    "kept once joined",
  );
  const later = f.id();
  f.ok(OLGA, "threads.create", { id: later, space: room, kind: "post", q: "Later" });
  await until(() => feedOf(r, { kind: "channel", id: room }).includes(later));
  t.pass();
});

test("the stream reconnects after it closes and reads on from its cursors", async (t) => {
  const { f, lounge } = world();
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  f.closeStreams();
  const id = f.id();
  f.ok(OLGA, "threads.create", { id, space: lounge, kind: "post", q: "While away" });
  await until(() => feedOf(r, { kind: "home" }).includes(id));
  await until(() => f.streams.size === 1);
  const reconnects = f.requests.filter((x) => x.path === "/api/sync/events");
  t.true(reconnects.length >= 2);
  t.truthy(reconnects.at(-1)?.headers["session-cursors"]);
});

test("a reload of the tab re-attaches its client id; a duplicated tab registers a new one", async (t) => {
  const { f } = world();
  const storage = new FakeStorage();
  const locks = new FakeLocks();
  const transport = new HttpSyncTransport({ fetch: f.fetchFor(MONA) });
  const register = (o?: { clientId?: string }) => transport.register(o);
  const first = await claimClientId({ userId: MONA, storage, locks, register });
  if ("error" in first) throw new Error(first.error.code);
  const ids = new Set([first.clientId]);
  first.release();
  await tick();
  // 100 reloads: each page releases the lock when it goes away
  for (let i = 0; i < 100; i++) {
    const held = await claimClientId({ userId: MONA, storage, locks, register });
    if ("error" in held) throw new Error(held.error.code);
    t.true(held.reattached);
    ids.add(held.clientId);
    held.release();
    await tick();
  }
  t.is(ids.size, 1);
  const fresh = f.requests.filter(
    (x) => x.path === "/api/sync/register" && !(x.body as { clientId?: string }).clientId,
  );
  t.is(fresh.length, 1, "one register call issued an id");

  const tab = await claimClientId({ userId: MONA, storage, locks, register });
  if ("error" in tab) throw new Error(tab.error.code);
  const duplicate = await claimClientId({ userId: MONA, storage: storage.copy(), locks, register });
  if ("error" in duplicate) throw new Error(duplicate.error.code);
  t.false(duplicate.reattached);
  t.not(duplicate.clientId, tab.clientId);
});
