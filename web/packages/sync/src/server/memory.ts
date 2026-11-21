// `MemoryStore`: a `ServerStore` in maps, for the tests and the
// prototype's suite (M2). Every table that expires is a Map kept in expiry
// order (a value written again moves to the end), so a prune drops only what
// expired from its front and stops at the first value that has not.
//
// A transaction keeps an undo log: every write inside it records how to
// take it back, and a throw takes back every write of the outermost
// transaction, so a fault mid-commit leaves the store as it was (as SQLite's
// rollback does).
//
// The store has no users table: a handle is an account once it registered a
// client (the prototype's rule), or after `setAccount`.

import {
  indexOf,
  uniqueOf,
  type Index,
  type Kind,
  type LogId,
  type StoredRecord,
  type UniqueIndex,
} from "@session/mutators";

import type {
  AccountStatus,
  AnswerRow,
  ClientRow,
  Epoch,
  LogRow,
  SeqAnswerRow,
  ServerStore,
  Tombstone,
} from "./store.js";

/** The name of an index entry: a kind and one of its index columns. */
const indexName = (kind: Kind, col: "sp" | "th" | "u", v: string) =>
  `${kind}\u0000${col}\u0000${v}`;
const UNIQUE: readonly UniqueIndex[] = ["space.name", "invite.code"];

export class MemoryStore implements ServerStore {
  readonly records = new Map<string, StoredRecord>();
  readonly byKind = new Map<Kind, Set<string>>();
  private readonly indexes = new Map<string, Set<string>>();
  private readonly uniques = new Map<string, string>();
  /** In the order they were made, so oldest first. */
  readonly tombs = new Map<string, Tombstone>();
  /** The version and time of the commit that created each record now stored. */
  readonly born = new Map<string, { version: number; at: number }>();
  /** Every id and key ever written, with its last rev. */
  readonly registry = new Map<string, number>();
  readonly logs = new Map<LogId, Map<string, LogRow>>();
  readonly epochs = new Map<LogId, Epoch>();
  private headValue = 0;
  /** Registered clients, least recently used first. */
  readonly clients = new Map<string, ClientRow>();
  /** Each person's registrations in the past day, by the time of their
   * latest, oldest first. */
  readonly registrations = new Map<string, number[]>();
  /** Answers by (user, mutation id), oldest first. */
  readonly answers = new Map<string, AnswerRow>();
  /** Answers by (client, seq), oldest first. */
  readonly seqAnswers = new Map<string, SeqAnswerRow>();
  readonly accounts = new Map<string, AccountStatus>();

  private undo: (() => void)[] | null = null;

  /** Record how to take a write back, inside a transaction. */
  private journal(f: () => void) {
    this.undo?.push(f);
  }

  /** Set `key` in an expiry-ordered map, as the newest value, undoably. */
  private setLast<K, V>(m: Map<K, V>, key: K, value: V) {
    this.restoreLater(m, key);
    m.delete(key);
    m.set(key, value);
  }

  private remove<K, V>(m: Map<K, V>, key: K) {
    if (!m.has(key)) return;
    this.restoreLater(m, key);
    m.delete(key);
  }

  /** Undo for a map entry: put back the value (and its place) it had. A
   * rollback restores entries in reverse order, so places are kept up to
   * the order of the entries it touched. */
  private restoreLater<K, V>(m: Map<K, V>, key: K) {
    if (!this.undo) return;
    const had = m.has(key);
    const old = m.get(key);
    const order = had ? [...m.keys()] : null;
    this.journal(() => {
      if (!had) {
        m.delete(key);
        return;
      }
      m.set(key, old as V);
      // the entry's place in an expiry order: rebuild the map in the order
      // it had
      if (order) {
        const entries = new Map(m);
        m.clear();
        for (const k of order) if (entries.has(k)) m.set(k, entries.get(k) as V);
        for (const [k, v] of entries) if (!m.has(k)) m.set(k, v);
      }
    });
  }

  transaction<T>(fn: () => T): T {
    if (this.undo) return fn();
    const undo: (() => void)[] = [];
    this.undo = undo;
    try {
      const out = fn();
      this.undo = null;
      return out;
    } catch (e) {
      this.undo = null;
      for (const f of undo.reverse()) f();
      throw e;
    }
  }

  // ---- Source ----

  byKey(key: string) {
    return this.records.get(key);
  }

  keysIn(kind: Kind, index: Index): Iterable<string> {
    const [col, v] = Object.entries(index)[0] as ["sp" | "th" | "u", string];
    return [...(this.indexes.get(indexName(kind, col, v)) ?? [])];
  }

  uniqueKey(index: UniqueIndex, value: string): string | undefined {
    return this.uniques.get(`${index}\u0000${value}`);
  }

  idTaken(id: string): boolean {
    return this.registry.has(id);
  }

  lastRev(name: string): number | undefined {
    return this.registry.get(name);
  }

  // ---- records ----

