// The server half's store over SQLite (`15-implementation-plan/01` D1-D4,
// D6, D7; M3 exit criteria): records read back as written, one transaction
// per commit (a fault between any two statements writes nothing), no
// server-only table reaches a read, erased text gone from the file and its
// WAL, restores detected at boot, record shapes rewritten by a backfill.

import { copyFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { MUTATORS, type StoredRecord } from "@session/mutators";
import { spaces } from "@session/shared";
import { MemoryStore, SyncServer, type Change, type LogRow, type Pull } from "@session/sync/server";
import test from "ava";
import SqliteDatabase from "better-sqlite3";

import {
  SqliteStore,
  checkRestore,
  databaseGeneration,
  requestNewHistory,
  rewriteRecords,
} from "../src/index.js";

import { DAY, KEYS, MINUTE, World, actor, cast, ok, post, refused, rng } from "./syncWorld.js";

const changesOf = (p: Pull): Change[] => ("changes" in p ? p.changes : []);

test("D1: a random sequence of writes stores the same records as the memory store, read back equal from a new connection", (t) => {
  for (const seed of [1, 2, 3]) {
    const mem = new World(t, { store: () => new MemoryStore(), seed });
    const sql = new World(t, { seed });
    const r = rng(seed * 7919);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const people = ["olga", "mona", "mel", "otto", "ada"];
    const texts = [
      "plain",
      'with "quotes" and \\ slashes',
      "ünïcödé — ✓ 🧪",
      "line\nbreak",
      "  spaced  ",
      '{"json":1}',
    ];
    const threads: string[] = [];
    const both = (u: string, name: string, input: (w: World) => unknown) => {
      const a = mem.as(u, name, input(mem));
      const b = sql.as(u, name, input(sql));
      const bare = (x: typeof a) => JSON.stringify(x).replace(/"serverTime":\d+/g, "");
      t.is(bare(b), bare(a), `${name} by ${u}`);
      return a;
    };
    const open = mem.id();
    sql.id();
    both("olga", "spaces.create", () => ({ id: open, name: `lounge${seed}` }));
    for (const u of people.slice(1)) both(u, "spaces.join", () => ({ space: open }));
    for (let step = 0; step < 60; step++) {
      const u = pick(people);
      const op = r();
      if (op < 0.3 || threads.length === 0) {
        const id = mem.id();
        sql.id();
        const q = pick(texts);
        const a = both(u, "threads.create", () => ({ id, space: open, kind: "post", q }));
        if (a.ok) threads.push(id);
      } else if (op < 0.55) {
        const id = mem.id();
        sql.id();
        const th = pick(threads);
        const text = pick(texts);
        both(u, "research.createPostFollowUp", () => ({ id, thread: th, t: text }));
      } else if (op < 0.75) {
        const th = pick(threads);
        const on = r() < 0.7;
        both(u, "saved.set", () => ({ kind: "thread", id: th, on }));
      } else if (op < 0.85) {
        const layout = pick(["centred", "wide"] as const);
        both(u, "prefs.set", () => ({ layout }));
      } else if (op < 0.95) {
        const th = pick(threads);
        const note = pick(texts);
        both("olga", "moderation.decide", () => ({ item: `p:${th}`, decision: "removed", note }));
      } else {
        const th = pick(threads);
        both(u, "threads.delete", () => ({ id: th }));
      }
      mem.clock.advance(1000);
      sql.clock.advance(1000);
    }
    const fresh = new SqliteStore(new SqliteDatabase(sql.path, { readonly: true }));
    const keys = fresh.sqlite
      .prepare<[], { key: string }>("SELECT key FROM records")
      .all()
      .map((x) => x.key);
    const stored = new Map(keys.map((k) => [k, fresh.byKey(k)]));
    const expected = (mem.store as MemoryStore).records;
    t.deepEqual([...stored.keys()].sort(), [...expected.keys()].sort());
    for (const [k, rec] of expected) t.is(JSON.stringify(stored.get(k)), JSON.stringify(rec), k);
    fresh.sqlite.close();
  }
});

test("D1: putRecord and deleteRecord are the only code that writes the records table", (t) => {
  const dir = new URL("../src/", import.meta.url);
  const sources = (sub: string): [string, string][] =>
    readdirSync(new URL(sub, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(`${sub}${e.name}/`)
        : e.name.endsWith(".ts")
          ? [[`${sub}${e.name}`, readFileSync(new URL(`${sub}${e.name}`, dir), "utf8")]]
          : [],
    );
  const writes =
    /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+`?records`?\b/gi;
  const found = sources("").flatMap(([file, text]) =>
    [...text.matchAll(writes)].map((m) => `${file}: ${m[0]}`),
  );
  t.deepEqual(
    found.map((f) => f.split(":")[0]),
    ["sync/store.ts", "sync/store.ts", "sync/store.ts"],
  );
  const store = readFileSync(new URL("sync/store.ts", dir), "utf8");
  // the three statements are used by putRecord and deleteRecord only
  const uses = [...store.matchAll(/this\.s\.(insertRecord|updateRecord|deleteRecord)\.run/g)]
    .length;
  t.is(uses, 3);
  const body = (name: string) => {
    const at = store.indexOf(`\n  ${name}(`);
    return store.slice(at, store.indexOf("\n  }\n", at));
  };
  t.is(
    [...body("putRecord").matchAll(/this\.s\.\w+Record\.run/g)].length +
      [...body("deleteRecord").matchAll(/this\.s\.\w+Record\.run/g)].length,
    3,
  );
});

test("D2: a fault between any two statements of a commit writes nothing, and the resend applies", (t) => {
  /** Writes through `SqliteStore`, throwing at the `n`th write while armed. */
  class Faulty extends SqliteStore {
    armed = false;
    calls = 0;
    n = 0;
    tick() {
      if (this.armed && ++this.calls === this.n) throw new Error(`fault at write ${this.n}`);
    }
  }
  for (const m of [
    "putRecord",
    "deleteRecord",
    "setLastRev",
    "putTombstone",
    "deleteTombstone",
    "putLogRow",
    "nextVersion",
    "putClient",
    "putAnswer",
    "putSeqAnswer",
  ] as const) {
    const orig = (SqliteStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[
      m
    ]!;
    (Faulty.prototype as unknown as Record<string, unknown>)[m] = function (
      this: Faulty,
      ...a: unknown[]
    ) {
      this.tick();
      return orig.apply(this, a);
    };
  }
  let writes = 0;
  for (let n = 1; ; n++) {
    const w = new World(t, { store: (db) => new Faulty(db) });
    const f = w.store as Faulty;
    const { open } = cast(t, w);
    const th = post(t, w, "mona", open);
    w.clientId("mel");
    const before = w.tables();
    // a reply: the reply, the counts, a reply notification to mona and a
    // mention notification to otto, all in one commit
    const e = w.envelope("mel", "research.createPostFollowUp", {
      id: w.id(),
      thread: th,
      t: "Agreed, @otto",
    });
    f.n = n;
    f.calls = 0;
    f.armed = true;
    const r = w.server.apply(actor("mel"), e);
    f.armed = false;
    if (r.ok) {
      writes = n - 1;
      t.true(w.store.keysIn("notif", { u: "otto" }) !== undefined);
      break;
    }
    t.is(r.error.code, "INTERNAL_SERVER_ERROR", `fault at write ${n}`);
    t.deepEqual(w.tables(), before, `fault at write ${n}`);
    // the answer was not recorded: the same envelope applies
    const again = ok(t, w.server.apply(actor("mel"), e)) as { notified: string[] };
    t.deepEqual(again.notified, ["otto"]);
    t.is([...w.store.keysIn("notif", { u: "mona" })].length, 1);
    w.close();
  }
  t.true(writes >= 10, `a reply's commit makes ${writes} writes`);
});

test("D2: a fault inside a nested serverApply rolls back to its savepoint; the outer transaction keeps only its own writes", (t) => {
  class Faulty extends SqliteStore {
    logCalls = 0;
    armed = false;
    override putLogRow(log: Parameters<SqliteStore["putLogRow"]>[0], row: LogRow) {
      if (this.armed && ++this.logCalls === 2) throw new Error("fault at the second log row");
      super.putLogRow(log, row);
    }
  }
  const w = new World(t, { store: (db) => new Faulty(db) });
  const f = w.store as Faulty;
  const { open } = cast(t, w);
  const a = post(t, w, "mona", open, "first");
  const b = post(t, w, "mona", open, "second");
  const before = w.tables();
  f.armed = true;
  w.store.transaction(() => {
    const res = w.server.serverApply({ me: "mona" }, (tx) => {
      for (const id of [a, b]) {
        const r = tx.byKey(`thread:${id}`);
        if (r?.kind === "thread") tx.put({ ...r, sum: "rewritten" });
      }
    });
    t.false(res.ok);
  });
  f.armed = false;
  t.deepEqual(w.tables(), before);
  t.is((w.get(`thread:${a}`) as { sum: unknown }).sum, null);
});

/** D1's kinds: the contract's stored records and the prototype's request. */
const D1_KINDS = new Set([
  ...spaces.storedRecordSchema.options.map((o) => o.shape.kind.value),
  "request",
]);

test("D3: no row of a server-only table reaches a snapshot or a pull; a hidden private save writes no change-log row", (t) => {
  const w = new World(t);
  const { open, closed } = cast(t, w);
  const readers = [null, "olga", "ada", "mona", "mel", "otto", "eve"];
  const logs = () =>
    [
      `space:${open}`,
      `space:${closed}`,
      ...readers.flatMap((u) => (u ? [`user:${u}`] : [])),
    ] as const;
  const cursors = new Map<string, string>();
  for (const u of readers)
    for (const log of logs())
      cursors.set(`${u}|${log}`, w.server.snapshot(actor(u), log as `space:${string}`).cursor);
  // server-only rows, each with a marker no read may carry
  const MARK = "SERVERONLY";
  const at = Date.now();
  w.db.$client
    .prepare("INSERT INTO server_meta (key, value, updated_at) VALUES ('probe', ?, ?)")
    .run(MARK, at);
  w.db.$client
    .prepare(
      "INSERT INTO run_live (run_id, attempt, turn_id, md, updated_at) VALUES ('r', 1, 't', ?, ?)",
    )
    .run(MARK, at);
  w.db.$client
    .prepare(
      "INSERT INTO site_settings (key, value_json, updated_at) VALUES ('default_model', ?, ?)",
    )
    .run(JSON.stringify(MARK), at);
  const th = post(t, w, "ada", closed, "a private post");
  const counts = `counts:${th}`;
  const row = () => w.store.logRow(`space:${closed}`, counts)?.version;
  const v0 = row();
  ok(t, w.as("mona", "saved.set", { kind: "thread", id: th, on: true }));
  ok(t, w.as("mel", "saved.set", { kind: "thread", id: th, on: true }));
  // two saves: the counts record serves 0 and its log row did not move
  t.is(row(), v0);
  t.is((w.get(counts) as { saves: number }).saves, 0);
  t.is((w.store as SqliteStore).trueSaves(th), 2);
  ok(t, w.as("olga", "saved.set", { kind: "thread", id: th, on: true }));
  t.true((row() ?? 0) > (v0 ?? 0));
  t.is((w.get(counts) as { saves: number }).saves, 3);
  t.is((w.store as SqliteStore).trueSaves(th), 3);
  ok(t, w.as("olga", "saved.set", { kind: "thread", id: th, on: false }));
  t.is((w.get(counts) as { saves: number }).saves, 0);
  // an open channel's count is the true count, and is not in save_counts
  const th2 = post(t, w, "mel", open, "an open post");
  ok(t, w.as("otto", "saved.set", { kind: "thread", id: th2, on: true }));
  t.is((w.get(`counts:${th2}`) as { saves: number }).saves, 1);
  t.is((w.store as SqliteStore).trueSaves(th2), 0);
  const served: StoredRecord[] = [];
  for (const u of readers)
    for (const log of logs()) {
      const l = log as `space:${string}`;
      served.push(...w.server.snapshot(actor(u), l).records.map((x) => x.record));
      for (const c of changesOf(w.server.pull(actor(u), l, cursors.get(`${u}|${log}`) ?? "")))
        if (c.op === "put") served.push(c.record);
    }
  const kinds = new Set(served.map((r) => r.kind));
  t.deepEqual(
    [...kinds].filter((k) => !D1_KINDS.has(k)),
    [],
  );
  t.false(JSON.stringify(served).includes(MARK));
});

test("D4: a removed thread's text is in neither the database file nor its WAL after a checkpoint", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const MARK = "ERASEME-7f3a9c";
  const th = post(t, w, "mona", open, `the question ${MARK}`);
  ok(
    t,
    w.as("mel", "research.createPostFollowUp", { id: w.id(), thread: th, t: `a reply ${MARK}` }),
  );
  ok(
    t,
    w.as("olga", "moderation.decide", { item: `p:${th}`, decision: "removed", note: "Off topic." }),
  );
  w.db.$client.pragma("wal_checkpoint(TRUNCATE)");
  const bytes = (p: string) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  for (const file of [w.path, `${w.path}-wal`]) t.is(bytes(file).indexOf(MARK), -1, file);
  // the text was there before the removal: the scan finds what it looks for
  const w2 = new World(t);
  const c2 = cast(t, w2);
  post(t, w2, "mona", c2.open, `the question ${MARK}`);
  w2.db.$client.pragma("wal_checkpoint(TRUNCATE)");
  t.true(bytes(w2.path).indexOf(MARK) >= 0);
});

test("D4: a removal's commit checkpoints the WAL itself: the text is in neither file without a checkpoint by hand", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const MARK = "ERASEME-1c2d3e";
  const bytes = (p: string) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  const th = post(t, w, "mona", open, `the question ${MARK}`);
  ok(
    t,
    w.as("mel", "research.createPostFollowUp", { id: w.id(), thread: th, t: `a reply ${MARK}` }),
  );
  // the text is in the WAL before the removal: the scan finds what it looks for
  t.true(bytes(`${w.path}-wal`).indexOf(MARK) >= 0);
  ok(
    t,
    w.as("olga", "moderation.decide", { item: `p:${th}`, decision: "removed", note: "Off topic." }),
  );
  for (const file of [w.path, `${w.path}-wal`]) t.is(bytes(file).indexOf(MARK), -1, file);
});

test("D4: a checkpoint a reader blocks is skipped without waiting, and the commit stands", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const th = post(t, w, "mona", open, "to be removed");
  const reader = new SqliteDatabase(w.path, { readonly: true });
  t.teardown(() => reader.close());
  // a reader holding a snapshot (as Litestream does) blocks a TRUNCATE
  reader.prepare("BEGIN").run();
  reader.prepare("SELECT count(*) FROM records").get();
  const started = Date.now();
  ok(
    t,
    w.as("olga", "moderation.decide", { item: `p:${th}`, decision: "removed", note: "Off topic." }),
  );
  t.true(Date.now() - started < 2000, "the commit did not wait for the busy timeout");
  t.like((w.store as SqliteStore).checkpoint(), { busy: true });
  reader.prepare("COMMIT").run();
  t.like((w.store as SqliteStore).checkpoint(), { busy: false, log: 0 });
  t.like(w.get(`thread:${th}`), { mod: "removed" });
});

