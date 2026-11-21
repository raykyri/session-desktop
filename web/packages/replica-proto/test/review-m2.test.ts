// The M2 reviews' findings, as tests of the acceptance suite (M2 review 21):
// the web client's in-flight outbox (Not sent, Retry, Discard), its
// predictions and their rollback, promotion of a summary thread, the web
// window, client id re-attach, recorded refusals and the cursor key's
// rotation. The client is `@session/sync`'s, over the server under test.
//
// The prototype server (`REPLICA_PROTO_SERVER=proto`) has no web window, no
// re-attach and no configured cursor keys: those tests run on the sync
// target only (`syncOnly`), and the M3 HTTP target runs them too.

import { randomBytes } from "node:crypto";

import {
  MemoryAdapter,
  SyncClient,
  claimClientId,
  type LockManagerLike,
  type SessionStorageLike,
  type SyncTransport,
} from "@session/sync/client";
import { MemoryStore, SyncServer } from "@session/sync/server";
import test from "ava";

import { PROTO_MUTATORS, type ServerHalf } from "../src/index.js";

import type { World } from "./harness.js";
import { DAY, MINUTE, MODEL, actor, cast, ok, refused, thread, threadInput } from "./harness.js";

const proto = process.env["REPLICA_PROTO_SERVER"] === "proto";
/** A test of what only the build's server half has. */
const syncOnly = proto ? test.skip : test;

/** The server half as one person's client reaches it. */
function transport(server: ServerHalf, u: string): SyncTransport {
  const a = actor(u);
  return {
    register: async (o) =>
      ({ lastSeq: 0, reattached: false, ...(await server.register(a, o)) }) as never,
    apply: (e) => server.apply(a, e),
    snapshot: (l, o) => server.snapshot(a, l, o),
    pull: (l, c, o) => server.pull(a, l, c, o),
  };
}

/** The web client (in-flight policy) for `u`. */
const web = (w: World, u: string, t: SyncTransport = transport(w.server, u), extra = {}) =>
  new SyncClient(t, {
    user: u,
    clock: w.clock,
    random: w.random,
    mutators: PROTO_MUTATORS,
    storage: new MemoryAdapter(),
    ...extra,
  });

const offline = (t: SyncTransport, state: { down: boolean }): SyncTransport => ({
  ...t,
  apply: (e) => (state.down ? Promise.reject(new Error("offline")) : t.apply(e)),
});

test("a failed request leaves the write Not sent with its prediction; Retry sends it with the same mutation id, Discard rolls it back", async (t) => {
  const { w, open } = await cast(t);
  const p = await thread(t, w, "mel", open, "post");
  const state = { down: true };
  const mona = web(w, "mona", offline(transport(w.server, "mona"), state));
  await mona.sync(`space:${open}`);
  await mona.sync("user:mona");
  const save = mona.write("saved.set", { kind: "thread", id: p, on: true });
  const r = mona.write("research.createPostFollowUp", { id: mona.newId(), thread: p, t: "x" });
  await mona.flush();
  t.deepEqual(mona.pending(), []);
  t.deepEqual(
    mona.unsent().map((x) => x.local),
    [save.local, r.local],
  );
  t.is(mona.prediction(r.local), "applied");
  t.like(mona.get(`counts:${p}`), { r: 1, saves: 1 });
  state.down = false;
  await mona.retry(save.local);
  t.is(new Set(mona.sent.filter((e) => e.name === "saved.set").map((e) => e.mutationId)).size, 1);
  t.like(w.get(`save:mona:${p}`), { u: "mona" });
  t.like(mona.get(`counts:${p}`), { r: 1 }, "the Not sent reply is still shown");
  t.true(mona.discard(r.local));
  t.like(mona.get(`counts:${p}`), { r: 0 });
  t.is(
    [...w.server.dump().values()].filter((x) => x.kind === "reply").length,
    0,
    "the discarded reply never reached the server",
  );
});

