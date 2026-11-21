// The client half's reads and registration as the web client's sync wiring
// uses them (`01` Y3, Y7, Y10, R3): `openMany` fetches the rows of one log
// with one `threads` read; an answer to a read of a log dropped meanwhile is
// not applied; a pushed batch older than the log's cursor is not applied;
// Retry is a change of the outbox; a client id issued for another person is
// not used; TOO_MANY_REQUESTS stops the writes behind it.

import { MUTATORS, threadKey, type LogId } from "@session/mutators";
import test from "ava";

import {
  MemoryAdapter,
  SyncClient,
  type ClientEvent,
  type ReadOptions,
  type SyncClientOptions,
  type SyncTransport,
} from "../src/client/index.js";

import { World, cast, ok, post } from "./world.js";

/** A transport that records the reads and can hold the next ones. */
function recorded(w: World, u: string) {
  const base = w.transport(u);
  const state = {
    snapshots: [] as { log: LogId; options: ReadOptions }[],
    pulls: [] as LogId[],
    gate: null as Promise<void> | null,
    registerUser: undefined as string | undefined,
    apply: null as SyncTransport["apply"] | null,
  };
  const transport: SyncTransport = {
    register: async (o) => {
      const r = await base.register(o);
      return r.ok && state.registerUser !== undefined ? { ...r, user: state.registerUser } : r;
    },
    apply: (e) => (state.apply ?? base.apply)(e),
    snapshot: async (log, o) => {
      state.snapshots.push({ log, options: o ?? {} });
      if (state.gate) await state.gate;
      return base.snapshot(log, o);
    },
    pull: async (log, c, o) => {
      state.pulls.push(log);
      if (state.gate) await state.gate;
      return base.pull(log, c, o);
    },
  };
  return { transport, state };
}

const client = (
  w: World,
  u: string,
  transport: SyncTransport,
  o: Partial<SyncClientOptions> = {},
) =>
  new SyncClient(transport, {
    user: u,
    clock: w.clock,
    random: w.random,
    mutators: MUTATORS,
    storage: new MemoryAdapter(),
    ...o,
  });

const events = (c: SyncClient) => {
  const out: ClientEvent[] = [];
  c.onEvent((e) => out.push(e));
  return out;
};

const gate = () => {
  let open: () => void = () => {};
  const p = new Promise<void>((done) => (open = done));
  return { p, open };
};

/** A channel with `n` posts of which the window serves the newest in full. */
function summaries(t: Parameters<typeof cast>[0], n: number) {
  const w = new World({ window: { days: 1, threads: 1, cap: 1 } });
  const { open } = cast(t, w);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    w.clock.advance(1000);
    ids.push(post(t, w, "olga", open, `Post ${i}`));
  }
  return { w, open, ids, log: `space:${open}` as LogId };
}

test("R3: openMany fetches the summary threads of one log with one threads read", async (t) => {
  const { w, ids, log } = summaries(t, 40);
  const { transport, state } = recorded(w, "mona");
  const mona = client(w, "mona", transport);
  await mona.sync(log, "window");
  const held = ids.filter((id) => !mona.replica.isFull(log, id));
  t.is(held.length, 39, "the newest is in full, the others are summaries");
  state.snapshots.length = 0;
  const nowhere = w.id();
  const r = await mona.openMany(log, [...ids, nowhere]);
  t.is(state.snapshots.length, 1, "one read");
  t.like(state.snapshots[0]?.options, { tier: "threads" });
  t.deepEqual(state.snapshots[0]?.options.threads, [...held, nowhere], "only what is not full");
  for (const id of ids) t.is(r.outcomes.get(id), "full");
  t.is(r.outcomes.get(nowhere), "missing");
  t.true(ids.every((id) => mona.replica.isFull(log, id)));
});

test("R3: openMany sends at most 100 ids per read, one read after another", async (t) => {
  const { w, ids, log } = summaries(t, 130);
  const { transport, state } = recorded(w, "mona");
  const mona = client(w, "mona", transport);
  await mona.sync(log, "window");
  state.snapshots.length = 0;
  const r = await mona.openMany(log, ids);
  t.deepEqual(
    state.snapshots.map((s) => s.options.threads?.length),
    [100, 29],
  );
  t.true([...r.outcomes.values()].every((x) => x === "full"));
});

test("R3: openMany offline answers unavailable with the error, and holds nothing", async (t) => {
  const { w, ids, log } = summaries(t, 3);
  const base = w.transport("mona");
  let down = false;
  const transport: SyncTransport = {
    ...base,
    snapshot: (l, o) => {
      if (down) throw Object.assign(new Error("offline"), { retryAfterMs: 5000 });
      return base.snapshot(l, o);
    },
  };
  const mona = client(w, "mona", transport);
  await mona.sync(log, "window");
  down = true;
  const r = await mona.openMany(log, ids.slice(0, 2));
  t.deepEqual([...r.outcomes.values()], ["unavailable", "unavailable"]);
  t.is((r.error as { retryAfterMs?: number }).retryAfterMs, 5000);
});

