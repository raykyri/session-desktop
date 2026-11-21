// The sync replica (02 §9.1, §9.2, §9.5; 01 R1-R5, Y3, Y7) over the HTTP
// transport, against the sync routes on the sync package's in-memory server
// half (`syncFake.ts`): what a member, a signed-out reader and an unjoined
// channel view read; the event stream; "Not sent" with Retry and Discard;
// `UPGRADE_REQUIRED`; known versus unknown reads; threads outside the window.

import { DAY, QUEUED_RUNS_MAX, threadKey } from "@session/mutators";
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
  o: {
    onUpgrade?: () => void;
    storage?: FakeStorage;
    locks?: FakeLocks;
    threadSpace?: (thread: string) => Promise<string | null>;
  } = {},
) {
  const storage = o.storage ?? new FakeStorage();
  const locks = o.locks ?? new FakeLocks();
  const restored: DraftRef[] = [];
  const left: string[] = [];
  const banned: string[] = [];
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
    ...(o.threadSpace ? { threadSpace: o.threadSpace } : {}),
    claim: (userId, register) => claimClientId({ userId, storage, locks, register }),
    restoreDraft: (d) => restored.push(d),
    onLeft: (name) => left.push(name),
    onBanned: (name) => banned.push(name),
    clock: f.clock,
    maxBackoffMs: 50,
    gatherMs: 20,
  });
  r.activate();
  return { r, restored, left, banned, storage, locks };
}

const query = <T>(f: () => T) => runQuery(f);

/** Every read the client sent in `POST /api/sync/read` requests, in order. */
const reads = (f: FakeSync) =>
  f.requests
    .filter((x) => x.path === "/api/sync/read")
    .flatMap(
      (x) =>
        (x.body as { reads: { log: string; cursor?: string; tier?: string; threads?: string[] }[] })
          .reads,
    );

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
  t.deepEqual(
    reads(f)
      .filter((x) => x.tier === "threads")
      .map((x) => x.threads),
    [[post]],
  );

  const nowhere = f.id();
  r.open(nowhere, lounge);
  await until(() => r.get(threadKey(nowhere)) !== UNKNOWN);
  t.is(r.get(threadKey(nowhere)), undefined);
});