test("a prediction shows a write before its answer, rolls back a refusal and is not counted twice after the pull", async (t) => {
  const { w, open } = await cast(t);
  const p = await thread(t, w, "mel", open, "post");
  // what the view shows when the reply is sent, after its thread's refusal
  const base = transport(w.server, "mona");
  const atReply: unknown[] = [];
  const mona: SyncClient = web(w, "mona", {
    ...base,
    apply: (e) => {
      if (e.name === "research.createPostFollowUp")
        atReply.push(mona.get(`thread:${th}`) ?? null, mona.get(`reply:${rid}`) ?? null);
      return base.apply(e);
    },
  });
  await mona.sync(`space:${open}`);
  await mona.sync("user:mona");
  mona.queue("saved.set", { kind: "thread", id: p, on: true });
  t.like(mona.get(`counts:${p}`), { saves: 1 });
  await mona.flush();
  // applied, not pulled yet: still shown
  t.like(mona.get(`counts:${p}`), { saves: 1 });
  t.truthy(mona.get(`save:mona:${p}`));
  await mona.sync(`space:${open}`);
  t.like(mona.get(`counts:${p}`), { saves: 1 }, "not counted twice");
  await mona.sync("user:mona");
  t.deepEqual(mona.view(), new Map(mona.replica.all()));
  // a refused write and the one that depends on it roll back at once
  await ok(t, w.as("olga", "members.ban", { space: open, user: "mona" }));
  const th = mona.newId();
  const a = mona.queue("threads.create", threadInput(th, open, "post", "banned"));
  const rid = mona.newId();
  const b = mona.queue("research.createPostFollowUp", { id: rid, thread: th, t: "x" });
  t.is(mona.prediction(a.local), "applied");
  t.is(mona.prediction(b.local), "applied");
  await mona.flush();
  t.deepEqual(atReply, [null, null], "the reply's prediction rolled back with the thread's");
  t.is(mona.get(`thread:${th}`), undefined);
  t.deepEqual(mona.pending(), []);
});

test("a write in flight is not dropped; no answer does not mark the clock right; a replay uses no seq", async (t) => {
  const { w, open } = await cast(t);
  const p = await thread(t, w, "mel", open, "post");
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const base = transport(w.server, "mona");
  const mona = web(w, "mona", {
    ...base,
    apply: async (e) => {
      if (e.name === "prefs.set") await held;
      return base.apply(e);
    },
  });
  await mona.register();
  const a = mona.queue("prefs.set", { layout: "wide" });
  const flushing = mona.flush();
  await new Promise((r) => setImmediate(r));
  t.false(mona.drop(a.mutationId));
  release();
  await flushing;
  // a fast device whose request got no answer is not known to be right
  const fast = { now: () => w.clock.now() + 10 * MINUTE };
  const state = { down: true };
  const otto = new SyncClient(offline(transport(w.server, "otto"), state), {
    user: "otto",
    clock: fast,
    random: w.random,
    mutators: PROTO_MUTATORS,
  });
  await otto.register();
  otto.write("saved.set", { kind: "thread", id: p, on: true });
  await otto.flush();
  state.down = false;
  t.false(otto.queue("prefs.set", { layout: "wide" }).known);
  // a lost answer retried: the replay uses no seq, and the next write's seq follows
  let lose = true;
  const mel = web(w, "mel", {
    ...transport(w.server, "mel"),
    apply: async (e) => {
      const r = await w.server.apply(actor("mel"), e);
      if (lose) throw new Error("lost");
      return r;
    },
  });
  await mel.register();
  const lost = mel.write("prefs.set", { layout: "wide" });
  await mel.flush();
  lose = false;
  await mel.retry(lost.local);
  mel.queue("prefs.set", { layout: "centred" });
  const next = await mel.flush();
  t.deepEqual(
    next.map((x) => (x.ok ? "ok" : x.error.code)),
    ["ok"],
  );
});

test("a queue_full refusal is recorded: after a slot is freed the same envelope gets it again", async (t) => {
  const { w, open } = await cast(t);
  const asks: string[] = [];
  for (let k = 0; k < 20; k++) {
    const id = w.id();
    asks.push(id);
    await ok(t, w.as("mel", "threads.create", threadInput(id, open, "ask", `q${k}`)));
  }
  const e = await w.envelope("mel", "threads.create", threadInput(w.id(), open, "ask", "more"));
  await refused(t, w.server.apply(actor("mel"), e), "PRECONDITION_FAILED");
  await ok(t, w.as("mel", "research.cancelNode", { thread: asks[0], node: "r" }));
  const again = await w.resend("mel", e);
  t.like(again, { ok: false, error: { code: "PRECONDITION_FAILED", reason: "queue_full" } });
});