test("R5: a log dropped while its snapshot is in flight is not applied when it answers", async (t) => {
  const { w, open } = cast(t);
  const { transport, state } = recorded(w, "mona");
  const mona = client(w, "mona", transport);
  const log = `space:${open}` as LogId;
  const g = gate();
  state.gate = g.p;
  const read = mona.sync(log, "summary");
  await new Promise((done) => setImmediate(done));
  mona.dropLog(log);
  g.open();
  t.is(await read, "dropped");
  t.deepEqual(mona.logs(), [], "the log does not come back");

  // a pull, and a read queued behind it, the same way
  state.gate = null;
  await mona.sync(log, "summary");
  const g2 = gate();
  state.gate = g2.p;
  const pull = mona.sync(log);
  const queued = mona.sync(log);
  await new Promise((done) => setImmediate(done));
  mona.dropLog(log);
  g2.open();
  t.is(await pull, "dropped");
  t.is(await queued, "dropped");
  t.deepEqual(mona.logs(), []);
});

test("R5: threads fetched for a log dropped meanwhile are not added back", async (t) => {
  const { w, ids, log } = summaries(t, 3);
  const { transport, state } = recorded(w, "mona");
  const mona = client(w, "mona", transport);
  await mona.sync(log, "window");
  const g = gate();
  state.gate = g.p;
  // the older two are summaries
  const opening = mona.openMany(log, ids.slice(0, 2));
  await new Promise((done) => setImmediate(done));
  mona.dropLog(log);
  g.open();
  const r = await opening;
  t.true([...r.outcomes.values()].every((x) => x !== "full"));
  t.deepEqual(mona.logs(), []);
  t.is(mona.get(threadKey(ids[0] ?? "")), undefined);
});

test("Y7: a pushed batch older than the cursor a pull read is not applied", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const mona = client(w, "mona", w.transport("mona"));
  const log = "user:mona" as LogId;
  await mona.sync(log);
  // the stream opens here
  const base = mona.cursorReadsOf(log);
  const start = mona.cursor(log) ?? "";
  ok(t, w.as("mona", "saved.set", { kind: "thread", id: p, on: true }));
  // the batch the stream computed, delivered late: the save
  const stale = w.server.pull({ u: "mona" }, log, start);
  if ("resync" in stale) throw new Error("resync");
  t.true(stale.changes.some((c) => c.key === `save:mona:${p}` && c.op === "put"));
  ok(t, w.as("mona", "saved.set", { kind: "thread", id: p, on: false }));
  // a pull reads past it: the save is deleted
  t.is(await mona.sync(log), "pull");
  t.is(mona.get(`save:mona:${p}`), undefined);
  const newer = mona.cursor(log);
  t.false(await mona.receive(log, stale, base), "older than the cursor: not applied");
  t.is(mona.get(`save:mona:${p}`), undefined, "the deleted record does not come back");
  t.is(mona.cursor(log), newer, "the cursor does not move back");
  // from a stream opened after the pull, a batch applies
  ok(t, w.as("mona", "saved.set", { kind: "thread", id: p, on: true }));
  const fresh = w.server.pull({ u: "mona" }, log, newer ?? "");
  if ("resync" in fresh) throw new Error("resync");
  t.true(await mona.receive(log, fresh, mona.cursorReadsOf(log)));
  t.like(mona.get(`save:mona:${p}`), { u: "mona" });
});

test("Y10: Retry is a change of the outbox: the write is no longer Not sent while in flight", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const { transport, state } = recorded(w, "otto");
  const otto = client(w, "otto", transport);
  await otto.sync("user:otto");
  await otto.register();
  state.apply = () => {
    throw new Error("offline");
  };
  const save = otto.queue("saved.set", { kind: "thread", id: p, on: true });
  await otto.flush();
  t.is(otto.unsent().length, 1);
  const g = gate();
  const base = w.transport("otto");
  state.apply = async (e) => {
    await g.p;
    return base.apply(e);
  };
  let heard = 0;
  otto.subscribe(() => heard++);
  const retried = otto.retry(save.local);
  t.true(heard >= 1, "subscribers hear of it");
  t.deepEqual(otto.unsent(), [], "not Not sent while in flight");
  t.false(otto.discard(save.local), "nothing to discard while in flight");
  g.open();
  await retried;
  t.like(w.get(`save:otto:${p}`), { u: "otto" });
  t.deepEqual(await otto.retry(save.local), [], "a write that is not Not sent: at once");
});

