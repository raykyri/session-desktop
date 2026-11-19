// The client half: regressions for the findings of the phase 1 review,
// round 2 (reviewer B: findings 1 to 9, 12, and the test gaps of section
// 10). Each test names its finding or gap; most are the reviewer's
// experiments (`r2b/eN-*.ts`) made into tests.

import test from "ava";

import {
  FetchTransport,
  InProcessTransport,
  MAX_OPENED,
  MemoryStorage,
  MockTransport,
  NO_RESPONSE,
  SqliteStorage,
  type Answer,
  type Envelope,
  type LogId,
  type ReadOptions,
  type StoredRecord,
  type SyncClient,
  type Timer,
  type Transport,
} from "../src/client/index.js";

import {
  Forced,
  client,
  fail,
  inProcess,
  laterProcess,
  nodeSqlite,
  tick,
  watched,
} from "./client-helpers.js";
import { DAY, HOUR, MINUTE, cast, ok, type World } from "./helpers.js";
import { httpFetch } from "./http.js";

const all = (w: World, kind: string) =>
  [...w.server.records().values()].filter((r) => r.kind === kind) as (StoredRecord & {
    th?: string;
    t?: string;
    q?: string;
    par?: string | null;
  })[];
const states = (c: SyncClient) => c.outbox().map((e) => `${e.name}:${e.state}`);

/** A thread `T` of mel's (an ask) with a follow-up `f1` and one under it
 * (`f2`), all mel's: a branch from `f1` copies `f2` with a derived id. */
function askTree(t: Parameters<typeof cast>[0], w: World, open: string) {
  const T = w.id();
  ok(t, w.as("mel", "threads.create", { id: T, space: open, kind: "ask", q: "root" }));
  const f1 = w.id();
  ok(t, w.as("mel", "followups.ask", { id: f1, thread: T, q: "first" }));
  const f2 = w.id();
  ok(t, w.as("mel", "research.forkNode", { id: f2, thread: T, parent: f1, q: "second" }));
  return { T, f1, f2 };
}

/** A timer the test fires by moving the clock. */
function manualTimer(w: World) {
  const timer = {
    due: null as { fn: () => void; at: number } | null,
    cleared: 0,
    set(fn: () => void, ms: number) {
      timer.due = { fn, at: w.clock.now() + ms };
      return timer.due;
    },
    clear() {
      timer.cleared++;
      timer.due = null;
    },
  };
  return timer;
}

// ---- finding 1: derived ids ----

test("round 2 finding 1: a remint maps the ids the write derives; an ask under a copied follow-up names the new copy", async (t) => {
  const { w, open } = cast(t);
  const { T, f1 } = askTree(t, w, open);
  // a process whose clock is 11 minutes fast, before it heard from the
  // server: after CLOCK_SKEW the branch's mutation id is further ahead than
  // a write waits, and is made again
  const mel = await laterProcess(w, "mel", [`space:${open}`, "user:mel"], 11 * MINUTE);
  const N = mel.newId();
  const branch = mel.write(
    "threads.create",
    { id: N, space: open, kind: "ask", q: "b", from: { th: T, node: f1 }, branch: "all" },
    { send: false },
  );
  const copy = mel.view().list("followup", (f) => f.th === N)[0];
  t.truthy(copy);
  const ask = mel.write(
    "research.forkNode",
    { id: mel.newId(), thread: N, parent: copy?.id, q: "third" },
    { send: false },
  );
  await mel.flush();
  t.is(mel.outbox()[0]?.replaces.length, 1, "the branch was made again");
  t.not((mel.outbox()[1]?.input as { parent: string }).parent, copy?.id);
  for (let k = 0; k < 3; k++) {
    w.clock.advance(10 * MINUTE);
    await mel.flush();
  }
  t.like(await branch.answer, { ok: true });
  t.like(await ask.answer, { ok: true });
  const under = all(w, "followup").filter((f) => f.th === N);
  const second = under.find((f) => f.q === "second");
  t.is(under.find((f) => f.q === "third")?.par, (second as { id?: string } | undefined)?.id);
});

test("round 2 finding 1: a member's admission id follows a remint of the approval", async (t) => {
  const { w, closed } = cast(t);
  ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  const olga = await laterProcess(w, "olga", [`space:${closed}`, "user:olga"], 11 * MINUTE);
  olga.write(
    "joinRequests.decide",
    {
      space: closed,
      users: ["otto"],
      decision: "approve",
      base: { otto: w.rev(`request:${closed}:otto`) },
    },
    { send: false },
  );
  const m = olga.view().get("member", `${closed}:otto`);
  const remove = olga.write(
    "members.remove",
    { space: closed, user: "otto", base: { adm: m?.adm } },
    { send: false },
  );
  for (let k = 0; k < 3; k++) {
    await olga.flush();
    w.clock.advance(MINUTE);
  }
  t.like(await remove.answer, { ok: true });
  t.is(w.get(`member:${closed}:otto`), undefined);
});