test("the outermost transaction takes the write lock before its first read", (t) => {
  const w = new World(t);
  const store = w.store as SqliteStore;
  const other = new SqliteDatabase(w.path);
  t.teardown(() => other.close());
  other.pragma("busy_timeout = 0");
  let otherWrote = true;
  store.transaction(() => {
    store.client("nobody");
    // another writer (Litestream's `_litestream_seq`, an operator command)
    // cannot write between this transaction's read and its write
    try {
      other.prepare("INSERT INTO server_meta (key, value, updated_at) VALUES ('x', 'y', 0)").run();
    } catch (e) {
      otherWrote = false;
      t.is((e as { code?: string }).code, "SQLITE_BUSY");
    }
    store.setLastRev("probe", 1);
  });
  t.false(otherWrote);
  t.is(store.lastRev("probe"), 1);
});

test("a read-only connection's store reads another connection's commits: it keeps no record cache", (t) => {
  const w = new World(t);
  ok(t, w.as("mona", "prefs.set", { layout: "wide" }));
  const ro = new SqliteStore(new SqliteDatabase(w.path, { readonly: true }));
  t.teardown(() => ro.sqlite.close());
  t.like(ro.byKey("prefs:mona"), { layout: "wide", rev: 1 });
  ok(t, w.as("mona", "prefs.set", { layout: "centred" }));
  t.like(ro.byKey("prefs:mona"), { layout: "centred", rev: 2 });
});

