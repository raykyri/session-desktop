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
  bumpEveryEpoch,
  checkRestore,
  databaseGeneration,
  rewriteRecords,
} from "../src/index.js";

import { KEYS, World, actor, cast, ok, post, refused, rng } from "./syncWorld.js";

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
  t.is(uses, 4);
  const body = (name: string) => {
    const at = store.indexOf(`\n  ${name}(`);
    return store.slice(at, store.indexOf("\n  }\n", at));
  };
  t.is(
    [...body("putRecord").matchAll(/this\.s\.\w+Record\.run/g)].length +
      [...body("deleteRecord").matchAll(/this\.s\.\w+Record\.run/g)].length,
    4,
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

test("D6: a database file restored from a backup boots with bumped epochs, and a cursor from before resyncs", (t) => {
  const a = new World(t);
  const { open } = cast(t, a);
  t.true(checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 1).bumped > 0);
  // a boot with the same generation bumps nothing
  t.like(checkRestore(a.store as SqliteStore, databaseGeneration(a.path), 2), { bumped: 0 });
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
  t.true(check.bumped >= 2);
  t.deepEqual(b.server.pull(actor("mel"), `space:${open}`, cursor), { resync: true });
  t.deepEqual(b.server.pull(actor("mel"), "user:mel", userCursor), { resync: true });
  // a cursor served after the restore pulls; the next boot of the same file
  // bumps nothing
  const fresh = b.server.snapshot(actor("mel"), `space:${open}`).cursor;
  t.like(checkRestore(b.store as SqliteStore, databaseGeneration(restored), 4), { bumped: 0 });
  t.true("changes" in b.server.pull(actor("mel"), `space:${open}`, fresh));
  // without the check (the same file, booted again), the old cursor still pulls
  t.true("changes" in a.server.pull(actor("mel"), `space:${open}`, cursor));
});

test("D6: bumping every epoch resyncs every log's readers", (t) => {
  const w = new World(t);
  const { open, closed } = cast(t, w);
  const c1 = w.server.snapshot(actor("ada"), `space:${closed}`).cursor;
  const c2 = w.server.snapshot(null, `space:${open}`).cursor;
  t.true(bumpEveryEpoch(w.store as SqliteStore) > 2);
  t.deepEqual(w.server.pull(actor("ada"), `space:${closed}`, c1), { resync: true });
  t.deepEqual(w.server.pull(null, `space:${open}`, c2), { resync: true });
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
  t.is(rewriteRecords(w.db, { id: "x", description: "", kind: "prefs", rewrite: (r) => r }), 0);
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
