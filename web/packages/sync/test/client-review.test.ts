// The client half: regressions for the findings of the phase 1 review,
// round 1 (reviewer B: findings 1 to 14, and the test gaps G1, G4, G5, G6,
// G8 and G11). Each test names its finding.

import test from "ava";

import {
  FetchTransport,
  InProcessTransport,
  MemoryStorage,
  Offline,
  SqliteStorage,
  type Answer,
  type ClientMeta,
  type CursorMap,
  type Envelope,
  type LogId,
  type ReadOptions,
  type StoredRecord,
  type SyncClient,
  type Timer,
  type Transport,
} from "../src/client/index.js";

import { Forced, client, fail, inProcess, nodeSqlite, sleep, tick } from "./client-helpers.js";
import { DAY, MINUTE, cast, ok, type World } from "./helpers.js";
import { httpFetch } from "./http.js";

const threadsOn = (w: World, q: string) =>
  [...w.server.records().values()].filter((r) => r.kind === "thread" && r.q === q);
const repliesUnder = (w: World, th: string) =>
  [...w.server.records().values()].filter((r) => r.kind === "reply" && r.th === th);

/** A transport over `inner` whose pushes and reads can be watched. */
function watched(
  inner: Transport,
  o: {
    push?: (es: readonly Envelope[], next: () => Promise<(Answer | null)[]>) => Promise<(Answer | null)[]>;
    pull?: Transport["pull"];
    snapshot?: Transport["snapshot"];
    listen?: Transport["listen"];
  } = {},
): Transport {
  return {
    register: () => inner.register(),
    push: (es) => (o.push ? o.push(es, () => inner.push(es)) : inner.push(es)),
    pull: o.pull ?? ((l, c, x) => inner.pull(l, c, x)),
    snapshot: o.snapshot ?? ((l, x) => inner.snapshot(l, x)),
    listen: o.listen ?? ((c, e, s) => inner.listen(c, e, s)),
    call: (n, i) => inner.call(n, i),
  };
}

// ---- finding 1: remint ----

test("finding 1: a sent write keeps its input ids, so a late copy of its first envelope and its remint agree", async (t) => {
  const { w, open } = cast(t);
  const tr = new Forced(inProcess(w, "mel"));
  // the device's clock is 90 s fast
  const mel = client(w, "mel", { transport: tr, clock: { now: () => w.clock.now() + 90_000 } });
  await mel.init();
  await mel.open(`space:${open}`);
  const X = mel.newId();
  const post = mel.write(
    "threads.create",
    { id: X, space: open, kind: "post", q: "my post" },
    { send: false },
  );
  const reply = mel.write(
    "research.createPostFollowUp",
    { id: mel.newId(), thread: X, t: "my reply" },
    { send: false },
  );
  await mel.flush(); // CLOCK_SKEW: the post keeps X and waits for it
  t.is(tr.pushes.length, 1);
  // 40 s later the network delivers a copy of the first envelope: applied
  w.clock.advance(40_000);
  ok(t, w.server.apply({ u: "mel" }, tr.pushes[0]));
  tr.queue = [null]; // the remint's request is lost
  await mel.flush();
  w.clock.advance(2000);
  await mel.flush();
  t.like(await post.answer, { ok: true, replayed: true, result: { id: X } });
  t.like(await reply.answer, { ok: true });
  t.is(repliesUnder(w, X).length, 1);
  t.is(threadsOn(w, "my post").length, 1);
});

test("finding 1: a replayed answer that names another id moves the write and the queued writes to the server's id", async (t) => {
  const { w, open } = cast(t);
  // the server made the post under S (an older envelope of this write)
  const S = w.id();
  ok(t, w.as("mel", "threads.create", { id: S, space: open, kind: "post", q: "made as S" }));
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  const X = mel.newId();
  const replayed = { ok: true, result: { id: S, run: null }, serverTime: w.clock.now(), replayed: true };
  tr.queue = [replayed as Answer];
  mel.write("threads.create", { id: X, space: open, kind: "post", q: "made as S" }, { send: false });
  const reply = mel.write(
    "research.createPostFollowUp",
    { id: mel.newId(), thread: X, t: "under S" },
    { send: false },
  );
  await mel.flush();
  t.like(await reply.answer, { ok: true });
  t.is((tr.pushes[1]?.input as { thread: string }).thread, S);
  t.like(mel.outbox()[0]?.input ?? {}, { id: S });
  t.is(repliesUnder(w, S).length, 1);
});

