// The client half: the replica and its working set, prediction and rebase,
// the outbox's rules, scope changes and frozen copies, queries, the storage
// adapters and both transports.

import { DatabaseSync } from "node:sqlite";

import test from "ava";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  FetchTransport,
  InProcessTransport,
  MemoryStorage,
  OUTBOX_TTL,
  SqliteStorage,
  SyncClient,
  type Answer,
  type Envelope,
  type SqliteDriver,
  type StorageAdapter,
  type Transport,
} from "../src/client/index.js";
import { useQuery } from "../src/react.js";
import { openStream } from "../src/server/index.js";

import { DAY, MINUTE, World, cast, ok, rng } from "./helpers.js";
import { httpFetch } from "./http.js";

/** A client of `u` on `w`'s server, in process, with the server's clock. */
function client(
  w: World,
  u: string,
  o: { storage?: StorageAdapter; transport?: Transport; seed?: number } = {},
) {
  return new SyncClient({
    user: u,
    transport:
      o.transport ??
      new InProcessTransport(
        w.server,
        { u },
        {
          stream: (a, c, s) =>
            openStream(w.server, a, c, s, { setInterval: () => 0, clearInterval: () => {} }),
        },
      ),
    clock: w.clock,
    random: rng(o.seed ?? 7),
    ...(o.storage ? { storage: o.storage } : {}),
  });
}

/** A transport that answers the next `n` pushes with `code` (or none). */
class Forced implements Transport {
  queue: (Answer | null | "pass")[] = [];
  pushes: Envelope[] = [];
  constructor(private readonly inner: Transport) {}
  register = () => this.inner.register();
  pull: Transport["pull"] = (l, c, o) => this.inner.pull(l, c, o);
  snapshot: Transport["snapshot"] = (l, o) => this.inner.snapshot(l, o);
  listen: Transport["listen"] = (c, e, s) => this.inner.listen(c, e, s);
  call: Transport["call"] = (n, i) => this.inner.call(n, i);
  async push(es: readonly Envelope[]) {
    const out: (Answer | null)[] = [];
    for (const e of es) {
      this.pushes.push(e);
      const f = this.queue.length ? this.queue.shift() : "pass";
      if (f === "pass") out.push(...(await this.inner.push([e])));
      else out.push(f);
      if (out.at(-1) === null) break;
    }
    return out;
  }
}
const fail = (code: string, serverTime = 0, extra: object = {}): Answer =>
  ({ ok: false, error: { code, message: code, ...extra }, serverTime }) as Answer;

test("a write is predicted at once, confirmed by the server, and leaves the outbox once pulled", async (t) => {
  const { w, open } = cast(t);
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.open("user:mel");
  const th = w.id();
  const titles = mel.query((v) => v.list("thread").map((p) => p.q));
  const seen: string[][] = [];
  titles.subscribe(() => seen.push(titles.get()));
  // offline: the write waits, predicted
  const offline = new Forced(new InProcessTransport(w.server, { u: "mel" }));
  void offline;
  const { answer } = mel.write("threads.create", { id: th, space: open, kind: "post", q: "Hello" });
  t.deepEqual(titles.get(), ["Hello"]);
  t.true(mel.view().pending(`thread:${th}`));
  t.like(await answer, { ok: true });
  // answered, not yet pulled: still in the overlay, no flicker
  t.deepEqual(titles.get(), ["Hello"]);
  await mel.sync();
  t.false(mel.view().pending(`thread:${th}`));
  t.deepEqual(mel.outbox(), []);
  t.like(mel.view().get("thread", th) ?? {}, { q: "Hello", u: "mel", rev: 1 });
  t.true(
    seen.every((x) => x.length === 1 && x[0] === "Hello"),
    JSON.stringify(seen),
  );
});