test("round 2 finding 1: a replayed answer names the mutation id it was recorded under; a later write names the ids derived from it", async (t) => {
  const { w, open } = cast(t);
  const { T, f1 } = askTree(t, w, open);
  // the branch applies, and five responses in a row are not answers
  let garble = 5;
  const tr = watched(inProcess(w, "mel"), {
    push: async (_es, next) => {
      const out = await next();
      return garble-- > 0 ? [null] : out;
    },
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.open("user:mel");
  const N = mel.newId();
  const branch = mel.write("threads.create", {
    id: N,
    space: open,
    kind: "ask",
    q: "b",
    from: { th: T, node: f1 },
    branch: "all",
  });
  const answers: unknown[] = [];
  for (let k = 0; k < 6; k++) {
    await mel.flush();
    w.clock.advance(20_000);
  }
  t.like(mel.problems()[0] ?? {}, { state: "failed", uncertain: true });
  t.is(await branch.answer, null);
  const first = mel.sent[0]?.mutationId;
  // Send again: a new mutation id, the old one in replaces; the ask is
  // queued after it, under the copy as the new id derives it
  t.true(mel.sendAgain(branch.local));
  const copy = mel.view().list("followup", (f) => f.th === N)[0];
  const ask = mel.write("research.forkNode", {
    id: mel.newId(),
    thread: N,
    parent: copy?.id,
    q: "third",
  });
  await mel.flush();
  void answers;
  // answered from the first envelope's record: the branch takes its id
  t.like(mel.outbox()[0] ?? {}, { state: "answered", mutationId: first });
  t.like(await ask.answer, { ok: true });
  t.truthy(w.get(`thread:${N}`));
  const under = all(w, "followup").filter((f) => f.th === N);
  t.is(
    under.find((f) => f.q === "third")?.par,
    (under.find((f) => f.q === "second") as { id?: string } | undefined)?.id,
  );
});

// ---- finding 2: a request in flight when the process ends ----

/** mel's reply applies and the process ends before its answer; the
 * storage of that process. */
async function crashInFlight(t: Parameters<typeof cast>[0]) {
  const { w, open } = cast(t);
  const storage = new MemoryStorage();
  let quit = false;
  const tr = watched(inProcess(w, "mel"), {
    push: async (_es, next) => {
      const out = await next();
      // the process ends here: the answer is never handled
      return quit ? new Promise<never>(() => {}) : out;
    },
  });
  const one = client(w, "mel", { storage, transport: tr });
  await one.init();
  await one.open(`space:${open}`);
  const th = one.newId();
  ok(t, (await one.write("threads.create", { id: th, space: open, kind: "post", q: "p" }).answer)!);
  quit = true;
  const reply = one.newId();
  one.write("research.createPostFollowUp", { id: reply, thread: th, t: "my reply" });
  await tick(40);
  t.is(all(w, "reply").length, 1);
  return { w, open, storage, th, reply };
}

test("round 2 finding 2: a write in flight when the app quit is uncertain at the next start; after 8 days its own id's CONFLICT reads as applied", async (t) => {
  const { w, open, storage, reply } = await crashInFlight(t);
  t.like(((await storage.loadOutbox()) as { wire: boolean }[]).at(-1) ?? {}, { wire: true });
  w.clock.advance(8 * DAY);
  const two = client(w, "mel", { storage, seed: 11 });
  await two.init();
  t.like(two.outbox().at(-1) ?? {}, { state: "queued", uncertain: true });
  await two.open(`space:${open}`);
  await two.flush();
  // the 3-day drop came first (the server's time is known from the read)
  const e = two.problems()[0];
  t.like(e ?? {}, { state: "dropped", uncertain: true });
  t.true(two.sendAgain(e?.local ?? ""));
  await two.flush();
  // the reply's id exists: CONFLICT on it, which the client reads as applied
  t.deepEqual(states(two).at(-1), "research.createPostFollowUp:answered");
  t.is((two.outbox().at(-1)?.input as { id: string }).id, reply);
  t.is(all(w, "reply").length, 1);
});

test("round 2 finding 2: EXPIRED of a write that may have applied keeps its ids unless the server says none of them is used", async (t) => {
  const { w, open, storage, reply } = await crashInFlight(t);
  w.clock.advance(8 * DAY);
  // a server that does not check the input's ids before the ages
  const tr = new Forced(inProcess(w, "mel"));
  const two = client(w, "mel", { storage, transport: tr, seed: 11 });
  await two.init();
  await two.open(`space:${open}`);
  const e = two.outbox().at(-1);
  // dropped at 3 days; Send again: EXPIRED, which says nothing here
  await two.flush();
  for (let k = 0; k < 2; k++) {
    tr.queue = [fail("EXPIRED", w.clock.now())];
    two.sendAgain(e?.local ?? "");
    await two.flush();
    t.like(two.outbox().at(-1) ?? {}, { state: "expired", uncertain: true });
    t.is((tr.pushes.at(-1)?.input as { id: string }).id, reply, "the ids are kept");
  }
  // EXPIRED with `unused`: no envelope of it applied, new ids are safe
  tr.queue = [fail("EXPIRED", w.clock.now(), { unused: true })];
  two.sendAgain(e?.local ?? "");
  await two.flush();
  t.like(two.outbox().at(-1) ?? {}, { state: "expired", uncertain: false });
  two.sendAgain(e?.local ?? "");
  t.not((two.outbox().at(-1)?.input as { id: string }).id, reply);
});

// ---- finding 3: offline ----

test("round 2 finding 3: offline, the outbox pauses with backoff and counts no try; the 3-day drop ends the wait, and Send again after EXPIRED with unused ids sends a new write", async (t) => {
  const { w, open } = cast(t);
  const real = httpFetch(w.server, { browser: { u: "mel" } });
  let online = true;
  let attempts = 0;
  const f: typeof fetch = (i, init) => {
    if (online) return real(i, init);
    if (String(i as string).includes("/write")) attempts++;
    return Promise.reject(new TypeError("fetch failed"));
  };
  const timer = manualTimer(w);
  const mel = client(w, "mel", {
    transport: new FetchTransport({ baseUrl: "https://s.test", fetch: f }),
    timer,
  });
  await mel.init();
  await mel.open(`space:${open}`);
  const th = mel.newId();
  ok(t, (await mel.write("threads.create", { id: th, space: open, kind: "post", q: "p" }).answer)!);
  await mel.sync();
  online = false;
  const ids = [mel.newId(), mel.newId(), mel.newId()];
  ids.forEach((id, k) =>
    mel.write("research.createPostFollowUp", { id, thread: th, t: `reply ${k}` }),
  );
  await tick(20);
  const waits: number[] = [];
  for (let k = 0; k < 30 && timer.due; k++) {
    const d = timer.due;
    waits.push(d.at - w.clock.now());
    timer.due = null;
    w.clock.ms = Math.max(w.clock.ms, d.at);
    d.fn();
    await tick(20);
  }
  t.deepEqual(
    mel.outbox().map((e) => `${e.state}:${e.tries}:${e.uncertain}`),
    ["queued:0:true", "queued:0:false", "queued:0:false"],
  );
  t.truthy(timer.due, "the timer is still set");
  t.is(attempts, 31, "one request per wait: the head of the outbox");
  t.deepEqual(waits.slice(0, 4), [1000, 2000, 4000, 8000]);
  t.is(Math.max(...waits), 10 * MINUTE);
  // 3 days later, back online: the writes are dropped (shown)
  w.clock.advance(3 * DAY);
  online = true;
  await mel.sync();
  await mel.flush();
  t.deepEqual(
    mel.outbox().map((e) => e.state),
    ["dropped", "dropped", "dropped"],
  );
  // 2 more days: Send again on the first (it may have applied: its ids are
  // kept); the server finds none of its ids, so EXPIRED says it never
  // applied, and Send again then sends a new write
  w.clock.advance(2 * DAY);
  const first = mel.outbox()[0];
  mel.sendAgain(first?.local ?? "");
  await mel.flush();
  t.like(first ?? {}, { state: "expired", uncertain: false, error: { unused: true } });
  mel.sendAgain(first?.local ?? "");
  await mel.flush();
  t.is(first?.state, "answered");
  t.deepEqual(
    all(w, "reply").map((r) => r.t),
    ["reply 0"],
  );
});

test("round 2 finding 3: a transport tells no response at all from a response that is not an answer", async (t) => {
  const { w } = cast(t);
  const env = w.envelope("mel", "likes.set", { thread: w.id(), on: true });
  // the mock: a request that throws got no response
  const mock = new MockTransport(() => Promise.reject(new Error("offline")));
  t.deepEqual(await mock.push([env]), [NO_RESPONSE]);
  // fetch: a rejected fetch, and a 502 page
  const down = new FetchTransport({
    baseUrl: "https://s.test",
    fetch: () => Promise.reject(new TypeError("fetch failed")),
  });
  t.deepEqual(await down.push([env]), [NO_RESPONSE]);
  const proxy = new FetchTransport({
    baseUrl: "https://s.test",
    fetch: () => Promise.resolve(new Response("<html>502</html>", { status: 502 })),
  });
  t.deepEqual(await proxy.push([env]), [null]);
  // in process: a lost answer is no response; a response that is not one,
  // null
  let plan: { answerLost?: boolean; notAnswer?: boolean } = { answerLost: true };
  const net = { plan: () => plan, wait: () => Promise.resolve() };
  const tr = new InProcessTransport(w.server, { u: "mel" }, { net });
  t.deepEqual(await tr.push([env]), [NO_RESPONSE]);
  plan = { notAnswer: true };
  t.deepEqual(await tr.push([w.envelope("mel", "likes.set", { thread: w.id(), on: true })]), [
    null,
  ]);
});

test("round 2 finding 3: on the web a write that gets no response ends at once with Try again", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr, persist: false });
  await mel.init();
  await mel.open(`space:${open}`);
  tr.queue = [NO_RESPONSE];
  const { answer } = mel.write("likes.set", { thread: th, on: true });
  t.is(await answer, null);
  t.like(mel.problems()[0] ?? {}, { state: "failed", uncertain: true });
});