test("finding 1: a remint is in storage before its envelope is on the wire (a crash between them)", async (t) => {
  const { w, open } = cast(t);
  const storage = new MemoryStorage();
  let disk: unknown[] | null = null;
  let wire: Envelope | null = null;
  const inner = inProcess(w, "mel");
  const tr = watched(inner, {
    push: async (es, next) => {
      if (es[0]?.replaces.length && !disk) {
        // the app dies while the reminted envelope is out; the server applies it
        disk = await storage.loadOutbox();
        wire = es[0];
        await next();
        return new Promise(() => {});
      }
      return next();
    },
  });
  const fast = { now: () => w.clock.now() + 2 * MINUTE };
  const mel = client(w, "mel", { storage, transport: tr, clock: fast });
  await mel.init();
  await mel.open(`space:${open}`);
  const X = mel.newId();
  mel.write("threads.create", { id: X, space: open, kind: "post", q: "p" }, { send: false });
  mel.write(
    "research.createPostFollowUp",
    { id: mel.newId(), thread: X, t: "r" },
    { send: false },
  );
  await mel.flush();
  w.clock.advance(61_000);
  void mel.flush();
  for (let k = 0; k < 200 && !disk; k++) await tick(1);
  const stored = disk as unknown as { mutationId: string; replaces: string[]; input: { id: string } }[];
  t.is(stored[0]?.mutationId, (wire as Envelope | null)?.mutationId, "the reminted id is stored");
  t.is(stored[0]?.replaces.length, 1);
  t.is(stored[0]?.input.id, X);
  // a new process from that storage
  const restored = new MemoryStorage();
  await restored.saveOutbox(stored);
  const m = await storage.loadMeta();
  if (m) await restored.saveMeta(m);
  const again = client(w, "mel", { storage: restored, clock: fast, seed: 11 });
  await again.init();
  await again.open(`space:${open}`);
  await again.flush();
  t.deepEqual(
    again.outbox().map((e) => `${e.name}:${e.state}`),
    ["threads.create:answered", "research.createPostFollowUp:answered"],
  );
  t.is(repliesUnder(w, X).length, 1);
});

test("finding 1: a write answered with a proxy's 502 page is uncertain and keeps its ids; a non-JSON read is not served", async (t) => {
  const { w, open } = cast(t);
  const real = httpFetch(w.server, { browser: { u: "mel" } });
  let writes: ("ok" | "apply-then-502")[] = [];
  let reads: "ok" | "502" = "ok";
  const f: typeof fetch = async (i, init) => {
    if (String(i).includes("/pull") && reads === "502")
      return new Response("<html>502 Bad Gateway</html>", { status: 502 });
    if (!String(i).includes("/write")) return real(i, init);
    const m = writes.shift() ?? "ok";
    const res = await real(i, init);
    return m === "apply-then-502" ? new Response("<html>502</html>", { status: 502 }) : res;
  };
  const mel = client(w, "mel", {
    transport: new FetchTransport({ baseUrl: "https://s.test", fetch: f }),
  });
  await mel.init();
  await mel.open(`space:${open}`);
  const X = mel.newId();
  writes = ["apply-then-502"];
  mel.write("threads.create", { id: X, space: open, kind: "post", q: "p" });
  await mel.flush();
  t.like(mel.outbox()[0] ?? {}, { state: "queued", uncertain: true, input: { id: X } });
  t.truthy(w.get(`thread:${X}`), "the server applied it");
  const reply = mel.write("research.createPostFollowUp", { id: mel.newId(), thread: X, t: "r" });
  w.clock.advance(2000);
  await mel.flush();
  t.like(await reply.answer, { ok: true });
  t.is(repliesUnder(w, X).length, 1);
  reads = "502";
  const before = [...mel.records(`space:${open}`).keys()];
  t.false(await mel.sync());
  t.deepEqual([...mel.records(`space:${open}`).keys()], before);
});

// ---- finding 3: a replica belongs to one user ----

test("finding 3 (G5): a person who only read leaves storage marked as theirs; the next person does not load it", async (t) => {
  const { w, closed } = cast(t);
  const secret = w.id();
  ok(t, w.as("olga", "threads.create", { id: secret, space: closed, kind: "post", q: "closed" }));
  const driver = nodeSqlite();
  const mel = client(w, "mel", { storage: new SqliteStorage(driver) });
  await mel.init();
  await mel.open(`space:${closed}`);
  t.truthy(mel.view().get("thread", secret));
  t.like((await new SqliteStorage(driver).loadMeta()) ?? {}, { user: "mel" });
  // otto on the same device, offline
  const offline = watched(inProcess(w, "otto"), {
    pull: () => Promise.reject(new Offline("offline")),
    snapshot: () => Promise.reject(new Offline("offline")),
  });
  const otto = client(w, "otto", { storage: new SqliteStorage(driver), transport: offline });
  await otto.init();
  t.deepEqual(await new SqliteStorage(driver).logs(), []);
  await otto.open(`space:${closed}`);
  t.is(otto.view().get("thread", secret), undefined);
  // a stored state with logs and no meta is cleared too
  const bare = new MemoryStorage();
  const rec = w.get(`thread:${secret}`) as StoredRecord;
  await bare.saveLog(`space:${closed}`, { cursor: "c", puts: [[`thread:${secret}`, rec]], dels: [] });
  const c = client(w, "otto", { storage: bare });
  await c.init();
  t.deepEqual(await bare.logs(), []);
});