test("Y3: a client id the server issued for another person is not used", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  // the session is olga's now: register answers with her id
  const { transport, state } = recorded(w, "olga");
  state.registerUser = "olga";
  const otto = client(w, "otto", transport);
  const seen = events(otto);
  const reply = w.id();
  otto.write("research.createPostFollowUp", { id: reply, thread: p, t: "typed by otto" });
  await otto.flush();
  t.is(w.get(`reply:${reply}`), undefined, "nothing applied as olga");
  t.true(otto.sessionChanged);
  t.is(otto.clientId, null);
  t.deepEqual(
    seen.map((e) => e.type),
    ["user", "unsent"],
    "no client event: the tab keeps no id",
  );
  t.like(seen[0], { type: "user", user: "olga" });
  t.like(otto.unsent()[0], { name: "research.createPostFollowUp" });
  // nothing more is sent, nor registered
  const sent = otto.sent.length;
  await otto.retry(otto.unsent()[0]?.local ?? "");
  t.is(otto.sent.length, sent);
  t.is(await otto.register(), null);
});

test("Y3: without a user in the answer, whoAmI is asked before a write is sent under a new id", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const { transport } = recorded(w, "olga");
  let asked = 0;
  const otto = client(w, "otto", transport, {
    whoAmI: () => {
      asked += 1;
      return Promise.resolve("olga");
    },
  });
  const reply = w.id();
  otto.write("research.createPostFollowUp", { id: reply, thread: p, t: "typed by otto" });
  await otto.flush();
  t.is(asked, 1);
  t.is(w.get(`reply:${reply}`), undefined);
  t.true(otto.sessionChanged);

  // the same person: the id is used
  const { transport: own } = recorded(w, "mel");
  const mel = client(w, "mel", own, { whoAmI: () => Promise.resolve("mel") });
  const r2 = w.id();
  mel.write("research.createPostFollowUp", { id: r2, thread: p, t: "mine" });
  await mel.flush();
  t.like(w.get(`reply:${r2}`), { u: "mel" });
  t.false(mel.sessionChanged);
});

test("Y3: WRONG_CLIENT on a write registers again, then checks the person before resending", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  // otto's tab holds his id; the cookie is olga's now
  const ottoId = w.clientId("otto");
  const { transport, state } = recorded(w, "olga");
  state.registerUser = "olga";
  const otto = client(w, "otto", transport, { clientId: ottoId });
  const seen = events(otto);
  const reply = w.id();
  otto.write("research.createPostFollowUp", { id: reply, thread: p, t: "typed by otto" });
  await otto.flush();
  t.is(w.get(`reply:${reply}`), undefined);
  t.false(
    seen.some((e) => e.type === "client"),
    "the new id is not kept",
  );
  t.true(seen.some((e) => e.type === "user"));
  t.is(otto.unsent().length, 1);
});

test("Y3: reregister drops the id and registers a new one", async (t) => {
  const { w } = cast(t);
  const mona = client(w, "mona", w.transport("mona"));
  const first = await mona.register();
  const seen = events(mona);
  const second = await mona.reregister();
  t.truthy(second);
  t.not(second, first);
  t.like(seen[0], { type: "client", clientId: second });
});

test("Y10: TOO_MANY_REQUESTS leaves the write and the ones behind it Not sent, without sending them", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const { transport, state } = recorded(w, "otto");
  const otto = client(w, "otto", transport);
  await otto.register();
  let applies = 0;
  state.apply = () => {
    applies += 1;
    return {
      ok: false,
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Slow down.",
        serverTime: w.clock.now(),
        retryAfterMs: 30_000,
      },
    };
  };
  otto.queue("saved.set", { kind: "thread", id: p, on: true });
  otto.queue("research.createPostFollowUp", { id: w.id(), thread: p, t: "a" });
  otto.queue("research.createPostFollowUp", { id: w.id(), thread: p, t: "b" });
  await otto.flush();
  t.is(applies, 1);
  t.is(otto.unsent().length, 3);
  t.deepEqual(otto.pending(), []);
});

test("Y10: the queue policy waits the Retry-After the server named", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const { transport, state } = recorded(w, "otto");
  const otto = client(w, "otto", transport, { policy: "queue" });
  await otto.register();
  state.apply = () => ({
    ok: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Slow down.",
      serverTime: w.clock.now(),
      retryAfterMs: 120_000,
    },
  });
  const save = otto.queue("saved.set", { kind: "thread", id: p, on: true });
  await otto.flush();
  t.is(otto.pending()[0]?.local, save.local);
  t.is((otto.pending()[0]?.notBefore ?? 0) - otto.now(), 120_000);
});