// ---- finding 4: a clock days off ----

test("round 2 finding 4: a device clock days behind or ahead takes the server's time from the first answer: its writes are neither dropped nor expired", async (t) => {
  for (const skew of [-4 * DAY, -DAY, 4 * DAY]) {
    const { w, open } = cast(t);
    const mel = client(w, "mel", { clock: { now: () => w.clock.now() + skew } });
    await mel.init();
    await mel.open(`space:${open}`);
    t.is(mel.offset, -skew);
    for (let k = 0; k < 3; k++)
      mel.write("threads.create", { id: mel.newId(), space: open, kind: "post", q: `p${k}` });
    await mel.flush();
    t.deepEqual(
      mel.outbox().map((e) => e.state),
      ["answered", "answered", "answered"],
    );
    t.is(mel.sent.length, 3, "no CLOCK_SKEW");
  }
});

test("round 2 finding 4: writes made offline on a clock 4 days behind are sent once online, with ids made again", async (t) => {
  const { w, open } = cast(t);
  let down = true;
  const net = { plan: () => ({}), wait: () => Promise.resolve(), down: () => down };
  const mel = client(w, "mel", {
    clock: { now: () => w.clock.now() - 4 * DAY - HOUR },
    transport: new InProcessTransport(w.server, { u: "mel" }, { net }),
  });
  await mel.init();
  const X = mel.newId();
  mel.write("threads.create", { id: X, space: open, kind: "post", q: "offline" });
  await mel.flush();
  down = false;
  // the first answer ends the wait for the connection
  await mel.open("user:mel");
  await mel.flush();
  t.deepEqual(states(mel), ["threads.create:answered"]);
  t.not((mel.outbox()[0]?.input as { id: string }).id, X);
  t.is(all(w, "thread").filter((p) => p.q === "offline").length, 1);
});