test("D6: a database file restored from a backup gets a new history id, and a cursor from before resyncs", (t) => {
  const a = new World(t);
  const { open } = cast(t, a);
  const first = checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 1);
  t.like(first, { replaced: true, reason: "generation" });
  // a boot with the same generation changes nothing
  t.like(checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 2), {
    replaced: false,
    history: first.history,
  });
  post(t, a, "mona", open);
  // the backup: a copy of the file as it is now
  a.db.$client.pragma("wal_checkpoint(TRUNCATE)");
  const backup = join(a.directory, "backup.db");
  copyFileSync(a.path, backup);
  // later writes, and a cursor served after them
  post(t, a, "mel", open);
  const cursor = a.server.snapshot(actor("mel"), `space:${open}`).cursor;
  const userCursor = a.server.snapshot(actor("mel"), "user:mel").cursor;
  a.db.$client.pragma("wal_checkpoint(TRUNCATE)");
  // the restore: the backup is a new file in place of the old one
  const restored = join(a.directory, "restored.db");
  copyFileSync(backup, restored);
  const b = new World(t, { path: restored, clock: a.clock });
  const check = checkRestore(b.store as SqliteStore, databaseGeneration(restored), 3);
  t.not(check.previous, check.current);
  t.true(check.replaced);
  t.not(check.history, first.history);
  t.deepEqual(b.server.pull(actor("mel"), `space:${open}`, cursor), { resync: true });
  t.deepEqual(b.server.pull(actor("mel"), "user:mel", userCursor), { resync: true });
  // a cursor served after the restore pulls; the next boot of the same file
  // changes nothing
  const fresh = b.server.snapshot(actor("mel"), `space:${open}`).cursor;
  t.like(checkRestore(b.store as SqliteStore, databaseGeneration(restored), 4), {
    replaced: false,
  });
  t.true("changes" in b.server.pull(actor("mel"), `space:${open}`, fresh));
  // without the check (the same file, booted again), the old cursor still pulls
  t.true("changes" in a.server.pull(actor("mel"), `space:${open}`, cursor));
});

