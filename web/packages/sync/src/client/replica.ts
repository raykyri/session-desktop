// The client's replica (`01` Y9): one state per log (records, cursor token,
// the threads held in full, the last seq the server reported), kept behind a
// `StorageAdapter`, and a merged view of every log with the indexes the
// mutators read through. The web client keeps it in memory only
// (`MemoryAdapter`); a persistent adapter can be added without changing the
// replica.
//
// Tiers (`01` R2): a snapshot of a `summary`, `window` or `threads` tier
// names the threads it served in full. A pull is not tiered: the replica
// drops the node, answer, reply, comment and run changes of threads it holds
// as summaries, and holds a thread that first arrives by a pull (a new one)
// in full.

import { indexOf, type Index, type Kind, type LogId, type StoredRecord } from "@session/mutators";

import type { Change, Cursor, LastSeq, Snapshot } from "../wire.js";

/** What the replica keeps of one log. `full`: the threads held in full, or
 * null for every thread (a `full` snapshot, and user logs). */
export interface LogState {
  cursor: Cursor;
  records: Map<string, StoredRecord>;
  full: Set<string> | null;
  /** The last seq the server reported for this client at the log's last
   * read. */
  seq: LastSeq;
}

/** Where the replica keeps its logs. Synchronous: the web client's is memory. */
export interface StorageAdapter {
  logs(): LogId[];
  get(log: LogId): LogState | undefined;
  set(log: LogId, state: LogState): void;
  delete(log: LogId): void;
}

export class MemoryAdapter implements StorageAdapter {
  private readonly states = new Map<LogId, LogState>();
  logs() {
    return [...this.states.keys()];
  }
  get(log: LogId) {
    return this.states.get(log);
  }
  set(log: LogId, state: LogState) {
    this.states.set(log, state);
  }
  delete(log: LogId) {
    this.states.delete(log);
  }
}

/** The kinds a summary thread does not hold. */
export const CONTENT_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "node",
  "answer",
  "reply",
  "comment",
  "run",
  "turn",
]);

/** The thread a record belongs to, or null. */
export const threadOf = (r: StoredRecord): string | null =>
  r.kind === "thread"
    ? r.id
    : r.kind === "counts" || CONTENT_KINDS.has(r.kind)
      ? (r as { th: string }).th
      : null;

const indexName = (kind: Kind, col: "sp" | "th" | "u", v: string) =>
  `${kind}\u0000${col}\u0000${v}`;

export class Replica {
  /** The records of every log, merged: a key two logs hold (a membership in
   * its space log and its person's user log) is the record with the higher
   * rev. */
  private readonly merged = new Map<string, StoredRecord>();
  private readonly holders = new Map<string, Set<LogId>>();
  private readonly indexes = new Map<string, Set<string>>();

  constructor(readonly adapter: StorageAdapter = new MemoryAdapter()) {
    for (const log of adapter.logs())
      for (const key of adapter.get(log)?.records.keys() ?? []) this.hold(log, key);
    this.refresh(new Set(this.holders.keys()));
  }

  logs(): LogId[] {
    return this.adapter.logs();
  }

  state(log: LogId): LogState | undefined {
    return this.adapter.get(log);
  }

  records(log: LogId): ReadonlyMap<string, StoredRecord> {
    return this.adapter.get(log)?.records ?? new Map<string, StoredRecord>();
  }

  /** Whether `th` is held in full (or not held at all: not a summary). */
  isFull(log: LogId, th: string): boolean {
    const full = this.adapter.get(log)?.full;
    return full === null || full === undefined || full.has(th);
  }

  /** Whether a log holds every thread in full (a `full` snapshot, or no
   * tier). */
  fullLog(log: LogId): boolean {
    const s = this.adapter.get(log);
    return s !== undefined && s.full === null;
  }

  /** Forget the seqs the logs were read at: they were another client id's. */
  resetSeqs(): void {
    for (const log of this.adapter.logs()) {
      const s = this.adapter.get(log);
      if (s) this.adapter.set(log, { ...s, seq: null });
    }
  }

  /** The log that holds a thread record, if any. */
  logOfThread(th: string): LogId | undefined {
    for (const log of this.holders.get(`thread:${th}`) ?? []) return log;
    return undefined;
  }

  private hold(log: LogId, key: string) {
    let h = this.holders.get(key);
    if (!h) this.holders.set(key, (h = new Set<LogId>()));
    h.add(log);
  }

  private release(log: LogId, key: string) {
    const h = this.holders.get(key);
    h?.delete(log);
    if (h?.size === 0) this.holders.delete(key);
  }

