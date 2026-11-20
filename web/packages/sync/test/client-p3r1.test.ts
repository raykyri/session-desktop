// The client half's findings of review round 1 of phase 3 (reviewer A):
// a stopped client sends, registers and stores nothing more (finding 1,
// the reviewer's sign-out experiment); a registration answered for another
// person is not taken (finding 1); a storage that failed to open is opened
// again on the next call (finding 7, the reviewer's experiment); a closed
// storage refuses later writes (finding 1); and the replica's schema
// version (finding 13).

import test from "ava";

import {
  InProcessTransport,
  MemoryStorage,
  NO_RESPONSE,
  SqliteStorage,
  StorageClosed,
  CLIENT_SCHEMA_VERSION,
  type ClientMeta,
  type Envelope,
  type PushResult,
  type SqlStatement,
  type Transport,
} from "../src/client/index.js";

import { client, fail, nodeSqlite, sleep, tick, watched } from "./client-helpers.js";
import { cast } from "./helpers.js";

/** A storage that records its writes. */
class Recorded extends MemoryStorage {
  readonly writes: string[] = [];
  override saveMeta(m: ClientMeta) {
    this.writes.push("meta");
    return super.saveMeta(m);
  }
  override saveOutbox(e: readonly unknown[]) {
    this.writes.push(`outbox:${e.length}`);
    return super.saveOutbox(e);
  }
  override saveLog(...a: Parameters<MemoryStorage["saveLog"]>) {
    this.writes.push(`log:${a[0]}`);
    return super.saveLog(...a);
  }
  override clear() {
    this.writes.push("clear");
    return super.clear();
  }
}

test("finding 1: a client stopped while a write is on the wire sends, registers and stores nothing more", async (t) => {
  const { w } = cast(t);
  const storage = new Recorded();
  let release: (() => void) | null = null;
  const pushes: Envelope[] = [];
  let registers = 0;
  const inner = new InProcessTransport(w.server, { u: "mel" });
  const transport: Transport = {
    ...watched(inner, {
      push: async (es, next) => {
        pushes.push(...es);
        const a = await next();
        // the first write's answer is slow to arrive
        if (pushes.length === 1) await new Promise<void>((r) => (release = r));
        return a;
      },
    }),
    register: () => (registers++, inner.register()),
  };
  const c = client(w, "mel", { storage, transport, persist: true });
  await c.init();
  c.write("profile.update", { name: "Mel one", bio: "" });
  c.write("profile.update", { name: "Mel's second write", bio: "" });
  for (let k = 0; k < 100 && release === null; k++) await tick();
  t.truthy(release, "the first write is on the wire");
  t.is(registers, 1);
  // the person signs out: the client stops, and storage is cleared
  c.stop();
  await storage.clear();
  const n = storage.writes.length;
  (release as unknown as () => void)();
  await sleep(50);
  // the second write was never sent, and nothing was stored after the stop
  t.is(pushes.length, 1);
  t.is(registers, 1);
  t.deepEqual(storage.writes.slice(n), []);
  t.deepEqual(await storage.loadOutbox(), []);
  // and nothing is sent later
  await c.flush();
  c.write("profile.update", { name: "after", bio: "" });
  await sleep(20);
  t.is(pushes.length, 1);
  t.deepEqual(storage.writes.slice(n), []);
});

test("finding 1: a client stopped during the registration after WRONG_CLIENT takes no client id and resends nothing", async (t) => {
  const { w } = cast(t);
  const storage = new Recorded();
  const inner = new InProcessTransport(w.server, { u: "mel" });
  let registers = 0;
  let hold: (() => void) | null = null;
  const pushes: Envelope[] = [];
  const transport: Transport = {
    ...watched(inner, {
      push: async (es, next) => {
        pushes.push(...es);
        if (pushes.length === 1) return [fail("WRONG_CLIENT", w.clock.now())];
        return next();
      },
    }),
    register: async () => {
      registers++;
      const a = await inner.register();
      if (registers === 2) await new Promise<void>((r) => (hold = r));
      return a;
    },
  };
  const c = client(w, "mel", { storage, transport, persist: true });
  await c.init();
  c.write("profile.update", { name: "Mel", bio: "" });
  for (let k = 0; k < 100 && hold === null; k++) await tick();
  t.truthy(hold, "the second registration is under way");
  c.stop();
  const n = storage.writes.length;
  (hold as unknown as () => void)();
  await sleep(30);
  t.is(pushes.length, 1);
  t.deepEqual(storage.writes.slice(n), []);
  const meta = await storage.loadMeta();
  t.not(meta?.clientId, null, "the stored id is the first registration's");
  // the late registration's id is not taken
  t.is(c.clientId, null);
});