// ---- finding 4: the flush loop ----

test("finding 4: a write queued during the flush's closing save is sent by that flush", async (t) => {
  const { w, open } = cast(t);
  class Slow extends MemoryStorage {
    n = 0;
    onSave: ((n: number) => void) | null = null;
    override async saveOutbox(e: readonly unknown[]) {
      this.onSave?.(++this.n);
      await sleep(5);
      return super.saveOutbox(e);
    }
  }
  const storage = new Slow();
  const mel = client(w, "mel", { storage });
  await mel.init();
  await mel.open(`space:${open}`);
  const b = w.id();
  let second: ReturnType<SyncClient["write"]> | undefined;
  // saves: the write, the registration, before the send, the closing one;
  // the person writes again 1 ms into the closing one
  storage.onSave = (n) => {
    if (n !== 4) return;
    storage.onSave = null;
    setTimeout(() => {
      second = mel.write("threads.create", { id: b, space: open, kind: "post", q: "second" });
    }, 1);
  };
  const first = mel.write("threads.create", { id: w.id(), space: open, kind: "post", q: "first" });
  t.like(await first.answer, { ok: true });
  for (let k = 0; k < 100 && !second; k++) await sleep(2);
  t.like(await second?.answer, { ok: true });
  t.truthy(w.get(`thread:${b}`));
});

test("finding 4: the client's timer sends the outbox when a backoff ends; a poke sends it too", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const timers: { fn: () => void; ms: number }[] = [];
  const timer: Timer = { set: (fn, ms) => timers.push({ fn, ms }), clear: () => {} };
  const tr = new Forced(inProcess(w, "mel"));
  tr.queue = [fail("SERVICE_UNAVAILABLE", w.clock.now())];
  const mel = client(w, "mel", { transport: tr, timer });
  await mel.init();
  await mel.open(`space:${open}`);
  const like = mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  t.is(timers.at(-1)?.ms, 1000);
  w.clock.advance(1000);
  timers.at(-1)?.fn();
  t.like(await like.answer, { ok: true });
  // a write that waits for nothing but a send (queued without one): a poke sends it
  const ctl = new AbortController();
  const done = mel.listen(ctl.signal);
  const save = mel.write("saved.set", { kind: "thread", id: th, on: true }, { send: false });
  ok(t, w.as("otto", "threads.create", { id: w.id(), space: open, kind: "post", q: "poke" }));
  t.like(await save.answer, { ok: true });
  ctl.abort();
  await done;
});

// ---- finding 5: one read per log ----

test("finding 5: a pull asked for while one is in flight waits for it; an older response never lands last", async (t) => {
  const { w, open } = cast(t);
  const held: (() => void)[] = [];
  let hold = false;
  let inFlight = 0;
  let most = 0;
  const inner = inProcess(w, "mel");
  const tr = watched(inner, {
    pull: async (l, c, o) => {
      inFlight++;
      most = Math.max(most, inFlight);
      const p = await inner.pull(l, c, o);
      if (hold) await new Promise<void>((r) => held.push(r));
      inFlight--;
      return p;
    },
    snapshot: async (l, o) => {
      inFlight++;
      most = Math.max(most, inFlight);
      const s = await inner.snapshot(l, o);
      inFlight--;
      return s;
    },
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  const log = `space:${open}` as const;
  await mel.open(log);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "v1" }));
  await mel.sync();
  ok(t, w.as("olga", "threads.update", { id: th, q: "v2", base: { rev: 1 } }));
  hold = true;
  const p1 = mel.sync(log);
  await tick();
  ok(t, w.as("olga", "threads.update", { id: th, q: "v3", base: { rev: 2 } }));
  hold = false;
  const p2 = mel.sync(log);
  const p3 = mel.sync(log); // joins p2
  const hydrated = mel.hydrate(log, th);
  await tick();
  t.is(held.length, 1);
  held.forEach((r) => r());
  await Promise.all([p1, p2, p3, hydrated]);
  t.is(most, 1, "one read of the log at a time");
  t.is(mel.view().get("thread", th)?.q, "v3");
  const want = w.server.snapshot({ u: "mel" }, log).records;
  t.deepEqual(
    want.map((x) => JSON.stringify(mel.records(log).get(x.key))),
    want.map((x) => JSON.stringify(x.record)),
  );
});

// ---- finding 6: overlay timing ----