  /** Recompute the merged record and its index entries for `keys`. */
  private refresh(keys: Iterable<string>) {
    for (const key of keys) {
      const old = this.merged.get(key);
      let best: StoredRecord | undefined;
      for (const log of this.holders.get(key) ?? []) {
        const r = this.adapter.get(log)?.records.get(key);
        if (r && (!best || r.rev >= best.rev)) best = r;
      }
      if (old) this.index(old, key, false);
      if (best) {
        this.merged.set(key, best);
        this.index(best, key, true);
      } else this.merged.delete(key);
    }
  }

  private index(r: StoredRecord, key: string, on: boolean) {
    const cols = indexOf(r);
    for (const col of ["sp", "th", "u"] as const) {
      const v = cols[col];
      if (v === null) continue;
      const name = indexName(r.kind, col, v);
      let set = this.indexes.get(name);
      if (on) {
        if (!set) this.indexes.set(name, (set = new Set<string>()));
        set.add(key);
      } else {
        set?.delete(key);
        if (set?.size === 0) this.indexes.delete(name);
      }
    }
    const all = `${r.kind}\u0000*`;
    let set = this.indexes.get(all);
    if (on) {
      if (!set) this.indexes.set(all, (set = new Set<string>()));
      set.add(key);
    } else set?.delete(key);
  }

  /** Replace a log's state with a snapshot. Returns the keys that changed. */
  applySnapshot(log: LogId, snap: Snapshot): Set<string> {
    const before = this.adapter.get(log);
    const records = new Map(snap.records.map((x) => [x.key, x.record]));
    const changed = new Set<string>();
    for (const [k, r] of before?.records ?? []) {
      this.release(log, k);
      if (records.get(k) !== r) changed.add(k);
    }
    for (const k of records.keys()) {
      this.hold(log, k);
      changed.add(k);
    }
    this.adapter.set(log, {
      cursor: snap.cursor,
      records,
      full: snap.full ? new Set(snap.full) : null,
      seq: snap.lastSeq,
    });
    this.refresh(changed);
    return changed;
  }

  /** Add a `threads` snapshot's records to a log (promotion, R3); the threads
   * become full. The log's cursor is kept: later pulls bring the changes. */
  addThreads(log: LogId, snap: Snapshot, threads: readonly string[]): Set<string> {
    const s = this.adapter.get(log);
    const changed = new Set<string>();
    if (!s) return changed;
    // merged by rev: a pull applied in between may hold a newer record
    for (const { key, record } of snap.records) {
      const held = s.records.get(key);
      if (held && held.rev > record.rev) continue;
      s.records.set(key, record);
      this.hold(log, key);
      changed.add(key);
    }
    if (s.full) for (const th of threads) s.full.add(th);
    this.adapter.set(log, s);
    this.refresh(changed);
    return changed;
  }

  /** Apply a pull batch to a log. Returns the keys that changed. */
  applyPull(log: LogId, changes: readonly Change[], cursor: Cursor, seq: LastSeq): Set<string> {
    const s = this.adapter.get(log);
    const changed = new Set<string>();
    if (!s) return changed;
    for (const c of changes) {
      if (c.op === "del") {
        if (s.records.delete(c.key)) {
          this.release(log, c.key);
          changed.add(c.key);
        }
        continue;
      }
      const r = c.record;
      // a record held at a newer rev (a promotion's snapshot) is kept
      const held = s.records.get(c.key);
      if (held && held.rev > r.rev) continue;
      if (s.full) {
        // a thread that first arrives by a pull is new: in the window
        if (r.kind === "thread" && !s.records.has(c.key)) s.full.add(r.id);
        const th = threadOf(r);
        if (CONTENT_KINDS.has(r.kind) && th !== null && !s.full.has(th)) continue;
      }
      s.records.set(c.key, r);
      this.hold(log, c.key);
      changed.add(c.key);
    }
    s.cursor = cursor;
    s.seq = seq;
    this.adapter.set(log, s);
    this.refresh(changed);
    return changed;
  }

  /** Forget a log. Returns the keys that changed. */
  dropLog(log: LogId): Set<string> {
    const s = this.adapter.get(log);
    const changed = new Set<string>();
    for (const k of s?.records.keys() ?? []) {
      this.release(log, k);
      changed.add(k);
    }
    this.adapter.delete(log);
    this.refresh(changed);
    return changed;
  }

  // ---- the merged view ----

  get(key: string): StoredRecord | undefined {
    return this.merged.get(key);
  }

  all(): ReadonlyMap<string, StoredRecord> {
    return this.merged;
  }

  /** The keys of `kind` in an index, over the merged view. */
  keysIn(kind: Kind, index: Index): string[] {
    const [col, v] = Object.entries(index)[0] as ["sp" | "th" | "u", string];
    return [...(this.indexes.get(indexName(kind, col, v)) ?? [])];
  }

  keysOfKind(kind: Kind): string[] {
    return [...(this.indexes.get(`${kind}\u0000*`) ?? [])];
  }
}
