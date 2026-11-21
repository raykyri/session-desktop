// The M2 reviews' findings on the client and the server half, as tests.

import { MUTATORS, Refusal } from "@session/mutators";
import test from "ava";

import {
  CLIENT_ID_KEY,
  LiveQuery,
  MemoryAdapter,
  SyncClient,
  claimClientId,
  storeClientId,
  type ClientEvent,
  type LockManagerLike,
  type SyncTransport,
} from "../src/client/index.js";
import { MemoryStore } from "../src/server/index.js";

import { DAY, MINUTE, World, actor, cast, ok, post } from "./world.js";

const client = (w: World, u: string, transport: SyncTransport = w.transport(u)) =>
  new SyncClient(transport, {
    user: u,
    clock: w.clock,
    random: w.random,
    mutators: MUTATORS,
    storage: new MemoryAdapter(),
  });

const events = (c: SyncClient) => {
  const out: ClientEvent[] = [];
  c.onEvent((e) => out.push(e));
  return out;
};

/** A promise and the function that settles it. */
function gate() {
  let open: () => void = () => {};
  const p = new Promise<void>((done) => (open = done));
  return { p, open };
}

test("1: an applied write's record is not counted twice once the log that holds it was read", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const mona = client(w, "mona");
  // read before the client has an id: no seq on either log
  await mona.sync(`space:${open}`);
  await mona.sync("user:mona");
  mona.write("saved.set", { kind: "thread", id: p, on: true });
  await mona.flush();
  // the space log first: the count is the server's, the save still shown
  await mona.sync(`space:${open}`);
  t.deepEqual(mona.get(`counts:${p}`), w.get(`counts:${p}`));
  t.truthy(mona.get(`save:mona:${p}`));
  await mona.sync("user:mona");
  t.deepEqual(mona.get(`save:mona:${p}`), w.get(`save:mona:${p}`));
  t.deepEqual(mona.view(), new Map(mona.replica.all()));
});

test("2, 17: a promotion and a pull of the same log run in turn: no reply is lost", async (t) => {
  const w = new World({ window: { days: 1, threads: 1, cap: 1 } });
  const { open } = cast(t, w);
  const older = post(t, w, "mel", open);
  w.clock.advance(2 * DAY);
  post(t, w, "mel", open);
  const base = w.transport("mona");
  const held = gate();
  const mona = client(w, "mona", {
    ...base,
    snapshot: async (l, o) => {
      const s = await base.snapshot(l, o);
      if (o?.tier === "threads") await held.p;
      return s;
    },
  });
  await mona.sync(`space:${open}`, "window");
  const opening = mona.open(older);
  // a reply lands while the promotion is in flight, and a pull is asked for
  const rid = w.id();
  ok(t, w.as("otto", "research.createPostFollowUp", { id: rid, thread: older, t: "late" }));
  const pulling = mona.sync(`space:${open}`);
  held.open();
  t.is(await opening, "full");
  t.is(await pulling, "pull");
  t.truthy(mona.get(`reply:${rid}`));
  t.deepEqual(mona.get(`counts:${older}`), w.get(`counts:${older}`));
});

test("3: a write in flight is not dropped; the next one is still sent", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const base = w.transport("mona");
  const held = gate();
  const mona = client(w, "mona", {
    ...base,
    apply: async (e) => {
      if (e.name === "saved.set") await held.p;
      return base.apply(e);
    },
  });
  await mona.register();
  const a = mona.queue("saved.set", { kind: "thread", id: p, on: true });
  const id = w.id();
  mona.queue("research.createPostFollowUp", { id, thread: p, t: "x" });
  const flushing = mona.flush();
  await new Promise((r) => setImmediate(r));
  t.false(mona.drop(a.mutationId));
  held.open();
  await flushing;
  t.truthy(w.get(`reply:${id}`));
  t.deepEqual(mona.pending(), []);
});

test("4: no answer says nothing about the clock", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const fast = { now: () => w.clock.now() + 10 * MINUTE };
  const base = w.transport("mona");
  let down = true;
  const mona = new SyncClient(
    {
      ...base,
      apply: (e) => {
        if (down) throw new Error("offline");
        return base.apply(e);
      },
    },
    { user: "mona", clock: fast, random: w.random, mutators: MUTATORS },
  );
  await mona.register();
  mona.write("saved.set", { kind: "thread", id: p, on: true });
  await mona.flush();
  down = false;
  const b = mona.queue("research.createPostFollowUp", { id: mona.newId(), thread: p, t: "x" });
  t.false(b.known);
  const res = await mona.flush();
  t.deepEqual(
    res.map((r) => (r.ok ? "ok" : r.error.code)),
    ["ok"],
  );
});