test("a write the replica cannot predict is pending without a prediction; derived ids are known to be free", async (t) => {
  const { w, open } = cast(t);
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.open("user:mel");
  // offline: nothing is sent
  const off = client(w, "mel", {
    transport: new Forced(new InProcessTransport(w.server, { u: "mel" })),
  });
  void off;
  const th = w.id();
  const tr = new Forced(new InProcessTransport(w.server, { u: "mel" }));
  tr.queue = [null, null, null, null, null];
  const c = client(w, "mel", { transport: tr });
  await c.init();
  await c.open(`space:${open}`);
  await c.open("user:mel");
  c.write("threads.create", { id: th, space: open, kind: "ask", q: "Q" });
  // the ask's run has an id derived from the mutation id: predicted, not unknown
  t.is(c.outbox()[0]?.prediction, "ok");
  t.true(
    c
      .view()
      .list("run")
      .some((r) => r.th === th),
  );
  // an invite link's code is the server's (pre): unknown, for a moderator
  // who may make one (mel may not: refused)
  c.write("invites.create", { id: w.id(), space: open });
  t.is(c.outbox()[1]?.prediction, "refused");
  const mona = client(w, "mona", { transport: tr });
  await mona.init();
  await mona.open(`space:${open}`);
  await mona.open("user:mona");
  tr.queue = [null];
  mona.write("invites.create", { id: w.id(), space: open });
  t.is(mona.outbox()[0]?.prediction, "unknown");
});

test("rebase: confirmed changes arrive under pending writes, which run again on top", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("otto", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const tr = new Forced(new InProcessTransport(w.server, { u: "mel" }));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  await mel.open(`space:${open}`);
  await mel.open("user:mel");
  tr.queue = [null, null, null, null, null];
  mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  t.is(mel.view().get("counts", th)?.likes, 1);
  // otto likes it too, mel pulls: the confirmed count is 1, mel's pending like on top makes 2
  ok(t, w.as("mona", "likes.set", { thread: th, on: true }));
  await mel.sync();
  t.is(mel.view().get("counts", th)?.likes, 2);
  t.true(mel.view().pending(`counts:${th}`));
});

test("outbox: backoff on transient answers, failed after 5 and shown, and the writes after it go on", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("otto", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const tr = new Forced(new InProcessTransport(w.server, { u: "mel" }));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  tr.queue = [fail("SERVICE_UNAVAILABLE"), fail("INTERNAL_SERVER_ERROR")];
  const first = mel.write("likes.set", { thread: th, on: true });
  mel.write("saved.set", { kind: "thread", id: th, on: true });
  await mel.flush();
  const e = mel.outbox()[0];
  t.like(e ?? {}, { state: "queued", tries: 1 });
  t.is((e?.next ?? 0) - w.clock.now(), 1000, "1 s after the first");
  w.clock.advance(1000);
  await mel.flush();
  t.is((mel.outbox()[0]?.next ?? 0) - w.clock.now(), 2000, "2 s after the second");
  t.is(w.get(`save:mel:${th}`), undefined, "the outbox pauses: the write after it waits");
  // three more: failed, shown, and the save is sent
  tr.queue = [null, fail("TOO_MANY_REQUESTS"), fail("SERVICE_UNAVAILABLE")];
  for (let k = 0; k < 3; k++) {
    w.clock.advance(10 * MINUTE);
    await mel.flush();
  }
  t.like(mel.problems()[0] ?? {}, { state: "failed", tries: 5, uncertain: true });
  t.is(await first.answer, null);
  t.truthy(w.get(`save:mel:${th}`));
  // TOO_MANY_REQUESTS with retryAt waits until then
  tr.queue = [
    fail("TOO_MANY_REQUESTS", 0, { retryAt: new Date(w.clock.now() + 3 * MINUTE).toISOString() }),
  ];
  mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  t.is(mel.outbox().find((x) => x.state === "queued")?.next, w.clock.now() + 3 * MINUTE);
});