test("an address without its channel asks spaces.threadSpace and reads that channel's log alone", async (t) => {
  const { f, lounge, post } = world({ window: { days: 1, threads: 1, cap: 1 } });
  const room = f.id();
  f.ok(OLGA, "spaces.create", { id: room, name: "room" });
  f.ok(MONA, "spaces.join", { space: room });
  f.clock.offset = 800 * DAY;
  f.ok(OLGA, "threads.create", { id: f.id(), space: lounge, kind: "post", q: "Fresh" });
  const asked: string[] = [];
  const { r } = replicaOf(f, MONA, {
    threadSpace: (thread) => {
      asked.push(thread);
      return Promise.resolve(thread === post ? lounge : null);
    },
  });
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  t.is(r.get(threadKey(post)), UNKNOWN);
  r.open(post);
  await until(() => r.get(threadKey(post)) !== UNKNOWN);
  t.is((r.get(threadKey(post)) as { q?: string }).q, "Welcome to the lounge");
  t.deepEqual(asked, [post]);
  const threadReads = () => reads(f).filter((x) => x.tier === "threads");
  t.deepEqual(
    threadReads().map((x) => [x.log, x.threads]),
    [[`space:${lounge}`, [post]]],
    "one read, of the thread's channel only",
  );

  // a thread the server names no channel for is absent, with no read
  const nowhere = f.id();
  r.open(nowhere);
  await until(() => r.get(threadKey(nowhere)) !== UNKNOWN);
  t.is(r.get(threadKey(nowhere)), undefined);
  t.is(threadReads().length, 1);
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

test("signed out with 250 open channels: summaries in a few requests, and rows opened together", async (t) => {
  const { f, post } = world();
  for (let i = 0; i < 249; i++) f.ok(OLGA, "spaces.create", { id: f.id(), name: `hall-${i}` });
  f.ok(MONA, "research.createPostFollowUp", { id: f.id(), thread: post, t: "A reply" });
  const { r } = replicaOf(f, null);
  t.teardown(() => r.dispose());
  await until(() => r.ready(), 10_000);
  const sent = f.requests.filter((x) => x.path.startsWith("/api/sync/"));
  t.deepEqual([...new Set(sent.map((x) => x.path))], ["/api/sync/read"], "no request per channel");
  t.is(sent.length, 3, "250 snapshots in reads of at most 100");
  t.true(reads(f).every((x) => x.tier === "summary"));
  t.is(reads(f).length, 250);

  // a summary: its replies come when its row asks for them
  t.is(
    query(() => repliesOf(r, post)),
    UNKNOWN,
  );
  const before = f.requests.length;
  r.open(post);
  r.open(post);
  await until(() => query(() => repliesOf(r, post)) !== UNKNOWN);
  t.is(repliesOf(r, post).length, 1);
  t.is(f.requests.length - before, 1, "one request");
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

test("leaving a private channel in this tab shows no lost-access message", async (t) => {
  const { f, lab } = world();
  const link = f.ok(OLGA, "invites.create", { id: f.id(), space: lab, days: 7 }) as {
    code: string;
  };
  f.ok(MONA, "spaces.join", { space: lab, invite: link.code });
  const { r, left } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  t.true(channelsOf(r).some((c) => c.name === "lab" && c.joined));
  t.true((await r.mutate("spaces.leave", { space: lab })).ok);
  await until(() => !channelsOf(r).some((c) => c.name === "lab" && c.joined));
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.deepEqual(left, []);
});

test("a ban in an open channel reaches the banned member as their lost membership, once", async (t) => {
  const { f, lounge } = world();
  const { r, banned, left } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  await until(() => channelsOf(r).some((c) => c.name === "lounge" && c.joined));
  f.ok(OLGA, "members.ban", { space: lounge, user: MONA });
  await until(() => banned.length > 0);
  t.deepEqual(banned, ["lounge"], "You are banned from #lounge.");
  t.deepEqual(left, [], "an open channel stays readable: no lost-access message");
  t.true(channelsOf(r).some((c) => c.name === "lounge" && !c.joined));
  // a later change tells nothing again
  f.ok(OLGA, "threads.create", { id: f.id(), space: lounge, kind: "post", q: "After the ban" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.deepEqual(banned, ["lounge"]);
});

test("leaving an open channel in this tab is not told as a ban", async (t) => {
  const { f, lounge } = world();
  const { r, banned } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready() && f.streams.size === 1);
  await until(() => channelsOf(r).some((c) => c.name === "lounge" && c.joined));
  t.true((await r.mutate("spaces.leave", { space: lounge })).ok);
  await until(() => !channelsOf(r).some((c) => c.name === "lounge" && c.joined));
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.deepEqual(banned, []);
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

/** mona's ask in #lounge, with its run claimed (`running`), as the server's
 * dispatcher leaves it. */
function runningAsk(f: FakeSync, lounge: string): { th: string; run: string } {
  const th = f.id();
  const r = f.ok(MONA, "threads.create", {
    id: th,
    space: lounge,
    kind: "ask",
    q: "A question",
    model: "claude-fable",
    effort: "medium",
  }) as { run: string };
  setRun(f, r.run, { status: "running" });
  return { th, run: r.run };
}

/** A server-side write of the run record, pushed to the streams. */
function setRun(f: FakeSync, run: string, fields: Record<string, unknown>): void {
  f.server.serverApply({ me: "", mutationId: "" }, (tx) => {
    const r = tx.byKey(`run:${run}`);
    if (r?.kind === "run") tx.put({ ...r, ...fields });
  });
  f.wake();
}

const delta = (run: string, seq: number, text: string, attempt = 1) => ({
  type: "run.delta",
  run,
  attempt,
  seq,
  n: 0,
  text,
});

/** Sends `data` on every open stream. */
const send = (f: FakeSync, event: string, data: unknown) => {
  for (const s of f.streams) s.send(event, data);
};

test("T3: a reconnect reads /live for each running run; a run.delta shows in liveText; liveText is null once the run is not running or its attempt moved", async (t) => {
  const { f, lounge } = world();
  const a = runningAsk(f, lounge);
  const b = runningAsk(f, lounge);
  f.live = (_u, run) => ({ attempt: 1, live: { n: 0, text: `Checkpoint of ${run}. `, seq: 3 } });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => f.streams.size === 1);
  await until(() => f.liveReads.length >= 2);
  t.deepEqual([...f.liveReads].sort(), [a.run, b.run].sort());
  await until(() => r.liveText(a.run) !== null);
  t.like(r.liveText(a.run), { attempt: 1, seq: 3, text: `Checkpoint of ${a.run}. ` });
  send(f, "run.delta", delta(a.run, 4, "More."));
  await until(() => r.liveText(a.run)?.seq === 4);
  t.is(r.liveText(a.run)?.text, `Checkpoint of ${a.run}. More.`);

  // the run is interrupted, then resumed on the same attempt: the text held
  // before is not shown again
  setRun(f, a.run, { status: "interrupted" });
  await until(() => r.liveText(a.run) === null);
  f.live = () => "fail";
  setRun(f, a.run, { status: "running" });
  await until(
    () => (r.get(`run:${a.run}`) as { status?: string } | undefined)?.status === "running",
  );
  t.is(r.liveText(a.run), null, "the held text was dropped when the run left running");

  // Run again: a new attempt; the old one's text is not the new one's
  t.not(r.liveText(b.run), null);
  setRun(f, b.run, { attempt: 2 });
  await until(() => r.liveText(b.run) === null);

  // the stream reconnects: /live is read again for the runs still running
  const before = f.liveReads.length;
  f.live = (_u, run) => ({ attempt: run === b.run ? 2 : 1, live: null });
  f.closeStreams();
  await until(() => f.liveReads.length >= before + 2);
  t.deepEqual(f.liveReads.slice(before).sort(), [a.run, b.run].sort());
});

test("T2: an ask hidden while its run streams: a reader's held text is dropped and not shown again; its author keeps it", async (t) => {
  const { f, lounge } = world();
  f.ok("mel", "spaces.join", { space: lounge });
  const { th, run } = runningAsk(f, lounge);
  f.live = () => ({ attempt: 1, live: { n: 0, text: "Text streamed before the hide. ", seq: 1 } });
  const mel = replicaOf(f, "mel").r;
  const mona = replicaOf(f, MONA).r;
  t.teardown(() => {
    mel.dispose();
    mona.dispose();
  });
  await until(() => mel.liveText(run) !== null && mona.liveText(run) !== null);
  f.live = () => null;
  f.ok(OLGA, "moderation.decide", { item: `a:${th}`, decision: "hidden" });
  f.wake();
  await until(() => (mel.get(threadKey(th)) as { mod?: string } | undefined)?.mod === "hidden");
  t.is(mel.liveText(run), null, "the reader may not read the hidden ask's text");
  t.like(mona.liveText(run), { text: "Text streamed before the hide. " }, "its author may");
  // shown again: the reader's held text was dropped, not kept back
  const rev = (f.server.store.byKey(threadKey(th)) as { rev: number }).rev;
  f.ok(OLGA, "moderation.decide", { item: `a:${th}`, decision: "shown", base: { rev } });
  f.wake();
  await until(() => (mel.get(threadKey(th)) as { mod?: string | null } | undefined)?.mod === null);
  t.is(mel.liveText(run), null);

  // a delta sent before a hide and received after it is held, not shown
  const late = runningAsk(f, lounge);
  f.ok(OLGA, "moderation.decide", { item: `a:${late.th}`, decision: "hidden" });
  f.wake();
  await until(
    () =>
      (mel.get(threadKey(late.th)) as { mod?: string } | undefined)?.mod === "hidden" &&
      (mel.get(`run:${late.run}`) as { status?: string } | undefined)?.status === "running",
  );
  send(f, "run.delta", delta(late.run, 1, "Sent before the hide."));
  await until(() => mona.liveText(late.run) !== null);
  t.is(mel.liveText(late.run), null);
});

test("T3: a resync of the space log drops the held texts of its runs", async (t) => {
  const { f, lounge } = world();
  const { run } = runningAsk(f, lounge);
  f.live = () => ({ attempt: 1, live: { n: 0, text: "Held. ", seq: 1 } });
  const { r } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.liveText(run) !== null);
  // reads of /live fail from now on: only the drop clears the text
  f.live = () => "fail";
  send(f, "resync", { log: `space:${lounge}` });
  await until(() => r.liveText(run) === null);
  t.is(r.liveText(run), null);
});

test("L1: a 21st queued ask is refused queue_full; its text returns to the composer", async (t) => {
  const { f, lounge } = world();
  for (let k = 0; k < QUEUED_RUNS_MAX; k += 1)
    f.ok(MONA, "threads.create", {
      id: f.id(),
      space: lounge,
      kind: "ask",
      q: `Question ${k}`,
      model: "claude-fable",
      effort: "medium",
    });
  const { r, restored } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  const id = f.id();
  const draft = { key: "new-thread", text: "One too many" };
  const outcome = await r.mutate(
    "threads.create",
    { id, space: lounge, kind: "ask", q: "One too many", model: "claude-fable", effort: "medium" },
    { draft },
  );
  t.like(outcome, { ok: false, error: { code: "PRECONDITION_FAILED", reason: "queue_full" } });
  t.deepEqual(restored, [draft]);
  t.is(r.get(threadKey(id)), UNKNOWN);
});

test("K8: an ask the server applies after the allowance ran out is kept with its run failed tokens; its text does not return to the composer", async (t) => {
  const { f, lounge } = world();
  const { r, restored } = replicaOf(f, MONA);
  t.teardown(() => r.dispose());
  await until(() => r.ready());
  // the replica saw tokens left; the server applies the write after another
  // tab spent the rest of the week's
  f.server.setPayerFacts(() => ({ includedLeft: false, billing: "pause", keys: [] }));
  const id = f.id();
  const draft = { key: "new-thread", text: "Sent with tokens left" };
  const outcome = await r.mutate(
    "threads.create",
    {
      id,
      space: lounge,
      kind: "ask",
      q: "Sent with tokens left",
      model: "claude-fable",
      effort: "medium",
    },
    { draft },
  );
  t.like(outcome, { ok: true });
  t.deepEqual(restored, []);
  const run = (outcome.ok ? outcome.result : null) as { run: string } | null;
  await until(() => {
    const rec = r.get(`run:${run?.run ?? ""}`);
    return rec !== UNKNOWN && rec?.kind === "run" && rec.status === "failed";
  });
  t.like(r.get(`run:${run?.run ?? ""}`), {
    status: "failed",
    fail: { why: "tokens", at: null, cls: null },
    pay: null,
  });
  t.like(r.get(threadKey(id)), { q: "Sent with tokens left", running: false });
  t.true(feedOf(r, { kind: "home" }).includes(id));
});
