// `ServerStore`: the storage the server half runs on (`01` D1, D2). The
// sync logic (apply, commit, reads, retention) is in `SyncServer`; a store
// only keeps rows. `MemoryStore` (this package) keeps them in maps for the
// tests; `@session/db` implements the same interface over SQLite (M3), where
// every method is a statement and `transaction` is `db.transaction()`.
//
// Every method is synchronous: a mutator's stages run on a synchronous `tx`
// inside one transaction with no `await` between the permission check and
// the commit (`01` §1).

import type { Audience, LogId, Source, StoredRecord } from "@session/mutators";

import type { StoredAnswer } from "../wire.js";

/** One change-log row (`change_log`): key, operation and version only. */
export interface LogRow {
  key: string;
  op: "put" | "del";
  version: number;
}

/** What a deleted record leaves for 30 days (`tombstones`): its key, kind and
 * audience, no text. Its last rev is in the registry. */
export interface Tombstone extends Audience {
  key: string;
  /** The commit time of the delete (ms). */
  at: number;
}

/** A log's history (`log_epochs`): how many times it was replaced, and the
 * version the current one began at. A log never replaced is `{ n: 0, start:
 * 0 }`. */
export interface Epoch {
  n: number;
  start: number;
}

/** A registered client (`clients`). */
export interface ClientRow {
  clientId: string;
  /** The user it is bound to. */
  u: string;
  /** The last seq the server processed for it. */
  last: number;
  /** When it was registered, and last used (a write, a read with its id, a
   * re-attach), in ms. */
  createdAt: number;
  seen: number;
}

/** An answer recorded under (user, mutation id) (`answers`). `digest` hashes
 * the name and canonical input; `"*"` marks an answer stored under a
 * mutation id a reminted envelope replaced. */
export interface AnswerRow {
  u: string;
  mutationId: string;
  digest: string;
  result: StoredAnswer;
  at: number;
}

/** An answer recorded under (client, seq): for a mutation id that is
 * malformed or already used for another payload. `digest` hashes the
 * mutation id, name and input. */
export interface SeqAnswerRow {
  clientId: string;
  seq: number;
  digest: string;
  result: StoredAnswer;
  at: number;
}

/** A person's standing, for `register` (`01` C8, Y3): a `waiting` account
 * gets FORBIDDEN and reads through the public path. */
export type AccountStatus = "active" | "waiting";

export interface ServerStore extends Source {
  /** Run `fn` in one transaction: every write it makes commits together, or
   * none does when it throws (the exception is rethrown). Calls may nest
   * (SQLite: a savepoint). */
  transaction<T>(fn: () => T): T;

  // ---- records (`records`; Source: byKey, keysIn, uniqueKey, idTaken, lastRev) ----

  /** Write a record at `key`: insert, or replace the one there. `created` is
   * given for a new key: the version and time of the creating commit
   * (`created_v`, `created_at`). The store keeps the indexes of `01` D1 and
   * the unique lookups. */
  putRecord(
    key: string,
    record: StoredRecord,
    created: { version: number; at: number } | null,
  ): void;
  /** Delete the record at `key` (and its index entries). */
  deleteRecord(key: string): void;
  /** The version of the commit that created the record now at `key`. */
  createdVersion(key: string): number | undefined;
  /** The keys of the records of `kind` created before `at` (ms), oldest
   * first (the retention of moderation log entries, Y8). */
  keysCreatedBefore(kind: StoredRecord["kind"], at: number): string[];

  // ---- id registry (`registry`) ----

  /** Set the last rev of an id or key. The registry is never pruned. */
  setLastRev(name: string, rev: number): void;

  // ---- tombstones ----

  tombstone(key: string): Tombstone | undefined;
  putTombstone(t: Tombstone): void;
  deleteTombstone(key: string): void;
  /** Delete the tombstones committed before `at` (ms), and their `del` rows
   * in every log. */
  pruneTombstones(at: number): void;

  // ---- change log (`change_log`, `server_head`, `log_epochs`) ----

  /** The server's newest version. */
  head(): number;
  /** Take the next version: the head + 1, which becomes the head. */
  nextVersion(): number;
  /** Write the row of `row.key` in `log`, replacing the key's earlier row. */
  putLogRow(log: LogId, row: LogRow): void;
  logRow(log: LogId, key: string): LogRow | undefined;
  /** The rows of `log` with a version above `after`, by version. */
  logRows(log: LogId, after: number): LogRow[];
  epoch(log: LogId): Epoch;
  setEpoch(log: LogId, epoch: Epoch): void;

  // ---- clients ----

  client(clientId: string): ClientRow | undefined;
  /** Insert or update a client. */
  putClient(row: ClientRow): void;
  /** How many client ids `u` registered at or after `at` (ms); re-attaches
   * are not registrations. */
  registrationsSince(u: string, at: number): number;
  /** Delete the clients last used before `at`. */
  pruneClients(at: number): void;
  /** Forget registrations made before `at` (a store that counts them from
   * `clients.created_at` has nothing to do). */
  pruneRegistrations(at: number): void;

  // ---- recorded answers (`answers`) ----

  answer(u: string, mutationId: string): AnswerRow | undefined;
  putAnswer(row: AnswerRow): void;
  seqAnswer(clientId: string, seq: number): SeqAnswerRow | undefined;
  putSeqAnswer(row: SeqAnswerRow): void;
  /** Delete the answers (both kinds) recorded before `at`. */
  pruneAnswers(at: number): void;

  // ---- accounts (`users`) ----

  /** Whether a handle is a Session account (a mention of anyone else is
   * reported back, 02 N16). */
  isAccount(handle: string): boolean;
  /** The account's standing; null for a handle with no account. */
  accountStatus(handle: string): AccountStatus | null;
}