test("D6: a restore resyncs a log with no rows in the restored file, and a cursor of an earlier restore from the same backup", (t) => {
  const a = new World(t);
  const { open } = cast(t, a);
  checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 1);
  a.clientId("zed");
  a.db.$client.pragma("wal_checkpoint(TRUNCATE)");
  const backup = join(a.directory, "backup.db");
  copyFileSync(a.path, backup);
  // zed's user log has no rows in the backup
  t.deepEqual(a.store.logRows("user:zed", 0), []);
  ok(t, a.as("zed", "prefs.set", { layout: "wide" }));
  const lost = a.server.snapshot(actor("zed"), "user:zed").cursor;
  const restore = (name: string, at: number) => {
    // a later time: the new server's ids do not repeat the lost timeline's
    a.clock.advance(MINUTE);
    const path = join(a.directory, name);
    copyFileSync(backup, path);
    const w = new World(t, { path, clock: a.clock });
    t.true(checkRestore(w.store as SqliteStore, databaseGeneration(path), at).replaced);
    return w;
  };
  const b = restore("r1.db", 2);
  // the restored timeline writes zed's preference again, at a version the
  // lost timeline used too
  ok(t, b.as("zed", "prefs.set", { layout: "centred" }));
  t.deepEqual(b.server.pull(actor("zed"), "user:zed", lost), { resync: true });
  // the first restore serves a cursor; a second restore from the same backup
  // writes as many commits again
  for (let i = 0; i < 3; i++) post(t, b, "olga", open, `first restore ${i}`);
  const served = b.server.snapshot(actor("olga"), `space:${open}`).cursor;
  const c = restore("r2.db", 3);
  for (let i = 0; i < 4; i++) post(t, c, "olga", open, `second restore ${i}`);
  t.deepEqual(c.server.pull(actor("olga"), `space:${open}`, served), { resync: true });
});

