// Record shape versions (`15-implementation-plan/01-architecture-and-
// data.md` D7). A record kind's stored shape changes through a versioned
// backfill that rewrites `body` and bumps `rev`, and writes a change-log row
// for every rewritten key, so that every replica pulls the new shape: one
// new version for the whole step, a `put` row in each log the record is
// written to, and the registry's last rev. It runs as one of `BACKFILLS`,
// inside the transaction `runBackfills` gives it, after the migrations.

import { logsOf, registryKey, type Kind, type StoredRecord } from "@session/mutators";

import type { SessionDatabase } from "../connection.js";
import { SqliteStore } from "../sync/store.js";

import type { Backfill } from "./index.js";

export interface RecordBackfillSpec {
  /** Recorded in `backfills`; never reused or renamed. */
  id: string;
  description: string;
  kind: Kind;
  /** The new shape of one record, from its stored shape (`rev` is set by the
   * backfill). A record returned equal is left as it is. */
  rewrite: (record: StoredRecord) => StoredRecord;
}

/** Rewrite every record of `spec.kind` with `spec.rewrite` under one new
 * version. Returns how many records it rewrote. */
export function rewriteRecords(db: SessionDatabase, spec: RecordBackfillSpec): number {
  const store = new SqliteStore(db);
  return store.transaction(() => {
    const keys = store.sqlite
      .prepare<[string], { key: string }>(
        "SELECT key FROM records WHERE kind = ? ORDER BY created_v",
      )
      .all(spec.kind)
      .map((r) => r.key);
    let version: number | null = null;
    let n = 0;
    for (const key of keys) {
      const old = store.byKey(key);
      if (!old) continue;
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