syncOnly(
  "the web window: newest and recent threads capped, own and saved ones, summaries, gone and removed shells take no slot",
  async (t) => {
    const { w, open } = await cast(t, 1, { window: { days: 1, threads: 2, cap: 3 } });
    const post = (u: string, q: string) => thread(t, w, u, open, "post", q);
    const mine = await post("mona", "mona's");
    const saved = await post("mel", "saved");
    await ok(t, w.as("mona", "saved.set", { kind: "thread", id: saved, on: true }));
    const ancient = await post("mel", "ancient");
    w.clock.advance(731 * DAY);
    // older than 90 days now: neither own nor saved counts. The harness's
    // client ids expired: otto writes from a client of his own
    const otto = web(w, "otto");
    const write = async (name: string, input: unknown) => {
      const r = await otto.send(name, input);
      if (!r.ok) t.fail(JSON.stringify(r.error));
    };
    const recent: string[] = [];
    for (let k = 0; k < 4; k++) {
      w.clock.advance(1000);
      const id = otto.newId();
      await write("threads.create", threadInput(id, open, "post", `recent ${k}`));
      recent.push(id);
    }
    const gone = otto.newId();
    await write("threads.create", threadInput(gone, open, "post", "gone"));
    await write("threads.delete", { id: gone });
    const snap = await w.server.snapshot(actor("mona"), `space:${open}`, { tier: "window" });
    // 4 recent ones beyond 2 newest, capped at 3; the gone shell takes no slot
    t.deepEqual([...(snap.full ?? [])].sort(), recent.slice(1).sort());
    const keys = new Set(snap.records.map((x) => x.key));
    t.true(keys.has(`thread:${gone}`), "a gone shell is a summary");
    t.false(keys.has(`thread:${ancient}`), "nothing over 2 years");
    void mine;
    // own and saved threads within 90 days are full
    const w2 = await cast(t, 2, { window: { days: 1, threads: 1, cap: 1 } });
    const own = await thread(t, w2.w, "mona", w2.open, "post", "own");
    const other = await thread(t, w2.w, "mel", w2.open, "post", "other");
    await ok(t, w2.w.as("mona", "saved.set", { kind: "thread", id: other, on: true }));
    w2.w.clock.advance(2 * DAY);
    await thread(t, w2.w, "otto", w2.open, "post", "newest");
    const s2 = await w2.w.server.snapshot(actor("mona"), `space:${w2.open}`, { tier: "window" });
    t.true(s2.full?.includes(own));
    t.true(s2.full?.includes(other));
    // the newest threads when none is recent; summaries back to 2 years; own
    // threads full for 90 days
    const w3 = await cast(t, 3, { window: { days: 1, threads: 1, cap: 3 } });
    const own3 = await thread(t, w3.w, "mona", w3.open, "post", "own");
    const old3 = await thread(t, w3.w, "mel", w3.open, "post", "old");
    w3.w.clock.advance(75 * DAY);
    const mel3 = web(w3.w, "mel");
    const newest = mel3.newId();
    const sent = await mel3.send("threads.create", threadInput(newest, w3.open, "post", "newest"));
    t.true(sent.ok);
    w3.w.clock.advance(2 * DAY);
    const at77 = await w3.w.server.snapshot(actor("mona"), `space:${w3.open}`, { tier: "window" });
    t.true(at77.full?.includes(own3), "an own thread 77 days old is full");
    t.true(at77.full?.includes(newest), "the newest threads are full when none is recent");
    w3.w.clock.advance(423 * DAY);
    const at500 = await w3.w.server.snapshot(actor("mona"), `space:${w3.open}`, { tier: "window" });
    t.true(
      at500.records.some((x) => x.key === `thread:${old3}`),
      "a thread 500 days old is a summary",
    );
    t.false(at500.full?.includes(own3), "an own thread 500 days old is not full");
    // a tier the protocol does not have is refused
    await t.throwsAsync(async () =>
      w2.w.server.snapshot(actor("mona"), `space:${w2.open}`, { tier: "all" as never }),
    );
  },
);

syncOnly(
  "promotion: an opened summary thread is fetched in full, sent again with the window, pulls keep its content; a thread not held is missing",
  async (t) => {
    const { w, open } = await cast(t, 1, { window: { days: 1, threads: 1, cap: 1 } });
    const old = await thread(t, w, "mel", open, "post", "old");
    w.clock.advance(2 * DAY);
    await thread(t, w, "mel", open, "post", "new");
    const reply = w.id();
    await ok(t, w.as("otto", "research.createPostFollowUp", { id: reply, thread: old, t: "r" }));
    const mona = web(w, "mona");
    await mona.sync(`space:${open}`, "window");
    t.false(mona.loadedIndex("reply", { th: old }));
    t.is(
      mona.prediction(
        mona.queue("research.createPostFollowUp", { id: mona.newId(), thread: old, t: "?" }).local,
      ),
      "unknown",
    );
    t.false(mona.loadedIndex("thread", { sp: open }));
    t.is(await mona.open(old), "full");
    t.truthy(mona.get(`reply:${reply}`));
    mona.dropLog(`space:${open}`);
    await mona.sync(`space:${open}`, "window");
    t.true(mona.replica.isFull(`space:${open}`, old), "the opened thread is sent again");
    // a new thread arrives by a pull, full: its reply is kept
    const fresh = await thread(t, w, "otto", open, "post", "fresh");
    const r2 = w.id();
    await ok(t, w.as("mel", "research.createPostFollowUp", { id: r2, thread: fresh, t: "hi" }));
    await mona.sync(`space:${open}`);
    t.truthy(mona.get(`reply:${r2}`));
    t.is(await mona.open(w.id()), "missing");
  },
);