test("finding 6: the records a STALE answer carries are not a pull: the answered write before it stays in the view", async (t) => {
  const { w, open } = cast(t);
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${open}`);
  const th = w.id();
  ok(t, w.as("mel", "threads.create", { id: th, space: open, kind: "post", q: "v1" }));
  await mel.sync();
  ok(t, w.as("mel", "threads.update", { id: th, q: "v2", base: { rev: 1 } }));
  const fresh = w.id();
  const a = mel.write("threads.create", { id: fresh, space: open, kind: "post", q: "new" }, { send: false });
  const b = mel.write("threads.update", { id: th, q: "v3", base: { rev: 1 } }, { send: false });
  await mel.flush();
  t.like(await a.answer, { ok: true });
  t.like(await b.answer, { ok: false, error: { code: "STALE" } });
  t.truthy(mel.view().get("thread", fresh));
  t.is(mel.view().get("thread", th)?.q, "v2", "the STALE answer's record");
});

test("finding 6: a pull in flight when a write is answered does not count as read after it", async (t) => {
  const { w, open } = cast(t);
  const inner = inProcess(w, "mel");
  const held: (() => void)[] = [];
  let hold = false;
  const tr = watched(inner, {
    pull: async (l, c, o) => {
      const p = await inner.pull(l, c, o);
      if (hold) await new Promise<void>((r) => held.push(r));
      return p;
    },
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  hold = true;
  const pulling = mel.sync();
  await tick();
  hold = false;
  const th = w.id();
  const { answer } = mel.write("threads.create", { id: th, space: open, kind: "post", q: "hi" });
  t.like(await answer, { ok: true });
  held.forEach((r) => r());
  await pulling;
  t.truthy(mel.view().get("thread", th), "kept in the overlay");
  t.is(mel.outbox().length, 1);
  await mel.sync();
  t.truthy(mel.view().get("thread", th));
  t.is(mel.outbox().length, 0);
});

test("finding 6: a stored answered write leaves the overlay after one full read in the new process", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "post" }));
  const storage = new MemoryStorage();
  const logs = [`space:${open}`, "user:mel"] as const;
  const a = client(w, "mel", { storage });
  await a.init();
  for (const l of logs) await a.open(l);
  for (let k = 0; k < 20; k++) await a.sync();
  t.like(await a.write("likes.set", { thread: th, on: true }).answer, { ok: true });
  t.false(
    "answeredTick" in ((await storage.loadOutbox())[0] as object),
    "the tick is not stored",
  );
  const b = client(w, "mel", { storage, seed: 9 });
  await b.init();
  for (const l of logs) await b.open(l);
  await b.sync();
  t.deepEqual(b.outbox(), []);
  ok(t, w.as("mel", "likes.set", { thread: th, on: false }));
  await b.sync();
  t.is(b.view().byKey(`like:mel:${th}`), undefined);
  t.like(b.view().get("counts", th) ?? {}, { likes: 0 });
});

test("finding 6: a sync rebuilds the view once: a write over two logs does not flicker", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "post" }));
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.open("user:mel");
  const likes = mel.query((v) => v.get("counts", th)?.likes);
  const seen: (number | undefined)[] = [likes.get()];
  likes.subscribe(() => seen.push(likes.get()));
  t.like(await mel.write("likes.set", { thread: th, on: true }).answer, { ok: true });
  await mel.sync();
  t.deepEqual(seen, [0, 1]);
});

test("finding 6 (G1): an answered write stays in the overlay until every open log was read after it", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "post" }));
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.open("user:mel");
  t.like(await mel.write("likes.set", { thread: th, on: true }).answer, { ok: true });
  await mel.sync(`space:${open}`);
  t.like(mel.outbox()[0] ?? {}, { state: "answered" });
  t.truthy(mel.view().byKey(`like:mel:${th}`), "the like record, in the user log not read yet");
  await mel.sync("user:mel");
  t.deepEqual(mel.outbox(), []);
  t.truthy(mel.view().byKey(`like:mel:${th}`));
});

// ---- finding 7: Send again ----

test("finding 7: Send again on EXPIRED sends a new write, with new ids and nothing in replaces", async (t) => {
  const { w, open } = cast(t);
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  const old = w.id(-4 * DAY - MINUTE);
  const th = w.id(-4 * DAY - MINUTE);
  const { local } = mel.write(
    "threads.create",
    { id: th, space: open, kind: "post", q: "late post" },
    { mutationId: old },
  );
  await mel.flush();
  t.like(mel.outbox()[0] ?? {}, { state: "expired", error: { code: "EXPIRED" } });
  t.true(mel.sendAgain(local));
  t.deepEqual(mel.outbox()[0]?.replaces, []);
  await mel.flush();
  t.like(mel.outbox()[0] ?? {}, { state: "answered" });
  t.deepEqual(tr.pushes.at(-1)?.replaces, []);
  t.not((tr.pushes.at(-1)?.input as { id: string }).id, th);
  t.is(threadsOn(w, "late post").length, 1);
});

test("finding 7: a failed write the server applied is answered once the replica holds its record; Send again sends nothing", async (t) => {
  const { w, open } = cast(t);
  let lose = 5;
  const tr = watched(inProcess(w, "olga"), {
    push: async (_es, next) => {
      const out = await next();
      return lose-- > 0 ? [null] : out;
    },
  });
  const olga = client(w, "olga", { transport: tr });
  await olga.init();
  await olga.open(`space:${open}`);
  const th = olga.newId();
  const { local } = olga.write("threads.create", { id: th, space: open, kind: "post", q: "once" });
  for (let k = 0; k < 6; k++) {
    await olga.flush();
    w.clock.advance(11 * MINUTE);
  }
  t.like(olga.problems()[0] ?? {}, { state: "failed", uncertain: true });
  w.clock.advance(7 * DAY); // the server forgot the answer
  await olga.sync();
  t.like(olga.outbox()[0] ?? {}, { state: "answered" });
  t.false(olga.sendAgain(local));
  t.is(threadsOn(w, "once").length, 1);
});

test("finding 7: Send again on a write dropped before it was ever sent gives it new ids", async (t) => {
  const { w, open } = cast(t);
  const down = { on: true };
  const c = client(w, "mel", {
    transport: new InProcessTransport(
      w.server,
      { u: "mel" },
      { net: { plan: () => ({}), wait: () => Promise.resolve(), down: () => down.on } },
    ),
  });
  await c.init();
  const th = c.newId();
  const { local } = c.write("threads.create", { id: th, space: open, kind: "post", q: "dropped" });
  await c.flush();
  w.clock.advance(3 * DAY);
  down.on = false;
  // the server's time arrives with the registration: dropped, never sent
  await c.flush();
  t.like(c.problems()[0] ?? {}, { state: "dropped", sent: false });
  t.true(c.sendAgain(local));
  await c.flush();
  t.like(c.outbox()[0] ?? {}, { state: "answered" });
  t.not((c.outbox()[0]?.input as { id: string }).id, th);
  t.is(threadsOn(w, "dropped").length, 1);
});

// ---- finding 8: read errors ----

test("finding 8: a read answered UPDATE_REQUIRED or a proxy page is not served; the outbox is held", async (t) => {
  const { w, open } = cast(t);
  let min = 4;
  const mel = client(w, "mel", {
    transport: new FetchTransport({
      baseUrl: "https://s.test",
      fetch: httpFetch(w.server, { browser: { u: "mel" }, minProtocol: () => min }),
    }),
  });
  await mel.init();
  await mel.open(`space:${open}`);
  const before = mel.cursors();
  min = 5;
  t.false(await mel.sync());
  t.true(mel.updateRequired);
  t.deepEqual(mel.cursors(), before);
  mel.write("likes.set", { thread: w.id(), on: true });
  await mel.flush();
  t.like(mel.outbox()[0] ?? {}, { state: "held" });
});

test("finding 8: a revoked device token signs the client out; no log is replaced and no write is lost", async (t) => {
  const { w, open } = cast(t);
  const s = w.server.call(null, "devices.authorize", { name: "Mac" });
  const request = s.ok ? (s.result as { request: string }).request : "";
  w.server.call({ u: "mel" }, "devices.approve", { request });
  const tok = w.server.call(null, "devices.token", { request });
  const token = tok.ok ? (tok.result as { token: string }).token : "";
  const mel = client(w, "mel", {
    transport: new FetchTransport({
      baseUrl: "https://s.test",
      token: () => token,
      fetch: httpFetch(w.server),
    }),
  });
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.open("user:mel");
  t.like(
    await mel.write("threads.create", { id: mel.newId(), space: open, kind: "post", q: "a" }).answer,
    { ok: true },
  );
  await mel.sync();
  const userLog = mel.records("user:mel").size;
  const dev = [...w.server.records().values()].find((r) => r.kind === "device") as { id: string };
  ok(t, w.server.call({ u: "mel" }, "devices.revoke", { id: dev.id }) as Answer);
  mel.write("threads.create", { id: mel.newId(), space: open, kind: "post", q: "b" });
  await mel.flush();
  t.true(mel.signedOut);
  t.like(mel.outbox()[0] ?? {}, { state: "queued" });
  t.false(await mel.sync());
  t.is(mel.records("user:mel").size, userLog);
});

// ---- finding 9: tiers ----

test("finding 9: a hydrated thread is reported as opened and stays full; summaries are known after a restart", async (t) => {
  const { w, open } = cast(t);
  const old: string[] = [];
  for (let k = 0; k < 3; k++) {
    const id = w.id();
    old.push(id);
    ok(t, w.as("olga", "threads.create", { id, space: open, kind: "post", q: `old ${k}` }));
    ok(t, w.as("mona", "research.createPostFollowUp", { id: w.id(), thread: id, t: `reply ${k}` }));
  }
  w.clock.advance(40 * DAY); // the Phone window: 30 days or the newest 200
  for (let k = 0; k < 200; k++)
    ok(t, w.as("olga", "threads.create", { id: w.id(), space: open, kind: "post", q: `new ${k}` }));
  const [a, b] = old as [string, string];
  const log = `space:${open}` as const;
  const asked: ReadOptions[] = [];
  const inner = inProcess(w, "mel");
  const tr = watched(inner, {
    pull: (l, c, o) => {
      if (l === log && o) asked.push(o);
      return inner.pull(l, c, o);
    },
  });
  const storage = new MemoryStorage();
  const mel = client(w, "mel", { storage, transport: tr });
  await mel.init();
  await mel.open(log, { window: "phone" });
  t.true(mel.summaries(log).has(a));
  t.true(mel.summaries(log).has(b));
  await mel.hydrate(log, a);
  t.false(mel.summaries(log).has(a));
  ok(t, w.as("mona", "research.createPostFollowUp", { id: w.id(), thread: a, t: "second" }));
  await mel.sync();
  t.deepEqual(asked.at(-1)?.tier?.opened, [a]);
  t.deepEqual(
    mel
      .view()
      .list("reply", (r) => r.th === a)
      .map((r) => r.t),
    ["reply 0", "second"],
  );
  t.like((await storage.loadMeta()) as ClientMeta, { opened: { [log]: { [a]: w.clock.now() } } });
  // a new process: the summaries come from the stored records
  const again = client(w, "mel", { storage, seed: 9 });
  await again.init();
  await again.open(log, { window: "phone" });
  t.true(again.summaries(log).has(b));
  t.false(again.summaries(log).has(a));
  // 14 days on, the opened thread is no longer reported
  w.clock.advance(15 * DAY);
  await mel.sync();
  t.is(asked.at(-1)?.tier?.opened, undefined);
});

test("finding 9: a server that marks summaries is followed", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "p" }));
  const log = `space:${open}` as const;
  const inner = inProcess(w, "mel");
  const tr = watched(inner, {
    snapshot: async (l, o) => {
      const s = await inner.snapshot(l, o);
      return l === log && !o?.threads && "records" in s ? { ...s, summaries: [th] } : s;
    },
  });
  const mel = client(w, "mel", { transport: tr, tier: { window: "phone" } });
  await mel.init();
  await mel.open(log);
  t.true(mel.summaries(log).has(th));
  await mel.hydrate(log, th);
  t.false(mel.summaries(log).has(th));
});

// ---- finding 10: live updates ----

test("finding 10: the stream follows the open logs: a log opened later is poked, one closed is not pulled, a frozen one is dropped", async (t) => {
  const { w, open, closed } = cast(t);
  const inner = inProcess(w, "mel");
  const pulls: LogId[] = [];
  const connects: CursorMap[] = [];
  const tr = watched(inner, {
    pull: (l, c, o) => {
      pulls.push(l);
      return inner.pull(l, c, o);
    },
    listen: (c, e, s) => {
      connects.push(c());
      return inner.listen(c, e, s);
    },
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open("user:mel");
  await mel.open(`space:${closed}`);
  const ctl = new AbortController();
  const done = mel.listen(ctl.signal);
  await tick();
  await mel.open(`space:${open}`);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "live" }));
  for (let k = 0; k < 50 && !mel.view().get("thread", th); k++) await tick(2);
  t.truthy(mel.view().get("thread", th));
  t.truthy(connects.at(-1)?.[`space:${open}`]);
  // closed: a poke for it pulls nothing
  mel.close(`space:${open}`);
  await tick();
  pulls.length = 0;
  ok(t, w.as("olga", "threads.create", { id: w.id(), space: open, kind: "post", q: "x" }));
  await tick(30);
  t.deepEqual(pulls, []);
  // removed from the closed space: resync, a frozen copy, and the stream
  // reconnects without it
  ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: { adm: (w.get(`member:${closed}:mel`) as { adm: string }).adm },
    }),
  );
  for (let k = 0; k < 50 && !mel.isFrozen(`space:${closed}`); k++) await tick(2);
  t.true(mel.isFrozen(`space:${closed}`));
  await tick();
  t.is(connects.at(-1)?.[`space:${closed}`], undefined);
  ctl.abort();
  await done;
});

// ---- finding 11 ----

test("finding 11: the 3-day drop waits for the server's time; a device clock that jumps does not drop writes", async (t) => {
  const { w, open } = cast(t);
  let skew = 0;
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr, clock: { now: () => w.clock.now() + skew } });
  await mel.init();
  await mel.open(`space:${open}`);
  for (let k = 0; k < 3; k++)
    mel.write("threads.create", { id: mel.newId(), space: open, kind: "post", q: `off ${k}` }, { send: false });
  skew = 3 * DAY + MINUTE;
  await mel.flush();
  t.deepEqual(
    mel.outbox().map((e) => e.state),
    ["answered", "answered", "answered"],
  );
  t.is(threadsOn(w, "off 0").length, 1);
});

test("finding 11: CLOCK_SKEW that does not converge counts as a try; after 5 the write is shown", async (t) => {
  const { w, open } = cast(t);
  let pushes = 0;
  const tr = watched(inProcess(w, "mel"), {
    push: () => {
      pushes++;
      // the server's time moves around the device's (a proxy that caches it)
      const at = w.clock.now() + (pushes % 2 ? 2 : -2) * MINUTE;
      return Promise.resolve([fail("CLOCK_SKEW", at)]);
    },
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  mel.write("likes.set", { thread: w.id(), on: true }, { send: false });
  await mel.flush();
  t.like(mel.outbox()[0] ?? {}, { state: "queued", tries: 1 });
  t.is(pushes, 4);
  for (let k = 0; k < 4; k++) {
    w.clock.advance(11 * MINUTE);
    await mel.flush();
  }
  t.like(mel.problems()[0] ?? {}, { state: "failed", tries: 5, error: { code: "CLOCK_SKEW" } });
  t.true((mel.problems()[0]?.replaces.length ?? 0) <= 64);
});

test("finding 11: a retryAt holds that write and the writes naming its ids; the others go on", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "ask", q: "an ask" }));
  let asks = 0;
  const timers: number[] = [];
  const tr = watched(inProcess(w, "mel"), {
    push: (es, next) => {
      if (es[0]?.name !== "followups.ask" || asks++ > 0) return next();
      const retryAt = new Date(w.clock.now() + 50 * MINUTE).toISOString();
      return Promise.resolve([fail("TOO_MANY_REQUESTS", w.clock.now(), { retryAt })]);
    },
  });
  const mel = client(w, "mel", {
    transport: tr,
    timer: { set: (_fn, ms) => timers.push(ms), clear: () => {} },
  });
  await mel.init();
  await mel.open(`space:${open}`);
  const f = mel.newId();
  mel.write("followups.ask", { id: f, thread: th, q: "a device run" }, { send: false });
  mel.write(
    "research.forkNode",
    { id: mel.newId(), thread: th, parent: f, q: "under it" },
    { send: false },
  );
  mel.write("likes.set", { thread: th, on: true }, { send: false });
  for (let k = 0; k < 6; k++) await mel.flush();
  t.deepEqual(
    mel.outbox().map((e) => `${e.name}:${e.state}:${e.tries}`),
    ["followups.ask:queued:1", "research.forkNode:queued:0", "likes.set:answered:0"],
  );
  t.is(asks, 1);
  t.is(timers.at(-1), 10 * MINUTE, "the timer looks again after at most 10 minutes");
  w.clock.advance(50 * MINUTE);
  await mel.flush();
  t.deepEqual(
    mel.outbox().map((e) => e.state),
    ["answered", "answered", "answered"],
  );
});

test("finding 11: an online-only write is sent at once and never queued or stored; a NOT_MUTATORS call goes to call", async (t) => {
  const { w, open } = cast(t);
  const storage = new MemoryStorage();
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { storage, transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  tr.queue = [null];
  mel.write("likes.set", { thread: w.id(), on: true }); // waits out its backoff
  await mel.flush();
  const sp = mel.newId();
  const created = mel.write("spaces.create", { id: sp, name: "later" });
  t.like(await created.answer, { ok: true });
  t.truthy(w.get(`space:${sp}`));
  t.deepEqual(
    mel.outbox().map((e) => e.name),
    ["likes.set"],
  );
  t.deepEqual(
    ((await storage.loadOutbox()) as { name: string }[]).map((e) => e.name),
    ["likes.set"],
  );
  // offline: an online write fails at once
  tr.queue = [null];
  t.is(await mel.write("spaces.create", { id: mel.newId(), name: "never" }).answer, null);
  const revoke = await mel.write("devices.revoke", { id: w.id() }).answer;
  t.like(revoke ?? {}, { ok: false });
  t.deepEqual(
    mel.outbox().map((e) => e.name),
    ["likes.set"],
  );
});

test("finding 11: answered writes leave no derived-id cache behind", async (t) => {
  const { w, open } = cast(t);
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.open("user:mel");
  for (let k = 0; k < 3; k++)
    ok(
      t,
      (await mel.write("threads.create", { id: mel.newId(), space: open, kind: "ask", q: `q${k}` })
        .answer) as Answer,
    );
  await mel.sync();
  t.deepEqual(mel.outbox(), []);
  t.is((mel as unknown as { derivedCache: Map<string, unknown> }).derivedCache.size, 0);
});

// ---- design 14 ----

test("design 14: leaving a closed space keeps no frozen copy; a removal does", async (t) => {
  const { w, closed } = cast(t);
  const mine = w.id();
  ok(t, w.as("mel", "threads.create", { id: mine, space: closed, kind: "post", q: "mine" }));
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${closed}`);
  await mel.open("user:mel");
  t.like(await mel.write("spaces.leave", { space: closed }).answer, { ok: true });
  await mel.sync();
  t.false(mel.isFrozen(`space:${closed}`));
  t.is(mel.view().get("thread", mine), undefined);
});