test("D6: an operator's request replaces the history id at the next boot of a file restored in place", (t) => {
  const a = new World(t);
  const { open } = cast(t, a);
  const first = checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 1);
  const cursor = a.server.snapshot(actor("mona"), `space:${open}`).cursor;
  // the bytes of a backup copied over the same file keep its identity: the
  // generation is the same, and only the request replaces the id
  t.like(checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 2), { replaced: false });
  requestNewHistory(a.db.$client);
  const check = checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 3);
  t.like(check, { replaced: true, reason: "requested" });
  t.not(check.history, first.history);
  t.deepEqual(a.server.pull(actor("mona"), `space:${open}`, cursor), { resync: true });
  // the request is used up
  t.like(checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 4), { replaced: false });
});

test("D7: a backfill that adds a field writes a log row for every rewritten key, and a replica pulls the new shape", (t) => {
  const w = new World(t);
  ok(t, w.as("mona", "prefs.set", { layout: "wide" }));
  ok(t, w.as("mel", "prefs.set", { layout: "centred" }));
  const cursor = w.server.snapshot(actor("mona"), "user:mona").cursor;
  const head = w.store.head();
  const n = rewriteRecords(w.db, {
    id: "test-prefs-density",
    description: "adds density to prefs",
    kind: "prefs",
    rewrite: (r) => ({ ...r, density: "normal" }) as unknown as StoredRecord,
  });
  t.is(n, 2);
  // the server's store reads the rewritten rows (its cache is per process
  // state; a backfill runs at boot, before the server's store exists)
  const store = new SqliteStore(w.db);
  for (const u of ["mona", "mel"]) {
    const row = store.logRow(`user:${u}`, `prefs:${u}`);
    t.is(row?.version, head + 1);
    t.like(store.byKey(`prefs:${u}`), { density: "normal", rev: 2 });
  }
  const server = new SyncServer({
    store,
    clock: w.clock,
    mutators: MUTATORS,
    cursorKeys: KEYS,
  });
  const p = server.pull(actor("mona"), "user:mona", cursor);
  t.deepEqual(
    changesOf(p).map((c) => (c.op === "put" ? c.record : null)),
    [{ kind: "prefs", u: "mona", layout: "wide", rev: 2, density: "normal" }],
  );
  // run again: nothing left to rewrite
  t.is(
    rewriteRecords(w.db, {
      id: "x",
      description: "",
      kind: "prefs",
      rewrite: (r) => r as unknown as StoredRecord,
    }),
    0,
  );
});

