// The server half's interface: what a client sends (`register`, `apply`) and
// reads (`snapshot`, `pull`). The adversarial suite in `test/` is written
// against these types and `TestServer` only, so a later `@session/sync` server
// half can run the same suite by providing a `ServerFactory`.
//
// Everything is synchronous in this prototype; the suite awaits every call,
// so an implementation may return promises (`Awaitable`).

import type { Spaces } from "@session/shared";

import type { AnyMutator, Effect } from "./mutators.js";
import type { LogId, StoredRecord } from "./records.js";

export type Awaitable<T> = T | Promise<T>;

/** The signed-in person a request is made for; `null` is a signed-out caller. */
export interface Actor {
  readonly u: string;
}

/** The protocol version this prototype speaks, and the lowest it accepts.
 * Version 3 added `clientTime` to the envelope, and made cursors tokens. */
export const PROTOCOL_VERSION = 3;
export const MIN_PROTOCOL_VERSION = 3;

/** One outbox entry as the client sends it: a mutator's name and input, the
 * client that sends it, its place in that client's sequence, and the
 * device's time when it was sent. There is no field for client-computed
 * changes; an envelope with any other field is refused.
 *
 * `clientId` comes from `register` and is bound to one user. `seq` numbers
 * the writes the server processed for a client 1, 2, 3, …; the server takes
 * a write only when its `seq` is the client's last processed seq + 1. The
 * client gives a write its `seq` when it sends it, from the last seq the
 * server acknowledged, not when it queues it: a write dropped from the outbox
 * before it was sent leaves no gap (review round 1, R7).
 *
 * `clientTime` is the device's clock, corrected by the offset the client
 * learned from CLOCK_SKEW, in milliseconds since the epoch. The client makes
 * its ids from the same clock, so `clientTime` minus the time in the mutation
 * id is the write's age measured on the device (review round 2, finding 3). */
export interface Envelope {
  clientId: string;
  seq: number;
  mutationId: string;
  name: string;
  input: unknown;
  protocolVersion: number;
  clientTime: number;
}

/** The spaces API's codes, and the ones the sync protocol adds:
 * - `UPDATE_REQUIRED`: the client's protocol version is below the minimum
 *   ("Update Session").
 * - `STALE`: the record a decision acts on is no longer in the state the
 *   client saw (a thread edited since `base.rev`, a member admitted again
 *   since the decision was made).
 * - `CLOCK_SKEW`: the envelope's `clientTime` is more than a minute from the
 *   server's time. Not recorded; the error carries `serverTime`, and the
 *   client corrects its clock and sends the write again.
 * - `EXPIRED`: the write is too old to apply. Measured on the device's clock
 *   (`clientTime`), its mutation id or a new id in its input is more than 4
 *   days old or more than a minute in the future, or an online-only write's
 *   mutation id is more than a minute old. Recorded; the client drops the
 *   write and tells the person.
 * - `OUT_OF_ORDER`: `seq` is not the client's next one. Not recorded; the
 *   error carries `expectedSeq`.
 * - `WRONG_CLIENT`: the client id is unknown, expired, or bound to another
 *   user. Not recorded.
 * - `TOO_LARGE`: an envelope larger than 256 KB as JSON (unrecorded, see
 *   UNRECORDED), or a device's answer over its cap. */
export type ErrorCode =
  | Spaces.SpaceErrorCode
  | "UPDATE_REQUIRED"
  | "STALE"
  | "CLOCK_SKEW"
  | "EXPIRED"
  | "OUT_OF_ORDER"
  | "WRONG_CLIENT"
  | "TOO_LARGE";

/** The answers that record nothing: the envelope's `seq` is not used up, the
 * same `seq` may be sent again, and the client keeps the write queued. The
 * transient ones (TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE,
 * INTERNAL_SERVER_ERROR, CLOCK_SKEW) say nothing about the write itself; the
 * client sends it again later. A BAD_REQUEST for a malformed envelope, and
 * TOO_LARGE for an oversized one, record nothing either (neither has a
 * usable `seq`).
 *
 * Every other answer, applied or refused, uses up the `seq` and is recorded
 * in the same commit as the write's changes: under (user, mutation id) for 7
 * days, or, for a mutation id that is malformed or already used for another
 * change, under (client, seq) for 7 days. Sent again, the same envelope gets
 * the recorded answer. So OUT_OF_ORDER means the server has no answer for
 * this mutation id, and the client may send the write again with
 * `expectedSeq`. */
export const UNRECORDED: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "UPDATE_REQUIRED",
  "UNAUTHORIZED",
  "WRONG_CLIENT",
  "OUT_OF_ORDER",
  "CLOCK_SKEW",
  "TOO_MANY_REQUESTS",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
  "TOO_LARGE",
]);

/** An error answer. `message` is fixed per code and cause, so two answers
 * with the same cause are byte-identical. `serverTime` (milliseconds since
 * the epoch) comes with CLOCK_SKEW; `expectedSeq`, the seq the server takes
 * next from this client, with OUT_OF_ORDER. */
export interface ApiError {
  code: ErrorCode;
  message: string;
  issues?: string[];
  serverTime?: number;
  expectedSeq?: number;
}

export type ApplyResult = { ok: true; result: unknown } | { ok: false; error: ApiError };

/** A new client id; or TOO_MANY_REQUESTS (the person registered 20 clients
 * in the past day), UNAUTHORIZED or INTERNAL_SERVER_ERROR. */
export type RegisterResult = { ok: true; clientId: string } | { ok: false; error: ApiError };

