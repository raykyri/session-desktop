// The server half's storage: one interface with a synchronous transaction,
// implemented over memory (`memory.ts`) and over SQLite (`sqlite.ts`, the
// schema in `migrations/`). Everything a write changes (records, log rows,
// tombstones, the id registry, the stored answer, the client's seq and the
// queued effects) is written in one `transaction`, which commits all of it or
// nothing.
//
// Expiring tables are read by time (`*Before`), so housekeeping takes a
// bounded batch from the oldest end and never walks a whole table.

import type { Audience, Effect, LogId, StoredRecord } from "@session/mutators";

/** One change-log row: key, operation and version only, no record content. */
export interface LogRow {
  key: string;
  op: "put" | "del";
  version: number;
}

/** What a deleted record leaves for 30 days: its key, kind and audience
 * fields, and the delete's time. No text; its last rev is in the registry. */
export interface Tombstone extends Audience {
  key: string;
  at: number;
}

/** A recorded answer: the answer without `serverTime`, `current` and
 * `changes`, with the keys a STALE answer is about (`reads`), so no record
 * text is stored with it; a replay reads them again. `digest` identifies
 * the payload (name and input, or for a (client, seq) answer the mutation id
 * too). */
export interface StoredAnswer {
  digest: string;
  answer: StoredResult;
  at: number;
}

/** `as`: the mutation id the write was processed under (absent on answers
 * stored before review round 2 of phase 1, and on answers kept by seq). */
export type StoredResult =
  | { ok: true; result: unknown; seq: number; as?: string }
  | {
      ok: false;
      error: { code: string; message: string; issues?: string[]; retryAt?: string };
      reads?: string[];
      seq: number;
      as?: string;
    };

/** A registered client: its user, its device (null for a browser), its last
 * processed seq and when it was last used. */
export interface ClientRec {
  u: string;
  device: string | null;
  last: number;
  seen: number;
}

/** One entry of the effect queue. */
export interface QueuedEffect {
  id: number;
  effect: Effect;
  /** The commit time of the write that queued it. */
  at: number;
  attempts: number;
  /** The time of the next attempt. */
  next: number;
}

export interface DeadLetter {
  id: number;
  effect: Effect;
  at: number;
  attempts: number;
  failedAt: number;
}

/** A device's token, by device: its user, the token's SHA-256 (never the
 * token) and when it was revoked. */
export interface DeviceToken {
  device: string;
  u: string;
  hash: string;
  revokedAt: number | null;
}

/** A device sign-in started by the app (`devices.authorize`). */
export interface Signin {
  request: string;
  code: string;
  name: string;
  kind: "mac" | "phone";
  at: number;
  state: "waiting" | "approved" | "denied" | "taken";
  u: string | null;
  /** The device's id, chosen at the approval; its record and token are made
   * when the app takes the token, so no token is ever stored. */
  device: string | null;
}

/** A device run's lease, kept apart from the run record (never replicated)
 * so a heartbeat changes no log and expiry finds the ended leases by time:
 * when it ends unless the device sends a heartbeat, the last heartbeat, and
 * the number of the attempt's last in-flight event. */
export interface Lease {
  run: string;
  until: number;
  beat: number;
  seq: number;
}

/** A log's history: how many times it was replaced (a space opening or
 * closing changes who reads it), and the version the current one began at. */
export interface Epoch {
  n: number;
  start: number;
}

export interface StoreTx {
  // ---- server state ----
  /** The highest version committed. */
  head(): number;
  setHead(version: number): void;
  /** The highest time the server used: its clock never goes back. */
  lastTime(): number;
  setLastTime(ms: number): void;
  /** The database's instance id (0 until one is set): cursor tokens carry
   * it, so a token served by another database, or by this one before a
   * restore from a backup, answers resync. */
  instance(): number;
  setInstance(id: number): void;

  // ---- records ----
  get(key: string): StoredRecord | undefined;
  /** The records of `kind` whose `field` equals `value` (an `INDEXES` scan). */
  scan(kind: string, field: string, value: string): StoredRecord[];
  /** Write a record; `born` is the version of the commit that created it. */
  put(key: string, record: StoredRecord, born: number): void;
  del(key: string): void;
  /** The version of the commit that created a stored record. */
  born(key: string): number | undefined;

  // ---- the id registry: every id and key ever written, with its last rev ----
  registryGet(id: string): number | undefined;
  registrySet(id: string, rev: number): void;