test("D7: a backfill reads a stored shape the current schema refuses, and validates only the rewritten record", (t) => {
  const w = new World(t);
  ok(t, w.as("mona", "prefs.set", { layout: "wide" }));
  // the shape of an earlier build: `wide: true` in place of `layout`
  w.db.$client
    .prepare("UPDATE records SET body = ? WHERE key = 'prefs:mona'")
    .run(JSON.stringify({ kind: "prefs", u: "mona", wide: true, rev: 1 }));
  const n = rewriteRecords(w.db, {
    id: "test-prefs-layout",
    description: "wide becomes layout",
    kind: "prefs",
    rewrite: (r) =>
      ({
        kind: "prefs",
        u: r["u"],
        layout: r["wide"] ? "wide" : "centred",
        rev: r.rev,
      }) as StoredRecord,
  });
  t.is(n, 1);
  t.like(new SqliteStore(w.db).byKey("prefs:mona"), { layout: "wide", rev: 2 });
  // a rewrite to a shape the schema refuses is refused, and commits nothing
  w.db.$client
    .prepare("UPDATE records SET body = ? WHERE key = 'prefs:mona'")
    .run(JSON.stringify({ kind: "prefs", u: "mona", wide: true, rev: 2 }));
  const before = w.tables();
  t.throws(() =>
    rewriteRecords(w.db, {
      id: "test-prefs-bad",
      description: "",
      kind: "prefs",
      rewrite: (r) => ({ ...r, wide: false }) as unknown as StoredRecord,
    }),
  );
  t.deepEqual(w.tables(), before);
});