test("round 2 finding 4: a write queued in this process is dropped by the monotonic clock, not by a device clock that went back days", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  let skew = 0;
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr, clock: { now: () => w.clock.now() + skew } });
  await mel.init();
  await mel.open(`space:${open}`);
  skew = -4 * DAY;
  tr.queue = [fail("SERVICE_UNAVAILABLE", w.clock.now())];
  mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  w.clock.advance(MINUTE);
  await mel.flush();
  t.deepEqual(states(mel), ["likes.set:answered"]);
});

// ---- finding 5: held after a restart ----

test("round 2 finding 5: a write held by UPDATE_REQUIRED is sent by the next process, in order", async (t) => {
  const { w, open } = cast(t);
  let min = 4;
  const f = httpFetch(w.server, { browser: { u: "mel" }, minProtocol: () => min });
  const storage = new MemoryStorage();
  const tr = () => new FetchTransport({ baseUrl: "https://s.test", fetch: f });
  const one = client(w, "mel", { storage, transport: tr() });
  await one.init();
  await one.open(`space:${open}`);
  const th = one.newId();
  ok(t, (await one.write("threads.create", { id: th, space: open, kind: "post", q: "p" }).answer)!);
  min = 5;
  one.write("research.createPostFollowUp", { id: one.newId(), thread: th, t: "before" });
  await one.flush();
  t.true(one.updateRequired);
  t.deepEqual(states(one).at(-1), "research.createPostFollowUp:held");
  // the update: a new process over the same storage, without `updated()`
  min = 4;
  const two = client(w, "mel", { storage, transport: tr(), seed: 11 });
  await two.init();
  t.deepEqual(states(two).at(-1), "research.createPostFollowUp:queued");
  await two.write("research.createPostFollowUp", { id: two.newId(), thread: th, t: "after" })
    .answer;
  t.deepEqual(
    all(w, "reply").map((r) => r.t),
    ["before", "after"],
  );
});

// ---- finding 6: a thread that leaves the full tier ----

test("round 2 finding 6: what a replica holds under a thread the server serves as a summary is dropped, in memory and in storage", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const th2 = w.id();
  ok(t, w.as("olga", "threads.create", { id: th2, space: open, kind: "post", q: "P2" }));
  const r = [w.id(), w.id(), w.id()];
  ok(t, w.as("otto", "research.createPostFollowUp", { id: r[0], thread: th, t: "to remove" }));
  ok(t, w.as("otto", "research.createPostFollowUp", { id: r[1], thread: th, t: "to edit" }));
  ok(t, w.as("otto", "research.createPostFollowUp", { id: r[2], thread: th2, t: "to hide" }));
  const log: LogId = `space:${open}`;
  const storage = new MemoryStorage();
  const mel = client(w, "mel", { storage, tier: { window: "summary" } });
  await mel.init();
  await mel.open(log);
  await mel.hydrate(log, th);
  await mel.hydrate(log, th2);
  t.is(mel.view().list("reply").length, 3);
  // later reads serve both as summaries: a removal, an edit, and a hide
  // under the other thread (no thread or counts record changes there)
  ok(t, w.as("mona", "moderation.decide", { item: `r:${th}:${r[0]}`, decision: "removed" }));
  ok(
    t,
    w.as("otto", "replies.update", {
      thread: th,
      reply: r[1],
      t: "edited",
      base: { rev: w.rev(`reply:${r[1]}`) },
    }),
  );
  ok(t, w.as("mona", "moderation.decide", { item: `r:${th2}:${r[2]}`, decision: "hidden" }));
  await mel.sync();
  t.deepEqual(
    mel.view().list("reply").map((x) => x.t),
    [],
  );
  t.true(mel.summaries(log).has(th));
  t.true(mel.summaries(log).has(th2));
  const stored = await storage.loadLog(log);
  t.deepEqual(
    stored?.records.filter(([, x]) => x.kind === "reply" || x.kind === "hide").map(([k]) => k),
    [],
  );
  // opening it again brings the server's version
  await mel.hydrate(log, th);
  t.deepEqual(
    mel
      .view()
      .list("reply", (x) => x.th === th)
      .map((x) => x.t),
    ["", "edited"],
  );
});

// ---- finding 7: a session that ends ----

test("round 2 finding 7: a read the server makes as nobody is not applied; the client signs out and stops the batch; signing in registers again", async (t) => {
  const { w, open, closed } = cast(t);
  ok(t, w.as("olga", "threads.create", { id: w.id(), space: closed, kind: "post", q: "olga's" }));
  const hid = w.id();
  ok(t, w.as("mel", "threads.create", { id: hid, space: open, kind: "post", q: "mine, hidden" }));
  ok(t, w.as("mona", "moderation.decide", { item: `p:${hid}`, decision: "hidden" }));
  let signedIn = true;
  const inn = inProcess(w, "mel");
  const out = new InProcessTransport(w.server, null);
  const reads: [LogId, ReadOptions | undefined][] = [];
  const pick = () => (signedIn ? inn : out);
  const tr: Transport = {
    register: () => pick().register(),
    push: (es) => pick().push(es),
    pull: (l, c, o) => (reads.push([l, o]), pick().pull(l, c, o)),
    snapshot: (l, o) => (reads.push([l, o]), pick().snapshot(l, o)),
    listen: (c, e, s) => pick().listen(c, e, s),
    call: (n, i) => pick().call(n, i),
  };
  const storage = new MemoryStorage();
  const mel = client(w, "mel", { transport: tr, storage });
  await mel.init();
  // the space logs first: their reads are served to nobody
  for (const l of [`space:${open}`, `space:${closed}`, "user:mel"] as const) await mel.open(l);
  t.true(reads.every(([, o]) => typeof o?.clientId === "string"), "every read carries the id");
  const before = JSON.stringify(await storage.loadLog(`space:${closed}`));
  const id = mel.clientId;
  signedIn = false;
  reads.length = 0;
  t.false(await mel.sync());
  t.true(mel.signedOut);
  // the first space log's pull answers resync, its snapshot is made as
  // nobody: no other log is read
  t.is(reads.length, 2, "the rest of the batch is not read");
  t.false(mel.isFrozen(`space:${closed}`));
  t.is(mel.view().get("thread", hid)?.q, "mine, hidden");
  t.is(JSON.stringify(await storage.loadLog(`space:${closed}`)), before);
  t.false(await mel.sync(), "signed out: nothing is read");
  t.is(reads.length, 2);
  signedIn = true;
  await mel.signedIn();
  t.true(await mel.sync());
  t.not(mel.clientId, id, "a new registration for the person signed in now");
  t.is(mel.view().list("thread", (p) => p.s === closed).length, 1);
});