test("design 14: another device of the person learns a leave from the user log's `ended`", async (t) => {
  const { w, closed } = cast(t);
  const mine = w.id();
  ok(t, w.as("mel", "threads.create", { id: mine, space: closed, kind: "post", q: "mine" }));
  const inner = inProcess(w, "mel");
  let ended: "left" | "removed" | null = null;
  const tr = watched(inner, {
    snapshot: async (l, o) => {
      const s = await inner.snapshot(l, o);
      return l === "user:mel" && ended && "records" in s ? { ...s, ended: { [closed]: ended } } : s;
    },
  });
  const other = client(w, "mel", { transport: tr });
  await other.init();
  await other.open("user:mel");
  await other.open(`space:${closed}`);
  ok(t, w.as("mel", "spaces.leave", { space: closed }));
  ended = "left";
  await other.sync();
  t.false(other.isFrozen(`space:${closed}`));
  t.is(other.view().get("thread", mine), undefined);
  // without the field (or "removed"), it reads as a removal: a frozen copy
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
  ended = null;
  await other.sync();
  t.truthy(other.view().get("thread", mine));
  ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: { adm: (w.get(`member:${closed}:mel`) as { adm: string }).adm },
    }),
  );
  await other.sync();
  t.true(other.isFrozen(`space:${closed}`));
});