test("5: a registration that throws or is refused leaves the writes Not sent with its error", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const base = w.transport("mona");
  let refusal: "throw" | "limit" = "throw";
  const mona = client(w, "mona", {
    ...base,
    register: () => {
      if (refusal === "throw") throw new Error("offline");
      return { ok: false, error: { code: "TOO_MANY_REQUESTS", message: "limit" } };
    },
  });
  const seen = events(mona);
  mona.queue("saved.set", { kind: "thread", id: p, on: true });
  await mona.flush();
  refusal = "limit";
  mona.queue("saved.set", { kind: "thread", id: p, on: false });
  await mona.flush();
  t.deepEqual(
    seen.flatMap((e) => (e.type === "unsent" ? [e.error.code] : [])),
    ["SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS"],
  );
  t.is(mona.unsent().length, 2);
});

test("6: a listener or a query that throws does not stop a flush or a read", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const reported: unknown[] = [];
  const g = globalThis as { reportError?: (e: unknown) => void };
  const saved = g.reportError;
  g.reportError = (e) => reported.push(e);
  try {
    const mona = client(w, "mona");
    await mona.sync(`space:${open}`);
    mona.onEvent(() => {
      throw new Error("a UI bug");
    });
    const heard: string[] = [];
    mona.onEvent((e) => {
      if (e.type !== "client") heard.push(e.type);
    });
    const live = new LiveQuery(mona, (q) => {
      if (q.get(`reply:${w.id()}`) === undefined && q.list("reply").length > 0)
        throw new Error("a selector bug");
      return q.list("reply").length;
    });
    const stop = live.subscribe(() => {});
    mona.queue("saved.set", { kind: "thread", id: p, on: true });
    const id = w.id();
    mona.queue("research.createPostFollowUp", { id, thread: p, t: "x" });
    await mona.flush();
    t.truthy(w.get(`reply:${id}`));
    t.deepEqual(heard, ["applied", "applied"]);
    t.is(await mona.sync(`space:${open}`), "pull");
    t.true(reported.length >= 2);
    stop();
  } finally {
    if (saved) g.reportError = saved;
    else delete g.reportError;
  }
});

test("7: a replayed answer uses no seq: the next write goes with the next one", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const base = w.transport("mona");
  let lose = true;
  const mona = client(w, "mona", {
    ...base,
    apply: async (e) => {
      const r = await base.apply(e);
      if (lose) throw new Error("lost");
      return r;
    },
  });
  await mona.register();
  const r = mona.write("research.createPostFollowUp", { id: w.id(), thread: p, t: "x" });
  await mona.flush();
  lose = false;
  const again = await mona.retry(r.local);
  t.like(again[0], { ok: true, replay: true });
  mona.queue("saved.set", { kind: "thread", id: p, on: true });
  const next = await mona.flush();
  t.deepEqual(
    next.map((x) => (x.ok ? "ok" : x.error.code)),
    ["ok"],
  );
  t.is(mona.sent.at(-1)?.seq, 2);
});

test("8: an empty log's snapshot and an outbox change notify", async (t) => {
  const w = new World();
  const zed = client(w, "zed");
  const calls: boolean[] = [];
  zed.subscribe((_c, info) => calls.push(info.structural));
  await zed.sync("user:zed");
  t.deepEqual(calls, [true]);
  zed.queue("prefs.set", { layout: "wide" });
  t.is(calls.length, 2);
});