// ---- finding 8: Send again ----

test("round 2 finding 8: Send again on a refused write that named the id of a write sent again with new ids names the new id", async (t) => {
  const { w, open } = cast(t);
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  const X = mel.newId();
  tr.queue = [fail("EXPIRED", w.clock.now())];
  const post = mel.write("threads.create", { id: X, space: open, kind: "post", q: "p" });
  const reply = mel.write("research.createPostFollowUp", { id: mel.newId(), thread: X, t: "r" });
  await mel.flush();
  t.deepEqual(states(mel), [
    "threads.create:expired",
    "research.createPostFollowUp:refused",
  ]);
  mel.sendAgain(post.local);
  await mel.flush();
  const Y = (mel.outbox()[0]?.input as { id: string }).id;
  t.not(Y, X);
  t.is((mel.outbox()[1]?.input as { thread: string }).thread, Y);
  mel.sendAgain(reply.local);
  await mel.flush();
  t.is(all(w, "reply").filter((r) => r.th === Y).length, 1);
});

test("round 2 finding 8: never-sent writes made on a clock that was fast and is right again get new ids before they are sent", async (t) => {
  const { w, open } = cast(t);
  const storage = new MemoryStorage();
  const first = client(w, "mel", { storage });
  await first.init();
  await first.open(`space:${open}`);
  // a new process, offline, its clock 5 minutes fast
  let skew = 5 * MINUTE;
  let down = true;
  const net = { plan: () => ({}), wait: () => Promise.resolve(), down: () => down };
  const mel = client(w, "mel", {
    storage,
    clock: { now: () => w.clock.now() + skew },
    transport: new InProcessTransport(w.server, { u: "mel" }, { net }),
  });
  await mel.init();
  await mel.open(`space:${open}`);
  const X = mel.newId();
  mel.write("threads.create", { id: X, space: open, kind: "post", q: "p" }, { send: false });
  mel.write(
    "research.createPostFollowUp",
    { id: mel.newId(), thread: X, t: "r" },
    { send: false },
  );
  skew = 0;
  down = false;
  await mel.flush();
  t.deepEqual(states(mel), ["threads.create:answered", "research.createPostFollowUp:answered"]);
  t.is(mel.sent.length, 2);
  const Y = (mel.outbox()[0]?.input as { id: string }).id;
  t.not(Y, X);
  t.is(all(w, "reply").filter((r) => r.th === Y).length, 1);
});

// ---- finding 9 ----

test("round 2 finding 9: on the web a write whose ids are ahead, and one made while signed out, end with Try again", async (t) => {
  {
    // (a client that sends before it heard from the server: its ids are on
    // a clock 5 minutes fast, and after CLOCK_SKEW they are ahead)
    const { w, open } = cast(t);
    const mel = await laterProcess(w, "mel", [`space:${open}`], 5 * MINUTE, { persist: false });
    const { answer } = mel.write("threads.create", {
      id: mel.newId(),
      space: open,
      kind: "post",
      q: "web",
    });
    t.is(await answer, null);
    t.like(mel.problems()[0] ?? {}, { state: "failed", error: { code: "CLOCK_SKEW" } });
  }
  {
    const { w, open } = cast(t);
    const tr = new Forced(inProcess(w, "mel"));
    const mel = client(w, "mel", { transport: tr, persist: false });
    await mel.init();
    await mel.open(`space:${open}`);
    tr.queue = [fail("UNAUTHORIZED", NaN)];
    mel.write("threads.create", { id: mel.newId(), space: open, kind: "post", q: "a" });
    await mel.flush();
    t.true(mel.signedOut);
    const { answer } = mel.write("threads.create", {
      id: mel.newId(),
      space: open,
      kind: "post",
      q: "b",
    });
    await mel.flush();
    t.is(await answer, null);
    t.deepEqual(
      mel.outbox().map((e) => `${e.state}:${e.error?.code}`),
      ["failed:UNAUTHORIZED", "failed:UNAUTHORIZED"],
    );
  }
});

