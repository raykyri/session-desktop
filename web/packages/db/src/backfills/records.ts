// Record shape versions (`15-implementation-plan/01-architecture-and-
// data.md` D7). A record kind's stored shape changes through a versioned
// backfill that rewrites `body` and bumps `rev`, and writes a change-log row
// for every rewritten key, so that every replica pulls the new shape: one
// new version for the whole step, a `put` row in each log the record is
// written to, and the registry's last rev. It runs as one of `BACKFILLS`,
// inside the transaction `runBackfills` gives it, after the migrations.
//
// The stored body is read as raw JSON, not through `SqliteStore.byKey`,
// which validates against the current schema: the old shape is the one a
// backfill exists to change, and the current schema may refuse it. Only the
// rewritten record is validated, by `putRecord`.

import { logsOf, registryKey, type Kind, type StoredRecord } from "@session/mutators";
import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { SqliteStore } from "../sync/store.js";

import type { Backfill } from "./index.js";

/** A record's body as stored: JSON with a kind and a rev, of any shape. */
export type StoredBody = { kind: string; rev: number } & Record<string, unknown>;

export interface RecordBackfillSpec {
  /** Recorded in `backfills`; never reused or renamed. */
  id: string;
  description: string;
  kind: Kind;
  /** The new shape of one record, from its stored shape as parsed JSON,
   * which the current schema need not accept (`rev` is set by the backfill).
   * A record returned equal is left as it is. */
  rewrite: (record: StoredBody) => StoredRecord;
}

/** Rewrite every record of `spec.kind` with `spec.rewrite` under one new
 * version. Returns how many records it rewrote. */
export function rewriteRecords(db: SessionDatabase, spec: RecordBackfillSpec): number {
  const store = new SqliteStore(db);
  return store.transaction(() => {
    const rows = store.sqlite
      .prepare<[string], { key: string; body: string }>(
        "SELECT key, body FROM records WHERE kind = ? ORDER BY created_v, key",
      )
      .all(spec.kind);
    let version: number | null = null;
    let n = 0;
    for (const { key, body } of rows) {
      const old = JSON.parse(body) as StoredBody;
      const next = spec.rewrite(structuredClone(old));
      if (JSON.stringify({ ...next, rev: 0 }) === JSON.stringify({ ...old, rev: 0 })) continue;
      if (next.kind !== old.kind)
        throw new Error(`${spec.id}: a backfill may not change a record's kind`);
      version ??= store.nextVersion();
      const rec: StoredRecord = { ...next, rev: old.rev + 1 };
      store.putRecord(key, rec, null);
      store.setLastRev(registryKey(rec), rec.rev);
      for (const log of logsOf(rec)) store.putLogRow(log, { key, op: "put", version });
      n += 1;
    }
    return n;
  });
}

/** A `Backfill` that rewrites one record kind (`rewriteRecords`). */
export function recordBackfill(spec: RecordBackfillSpec): Backfill {
  return {
    id: spec.id,
    description: spec.description,
    run: (db) => {
      rewriteRecords(db, spec);
    },
  };
}

/** Adds a `put` row to the banned person's user log for every ban stored
 * before bans were written there (`personOf`, `01` C18), under one new
 * version, so the banned person's replica pulls their own ban. A ban that
 * already has its row is left as it is. Returns how many rows it wrote.
 * Plain SQL over `db`, which is the transaction `runBackfills` gives (a
 * drizzle transaction, which `SqliteStore` does not take). */
export function logBansInUserLogs(db: SessionDatabase): number {
  return db.transaction((tx) => {
    const rows = tx.all<{ key: string; body: string }>(
      sql`SELECT key, body FROM records WHERE kind = 'ban' ORDER BY created_v, key`,
    );
    let version: number | null = null;
    let n = 0;
    for (const { key, body } of rows) {
      const log = `user:${(JSON.parse(body) as { u: string }).u}`;
      const held = tx.all(sql`SELECT 1 FROM change_log WHERE log = ${log} AND key = ${key}`);
      if (held.length > 0) continue;
      if (version === null) {
        const head = tx.all<{ version: number }>(
          sql`UPDATE server_head SET version = version + 1 WHERE id = 1 RETURNING version`,
        );
        if (!head[0]) throw new Error("server_head has no row");
        version = head[0].version;
      }
      tx.run(
        sql`INSERT INTO change_log (log, key, op, version) VALUES (${log}, ${key}, 'put', ${version})`,
      );
      n += 1;
    }
    return n;
  });
}

/** `logBansInUserLogs` as a step of `BACKFILLS`. */
export const banUserLogs: Backfill = {
  id: "0007-ban-user-logs",
  description: "write each stored ban to the banned person's user log",
  run: (db) => {
    logBansInUserLogs(db);
  },
};
