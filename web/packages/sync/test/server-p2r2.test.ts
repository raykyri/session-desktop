// The server half's findings of review round 2 of phase 2 (reviewer A), over
// both stores: the stream's cursor checks, which `pull` and `streamPull`
// share (`openCursor`, finding 4; the mutations m01 SP1 to SP6 as tests); a
// run's context without the earlier asks hidden for its person (finding 3);
// a device's calls on a run it holds, which take nothing from the write
// budget (finding 2); the key a signed-out caller's address is counted under
// (finding 6); and
// the run status index, which nothing reads (finding 8, migration 0005).

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import test, { type ExecutionContext } from "ava";
import BetterSqlite from "better-sqlite3";

import {
  LEASE_MS,
  SYNC_MIGRATIONS,
  SqliteServerStore,
  SyncServer,
  TOMBSTONE_TTL,
  addressKey,
  migrate,
  newCursorKey,
  type Actor,
  type Cursor,
  type LogId,
} from "../src/server/index.js";

import { STORES, cast, ok, type World } from "./helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return --
   records and call results are read as `any` */
type Any = any;

/** What the streams' read answers one stream: `resync`, `skip` or `cursor`. */
const streamRead = (
  w: World | { server: SyncServer },
  actor: Actor | null,
  log: LogId,
  cursor: Cursor,
  keys: ReadonlySet<string> | null = null,
) => Object.keys(w.server.streamPulls([{ actor, log, cursor, keys }])[0] ?? {})[0];

/** What a pull answers: `resync`, `changes`, or the error code. */
const pullRead = (w: World, actor: Actor | null, log: LogId, cursor: Cursor) => {
  const p = w.server.pull(actor, log, cursor) as Any;
  return p.ok === false ? p.error.code : "resync" in p ? "resync" : "changes";
};

/** Sign a device in for `u` (approved with the code, the token taken). */
function device(w: World, u: string): Actor {
  const a = w.server.call(null, "devices.authorize", { name: "mac" }) as Any;
  const b = w.server.call({ u }, "devices.approve", {
    request: a.result.request,
    code: a.result.code,
  }) as Any;
  const c = w.server.call(null, "devices.token", { request: a.result.request }) as Any;
  if (!a.ok || !b.ok || !c.ok) throw new Error(JSON.stringify([a, b, c]));
  return { u, device: c.result.device };
}

const post = (t: ExecutionContext, w: World, u: string, space: string, q = "p") =>
  ok(t, w.as(u, "threads.create", { id: w.id(), space, kind: "post", q }));