test("round 2 finding 9: discard of a write whose envelope is on the wire is refused", async (t) => {
  const { w, open } = cast(t);
  let release: (() => void) | null = null;
  const tr = watched(inProcess(w, "mel"), {
    push: async (_es, next) => {
      await new Promise<void>((r) => (release = r));
      return next();
    },
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  const { local, answer } = mel.write("threads.create", {
    id: mel.newId(),
    space: open,
    kind: "post",
    q: "kept",
  });
  for (let k = 0; k < 50 && !release; k++) await tick(1);
  t.false(mel.discard(local));
  t.is(mel.outbox().length, 1);
  (release as unknown as () => void)();
  t.like(await answer, { ok: true });
});

test("round 2 finding 9: an online write fails when the flush ends blocked (offline, never registered)", async (t) => {
  const { w } = cast(t);
  let down = true;
  const net = { plan: () => ({}), wait: () => Promise.resolve(), down: () => down };
  const mel = client(w, "mel", {
    transport: new InProcessTransport(w.server, { u: "mel" }, { net }),
  });
  await mel.init();
  const id = mel.newId();
  const { answer } = mel.write("spaces.create", { id, name: "made-offline" });
  t.is(await answer, null);
  down = false;
  await mel.flush();
  t.is(w.get(`space:${id}`), undefined, "not sent later");
});

test("round 2 finding 9: an event stream refused with 401 ends, reports the lost sign-in and signs the client out", async (t) => {
  const { w, open } = cast(t);
  const f = httpFetch(w.server, { browser: { u: "mel" } });
  let streams = 0;
  let lost = 0;
  const fetchIt: typeof fetch = (i, init) => {
    if (String(i as string).includes("/events")) {
      streams++;
      return Promise.resolve(new Response("", { status: 401 }));
    }
    return f(i, init);
  };
  const tr = new FetchTransport({
    baseUrl: "https://s.test",
    fetch: fetchIt,
    reconnectMs: 1,
    onUnauthorized: () => void lost++,
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.listen(new AbortController().signal);
  t.is(streams, 1);
  t.is(lost, 1);
  t.true(mel.signedOut);
});

test("round 2 finding 9: a client made without a tier reads space logs with the desktop window, and lists at most 500 opened threads, the latest first", async (t) => {
  const { w, open } = cast(t);
  const seen: ReadOptions[] = [];
  const inner = inProcess(w, "mel");
  const tr = watched(inner, {
    snapshot: (l, o) => (seen.push(o ?? {}), inner.snapshot(l, o)),
    pull: (l, c, o) => (seen.push(o ?? {}), inner.pull(l, c, o)),
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  t.is(seen[0]?.tier?.window, "desktop");
  const ths: string[] = [];
  for (let k = 0; k < MAX_OPENED + 5; k++) {
    const th = w.id();
    ths.push(th);
    await mel.hydrate(`space:${open}`, th);
    w.clock.advance(1);
  }
  seen.length = 0;
  await mel.sync();
  const opened = seen[0]?.tier?.opened ?? [];
  t.is(opened.length, MAX_OPENED);
  t.is(opened[0], ths.at(-1));
  t.false(opened.includes(ths[0] ?? ""));
});

// ---- design (section 12): SQLite storage in one batch per write ----

test("round 2 design: SqliteStorage writes each change as one batch of the driver, never BEGIN and COMMIT as separate calls", async (t) => {
  const d = nodeSqlite();
  const executes: string[] = [];
  const driver = {
    ...d,
    execute: (sql: string, p?: unknown[]) => (executes.push(sql), d.execute(sql, p)),
  };
  const s = new SqliteStorage(driver);
  await s.saveMeta({ user: "mel", clientId: null, lastSeq: 0, offset: 0 });
  const n = d.batches;
  await s.saveLog("user:mel", { cursor: "c1", frozen: true, puts: [], dels: [] });
  await s.saveLog("user:mel", { cursor: "c2", puts: [], dels: [] });
  t.is(d.batches - n, 2);
  t.like((await s.loadLog("user:mel")) ?? {}, { cursor: "c2", frozen: true });
  await s.saveOutbox([{ a: 1 }, { b: 2 }]);
  await s.clear();
  t.deepEqual(executes, []);
  t.is(await s.loadMeta(), null);
});

// ---- test gaps (section 10) ----

test("gap R3: a restored write that went without an answer keeps its mutation id when the first answer corrects the clock", async (t) => {
  const { w, open } = cast(t);
  const storage = new MemoryStorage();
  const one = client(w, "mel", { storage });
  await one.init();
  await one.open(`space:${open}`);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  // the process ends with the like on the wire
  const hang = watched(inProcess(w, "mel"), { push: () => new Promise<never>(() => {}) });
  const two = client(w, "mel", { storage, transport: hang, seed: 3 });
  await two.init();
  two.write("likes.set", { thread: th, on: true });
  await tick(20);
  const mid = two.outbox()[0]?.mutationId;
  // the next process: its clock 20 minutes fast
  const three = client(w, "mel", {
    storage,
    seed: 5,
    clock: { now: () => w.clock.now() + 20 * MINUTE },
  });
  await three.init();
  await three.open(`space:${open}`);
  t.like(three.outbox()[0] ?? {}, { mutationId: mid, uncertain: true, replaces: [] });
  await three.flush();
  t.deepEqual(states(three), ["likes.set:answered"]);
});

test("gap R6: Send again on a refused write that once went without an answer lists nothing in replaces", async (t) => {
  const { w, open } = cast(t);
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  const th = w.id();
  // a response that is not an answer, then NOT_FOUND (the thread is not
  // there yet)
  tr.queue = [null];
  const { local } = mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  w.clock.advance(2000);
  await mel.flush();
  t.like(mel.problems()[0] ?? {}, { state: "refused", uncertain: true });
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  mel.sendAgain(local);
  t.deepEqual(mel.outbox()[0]?.replaces, []);
  await mel.flush();
  t.deepEqual(states(mel), ["likes.set:answered"]);
  t.truthy(w.get(`like:mel:${th}`));
});

test("gap R9: a backoff ends when the device clock goes back past its start", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  let skew = 0;
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr, clock: { now: () => w.clock.now() + skew } });
  await mel.init();
  await mel.open(`space:${open}`);
  tr.queue = [fail("SERVICE_UNAVAILABLE", w.clock.now())];
  mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  t.is(tr.pushes.length, 1);
  skew = -30_000;
  await mel.flush();
  t.true(tr.pushes.length > 1, "sent without waiting");
});

test("gap R10: CLOCK_SKEW moves a wait that began on the wrong clock to the corrected one", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  let skew = 0;
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr, clock: { now: () => w.clock.now() + skew } });
  await mel.init();
  await mel.open(`space:${open}`);
  skew = 15 * MINUTE;
  // the first write waits for the server's retryAt (its own wait, begun on
  // the fast clock); the second goes on and answers CLOCK_SKEW
  const retryAt = new Date(w.clock.now() + 20 * MINUTE).toISOString();
  tr.queue = [fail("TOO_MANY_REQUESTS", w.clock.now(), { retryAt })];
  mel.write("likes.set", { thread: th, on: true });
  mel.write("saved.set", { kind: "thread", id: th, on: true });
  await mel.flush();
  t.deepEqual(states(mel), ["likes.set:queued", "saved.set:answered"]);
  const likes = () => tr.pushes.filter((e) => e.name === "likes.set").length;
  t.is(likes(), 1, "the like waits for retryAt");
  w.clock.advance(20 * MINUTE);
  await mel.flush();
  t.deepEqual(states(mel), ["likes.set:answered", "saved.set:answered"]);
});