test("finding 1: a WRONG_CLIENT that arrives after the stop makes no registration", async (t) => {
  const { w } = cast(t);
  const storage = new Recorded();
  const inner = new InProcessTransport(w.server, { u: "mel" });
  let registers = 0;
  let release: (() => void) | null = null;
  const pushes: Envelope[] = [];
  const transport: Transport = {
    ...watched(inner, {
      push: async (es) => {
        pushes.push(...es);
        await new Promise<void>((r) => (release = r));
        return [fail("WRONG_CLIENT", w.clock.now())];
      },
    }),
    register: () => (registers++, inner.register()),
  };
  const c = client(w, "mel", { storage, transport, persist: true });
  await c.init();
  c.write("profile.update", { name: "Mel", bio: "" });
  for (let k = 0; k < 100 && release === null; k++) await tick();
  t.truthy(release, "the write is on the wire");
  c.stop();
  const n = storage.writes.length;
  (release as unknown as () => void)();
  await sleep(30);
  t.is(registers, 1);
  t.is(pushes.length, 1);
  t.deepEqual(storage.writes.slice(n), []);
});

test("finding 1: a registration answered for another person is not taken: the client signs out and sends nothing", async (t) => {
  const { w } = cast(t);
  const pushes: Envelope[] = [];
  let first = true;
  const mel = new InProcessTransport(w.server, { u: "mel" });
  const otto = new InProcessTransport(w.server, { u: "otto" });
  // after WRONG_CLIENT the registration goes out with someone else's
  // token (another person signed in on the device)
  const transport: Transport = {
    ...watched(mel, {
      push: (es, next) => {
        pushes.push(...es);
        if (first) {
          first = false;
          return Promise.resolve([fail("WRONG_CLIENT", w.clock.now()) as PushResult]);
        }
        return next();
      },
    }),
    register: () => (pushes.length ? otto.register() : mel.register()),
  };
  const storage = new MemoryStorage();
  const c = client(w, "mel", { storage, transport, persist: true });
  await c.init();
  c.write("profile.update", { name: "Mel's write", bio: "" });
  await c.flush();
  t.true(c.signedOut);
  t.is(pushes.length, 1);
  t.is(c.outbox()[0]?.state, "queued");
  // the stored client id is not otto's
  const meta = await storage.loadMeta();
  t.is(meta?.clientId, null);
  // otto's profile is untouched
  const me = w.server.snapshot({ u: "otto" }, "user:otto");
  t.false(JSON.stringify(me).includes("Mel's write"));
});

test("finding 1: the server's registration names its person; a client takes its own", async (t) => {
  const { w } = cast(t);
  const a = w.server.register({ u: "mel" });
  t.like(a, { ok: true, u: "mel" });
  const c = client(w, "mel", { persist: true });
  await c.init();
  c.write("profile.update", { name: "Mel", bio: "" });
  await c.flush();
  t.false(c.signedOut);
  t.is(c.outbox()[0]?.state, "answered");
  // an answer without `u` (the mock backend's) is taken
  const inner = new InProcessTransport(w.server, { u: "mel" });
  const noU: Transport = {
    ...watched(inner),
    register: async () => {
      const r = await inner.register();
      if (!r.ok) return r;
      return { ok: true, clientId: r.clientId, serverTime: r.serverTime };
    },
  };
  const d = client(w, "mel", { transport: noU, persist: true, seed: 9 });
  await d.init();
  d.write("profile.update", { name: "Mel 2", bio: "" });
  await d.flush();
  t.is(d.outbox()[0]?.state, "answered");
});

/** A driver over Node's SQLite whose first `batch` fails (the replica's
 * file busy or the disk full at start). */
function flaky() {
  const d = nodeSqlite();
  let failures = 1;
  const calls: string[] = [];
  return {
    calls,
    driver: {
      ...d,
      batch: (statements: readonly SqlStatement[]) => {
        if (failures > 0) {
          failures--;
          calls.push("batch: database is locked");
          return Promise.reject(new Error("database is locked"));
        }
        calls.push("batch");
        return d.batch(statements);
      },
    },
  };
}

test("finding 7: a storage whose first batch failed opens on the next call, and the outbox sends", async (t) => {
  const { w } = cast(t);
  const { driver, calls } = flaky();
  const pushes: Envelope[] = [];
  const transport = watched(new InProcessTransport(w.server, { u: "mel" }), {
    push: (es, next) => (pushes.push(...es), next()),
  });
  const c = client(w, "mel", { storage: new SqliteStorage(driver), transport, persist: true });
  await t.throwsAsync(c.init(), { message: "database is locked" });
  // the next call opens it
  await c.init();
  c.write("profile.update", { name: "Mel", bio: "" });
  await c.flush();
  t.is(pushes.length, 1);
  t.is(c.outbox()[0]?.state, "answered");
  t.is(calls[0], "batch: database is locked");
  t.true(calls.slice(1).every((x) => x === "batch"));
});