  // ---- the change log ----
  logPut(log: LogId, row: LogRow): void;
  logDelete(log: LogId, key: string): void;
  logGet(log: LogId, key: string): LogRow | undefined;
  /** The rows of a log with a version above `after`, by version. */
  logAfter(log: LogId, after: number): LogRow[];
  epoch(log: LogId): Epoch;
  setEpoch(log: LogId, e: Epoch): void;
  /** The logs whose history was replaced after `version` (epoch start
   * above it). */
  epochsAfter(version: number): LogId[];

  // ---- tombstones ----
  tombGet(key: string): Tombstone | undefined;
  tombPut(t: Tombstone): void;
  tombDelete(key: string): void;
  /** At most `limit` tombstones committed before `at`, oldest first. */
  tombsBefore(at: number, limit: number): Tombstone[];

  // ---- recorded answers ----
  answerGet(u: string, mutationId: string): StoredAnswer | undefined;
  answerPut(u: string, mutationId: string, a: StoredAnswer): void;
  seqAnswerGet(clientId: string, seq: number): StoredAnswer | undefined;
  seqAnswerPut(clientId: string, seq: number, a: StoredAnswer): void;
  /** Delete at most `limit` answers of each table stored before `at`. */
  answersPrune(at: number, limit: number): number;

  // ---- clients ----
  clientGet(id: string): ClientRec | undefined;
  clientPut(id: string, c: ClientRec): void;
  /** Delete at most `limit` clients last used before `at`. */
  clientsPrune(at: number, limit: number): number;
  /** The clients a device registered (for a revoked device). */
  clientsOfDevice(device: string): string[];
  clientDelete(id: string): void;
  /** A person's registrations at `since` or later. */
  registrations(u: string, since: number): number;
  registrationAdd(u: string, at: number): void;
  registrationsPrune(at: number, limit: number): number;

  // ---- effects ----
  effectAdd(effect: Effect, at: number): void;
  /** At most `limit` queued effects due at `now`, oldest first. */
  effectsDue(now: number, limit: number): QueuedEffect[];
  effectUpdate(id: number, attempts: number, next: number): void;
  effectDelete(id: number): void;
  deadLetterAdd(d: Omit<DeadLetter, "id">): void;

  // ---- devices and device runs (online-only calls) ----
  tokenGet(device: string): DeviceToken | undefined;
  tokenByHash(hash: string): DeviceToken | undefined;
  tokenPut(t: DeviceToken): void;
  signinGet(request: string): Signin | undefined;
  signinPut(s: Signin): void;
  signinsPrune(at: number, limit: number): number;
  leaseGet(run: string): Lease | undefined;
  leasePut(l: Lease): void;
  leaseDelete(run: string): void;
  leasesBefore(at: number, limit: number): Lease[];
  /** The device runs a person started (the hourly limit counts them, not run
   * records, which a deleted thread takes with it). */
  deviceRunAdd(u: string, at: number): void;
  /** The start times of `u`'s device runs after `since`. */
  deviceRunsSince(u: string, since: number): number[];
  deviceRunsPrune(at: number, limit: number): number;
}

/** Every value at rest, table by table (tests: the erasure checks). */
export interface StoreDump {
  records: { key: string; record: StoredRecord; born: number }[];
  registry: { id: string; rev: number }[];
  logRows: (LogRow & { log: LogId })[];
  epochs: (Epoch & { log: LogId })[];
  tombstones: Tombstone[];
  answers: {
    u?: string;
    mutationId?: string;
    clientId?: string;
    seq?: number;
    digest: string;
    answer: StoredResult;
    at: number;
  }[];
  clients: (ClientRec & { clientId: string })[];
  registrations: { u: string; at: number }[];
  effects: QueuedEffect[];
  deadLetters: DeadLetter[];
  tokens: DeviceToken[];
  signins: Signin[];
  leases: Lease[];
  deviceRuns: { u: string; at: number }[];
}

export interface ServerStore {
  /** Run `fn` in one transaction: all its writes commit, or (it threw) none. */
  transaction<T>(fn: (tx: StoreTx) => T): T;
  /** Every value at rest (tests). */
  dump(): StoreDump;
  /** The stored records by key (tests and operators). */
  records(): Map<string, StoredRecord>;
  close?(): void;
}