for (const kind of STORES) {
  test(`${kind}: finding 4: a stream resyncs a token older than the tombstones, as a pull does`, (t) => {
    const { w, open } = cast(t, kind);
    const log: LogId = `space:${open}`;
    const cursor = w.server.snapshot({ u: "mel" }, log).cursor;
    w.clock.advance(TOMBSTONE_TTL - 1);
    t.is(streamRead(w, { u: "mel" }, log, cursor), "cursor");
    t.is(pullRead(w, { u: "mel" }, log, cursor), "changes");
    w.clock.advance(2);
    t.is(streamRead(w, { u: "mel" }, log, cursor), "resync");
    t.is(pullRead(w, { u: "mel" }, log, cursor), "resync");
  });

  test(`${kind}: finding 4: a stream resyncs a token served before a restore (another instance id)`, (t) => {
    const { w, open } = cast(t, kind);
    const log: LogId = `space:${open}`;
    const cursor = w.server.snapshot({ u: "mel" }, log).cursor;
    t.is(streamRead(w, { u: "mel" }, log, cursor), "cursor");
    w.server.resetInstance();
    t.is(streamRead(w, { u: "mel" }, log, cursor), "resync");
    t.is(pullRead(w, { u: "mel" }, log, cursor), "resync");
    // the stream does not seal the old token under the new instance id
    const fresh = w.server.snapshot({ u: "mel" }, log).cursor;
    t.is(streamRead(w, { u: "mel" }, log, fresh), "cursor");
  });

  test(`${kind}: finding 4: a stream resyncs when its reader's scope changed, as a pull does`, (t) => {
    const { w, open } = cast(t, kind);
    const log: LogId = `space:${open}`;
    const cursor = w.server.snapshot({ u: "mel" }, log).cursor;
    post(t, w, "olga", open);
    t.is(streamRead(w, { u: "mel" }, log, cursor), "cursor");
    // mel becomes a moderator: what she may read changed
    ok(
      t,
      w.as("olga", "members.setRole", {
        space: open,
        user: "mel",
        role: "mod",
        base: { rev: w.rev(`member:${open}:mel`) },
      }),
    );
    t.is(streamRead(w, { u: "mel" }, log, cursor, new Set([`member:${open}:mel`])), "resync");
    t.is(pullRead(w, { u: "mel" }, log, cursor), "resync");
    // another reader's scope did not change
    const otto = w.server.snapshot({ u: "otto" }, log).cursor;
    post(t, w, "olga", open);
    t.is(streamRead(w, { u: "otto" }, log, otto), "cursor");
  });

  test(`${kind}: finding 4: a stream resyncs a read the server does not serve, as a pull refuses it`, (t) => {
    const { w, open } = cast(t, kind);
    const log: LogId = `space:${open}`;
    // a signed-out reader's token; an actor whose name is no handle reads
    // as nobody, and is refused
    const cursor = w.server.snapshot(null, log).cursor;
    t.is(streamRead(w, null, log, cursor), "cursor");
    t.is(streamRead(w, { u: "Not A Handle" }, log, cursor), "resync");
    t.is(pullRead(w, { u: "Not A Handle" }, log, cursor), "UNAUTHORIZED");
    // and a log that is none
    t.is(streamRead(w, null, "space:a:b", cursor), "resync");
  });

  test(`${kind}: finding 3: a run's history leaves out the earlier asks hidden for its person`, (t) => {
    const { w, open } = cast(t, kind);
    const ask = (u: string, q: string) => {
      const id = w.id();
      const a = w.as(u, "threads.create", { id, space: open, kind: "ask", q });
      if (!a.ok) throw new Error(JSON.stringify(a.error));
      return id;
    };
    const fork = (u: string, thread: string, parent: string, q: string) => {
      const id = w.id();
      const a = w.as(u, "research.forkNode", { id, thread, parent, q });
      if (!a.ok) throw new Error(JSON.stringify(a.error));
      return { fu: id, run: (a.result as { run: string }).run };
    };
    const th = ask("mel", "SECRET THREAD QUESTION");
    t.true(w.server.finishJob(`thread:${th}`, "THE THREAD'S ANSWER"));
    const f = fork("mel", th, "r", "SECRET FOLLOW-UP");
    t.true(w.server.finishJob(`followup:${f.fu}`, "THE FOLLOW-UP'S ANSWER"));
    const history = (run: string) => {
      const s = w.server.runJobs.start(run);
      if (!s.ok) throw new Error(s.why);
      return s.job.history.map((x) => x.q);
    };
    // shown: both reach otto's run below the follow-up
    t.deepEqual(history(fork("otto", th, f.fu, "OTTO ASKS").run), [
      "SECRET THREAD QUESTION",
      "SECRET FOLLOW-UP",
    ]);
    // the thread's ask hidden: only the follow-up
    ok(t, w.as("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
    t.deepEqual(history(fork("otto", th, f.fu, "OTTO AGAIN").run), ["SECRET FOLLOW-UP"]);
    // the follow-up hidden too: nothing
    ok(t, w.as("mona", "moderation.decide", { item: `f:${th}:${f.fu}`, decision: "hidden" }));
    t.deepEqual(history(fork("otto", th, f.fu, "OTTO ONCE MORE").run), []);
    // the author and a moderator read both
    t.deepEqual(history(fork("mel", th, f.fu, "MEL ASKS").run), [
      "SECRET THREAD QUESTION",
      "SECRET FOLLOW-UP",
    ]);
    t.deepEqual(history(fork("mona", th, f.fu, "MONA ASKS").run), [
      "SECRET THREAD QUESTION",
      "SECRET FOLLOW-UP",
    ]);
  });

  test(`${kind}: finding 2: a device's run calls are free only on a run it holds now, at its attempt`, (t) => {
    const { w, open } = cast(t, kind, 1, { writeBudget: { burst: 6, perMinute: 600 } });
    const d = device(w, "mel");
    w.clock.advance(1000);
    const dev = d.device as string;
    const exec = { kind: "device", cli: "claude", device: dev };
    // what is left of mel's budget, used up; then a second refills it
    const left = () => {
      let n = 0;
      while (n < 10 && w.server.overBudget("u:mel") === null) n++;
      w.clock.advance(1000);
      return n;
    };
    const ask = () => {
      const id = w.id();
      const a = w.as("mel", "threads.create", {
        id,
        space: open,
        kind: "ask",
        q: "Q?",
        executor: exec,
      });
      if (!a.ok) throw new Error(JSON.stringify(a.error));
      return { th: id, run: (a.result as { run: string }).run };
    };
    const call = (name: string, input: object) => w.server.call(d, name, { device: dev, ...input });
    const code = (a: Any) => (a.ok ? "ok" : a.error.code);
    const a = ask();
    w.clock.advance(1000);
    const b = ask();
    w.clock.advance(1000);
    t.is(code(call("runs.claim", { run: a.run })), "ok");
    t.is(left(), 5, "a claim is counted");
    t.is(code(call("runs.claim", { run: b.run })), "ok");
    left();
    // held: free
    t.is(code(call("runs.heartbeat", { run: a.run, attempt: 1 })), "ok");
    t.is(code(call("runs.turn", { run: a.run, attempt: 1, turn: "t" })), "ok");
    t.is(left(), 6);
    // another attempt: counted
    t.is(code(call("runs.heartbeat", { run: a.run, attempt: 2 })), "PRECONDITION_FAILED");
    t.is(left(), 5);
    // a run that Run again cancelled, its lease not yet dropped: counted
    ok(
      t,
      w.as("mel", "threads.update", {
        id: a.th,
        q: "Q?",
        run: true,
        base: { rev: w.rev(`thread:${a.th}`) },
      }),
    );
    t.not((w.get(`run:${a.run}`) as Any).status, "running");
    left();
    t.not(code(call("runs.heartbeat", { run: a.run, attempt: 1 })), "ok");
    t.is(left(), 5);
    // a lease that ended: counted
    t.is(code(call("runs.heartbeat", { run: b.run, attempt: 1 })), "ok");
    t.is(left(), 6);
    w.clock.advance(LEASE_MS);
    t.is(code(call("runs.heartbeat", { run: b.run, attempt: 1 })), "PRECONDITION_FAILED");
    t.is(left(), 5);
  });

  test(`${kind}: finding 8: the queued runs limit counts the person's runs, and writes add no run status index rows`, (t) => {
    const db = kind === "sqlite" ? new BetterSqlite(":memory:") : null;
    const { w, open } = cast(t, kind, 1, {
      queuedRunsPerUser: 2,
      ...(db ? { store: new SqliteServerStore(db) } : {}),
    });
    const ask = (u: string) =>
      w.as(u, "threads.create", { id: w.id(), space: open, kind: "ask", q: "Q?" });
    ok(t, ask("mel"));
    ok(t, ask("mel"));
    const third = ask("mel");
    t.like(third, { ok: false, error: { code: "TOO_MANY_REQUESTS" } });
    ok(t, ask("otto"));
    if (db)
      t.is(
        (
          db
            .prepare("SELECT count(*) AS n FROM sync_index WHERE kind = 'run' AND field = 'status'")
            .get() as { n: number }
        ).n,
        0,
      );
  });
}

test("finding 4: a stream resyncs a token served after the backup a database was restored from (its head)", (t) => {
  const keys = { current: newCursorKey() };
  const db = new BetterSqlite(":memory:");
  const { w, open } = cast(t, "sqlite", 1, { store: new SqliteServerStore(db), cursorKeys: keys });
  const backup = db.serialize();
  for (let k = 0; k < 3; k++) post(t, w, "olga", open);
  const log: LogId = `space:${open}`;
  const cursor = w.server.snapshot({ u: "olga" }, log).cursor;
  const restored = new SyncServer({
    store: new SqliteServerStore(new BetterSqlite(backup)),
    clock: w.clock,
    cursorKeys: keys,
  });
  t.is(streamRead({ server: restored }, { u: "olga" }, log, cursor), "resync");
  const fresh = restored.snapshot({ u: "olga" }, log).cursor;
  t.is(streamRead({ server: restored }, { u: "olga" }, log, fresh), "cursor");
});

test("finding 6: addressKey: IPv4 as it is, IPv4-mapped as its IPv4 address, IPv6 by its /64", (t) => {
  t.is(addressKey("203.0.113.5"), "203.0.113.5");
  t.is(addressKey(" 203.0.113.5 "), "203.0.113.5");
  t.is(addressKey("::ffff:203.0.113.5"), "203.0.113.5");
  t.is(addressKey("::FFFF:cb00:7105"), "203.0.113.5");
  t.is(addressKey("2001:db8:1:2::5"), "2001:db8:1:2::/64");
  t.is(addressKey("2001:DB8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  t.is(addressKey("2001:db8::"), "2001:db8:0:0::/64");
  t.is(addressKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  t.is(addressKey("::ffff:203.0.113.5%eth0"), "203.0.113.5");
  t.is(addressKey("::1"), "0:0:0:0::/64");
  t.is(addressKey("unknown"), "unknown");
});

test("finding 8: migration 0005 drops the run status index rows 0004 added", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sync-mig-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const src = fileURLToPath(SYNC_MIGRATIONS);
  for (const f of ["0001_sync.sql", "0002_review_r1.sql", "0003_space_vis.sql"])
    cpSync(join(src, f), join(dir, f));
  const db = new BetterSqlite(":memory:");
  migrate(db, dir);
  const run = { kind: "run", id: "R1", u: "mel", status: "queued", rev: 1 };
  db.prepare("INSERT INTO sync_records (key, kind, body, born) VALUES (?, ?, ?, ?)").run(
    "run:R1",
    "run",
    JSON.stringify(run),
    1,
  );
  cpSync(join(src, "0004_review_r1_phase2.sql"), join(dir, "0004_review_r1_phase2.sql"));
  t.deepEqual(migrate(db, dir), ["0004_review_r1_phase2.sql"]);
  const count = () =>
    (
      db
        .prepare("SELECT count(*) AS n FROM sync_index WHERE kind = 'run' AND field = 'status'")
        .get() as { n: number }
    ).n;
  t.is(count(), 1);
  t.deepEqual(migrate(db), ["0005_review_r2_phase2.sql"]);
  t.is(count(), 0);
});