/** Where a replica of one log stands: an opaque token the server sealed with
 * AES-256-GCM under a key only the server holds. Sealed in it are the log,
 * the reader, the log's history, the server's internal version the replica
 * is at, the server's head and the time the token was served. Nothing of it
 * can be read without the key, and its length depends only on the lengths of
 * the log id and the reader's handle, so a reader learns nothing from it
 * about writes it may not read (review round 2, finding 1).
 *
 * The server keeps no state per cursor. A token it did not seal, or sealed
 * for another reader, another log or an earlier history of the log, or
 * served more than 30 days ago, resyncs. The planned SSE stream's event id
 * is a map of these tokens by log. */
export type Cursor = string;

export type Change = { key: string; op: "put"; record: StoredRecord } | { key: string; op: "del" };

/** Replication tier of a snapshot: `full` records, or `summary` (threads
 * without follow-ups and replies). Pulls are not tiered in this prototype. */
export type Tier = "full" | "summary";

export interface ReadOptions {
  tier?: Tier;
  /** The reading client: its last processed `seq` comes back as `lastSeq`. */
  clientId?: string;
}

/** The last `seq` the server processed (applied or refused, recorded) for the
 * reading client; 0 before its first. Null when no client id was given, or
 * the client id is not the caller's. */
export type LastSeq = number | null;

export interface Snapshot {
  /** In order of the server's `createdAt`, then the version of the commit
   * that created the record. */
  records: { key: string; record: StoredRecord }[];
  cursor: Cursor;
  lastSeq: LastSeq;
}

export type Pull =
  | {
      changes: Change[];
      cursor: Cursor;
      lastSeq: LastSeq;
    }
  | { resync: true };

export interface ServerHalf {
  /** A new client id, bound to the caller. */
  register(actor: Actor | null): Awaitable<RegisterResult>;
  apply(actor: Actor | null, envelope: Envelope): Awaitable<ApplyResult>;
  snapshot(actor: Actor | null, log: LogId, options?: ReadOptions): Awaitable<Snapshot>;
  pull(actor: Actor | null, log: LogId, cursor: Cursor, options?: ReadOptions): Awaitable<Pull>;
}

/** One change-log row. Rows hold no record content. */
export interface LogRow {
  key: string;
  op: "put" | "del";
  version: number;
}

/** Every value the server keeps at rest, table by table, for the erasure
 * tests: no text a removal or a delete erased may appear anywhere in it. */
export interface StorageScan {
  records: StoredRecord[];
  /** A deleted record's key, kind and audience, and the delete's time. */
  tombstones: {
    key: string;
    kind: string;
    sp: string | null;
    person: string | null;
    by: string | null;
    at: number;
  }[];
  logRows: (LogRow & { log: LogId })[];
  /** The idempotency store: answers by (user, mutation id), or by (client, seq). */
  answers: {
    u: string;
    mutationId?: string;
    clientId?: string;
    seq?: number;
    digest: string;
    result: ApplyResult;
    at: number;
  }[];
  /** Registered clients: the user each is bound to, its last processed seq
   * and when it was last used. */
  clients: { clientId: string; u: string; last: number; seen: number }[];
  /** The times each person registered a client in the past day. */
  registrations: { u: string; at: number[] }[];
  /** Every id and every key ever written, with its last rev. */
  registry: { id: string; rev: number }[];
  /** The version of the commit that created each record now stored. */
  born: { key: string; version: number }[];
  /** The logs whose history was replaced: how many times, and the version
   * the current history began at. */
  epochs: { log: LogId; n: number; start: number }[];
  /** The post-commit effects not yet run, with the time of the next attempt. */
  effects: { effect: unknown; at: number; attempts: number; next: number }[];
  /** The effects that failed 10 times and are no longer tried. */
  deadLetters: { effect: unknown; at: number; attempts: number; failedAt: number }[];
  /** The server jobs the effects started. */
  jobs: { kind: string; id: string }[];
}

/** Test-only access the suite needs besides the API: the stored records (the
 * oracles read them as facts), a log's rows, the post-commit jobs the server
 * started, every value at rest, one pass of the effect worker, and a server
 * job's result. */
export interface TestServer extends ServerHalf {
  dump(): ReadonlyMap<string, StoredRecord>;
  logRows(log: LogId): Awaitable<LogRow[]>;
  jobs(): readonly { kind: string; id: string }[];
  /** Expires what is past its lifetime first, as every call does. */
  scanStorage(): Awaitable<StorageScan>;
  /** One pass of the effect worker at the server's time: runs each queued
   * effect whose next attempt is due. Answers how many ran. On the real
   * server a loop calls it; no request handler does. */
  work(): Awaitable<number>;
  /** What a run writes when it finishes (not modelled otherwise): `text` as
   * a thread's summary (`thread:<id>`) or a follow-up's answer
   * (`followup:<id>`). False, and nothing written, for a removed item, a
   * deleted thread or another key. */
  finishJob(key: string, text: string): Awaitable<boolean>;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface ServerOptions {
  clock: Clock;
  /** The server's random source for client ids, invite codes and
   * server-made ids: a number in [0, 1). The default reads
   * `crypto.randomBytes`; the suite passes a seeded one, or one that fails.
   * The cursor key always comes from `crypto.randomBytes`. */
  random?: () => number;
  /** The mutator definitions the server runs, by name (default: `MUTATORS`).
   * The suite passes a set with a faulty definition to test that a fault
   * writes nothing. */
  mutators?: Readonly<Record<string, AnyMutator>>;
  /** Test only: an effect for which this answers true fails on that attempt
   * (1, 2, …), as if the service it calls were down. */
  failEffect?: (effect: Effect, attempt: number) => boolean;
}

export type ServerFactory = (options: ServerOptions) => TestServer;
