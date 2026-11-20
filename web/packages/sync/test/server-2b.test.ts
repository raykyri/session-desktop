// Phase 2b: the space directory (`SyncServer.directory`), which the web
// client's Home, header and Browse read, and the `space.vis` index it scans
// (migration 0003 for the spaces stored before it).

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import test from "ava";
import BetterSqlite from "better-sqlite3";

import { SYNC_MIGRATIONS, SqliteServerStore, migrate } from "../src/server/index.js";

import { STORES, cast, ok } from "./helpers.js";

for (const kind of STORES) {
  test(`${kind}: the directory lists the open and listed spaces, and unlisted ones to their members`, (t) => {
    const { w, open, closed } = cast(t, kind);
    const hidden = w.id();
    ok(
      t,
      w.as("olga", "spaces.create", { id: hidden, name: "attic", vis: "unlisted", policy: "invite" }),
    );
    const names = (u: string | null) =>
      w.server.directory(u === null ? null : { u }).spaces.map((s) => s.name);
    const stats = (u: string | null) =>
      w.server
        .directory(u === null ? null : { u })
        .stats.map((s) => s.sp)
        .sort();
    // by name; an unlisted space only to its members
    t.deepEqual(names(null), ["lab", "lounge"]);
    t.deepEqual(names("otto"), ["lab", "lounge"]);
    t.deepEqual(names("olga"), ["attic", "lab", "lounge"]);
    // stats only where the reader reads the content
    t.deepEqual(stats(null), [open]);
    t.deepEqual(stats("otto"), [open]);
    t.deepEqual(stats("mel"), [open, closed].sort());
    t.deepEqual(stats("olga"), [open, closed, hidden].sort());
    t.true(Number.isFinite(w.server.directory(null).serverTime));
    // a deleted space is not listed
    ok(t, w.as("olga", "spaces.delete", { id: open }));
    t.deepEqual(names("mel"), ["lab"]);
    // a space that changes visibility moves with its index
    ok(t, w.as("olga", "spaces.update", { id: closed, set: { vis: "unlisted", policy: "invite" } }));
    t.deepEqual(names("otto"), []);
    t.deepEqual(names("mel"), ["lab"]);
  });
}

test("migration 0003 indexes the spaces stored before it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sync-mig-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const src = fileURLToPath(SYNC_MIGRATIONS);
  for (const f of ["0001_sync.sql", "0002_review_r1.sql"]) cpSync(join(src, f), join(dir, f));
  const db = new BetterSqlite(":memory:");
  t.deepEqual(migrate(db, dir), ["0001_sync.sql", "0002_review_r1.sql"]);
  const space = { kind: "space", id: "S1", name: "old", vis: "open", deleted: false, rev: 1 };
  db.prepare("INSERT INTO sync_records (key, kind, body, born) VALUES (?, ?, ?, ?)").run(
    "space:S1",
    "space",
    JSON.stringify(space),
    1,
  );
  t.deepEqual(migrate(db), ["0003_space_vis.sql"]);
  const store = new SqliteServerStore(db, { migrations: false });
  const found = store.transaction((tx) => tx.scan("space", "vis", "open").map((r) => r.kind));
  t.deepEqual(found, ["space"]);
});