test("outbox: Send again remints with replaces, and a write the server applied under its old id applies once", async (t) => {
  const { w, open } = cast(t);
  const inner = new InProcessTransport(w.server, { u: "mel" });
  // the first envelope is applied and its answer lost; then no server
  let mode: "applyLose" | "down" | "up" = "applyLose";
  const flaky: Transport = {
    register: () => inner.register(),
    pull: (l, c, o) => inner.pull(l, c, o),
    snapshot: (l, o) => inner.snapshot(l, o),
    listen: (c, e, s) => inner.listen(c, e, s),
    call: (n, i) => inner.call(n, i),
    push: async (es) => {
      if (mode === "up") return inner.push(es);
      if (mode === "applyLose") {
        await inner.push(es);
        mode = "down";
      }
      return [null];
    },
  };
  const c = client(w, "mel", { transport: flaky });
  await c.init();
  const th = c.newId();
  c.write("threads.create", { id: th, space: open, kind: "post", q: "once" });
  for (let k = 0; k < 5; k++) {
    await c.flush();
    w.clock.advance(11 * MINUTE);
  }
  const failed = c.problems()[0];
  t.like(failed ?? {}, { state: "failed", tries: 5, uncertain: true });
  const old = failed?.mutationId ?? "";
  mode = "up";
  t.true(c.sendAgain(failed?.local ?? ""));
  const again = c.outbox()[0];
  t.deepEqual(again?.replaces, [old]);
  t.not(again?.mutationId, old);
  await c.flush();
  const threads = [...w.server.records().values()].filter(
    (r) => r.kind === "thread" && r.q === "once",
  );
  t.is(threads.length, 1);
  t.like(c.outbox()[0] ?? {}, { state: "answered" });
});

test("outbox: EXPIRED and a write dropped after 3 days are shown; UPDATE_REQUIRED holds it and every write after it", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("otto", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const tr = new Forced(new InProcessTransport(w.server, { u: "mel" }));
  const mel = client(w, "mel", { transport: tr });
  await mel.init();
  tr.queue = [fail("EXPIRED", w.clock.now())];
  mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  t.like(mel.problems()[0] ?? {}, { state: "expired" });
  // offline for 3 days: dropped, never sent
  const down = { on: true };
  const off = new InProcessTransport(
    w.server,
    { u: "mel" },
    {
      net: { plan: () => ({}), wait: () => Promise.resolve(), down: () => down.on },
    },
  );
  const c = client(w, "mel", { transport: off });
  await c.init();
  c.write("likes.set", { thread: th, on: true });
  await c.flush();
  w.clock.advance(OUTBOX_TTL);
  down.on = false;
  await c.flush();
  t.like(c.problems()[0] ?? {}, { state: "dropped" });
  t.is(w.get(`like:mel:${th}`), undefined);
  // UPDATE_REQUIRED: this write and the ones after it wait for the update
  tr.queue = [fail("UPDATE_REQUIRED")];
  mel.write("likes.set", { thread: th, on: true });
  mel.write("saved.set", { kind: "thread", id: th, on: true });
  await mel.flush();
  t.true(mel.updateRequired);
  t.deepEqual(
    mel
      .outbox()
      .filter((e) => e.state === "held")
      .map((e) => e.name),
    ["likes.set", "saved.set"],
  );
  await mel.updated();
  t.truthy(w.get(`like:mel:${th}`));
  t.truthy(w.get(`save:mel:${th}`));
});