test("gap R15: a frozen copy is not kept once the person left the space on another device", async (t) => {
  const { w, closed } = cast(t);
  const mine = w.id();
  ok(t, w.as("mel", "threads.create", { id: mine, space: closed, kind: "post", q: "mine" }));
  const mel = client(w, "mel");
  await mel.init();
  await mel.open("user:mel");
  await mel.open(`space:${closed}`);
  const adm = (w.get(`member:${closed}:mel`) as { adm: string }).adm;
  ok(t, w.as("olga", "members.remove", { space: closed, user: "mel", base: { adm } }));
  await mel.sync();
  t.true(mel.isFrozen(`space:${closed}`));
  // let back in and leaving again, on another device
  ok(t, w.as("mel", "joinRequests.create", { space: closed, rulesAccepted: true }));
  ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["mel"],
      decision: "approve",
      base: { mel: w.rev(`request:${closed}:mel`) },
    }),
  );
  ok(t, w.as("mel", "spaces.leave", { space: closed }));
  await mel.sync();
  t.false(mel.isFrozen(`space:${closed}`));
  t.is(mel.view().get("thread", mine), undefined);
});

test("gap R16: the `ended` of a member key's del says the membership ended by a leave", async (t) => {
  const { w, closed } = cast(t);
  const mine = w.id();
  ok(t, w.as("mel", "threads.create", { id: mine, space: closed, kind: "post", q: "mine" }));
  const inner = inProcess(w, "mel");
  // a server that says it on the del, not in `ended`
  const tr = watched(inner, {
    pull: async (l, c, o) => {
      const p = await inner.pull(l, c, o);
      if (!("changes" in p) || l !== "user:mel") return p;
      const { ended, ...rest } = p;
      void ended;
      return {
        ...rest,
        changes: p.changes.map((x) =>
          x.op === "del" && x.key === `member:${closed}:mel` ? { ...x, ended: "left" as const } : x,
        ),
      };
    },
  });
  const other = client(w, "mel", { transport: tr });
  await other.init();
  await other.open("user:mel");
  await other.open(`space:${closed}`);
  ok(t, w.as("mel", "spaces.leave", { space: closed }));
  await other.sync();
  t.false(other.isFrozen(`space:${closed}`));
  t.is(other.view().get("thread", mine), undefined);
});

test("gap R18: a thread the server stops marking is no longer a summary", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const inner = inProcess(w, "mel");
  let mark = true;
  const tr = watched(inner, {
    pull: async (l, c, o) => {
      const p = await inner.pull(l, c, o);
      return "changes" in p && !mark ? { ...p, summaries: [] } : p;
    },
  });
  const log: LogId = `space:${open}`;
  const mel = client(w, "mel", { transport: tr, tier: { window: "summary" } });
  await mel.init();
  await mel.open(log);
  t.true(mel.summaries(log).has(th));
  mark = false;
  ok(t, w.as("olga", "threads.update", { id: th, q: "P2", base: { rev: w.rev(`thread:${th}`) } }));
  await mel.sync();
  t.false(mel.summaries(log).has(th));
});