test("finding 1: a closed SQLite storage refuses every later call and a write still waiting; one under way ends first", async (t) => {
  const d = nodeSqlite();
  let slow: (() => void) | null = null;
  let batches = 0;
  const driver = {
    ...d,
    batch: async (s: readonly SqlStatement[]) => {
      batches++;
      // the third batch (the first outbox save) is slow
      if (batches === 3) await new Promise<void>((r) => (slow = r));
      return d.batch(s);
    },
  };
  const s = new SqliteStorage(driver);
  await s.saveMeta({ user: "mel", clientId: null, lastSeq: 0, offset: 0 });
  const under = s.saveOutbox([{ local: "w1" }]);
  const waiting = s.saveOutbox([{ local: "w1" }, { local: "w2" }]);
  for (let k = 0; k < 50 && slow === null; k++) await tick();
  t.truthy(slow, "the first save is under way");
  let closed = false;
  const closing = s.close().then(() => (closed = true));
  await tick();
  t.false(closed, "close waits for the write under way");
  (slow as unknown as () => void)();
  await under;
  await closing;
  await t.throwsAsync(waiting, { instanceOf: StorageClosed });
  await t.throwsAsync(s.saveOutbox([]), { instanceOf: StorageClosed });
  await t.throwsAsync(s.loadOutbox(), { instanceOf: StorageClosed });
  await t.throwsAsync(s.clear(), { instanceOf: StorageClosed });
  // what was stored before the close is in the file
  const again = new SqliteStorage(d);
  t.deepEqual(await again.loadOutbox(), [{ local: "w1" }]);
});

const version = async (d: ReturnType<typeof nodeSqlite>) =>
  (await d.select<{ user_version: number }>("PRAGMA user_version"))[0]?.user_version;

test("finding 13: a new file gets the client's tables at the schema version", async (t) => {
  const d = nodeSqlite();
  const s = new SqliteStorage(d);
  t.is(await s.loadMeta(), null);
  t.is(await version(d), CLIENT_SCHEMA_VERSION);
  t.true(CLIENT_SCHEMA_VERSION >= 1);
  await s.saveLog("user:mel", { cursor: "c1", puts: [["k", { kind: "x" } as never]], dels: [] });
  // the next process finds the version and keeps the replica
  const again = new SqliteStorage(d);
  t.like((await again.loadLog("user:mel")) ?? {}, { cursor: "c1" });
});

for (const stored of [0, CLIENT_SCHEMA_VERSION + 1]) {
  test(`finding 13: a file at version ${stored} is made again: its logs read again from the server, its meta and outbox kept`, async (t) => {
    const d = nodeSqlite();
    // a file of the phase 3 tables (no version), or of a later version
    const old = new SqliteStorage(d);
    await old.saveMeta({ user: "mel", clientId: "c1", lastSeq: 4, offset: 12 });
    await old.saveLog("space:x", {
      cursor: "cur",
      puts: [["thread:1", { kind: "thread", q: "kept?" } as never]],
      dels: [],
    });
    await old.saveOutbox([{ local: "w1", input: { t: "unsent text" } }, { local: "w2" }]);
    d.db.exec(`PRAGMA user_version = ${stored}`);
    d.db.exec("CREATE TABLE sync_client_extra (x)");
    const s = new SqliteStorage(d);
    t.deepEqual(await s.logs(), []);
    t.is(await s.loadLog("space:x"), null);
    t.deepEqual(await s.loadMeta(), { user: "mel", clientId: "c1", lastSeq: 4, offset: 12 });
    t.deepEqual(await s.loadOutbox(), [
      { local: "w1", input: { t: "unsent text" } },
      { local: "w2" },
    ]);
    t.is(await version(d), CLIENT_SCHEMA_VERSION);
    // a table of the other version that is not the client's stays
    t.is(d.db.prepare("SELECT count(*) AS n FROM sync_client_extra").get()?.["n"], 0);
  });
}

test("finding 13: a client over a file made again reads its logs from the server and sends the kept outbox", async (t) => {
  const { w, open } = cast(t);
  const d = nodeSqlite();
  const pushes: Envelope[] = [];
  const offline: Transport = {
    ...watched(new InProcessTransport(w.server, { u: "mel" })),
    push: () => Promise.resolve([NO_RESPONSE]),
  };
  const first = client(w, "mel", {
    storage: new SqliteStorage(d),
    persist: true,
    transport: offline,
  });
  await first.init();
  await first.open(`space:${open}`);
  first.write("profile.update", { name: "Mel offline", bio: "" });
  await first.flush();
  first.stop();
  d.db.exec("PRAGMA user_version = 0");
  const transport = watched(new InProcessTransport(w.server, { u: "mel" }), {
    push: (es, next) => (pushes.push(...es), next()),
  });
  const c = client(w, "mel", { storage: new SqliteStorage(d), persist: true, transport });
  await c.init();
  await c.open(`space:${open}`);
  t.true(
    c
      .view()
      .list("space")
      .some((s) => s.id === open),
  );
  await c.flush();
  t.is(pushes.length, 1);
  t.is(pushes[0]?.name, "profile.update");
});