syncOnly(
  "register re-attaches the caller's id, uncounted and as use; not another's; a client built from it sends the next seq",
  async (t) => {
    const { w, open } = await cast(t);
    const p = await thread(t, w, "mel", open, "post");
    const first = await w.server.register(actor("otto"));
    if (!first.ok) return t.fail();
    // the suite's target registers 20 new ids a day; re-attaches are not counted
    for (let k = 0; k < 25; k++)
      t.true((await w.server.register(actor("otto"), { clientId: first.clientId })).ok);
    t.true((await w.server.register(actor("otto"))).ok, "a new id is still allowed");
    t.like(await w.server.register(actor("mel"), { clientId: first.clientId }), {
      ok: false,
      error: { code: "WRONG_CLIENT" },
    });
    // a re-attach is use of the id: 89 days, re-attached, 2 more days, applied
    w.clock.advance(89 * DAY);
    t.true((await w.server.register(actor("otto"), { clientId: first.clientId })).ok);
    w.clock.advance(2 * DAY);
    const otto = web(w, "otto", transport(w.server, "otto"), {
      clientId: first.clientId,
      lastSeq: 0,
    });
    otto.queue("saved.set", { kind: "thread", id: p, on: true });
    t.deepEqual(
      (await otto.flush()).map((x) => (x.ok ? "ok" : x.error.code)),
      ["ok"],
    );
    const re = await w.server.register(actor("otto"), { clientId: first.clientId });
    t.like(re, { ok: true, lastSeq: 1 });
    const again = web(w, "otto", transport(w.server, "otto"), {
      clientId: first.clientId,
      lastSeq: 1,
    });
    again.queue("saved.set", { kind: "thread", id: p, on: false });
    await again.flush();
    t.deepEqual(
      again.sent.map((e) => e.seq),
      [2],
    );
  },
);

syncOnly(
  "a tab keeps its id across reloads behind its lock; a duplicated tab gets a new one",
  async (t) => {
    const { w } = await cast(t);
    const items = new Map<string, string>();
    const storage: SessionStorageLike = {
      getItem: (k) => items.get(k) ?? null,
      setItem: (k, v) => void items.set(k, v),
      removeItem: (k) => void items.delete(k),
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
    const register = async (o?: { clientId?: string }) =>
      ({ lastSeq: 0, reattached: false, ...(await w.server.register(actor("ada"), o)) }) as never;
    const a = await claimClientId({ userId: "ada", storage, locks, register });
    if ("error" in a) return t.fail();
    // a duplicated tab: a copy of the storage, the first tab's lock held
    const copy = new Map(items);
    const dup = await claimClientId({
      userId: "ada",
      storage: {
        getItem: (k) => copy.get(k) ?? null,
        setItem: (k, v) => void copy.set(k, v),
        removeItem: (k) => void copy.delete(k),
      },
      locks,
      register,
    });
    if ("error" in dup) return t.fail();
    t.not(dup.clientId, a.clientId);
    a.release();
    await new Promise((r) => setImmediate(r));
    const reload = await claimClientId({ userId: "ada", storage, locks, register });
    if ("error" in reload) return t.fail();
    t.true(reload.reattached);
  },
);

syncOnly(
  "a cursor sealed with the previous key pulls for 30 days after the rotation, then resyncs; a savepoint rolls back alone",
  (t) => {
    const store = new MemoryStore();
    const clock = {
      ms: Date.parse("2026-11-16T10:00:00Z"),
      now() {
        return this.ms;
      },
    };
    const old = randomBytes(32);
    const first = new SyncServer({
      store,
      clock,
      mutators: PROTO_MUTATORS,
      cursorKeys: { current: old },
    });
    const token = first.snapshot(null, "user:x").cursor;
    const rotated = new SyncServer({
      store,
      clock,
      mutators: PROTO_MUTATORS,
      cursorKeys: { current: randomBytes(32), previous: { key: old, rotatedAt: clock.ms } },
    });
    clock.ms += 30 * DAY - 1;
    t.false("resync" in rotated.pull(null, "user:x", token));
    clock.ms += 1;
    t.true("resync" in rotated.pull(null, "user:x", token));
    // a nested transaction that throws takes back its own writes only
    store.transaction(() => {
      store.setLastRev("kept", 1);
      t.throws(() =>
        store.transaction(() => {
          store.setLastRev("gone", 1);
          throw new Error("inner");
        }),
      );
    });
    t.is(store.lastRev("kept"), 1);
    t.is(store.lastRev("gone"), undefined);
    void MODEL;
  },
);
