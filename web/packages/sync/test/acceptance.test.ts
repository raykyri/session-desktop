// The M2 exit's acceptance cases that the review asked to have in this
// package (M2 review 22-25): rollback with a listener, the window's
// boundaries, the queue policy's backoff, failure and drop, re-attach timing
// and the recorded queue_full refusal.

import { MUTATORS } from "@session/mutators";
import test from "ava";

import {
  MAX_SERVER_ERRORS,
  MemoryAdapter,
  OUTBOX_TTL,
  RETRY_MAX,
  RETRY_MIN,
  SyncClient,
  claimClientId,
  type ApplyResult,
  type SyncTransport,
} from "../src/client/index.js";
import { PROTOCOL_VERSION } from "../src/server/index.js";

import { DAY, MINUTE, MODEL, World, actor, cast, ok, post } from "./world.js";

const client = (
  w: World,
  u: string,
  transport: SyncTransport = w.transport(u),
  policy: "in-flight" | "queue" = "in-flight",
) =>
  new SyncClient(transport, {
    user: u,
    clock: w.clock,
    random: w.random,
    mutators: MUTATORS,
    storage: new MemoryAdapter(),
    policy,
  });

const codes = (rs: ApplyResult[]) => rs.map((r) => (r.ok ? "ok" : r.error.code));

test("22: a refused thread and the reply under it both roll back, and a listener hears it", async (t) => {
  const { w, open } = cast(t);
  const otto = client(w, "otto");
  await otto.sync(`space:${open}`);
  await otto.sync("user:otto");
  ok(t, w.as("olga", "members.ban", { space: open, user: "otto" }));
  const heard: string[][] = [];
  otto.subscribe((changed) => heard.push([...changed]));
  const th = otto.newId();
  otto.queue("threads.create", { id: th, space: open, kind: "post", q: "mine" });
  const reply = otto.newId();
  otto.queue("research.createPostFollowUp", { id: reply, thread: th, t: "under it" });
  t.truthy(otto.get(`thread:${th}`));
  t.truthy(otto.get(`reply:${reply}`));
  heard.length = 0;
  // the thread is refused, so the reply's thread is not found
  t.deepEqual(codes(await otto.flush()), ["FORBIDDEN", "NOT_FOUND"]);
  t.is(otto.get(`thread:${th}`), undefined);
  t.is(otto.get(`reply:${reply}`), undefined);
  t.true(heard.some((keys) => keys.includes(`thread:${th}`)));
  t.true(heard.some((keys) => keys.includes(`reply:${reply}`)));
  // a Not sent write read, then discarded: gone from the view
  const down = { ...w.transport("mona"), apply: () => Promise.reject(new Error("offline")) };
  const mona = client(w, "mona", down);
  await mona.sync(`space:${open}`);
  const p = post(t, w, "mel", open);
  await mona.sync(`space:${open}`);
  const r = mona.write("research.createPostFollowUp", { id: mona.newId(), thread: p, t: "x" });
  await mona.flush();
  t.like(mona.get(`counts:${p}`), { r: 1 });
  mona.discard(r.local);
  t.like(mona.get(`counts:${p}`), { r: 0 });
});