test("the store refuses a record that does not match its schema, and the write commits nothing", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const before = w.tables();
  const res = w.server.serverApply({ me: "olga" }, (tx) => {
    const s = tx.byKey(`space:${open}`);
    if (s?.kind === "space") tx.put({ ...s, vis: "secret" } as never);
  });
  t.false(res.ok);
  t.deepEqual(w.tables(), before);
  refused(t, w.as("olga", "spaces.update", { id: open, desc: "x".repeat(301) }), "BAD_REQUEST");
});

test("sync review-m2 17 on SqliteStore: a nested transaction that throws takes back its own writes only", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const p = post(t, w, "mel", open);
  const store = w.store as SqliteStore;
  const head = store.head();
  const r = w.store.transaction(() => {
    w.store.setLastRev("outer", 1);
    // a fault after serverApply staged and wrote its records
    return w.server.serverApply({ me: "mel" }, (tx) => {
      const th = tx.byKey(`thread:${p}`);
      if (th?.kind === "thread") tx.put({ ...th, sum: "partial" });
      throw new Error("the fault");
    });
  });
  t.false(r.ok);
  t.is(store.lastRev("outer"), 1, "the outer transaction's write is kept");
  t.like(w.get(`thread:${p}`), { sum: null });
  t.is(w.store.head(), head);
  // a fault inside a nested call, caught by the outer one
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
  // a new connection reads the same
  const fresh = new SqliteStore(new SqliteDatabase(w.path, { readonly: true }));
  t.is(fresh.lastRev("a"), 1);
  t.is(fresh.lastRev("b"), undefined);
  t.like(fresh.byKey(`thread:${p}`), { sum: null });
  fresh.sqlite.close();
});

// ---- the sync package's Y8 retention tests, on SqliteStore ----

const count = (w: World, table: string) =>
  (w.db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test("Y8 on SqliteStore: retention prunes each table at its boundary millisecond", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const p = post(t, w, "mel", open);
  ok(t, w.as("mel", "threads.delete", { id: p }));
  ok(t, w.as("otto", "saved.set", { kind: "thread", id: post(t, w, "mel", open), on: true }));
  const saved = (
    w.db.$client.prepare("SELECT key FROM records WHERE key LIKE 'save:otto:%'").get() as {
      key: string;
    }
  ).key;
  ok(t, w.as("otto", "saved.set", { kind: "thread", id: saved.split(":")[2], on: false }));
  const tomb = w.store.tombstone(saved);
  if (!tomb) return t.fail("no tombstone");
  t.is(tomb.at, w.clock.now(), "the tombstone carries the commit time");
  refused(t, w.as("otto", "prefs.set", { layout: "wide" }, "not-a-ulid"), "BAD_REQUEST");
  t.is(count(w, "sync_seq_answers"), 1);
  const answers = count(w, "sync_answers");
  t.true(answers > 0);
  const t0 = w.clock.now();
  w.server.retain(t0 + 7 * DAY - 1);
  t.is(count(w, "sync_answers"), answers, "an answer recorded 1 ms less than 7 days ago is kept");
  t.true(count(w, "sync_clients") > 0);
  w.server.retain(t0 + 7 * DAY);
  t.is(count(w, "sync_answers"), 0);
  t.is(count(w, "sync_seq_answers"), 0);
  t.is(count(w, "sync_clients"), 0);
  w.server.retain(tomb.at + 30 * DAY);
  t.truthy(w.store.tombstone(saved), "a tombstone committed exactly 30 days ago is kept");
  w.server.retain(tomb.at + 30 * DAY + 1);
  t.is(w.store.tombstone(saved), undefined);
  t.false(w.store.logRows("user:otto", 0).some((r) => r.key === saved));
  t.true(w.store.idTaken(p), "the registry keeps every id");
});