test("gap R23: Send again on a dropped write whose record the replica holds answers it without sending", async (t) => {
  const { w, open } = cast(t);
  // the server applies the post; the client is told TOO_MANY_REQUESTS
  let lie = true;
  const pushes: Envelope[] = [];
  const tr = watched(inProcess(w, "mel"), {
    push: async (es, next) => {
      pushes.push(...es);
      const out = await next();
      if (!lie) return out;
      lie = false;
      return [fail("TOO_MANY_REQUESTS", w.clock.now())];
    },
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  const { local } = mel.write("threads.create", {
    id: mel.newId(),
    space: open,
    kind: "post",
    q: "once",
  });
  await tick(20);
  w.clock.advance(3 * DAY);
  await mel.flush();
  t.like(mel.problems()[0] ?? {}, { state: "dropped", uncertain: false });
  await mel.sync();
  const n = pushes.length;
  t.true(mel.sendAgain(local));
  await mel.flush();
  t.is(pushes.length, n, "nothing sent");
  t.deepEqual(states(mel), ["threads.create:answered"]);
});

test("gap R38: an online write fails at once when the client is signed out", async (t) => {
  const { w, open } = cast(t);
  const inner = inProcess(w, "mel");
  let refuse = false;
  const tr = watched(inner, {
    pull: async (l, c, o) =>
      refuse
        ? { ok: false as const, error: { code: "UNAUTHORIZED" as const, message: "" }, serverTime: 0 }
        : inner.pull(l, c, o),
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  refuse = true;
  await mel.sync();
  t.true(mel.signedOut);
  const id = mel.newId();
  const { answer } = mel.write("spaces.create", { id, name: "while-signed-out" });
  t.is(await answer, null);
  t.is(w.get(`space:${id}`), undefined);
});

test("gap R39: a log opened from storage joins the event stream", async (t) => {
  const { w, open } = cast(t);
  const storage = new MemoryStorage();
  const one = client(w, "mel", { storage });
  await one.init();
  await one.open(`space:${open}`);
  const two = client(w, "mel", { storage, seed: 9 });
  await two.init();
  await two.open("user:mel");
  const ctl = new AbortController();
  const done = two.listen(ctl.signal);
  await tick();
  await two.open(`space:${open}`);
  await tick();
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "live" }));
  for (let k = 0; k < 50 && !two.view().get("thread", th); k++) await tick(2);
  t.truthy(two.view().get("thread", th));
  ctl.abort();
  await done;
});

test("gap R41: the user log is applied before the space logs of one sync: a leave on another device is read once", async (t) => {
  const { w, closed } = cast(t);
  const inner = inProcess(w, "mel");
  let snaps = 0;
  const tr = watched(inner, {
    snapshot: (l, o) => {
      if (l === `space:${closed}`) snaps++;
      return inner.snapshot(l, o);
    },
  });
  const other = client(w, "mel", { transport: tr });
  await other.init();
  // the space log first: the batch fetches it before the user log
  await other.open(`space:${closed}`);
  await other.open("user:mel");
  ok(t, w.as("mel", "spaces.leave", { space: closed }));
  snaps = 0;
  await other.sync();
  t.false(other.isFrozen(`space:${closed}`));
  t.is(snaps, 1, "one snapshot: no frozen copy made and undone");
});

test("gap R42: an ask thread held without its run is a summary, also when the server marks none", async (t) => {
  const { w, open } = cast(t);
  const ask = w.id();
  ok(t, w.as("olga", "threads.create", { id: ask, space: open, kind: "ask", q: "Q" }));
  const inner = inProcess(w, "mel");
  const tr = watched(inner, {
    snapshot: async (l, o) => {
      const s = await inner.snapshot(l, o);
      if (!("records" in s)) return s;
      const { summaries, ...rest } = s;
      void summaries;
      return rest;
    },
  });
  const log: LogId = `space:${open}`;
  const mel = client(w, "mel", { transport: tr, tier: { window: "summary" } });
  await mel.init();
  await mel.open(log);
  t.truthy(mel.records(log).get(`thread:${ask}`));
  t.true(mel.summaries(log).has(ask));
});

test("gap R43: a remap does not change the input of a write that was sent", async (t) => {
  const { w, open } = cast(t);
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  const X = mel.newId();
  tr.queue = [fail("EXPIRED", w.clock.now()), fail("SERVICE_UNAVAILABLE", w.clock.now())];
  const post = mel.write("threads.create", { id: X, space: open, kind: "post", q: "p" });
  mel.write("research.createPostFollowUp", { id: mel.newId(), thread: X, t: "r" });
  await mel.flush();
  t.like(mel.outbox()[1] ?? {}, { state: "queued", sent: true });
  mel.sendAgain(post.local);
  t.not((mel.outbox()[0]?.input as { id: string }).id, X);
  t.is((mel.outbox()[1]?.input as { thread: string }).thread, X);
});

test("gap R47: HTTP 403 without a body is UNAUTHORIZED", async (t) => {
  const tr = new FetchTransport({
    baseUrl: "https://s.test",
    fetch: () => Promise.resolve(new Response("", { status: 403 })),
  });
  t.like(await tr.pull("user:mel", "c"), { ok: false, error: { code: "UNAUTHORIZED" } });
  const [a] = await tr.push([
    {
      clientId: "c",
      seq: 1,
      mutationId: "m",
      name: "likes.set",
      input: {},
      protocolVersion: 4,
      clientTime: 0,
      queuedAt: 0,
      replaces: [],
    },
  ]);
  t.like(a as Answer, { ok: false, error: { code: "UNAUTHORIZED" } });
});

test("gap R48: an entry stored without `sent` and `wire` loads as sent and on the wire (uncertain)", async (t) => {
  const { w, open } = cast(t);
  const storage = new MemoryStorage();
  await storage.saveMeta({ user: "mel", clientId: null, lastSeq: 0, offset: 0 });
  await storage.saveOutbox([
    {
      local: "L",
      mutationId: w.id(),
      name: "likes.set",
      input: { thread: w.id(), on: true },
      queuedAt: w.clock.now(),
      replaces: [],
      uncertain: false,
      tries: 0,
      next: 0,
      state: "queued",
      minted: [],
    },
  ]);
  const mel = client(w, "mel", { storage });
  await mel.init();
  t.like(mel.outbox()[0] ?? {}, { sent: true, wire: true, uncertain: true });
  void open;
});

test("gap R52: stop() clears the outbox's timer", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const timer = manualTimer(w);
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr, timer: timer as Timer });
  await mel.init();
  await mel.open(`space:${open}`);
  tr.queue = [fail("SERVICE_UNAVAILABLE", w.clock.now())];
  mel.write("likes.set", { thread: th, on: true });
  await tick(20);
  t.truthy(timer.due);
  mel.stop();
  t.is(timer.due, null);
});