test("9: the lock is released when a re-attach throws; a refused lock request does not hang", async (t) => {
  const w = new World();
  const storage = new Map<string, string>();
  const s = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
  const held = new Set<string>();
  const locks: LockManagerLike = {
    async request(name, _o, cb) {
      if (held.has(name)) return cb(null);
      held.add(name);
      try {
        return await cb({});
      } finally {
        held.delete(name);
      }
    },
  };
  const first = await claimClientId({
    userId: "mel",
    storage: s,
    locks,
    register: (o) => Promise.resolve(w.server.register(actor("mel"), o)),
  });
  if ("error" in first) return t.fail();
  first.release();
  await new Promise((r) => setImmediate(r));
  await t.throwsAsync(
    claimClientId({
      userId: "mel",
      storage: s,
      locks,
      register: () => Promise.reject(new Error("offline")),
    }),
  );
  await new Promise((r) => setImmediate(r));
  t.is(held.size, 0, "the re-attach's lock was released");
  const refusing: LockManagerLike = { request: () => Promise.reject(new Error("SecurityError")) };
  const h = await claimClientId({
    userId: "mel",
    storage: s,
    locks: refusing,
    register: (o) => Promise.resolve(w.server.register(actor("mel"), o)),
  });
  t.false("error" in h);
});

test("10: a prediction is stamped with its write's queue time", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const mona = client(w, "mona");
  await mona.sync(`space:${open}`);
  const id = w.id();
  mona.queue("research.createPostFollowUp", { id, thread: p, t: "x" });
  const at =
    mona.get(`reply:${id}`)?.kind === "reply"
      ? (mona.get(`reply:${id}`) as { createdAt: string }).createdAt
      : "";
  w.clock.advance(5 * MINUTE);
  post(t, w, "mel", open);
  await mona.sync(`space:${open}`);
  t.is((mona.get(`reply:${id}`) as { createdAt: string }).createdAt, at);
});

test("11: an id registered after WRONG_CLIENT is told to the app, which stores it", async (t) => {
  const w = new World({ expireEveryCall: true });
  const { open } = cast(t, w);
  const p = post(t, w, "mel", open);
  const mona = client(w, "mona");
  await mona.register();
  const old = mona.clientId;
  const seen = events(mona);
  w.clock.advance(8 * DAY);
  mona.write("saved.set", { kind: "thread", id: p, on: true });
  await mona.flush();
  const e = seen.find((x) => x.type === "client");
  t.like(e, { type: "client", lastSeq: 0 });
  t.not(mona.clientId, old);
  const storage = new Map<string, string>();
  const h = await storeClientId({
    userId: "mona",
    clientId: mona.clientId ?? "",
    lastSeq: 0,
    storage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
    },
    locks: { request: (_n, _o, cb) => cb({}) },
  });
  t.is(h.clientId, mona.clientId ?? "");
  t.true((storage.get(CLIENT_ID_KEY) ?? "").includes(mona.clientId ?? "x"));
});

test("12: serverNow follows the server time of answers and reads", async (t) => {
  const { w, open } = cast(t);
  const slow = { now: () => w.clock.now() - 3 * MINUTE };
  const mona = new SyncClient(w.transport("mona"), {
    user: "mona",
    clock: slow,
    random: w.random,
    mutators: MUTATORS,
  });
  await mona.sync(`space:${open}`);
  t.true(Math.abs(mona.serverNow() - w.clock.now()) < 1000);
});

test("13: problems can be dismissed; the tab keeps at most 500 opened threads", async (t) => {
  const { w, open } = cast(t);
  const mona = client(w, "mona");
  await mona.sync(`space:${open}`, "window");
  for (let k = 0; k < 501; k++) await mona.open(w.id());
  mona.dropLog(`space:${open}`);
  t.is(await mona.sync(`space:${open}`, "window"), "snapshot");
  const old = mona.newId();
  w.clock.advance(5 * DAY);
  mona.queue("prefs.set", { layout: "wide" }, old);
  await mona.flush();
  const [problem] = mona.problems();
  t.true(problem !== undefined && mona.dismiss(problem.local));
  t.deepEqual(mona.problems(), []);
});

test("14: a query does not re-run on its first listener, nor notify an equal value", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const mona = client(w, "mona");
  await mona.sync(`space:${open}`);
  const live = new LiveQuery(mona, (q) => q.list("thread").map((x) => x.id));
  const runs = live.runs;
  let told = 0;
  const stop = live.subscribe(() => told++);
  t.is(live.runs, runs);
  // a change to a thread's text: same ids, no notification
  ok(
    t,
    w.as("mel", "threads.update", { id: p, q: "edited", base: { rev: w.get(`thread:${p}`)?.rev } }),
  );
  await mona.sync(`space:${open}`);
  t.is(told, 0);
  post(t, w, "mel", open);
  await mona.sync(`space:${open}`);
  t.is(told, 1);
  stop();
});