test("23: the window's boundaries at 30, 90 and 730 days", (t) => {
  const at = (days: number, threads: number) => {
    const w = new World({ window: { days, threads, cap: 500 } });
    const c = cast(t, w);
    return { ...c, w };
  };
  const full = (w: World, sp: string, u: string, th: string) =>
    w.server.snapshot(actor(u), `space:${sp}`, { tier: "window" }).full?.includes(th) ?? false;
  const served = (w: World, sp: string, th: string) =>
    w.server
      .snapshot(actor("mona"), `space:${sp}`, { tier: "window" })
      .records.some((x) => x.key === `thread:${th}`);
  // the last 30 days
  {
    const { w, open } = at(30, 0);
    const p = post(t, w, "otto", open);
    w.clock.advance(30 * DAY);
    t.true(full(w, open, "mona", p), "30 days old: in the window");
    w.clock.advance(1);
    t.false(full(w, open, "mona", p), "30 days and 1 ms: a summary");
  }
  // the reader's own threads, 90 days
  {
    const { w, open } = at(1, 0);
    const p = post(t, w, "mona", open);
    w.clock.advance(90 * DAY);
    t.true(full(w, open, "mona", p));
    w.clock.advance(1);
    t.false(full(w, open, "mona", p));
  }
  // summaries, 2 years
  {
    const { w, open } = at(1, 0);
    const p = post(t, w, "otto", open);
    w.clock.advance(730 * DAY);
    t.true(served(w, open, p));
    w.clock.advance(1);
    t.false(served(w, open, p));
  }
  // the newest threads when they are more than the recent ones
  {
    const { w, open } = at(1, 3);
    const ids: string[] = [];
    for (let k = 0; k < 5; k++) {
      ids.push(post(t, w, "otto", open, `t${k}`));
      w.clock.advance(1000);
    }
    w.clock.advance(2 * DAY);
    const recent = post(t, w, "otto", open, "recent");
    const snap = w.server.snapshot(actor("mona"), `space:${open}`, { tier: "window" });
    t.deepEqual([...(snap.full ?? [])].sort(), [recent, ids[4] ?? "", ids[3] ?? ""].sort());
  }
});

test("23: a window client keeps an opened thread full across snapshots, holds a pulled thread's reply, and predicts a summary thread's write unknown", async (t) => {
  const w = new World({ window: { days: 1, threads: 1, cap: 1 } });
  const { open } = cast(t, w);
  const old = post(t, w, "mel", open);
  w.clock.advance(2 * DAY);
  post(t, w, "mel", open);
  const mona = client(w, "mona");
  await mona.sync(`space:${open}`, "window");
  const r = mona.queue("research.createPostFollowUp", { id: mona.newId(), thread: old, t: "x" });
  t.is(mona.prediction(r.local), "unknown");
  mona.drop(r.mutationId);
  t.is(await mona.open(old), "full");
  mona.dropLog(`space:${open}`);
  await mona.sync(`space:${open}`, "window");
  t.true(mona.replica.isFull(`space:${open}`, old), "the opened thread is sent again");
  // a new thread and a reply to it arrive by a pull
  const fresh = post(t, w, "otto", open);
  const reply = w.id();
  ok(t, w.as("mel", "research.createPostFollowUp", { id: reply, thread: fresh, t: "hi" }));
  await mona.sync(`space:${open}`);
  t.truthy(mona.get(`reply:${reply}`));
});

/** A transport that answers INTERNAL_SERVER_ERROR to one mutator. */
function failing(w: World, u: string, name: string) {
  const base = w.transport(u);
  return {
    ...base,
    apply: (e) =>
      e.name === name
        ? {
            ok: false,
            error: { code: "INTERNAL_SERVER_ERROR", message: "bug", serverTime: w.clock.now() },
          }
        : base.apply(e),
  } satisfies SyncTransport;
}

test("24: the queue policy backs off 1 s to 10 minutes, fails a write after 5 errors and sends the writes behind it", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const mel = client(w, "mel", failing(w, "mel", "saved.set"), "queue");
  mel.queue("saved.set", { kind: "thread", id: p, on: true });
  const reply = mel.newId();
  mel.queue("research.createPostFollowUp", { id: reply, thread: p, t: "behind it" });
  const waits: number[] = [];
  for (let k = 0; k < MAX_SERVER_ERRORS; k++) {
    const res = await mel.flush();
    t.is(codes(res)[0], "INTERNAL_SERVER_ERROR");
    // not sent again before its wait
    const before = mel.sent.length;
    await mel.flush();
    if (k < MAX_SERVER_ERRORS - 1) t.is(mel.sent.length, before, "waits out its backoff");
    const wait = Math.min(RETRY_MAX, RETRY_MIN * 2 ** k);
    waits.push(wait);
    w.clock.advance(wait);
  }
  t.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  t.deepEqual(
    mel.problems().map((x) => x.reason),
    ["FAILED"],
  );
  t.truthy(w.get(`reply:${reply}`), "the write behind it was sent");
  t.deepEqual(mel.pending(), []);
});