  /** Add a record's key to its indexes, or take it out. */
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
    for (const u of UNIQUE) {
      const v = uniqueOf(r, u);
      if (v === null) continue;
      const name = `${u}\u0000${v}`;
      if (on) this.uniques.set(name, key);
      else if (this.uniques.get(name) === key) this.uniques.delete(name);
    }
    let kind = this.byKind.get(r.kind);
    if (!kind) this.byKind.set(r.kind, (kind = new Set<string>()));
    if (on) kind.add(key);
    else kind.delete(key);
  }

  putRecord(key: string, record: StoredRecord, created: { version: number; at: number } | null) {
    const prev = this.records.get(key);
    const born = this.born.get(key);
    this.journal(() => {
      const now = this.records.get(key);
      if (now) this.index(now, key, false);
      if (prev) {
        this.records.set(key, prev);
        this.index(prev, key, true);
      } else this.records.delete(key);
      if (born) this.born.set(key, born);
      else this.born.delete(key);
    });
    if (prev) this.index(prev, key, false);
    this.index(record, key, true);
    this.records.set(key, record);
    if (created) this.born.set(key, created);
  }

  deleteRecord(key: string) {
    const prev = this.records.get(key);
    if (!prev) return;
    const born = this.born.get(key);
    this.journal(() => {
      this.records.set(key, prev);
      this.index(prev, key, true);
      if (born) this.born.set(key, born);
    });
    this.records.delete(key);
    this.index(prev, key, false);
    this.born.delete(key);
  }

  createdVersion(key: string) {
    return this.born.get(key)?.version;
  }

  keysCreatedBefore(kind: Kind, at: number): string[] {
    return [...(this.byKind.get(kind) ?? [])]
      .filter((k) => (this.born.get(k)?.at ?? 0) < at)
      .sort((a, b) => (this.born.get(a)?.version ?? 0) - (this.born.get(b)?.version ?? 0));
  }

  setLastRev(name: string, rev: number) {
    const had = this.registry.has(name);
    const old = this.registry.get(name);
    this.journal(() => (had ? this.registry.set(name, old as number) : this.registry.delete(name)));
    this.registry.set(name, rev);
  }

  // ---- tombstones ----

  tombstone(key: string) {
    return this.tombs.get(key);
  }

  putTombstone(t: Tombstone) {
    this.setLast(this.tombs, t.key, t);
  }

  deleteTombstone(key: string) {
    this.remove(this.tombs, key);
  }

  pruneTombstones(at: number) {
    for (const [key, t] of this.tombs) {
      if (t.at >= at) break;
      this.remove(this.tombs, key);
      for (const rows of this.logs.values())
        if (rows.get(key)?.op === "del") this.remove(rows, key);
    }
  }

  // ---- change log ----

  head() {
    return this.headValue;
  }

  nextVersion() {
    const old = this.headValue;
    this.journal(() => (this.headValue = old));
    return ++this.headValue;
  }

  putLogRow(log: LogId, row: LogRow) {
    let rows = this.logs.get(log);
    if (!rows) this.logs.set(log, (rows = new Map<string, LogRow>()));
    this.setLast(rows, row.key, { ...row });
  }

  logRow(log: LogId, key: string) {
    return this.logs.get(log)?.get(key);
  }

  logRows(log: LogId, after: number): LogRow[] {
    // a log's rows are kept in version order: a written row moves to the end
    const out: LogRow[] = [];
    for (const r of this.logs.get(log)?.values() ?? []) if (r.version > after) out.push({ ...r });
    return out;
  }

  epoch(log: LogId): Epoch {
    return this.epochs.get(log) ?? { n: 0, start: 0 };
  }

  setEpoch(log: LogId, epoch: Epoch) {
    this.setLast(this.epochs, log, { ...epoch });
  }

  // ---- clients ----

  client(clientId: string) {
    const c = this.clients.get(clientId);
    return c ? { ...c } : undefined;
  }

  putClient(row: ClientRow) {
    if (!this.clients.has(row.clientId)) {
      this.setLast(this.registrations, row.u, [
        ...(this.registrations.get(row.u) ?? []),
        row.createdAt,
      ]);
      if (!this.accounts.has(row.u)) {
        this.journal(() => this.accounts.delete(row.u));
        this.accounts.set(row.u, "active");
      }
    }
    this.setLast(this.clients, row.clientId, { ...row });
  }

  registrationsSince(u: string, at: number) {
    return (this.registrations.get(u) ?? []).filter((x) => x >= at).length;
  }

  pruneClients(at: number) {
    for (const [id, c] of this.clients) {
      if (c.seen >= at) break;
      this.remove(this.clients, id);
    }
  }

  pruneRegistrations(at: number) {
    for (const [u, times] of this.registrations) {
      if ((times.at(-1) ?? 0) >= at) break;
      this.remove(this.registrations, u);
    }
  }

  // ---- answers ----

  answer(u: string, mutationId: string) {
    return this.answers.get(`${u}\u0000${mutationId}`);
  }

  putAnswer(row: AnswerRow) {
    this.setLast(this.answers, `${row.u}\u0000${row.mutationId}`, row);
  }

  seqAnswer(clientId: string, seq: number) {
    return this.seqAnswers.get(`${clientId}\u0000${seq}`);
  }

  putSeqAnswer(row: SeqAnswerRow) {
    this.setLast(this.seqAnswers, `${row.clientId}\u0000${row.seq}`, row);
  }

  pruneAnswers(at: number) {
    for (const [k, d] of this.answers) {
      if (d.at >= at) break;
      this.remove(this.answers, k);
    }
    for (const [k, a] of this.seqAnswers) {
      if (a.at >= at) break;
      this.remove(this.seqAnswers, k);
    }
  }

  // ---- accounts ----

  isAccount(handle: string) {
    return this.accounts.has(handle);
  }

  accountStatus(handle: string): AccountStatus | null {
    return this.accounts.get(handle) ?? "active";
  }

  /** Make `handle` an account with this standing (a test's users table). */
  setAccount(handle: string, status: AccountStatus) {
    this.accounts.set(handle, status);
  }
}