test("15: loaded tells held from unknown; open answers missing for a thread not held; a window index is not full", async (t) => {
  const w = new World({ window: { days: 1, threads: 1, cap: 1 } });
  const { open, closed } = cast(t, w);
  const old = post(t, w, "mel", open);
  w.clock.advance(2 * DAY);
  post(t, w, "mel", open);
  const mona = client(w, "mona");
  await mona.sync(`space:${open}`, "window");
  t.true(mona.loaded(`thread:${old}`));
  t.true(mona.loaded(`member:${open}:mona`));
  t.false(mona.loaded(`member:${closed}:ada`));
  t.false(mona.loaded(`thread:${w.id()}`));
  t.false(mona.loadedIndex("reply", { th: old }));
  t.false(mona.loadedIndex("thread", { sp: open }), "a window holds no thread over 2 years");
  t.true(mona.loadedIndex("member", { sp: open }));
  t.is(await mona.open(w.id()), "missing");
});

test("16: send reports its answer and leaves no Not sent write", async (t) => {
  const w = new World();
  const base = w.transport("mona");
  const mona = client(w, "mona", {
    ...base,
    apply: () => {
      throw new Error("offline");
    },
  });
  const seen = events(mona);
  const r = await mona.send("spaces.create", { id: mona.newId(), name: "new-one" });
  t.like(r, { ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
  t.deepEqual(mona.unsent(), []);
  t.false(seen.some((e) => e.type === "unsent"));
});

test("17 (store): a nested transaction that throws takes back its own writes only", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const head = w.store.head();
  const r = w.store.transaction(() => {
    w.store.setLastRev("outer", 1);
    const inner = w.server.serverApply({ me: "mel" }, (tx) => {
      const th = tx.byKey(`thread:${p}`);
      if (th?.kind === "thread") tx.put({ ...th, sum: "partial" });
      // a fault after serverApply staged and committed its records
      throw new Error("the fault");
    });
    return inner;
  });
  t.false(r.ok);
  t.is(w.store.lastRev("outer"), 1, "the outer transaction's write is kept");
  t.like(w.get(`thread:${p}`), { sum: null });
  t.is(w.store.head(), head);
  // a fault inside commit (after records were written) in a nested call
  const store = new MemoryStore();
  store.transaction(() => {
    store.setLastRev("a", 1);
    try {
      store.transaction(() => {
        store.setLastRev("b", 1);
        throw new Error("inner");
      });
    } catch {
      // the inner savepoint was rolled back
    }
  });
  t.is(store.lastRev("a"), 1);
  t.is(store.lastRev("b"), undefined);
});

test("18: gone and removed threads take no slot of the window, and are summaries", (t) => {
  const w = new World({ window: { days: 1, threads: 2, cap: 2 } });
  const { open } = cast(t, w);
  const make = (q: string) => {
    w.clock.advance(1000);
    return post(t, w, "mel", open, q);
  };
  const a = make("a");
  const b = make("b");
  const gone = make("gone");
  const removed = make("removed");
  ok(t, w.as("mel", "threads.delete", { id: gone }));
  ok(t, w.as("olga", "moderation.decide", { item: `p:${removed}`, decision: "removed" }));
  w.clock.advance(2 * DAY);
  const snap = w.server.snapshot(actor("mona"), `space:${open}`, { tier: "window" });
  t.deepEqual(new Set(snap.full), new Set([a, b]));
  const keys = new Set(snap.records.map((x) => x.key));
  t.true(keys.has(`thread:${gone}`) && keys.has(`thread:${removed}`));
});

test("19: a snapshot's tier and threads are validated", (t) => {
  const { w, open } = cast(t);
  const bad = (o: object) =>
    t.throws(() => w.server.snapshot(actor("mona"), `space:${open}`, o as never), {
      instanceOf: Refusal,
      message: /data is missing or not valid/,
    });
  bad({ tier: "everything" });
  bad({ tier: "threads" });
  bad({ tier: "window", threads: ["not-an-id"] });
  bad({ tier: "window", threads: Array.from({ length: 501 }, () => w.id()) });
  t.notThrows(() => w.server.snapshot(actor("mona"), `space:${open}`, { tier: "window" }));
});