test("24: the queue policy drops a write still queued 3 days after it was queued, and shows it", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const down = { ...w.transport("mel"), apply: () => Promise.reject(new Error("offline")) };
  const mel = client(w, "mel", down, "queue");
  mel.queue("saved.set", { kind: "thread", id: p, on: true });
  await mel.flush();
  w.clock.advance(OUTBOX_TTL - 1);
  await mel.flush();
  t.is(mel.pending().length, 1);
  w.clock.advance(2);
  await mel.flush();
  t.deepEqual(
    mel.problems().map((x) => [x.reason, x.sent]),
    [["DROPPED", true]],
  );
  t.deepEqual(mel.pending(), []);
  t.is(w.get(`save:mel:${p}`), undefined);
});

test("25: a re-attach counts as use: re-attached at day 6, the id applies at day 8", (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const r = w.server.register(actor("otto"));
  if (!r.ok) return t.fail();
  w.clock.advance(6 * DAY);
  t.true(w.server.register(actor("otto"), { clientId: r.clientId }).ok);
  w.clock.advance(2 * DAY);
  const now = w.clock.now();
  ok(
    t,
    w.server.apply(actor("otto"), {
      clientId: r.clientId,
      seq: 1,
      mutationId: w.id(),
      name: "saved.set",
      input: { kind: "thread", id: p, on: true },
      protocolVersion: PROTOCOL_VERSION,
      clientTime: now,
      queuedAt: now,
    }),
  );
});

test("25: a client built from a re-attached id sends the next seq first", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const items = new Map<string, string>();
  const storage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
  const locks = {
    request: (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) => cb({}),
  };
  const register = (o?: { clientId?: string }) =>
    Promise.resolve(w.server.register(actor("otto"), o));
  const first = await claimClientId({ userId: "otto", storage, locks, register });
  if ("error" in first) return t.fail();
  const a = new SyncClient(w.transport("otto"), {
    user: "otto",
    clock: w.clock,
    mutators: MUTATORS,
    clientId: first.clientId,
    lastSeq: first.lastSeq,
  });
  a.queue("saved.set", { kind: "thread", id: p, on: true });
  await a.flush();
  // a reload: re-attached with its last seq
  const again = await claimClientId({ userId: "otto", storage, locks, register });
  if ("error" in again) return t.fail();
  t.true(again.reattached);
  t.is(again.lastSeq, 1);
  const b = new SyncClient(w.transport("otto"), {
    user: "otto",
    clock: w.clock,
    mutators: MUTATORS,
    clientId: again.clientId,
    lastSeq: again.lastSeq,
  });
  b.queue("saved.set", { kind: "thread", id: p, on: false });
  t.deepEqual(codes(await b.flush()), ["ok"]);
  t.deepEqual(
    b.sent.map((e) => e.seq),
    [2],
  );
});

test("25: a queue_full refusal is recorded: after a slot is freed, a resend gets it again", (t) => {
  const { w, open } = cast(t);
  const asks: string[] = [];
  for (let k = 0; k < 20; k++) {
    const id = w.id();
    asks.push(id);
    ok(t, w.as("mel", "threads.create", { id, space: open, kind: "ask", q: `q${k}`, ...MODEL }));
  }
  const e = w.envelope("mel", "threads.create", {
    id: w.id(),
    space: open,
    kind: "ask",
    q: "one more",
    ...MODEL,
  });
  const first = w.server.apply(actor("mel"), e);
  t.like(first, { ok: false, error: { reason: "queue_full" } });
  // a slot is freed: a run is cancelled
  ok(t, w.as("mel", "research.cancelNode", { thread: asks[0], node: "r" }));
  w.clock.advance(MINUTE);
  const again = w.server.apply(actor("mel"), { ...e, clientTime: w.clock.now() });
  t.like(again, { ok: false, error: { code: "PRECONDITION_FAILED", reason: "queue_full" } });
});