test("Y8 on SqliteStore: moderation log entries over 180 days are deleted for every replica", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  ok(t, w.as("olga", "members.ban", { space: open, user: "otto" }));
  const key = (
    w.db.$client.prepare("SELECT key, created_at FROM records WHERE kind = 'modlog'").get() as {
      key: string;
      created_at: number;
    }
  ).key;
  const at = w.clock.now();
  t.is(
    (
      w.db.$client.prepare("SELECT created_at AS c FROM records WHERE key = ?").get(key) as {
        c: number;
      }
    ).c,
    at,
    "the entry's row carries its creation time",
  );
  w.clock.ms = at + 180 * DAY;
  const owner = w.server.snapshot(actor("olga"), `space:${open}`);
  w.server.retain();
  t.truthy(w.get(key), "an entry made exactly 180 days ago is kept");
  w.clock.ms = at + 180 * DAY + 1000;
  w.server.retain();
  t.is(new SqliteStore(w.db).byKey(key), undefined);
  const pull = w.server.pull(actor("olga"), `space:${open}`, owner.cursor);
  t.true("changes" in pull && pull.changes.some((c) => c.key === key && c.op === "del"));
});

test("a record put with no creation version keeps the row's own, and a new key without one is refused", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const store = w.store as SqliteStore;
  const key = `space:${open}`;
  const v = store.createdVersion(key);
  const at = (
    w.db.$client.prepare("SELECT created_at AS c FROM records WHERE key = ?").get(key) as {
      c: number;
    }
  ).c;
  const s = store.byKey(key);
  if (s?.kind !== "space") return t.fail("no space");
  store.transaction(() => store.putRecord(key, { ...s, desc: "changed", rev: s.rev + 1 }, null));
  t.is(store.createdVersion(key), v);
  t.is(
    (
      w.db.$client.prepare("SELECT created_at AS c FROM records WHERE key = ?").get(key) as {
        c: number;
      }
    ).c,
    at,
  );
  t.throws(() =>
    store.transaction(() =>
      store.putRecord(`space:${w.id()}`, { ...s, id: w.id(), name: "fresh", rev: 1 }, null),
    ),
  );
});

test("a snapshot orders records of one creation time by the version of the commit that made them", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  // ids in reverse of the commit order, all at one server time
  const ids = [w.id(3000), w.id(2000), w.id(1000)];
  for (const id of ids)
    ok(t, w.as("mona", "threads.create", { id, space: open, kind: "post", q: id }));
  const order = w.server
    .snapshot(actor("mona"), `space:${open}`)
    .records.filter((r) => r.record.kind === "thread")
    .map((r) => (r.record as { id: string }).id);
  t.deepEqual(order, ids);
});

test("the record cache holds cacheSize records: an evicted one is read again from its row", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const ids = [
    post(t, w, "mona", open, "a"),
    post(t, w, "mona", open, "b"),
    post(t, w, "mona", open, "c"),
  ];
  const store = new SqliteStore(w.db, { cacheSize: 3 });
  let reads = 0;
  const statement = (store as unknown as { s: { byKey: { get: (k: string) => unknown } } }).s.byKey;
  const get = statement.get.bind(statement);
  statement.get = (k: string) => {
    reads += 1;
    return get(k);
  };
  for (const id of ids) store.byKey(`thread:${id}`);
  t.is(reads, 3);
  for (const id of ids) store.byKey(`thread:${id}`);
  t.is(reads, 3, "three records stay cached");
  store.byKey(`space:${open}`);
  t.is(reads, 4);
  // the oldest went out
  store.byKey(`thread:${ids[0] ?? ""}`);
  t.is(reads, 5);
  store.byKey(`thread:${ids[2] ?? ""}`);
  t.is(reads, 5);
});

test("a tombstone keeps who deleted the record", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const th = post(t, w, "mona", open);
  ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: true }));
  ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: false }));
  t.like(w.store.tombstone(`save:otto:${th}`), { kind: "save", person: "otto", by: "otto" });
});

test("a deleted record's id stays taken: a new record may not reuse it", (t) => {
  const w = new World(t);
  const { open } = cast(t, w);
  const th = post(t, w, "mona", open);
  const reply = w.id();
  ok(t, w.as("mel", "research.createPostFollowUp", { id: reply, thread: th, t: "A reply" }));
  ok(t, w.as("olga", "moderation.decide", { item: `p:${th}`, decision: "removed", note: "No." }));
  t.is(w.get(`reply:${reply}`), undefined, "the removal deleted the reply");
  t.true(w.store.idTaken(reply));
  const other = post(t, w, "mona", open);
  const again = w.as("mel", "research.createPostFollowUp", {
    id: reply,
    thread: other,
    t: "Again",
  });
  t.false(again.ok);
});