test("outbox: CLOCK_SKEW sets an offset that persists, and remints the never-sent writes with replaces", async (t) => {
  const { w, open } = cast(t);
  const storage = new MemoryStorage();
  const fast = { now: () => w.clock.now() + 2 * MINUTE };
  const mk = () =>
    new SyncClient({
      user: "mel",
      transport: new InProcessTransport(w.server, { u: "mel" }),
      clock: fast,
      random: rng(3),
      storage,
    });
  const mel = mk();
  await mel.init();
  const th = mel.newId();
  const f = mel.newId();
  mel.write("threads.create", { id: th, space: open, kind: "ask", q: "Q" });
  // a later write names the first write's id: it is reminted to match
  mel.write("followups.ask", { id: f, thread: th, q: "F" });
  await mel.flush();
  t.is(mel.offset, -2 * MINUTE);
  const created = [...w.server.records().values()].find((r) => r.kind === "thread" && r.q === "Q");
  t.truthy(created);
  t.not(created?.kind === "thread" ? created.id : th, th, "the input's id was reminted");
  t.truthy(
    [...w.server.records().values()].find(
      (r) => r.kind === "followup" && r.q === "F" && r.th === (created as { id: string }).id,
    ),
  );
  const again = mk();
  await again.init();
  t.is(again.offset, -2 * MINUTE, "the offset was stored");
});

test("outbox: OUT_OF_ORDER resends with the expected seq; WRONG_CLIENT registers again", async (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  ok(t, w.as("otto", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  const mel = client(w, "mel");
  await mel.init();
  mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  // another device of mel's used this client id's next seq (a restored copy)
  const id = mel.clientId ?? "";
  ok(
    t,
    w.server.apply(
      { u: "mel" },
      {
        ...w.envelope("mel", "saved.set", { kind: "thread", id: th, on: true }),
        clientId: id,
        seq: 2,
      },
    ),
  );
  mel.write("likes.set", { thread: th, on: false });
  await mel.flush();
  t.is(w.get(`like:mel:${th}`), undefined);
  // the client record expires: register again
  w.clock.advance(91 * DAY);
  mel.write("likes.set", { thread: th, on: true });
  await mel.flush();
  t.not(mel.clientId, id);
  t.truthy(w.get(`like:mel:${th}`));
});

test("scope: a lost membership resyncs; a closed space becomes a frozen copy of the user's own threads", async (t) => {
  const { w, closed } = cast(t);
  const mine = w.id();
  const theirs = w.id();
  ok(t, w.as("mel", "threads.create", { id: mine, space: closed, kind: "post", q: "mine" }));
  ok(t, w.as("olga", "threads.create", { id: theirs, space: closed, kind: "post", q: "theirs" }));
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
  t.truthy(mel.view().get("thread", mine));
  t.is(mel.view().get("thread", theirs), undefined);
  // still deletable
  const { answer } = mel.write("threads.delete", { id: mine });
  t.like(await answer, { ok: true });
  t.is(mel.view().get("thread", mine), undefined);
  // let in again: the log is live again
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
  await mel.sync();
  t.false(mel.isFrozen(`space:${closed}`));
  t.truthy(mel.view().get("thread", theirs));
});

test("live updates: a poke pulls the log", async (t) => {
  const { w, open } = cast(t);
  const otto = client(w, "otto");
  await otto.init();
  await otto.open(`space:${open}`);
  const ctl = new AbortController();
  const done = otto.listen(ctl.signal);
  const th = w.id();
  ok(t, w.as("mel", "threads.create", { id: th, space: open, kind: "post", q: "news" }));
  for (let k = 0; k < 50 && !otto.view().get("thread", th); k++)
    await new Promise((r) => setTimeout(r, 5));
  t.truthy(otto.view().get("thread", th));
  ctl.abort();
  await done;
});

/** `SqliteDriver` over Node's SQLite, as Tauri's plugin is shaped. */
function nodeSqlite(): SqliteDriver {
  const db = new DatabaseSync(":memory:");
  return {
    execute: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
      return Promise.resolve();
    },
    select: <T>(sql: string, params: unknown[] = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as never[])) as T[]),
  };
}