test("design 14: persist: false (the web) sends at once, shows a transient failure with Try again, and stores no outbox", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("olga", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const storage = new MemoryStorage();
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { storage, transport: tr, persist: false });
  await mel.init();
  await mel.open(`space:${open}`);
  tr.queue = [fail("SERVICE_UNAVAILABLE", w.clock.now())];
  const like = mel.write("likes.set", { thread: th, on: true });
  t.is(await like.answer, null);
  t.like(mel.problems()[0] ?? {}, { state: "failed", tries: 1 });
  t.deepEqual(await storage.loadOutbox(), []);
  t.true(mel.sendAgain(mel.problems()[0]?.local ?? ""));
  await mel.flush();
  t.truthy(w.get(`like:mel:${th}`));
});

// ---- test gaps ----

test("G4: a frozen copy keeps what the user wrote under their threads, not what others wrote", async (t) => {
  const { w, closed } = cast(t);
  const mine = w.id();
  ok(t, w.as("mel", "threads.create", { id: mine, space: closed, kind: "post", q: "mine" }));
  const own = w.id();
  const theirs = w.id();
  ok(t, w.as("mel", "research.createPostFollowUp", { id: own, thread: mine, t: "mel's" }));
  ok(t, w.as("olga", "research.createPostFollowUp", { id: theirs, thread: mine, t: "olga's" }));
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${closed}`);
  await mel.open("user:mel");
  ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: { adm: (w.get(`member:${closed}:mel`) as { adm: string }).adm },
    }),
  );
  await mel.sync();
  t.true(mel.isFrozen(`space:${closed}`));
  t.truthy(mel.records(`space:${closed}`).get(`reply:${own}`));
  t.is(mel.records(`space:${closed}`).get(`reply:${theirs}`), undefined);
});

test("G6: an envelope carries the time the write was queued, not the time it was sent", async (t) => {
  const { w, open } = cast(t);
  const tr = new Forced(inProcess(w, "mel"));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  tr.queue = [null];
  const at = w.clock.now();
  mel.write("likes.set", { thread: w.id(), on: true });
  await mel.flush();
  w.clock.advance(HOUR_MS);
  await mel.flush();
  t.is(tr.pushes.length, 2);
  t.is(tr.pushes[1]?.queuedAt, at);
  t.is(tr.pushes[1]?.clientTime, at + HOUR_MS);
});
const HOUR_MS = 60 * MINUTE;

test("G8: a frozen copy is never read again", async (t) => {
  const { w, closed } = cast(t);
  const inner = inProcess(w, "mel");
  const reads: LogId[] = [];
  const tr = watched(inner, {
    pull: (l, c, o) => {
      reads.push(l);
      return inner.pull(l, c, o);
    },
    snapshot: (l, o) => {
      reads.push(l);
      return inner.snapshot(l, o);
    },
  });
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${closed}`);
  await mel.open("user:mel");
  ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: { adm: (w.get(`member:${closed}:mel`) as { adm: string }).adm },
    }),
  );
  await mel.sync();
  t.true(mel.isFrozen(`space:${closed}`));
  reads.length = 0;
  await mel.sync();
  await mel.sync(`space:${closed}`);
  t.deepEqual(reads, ["user:mel"]);
});

test("G11: a write that reads a staff-only record the replica lacks is predicted unknown, not refused", async (t) => {
  const { w, open } = cast(t);
  const c = client(w, "mona");
  await c.init();
  await c.open(`space:${open}`);
  await c.open("user:mona");
  c.write("reports.resolve", { report: w.id(), outcome: "dismissed" }, { send: false });
  t.is(c.outbox()[0]?.prediction, "unknown");
});