test("storage: the SQLite adapter keeps the replica, the outbox and the meta across a restart", async (t) => {
  const { w, open } = cast(t);
  const storage = new SqliteStorage(nodeSqlite());
  const down = { on: false };
  const tr = () =>
    new InProcessTransport(
      w.server,
      { u: "mel" },
      { net: { plan: () => ({}), wait: () => Promise.resolve(), down: () => down.on } },
    );
  const a = client(w, "mel", { storage, transport: tr() });
  await a.init();
  await a.open(`space:${open}`);
  await a.open("user:mel");
  const th = w.id();
  ok(t, w.as("otto", "threads.create", { id: th, space: open, kind: "post", q: "P" }));
  down.on = true;
  a.write("likes.set", { thread: th, on: true });
  await a.flush();
  await new Promise((r) => setTimeout(r, 10));
  // a new process: the stored log and outbox come back; the write is sent
  const b = client(w, "mel", { storage, transport: tr() });
  await b.init();
  t.deepEqual(
    b.outbox().map((e) => e.name),
    ["likes.set"],
  );
  await b.open(`space:${open}`);
  t.truthy(b.records(`space:${open}`).get(`space:${open}`), "loaded from storage, not the server");
  down.on = false;
  await b.flush();
  await b.sync();
  t.truthy(w.get(`like:mel:${th}`));
  t.is(b.view().get("counts", th)?.likes, 1);
  // another person's stored state is not used
  const c = client(w, "otto", { storage, transport: tr() });
  await c.init();
  t.deepEqual(c.outbox(), []);
});

test("fetch transport: bearer token, the protocol header, SSE, and Update Session", async (t) => {
  const { w, open } = cast(t);
  const s = w.server.call(null, "devices.authorize", { name: "Mac" });
  const request = s.ok ? (s.result as { request: string }).request : "";
  w.server.call({ u: "mel" }, "devices.approve", { request });
  const tok = w.server.call(null, "devices.token", { request });
  const token = tok.ok ? (tok.result as { token: string }).token : "";
  let min = 4;
  let updates = 0;
  const transport = new FetchTransport({
    baseUrl: "https://session.test",
    token: () => token,
    fetch: httpFetch(w.server, { minProtocol: () => min }),
    onUpdateRequired: () => void updates++,
    reconnectMs: 1,
  });
  const mel = client(w, "mel", { transport });
  await mel.init();
  await mel.open(`space:${open}`);
  const th = mel.newId();
  const { answer } = mel.write("threads.create", {
    id: th,
    space: open,
    kind: "post",
    q: "over HTTP",
  });
  t.like(await answer, { ok: true });
  t.like(w.get(`thread:${th}`) ?? {}, { u: "mel" });
  // SSE over fetch
  const ctl = new AbortController();
  const done = mel.listen(ctl.signal);
  const other = w.id();
  ok(t, w.as("otto", "threads.create", { id: other, space: open, kind: "post", q: "poke" }));
  for (let k = 0; k < 100 && !mel.view().get("thread", other); k++)
    await new Promise((r) => setTimeout(r, 5));
  t.truthy(mel.view().get("thread", other));
  ctl.abort();
  await done;
  // the server's minimum moves up: Update Session
  min = 5;
  mel.write("likes.set", { thread: other, on: true });
  await mel.flush();
  t.true(updates > 0);
  t.true(mel.updateRequired);
});

test("queries: subscribe hears a change of the result only; useQuery renders without the DOM", async (t) => {
  const { w, open } = cast(t);
  const mel = client(w, "mel");
  await mel.init();
  await mel.open(`space:${open}`);
  const q = mel.query((v) => v.list("thread").length);
  let calls = 0;
  q.subscribe(() => calls++);
  // a change that is not a thread's: the result is the same
  ok(t, w.as("olga", "spaces.update", { id: open, set: { desc: "not a thread" } }));
  await mel.sync();
  t.is(calls, 0);
  ok(t, w.as("otto", "threads.create", { id: w.id(), space: open, kind: "post", q: "one" }));
  await mel.sync();
  t.is(calls, 1);
  t.is(q.get(), 1);
  const html = renderToString(createElement(() => createElement("b", null, String(useQuery(q)))));
  t.is(html, "<b>1</b>");
});
