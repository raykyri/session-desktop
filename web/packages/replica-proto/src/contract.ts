// The server half's interface: what a client sends (`register`, `apply`) and
// reads (`snapshot`, `pull`). The adversarial suite in `test/` is written
// against these types and `TestServer` only, so a later `@session/sync` server
// half can run the same suite by providing a `ServerFactory`.
//
// Everything is synchronous in this prototype; the suite awaits every call,
// so an implementation may return promises (`Awaitable`).

import type { Spaces } from "@session/shared";

import type { AnyMutator } from "./mutators.js";
import type { LogId, StoredRecord } from "./records.js";

export type Awaitable<T> = T | Promise<T>;

/** The signed-in person a request is made for; `null` is a signed-out caller. */
export interface Actor {
  readonly u: string;
}

/** The protocol version this prototype speaks, and the lowest it accepts. */
export const PROTOCOL_VERSION = 2;
export const MIN_PROTOCOL_VERSION = 2;

/** One outbox entry as the client sends it: a mutator's name and input, the
 * client that sends it and its place in that client's sequence. There is no
 * field for client-computed changes; an envelope with any other field is
 * refused.
 *
 * `clientId` comes from `register` and is bound to one user. `seq` numbers
 * the writes the server processed for a client 1, 2, 3, …; the server takes
 * a write only when its `seq` is the client's last processed seq + 1. The
 * client gives a write its `seq` when it sends it, from the last seq the
 * server acknowledged, not when it queues it: a write dropped from the outbox
 * before it was sent leaves no gap (review round 1, R7). */
export interface Envelope {
  clientId: string;
  seq: number;
  mutationId: string;
  name: string;
  input: unknown;
  protocolVersion: number;
}

/** The spaces API's codes, and the ones the sync protocol adds:
 * - `UPGRADE_REQUIRED`: the client's protocol version is below the minimum
 *   ("Update Session").
 * - `STALE`: the record the write acts on is no longer in the state the
 *   client saw (a request already decided, a role already changed, a thread
 *   edited since its `base.rev`).
 * - `CLOCK_SKEW`: an id's time is outside the accepted window, or an
 *   online-only write's mutation id is more than a minute old. Not recorded;
 *   the error carries `serverTime`, and the client retries with new ids.
 * - `OUT_OF_ORDER`: `seq` is not the client's next one. Not recorded; the
 *   error carries `expectedSeq`.
 * - `WRONG_CLIENT`: the client id is unknown or bound to another user. Not
 *   recorded. */
export type ErrorCode =
  | Spaces.SpaceErrorCode
  | "UPGRADE_REQUIRED"
  | "STALE"
  | "CLOCK_SKEW"
  | "OUT_OF_ORDER"
  | "WRONG_CLIENT";

/** The answers that record nothing: the envelope's `seq` is not used up, the
 * same `seq` may be sent again, and the client keeps the write queued. The
 * transient ones (TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE,
 * INTERNAL_SERVER_ERROR, CLOCK_SKEW) say nothing about the write itself; the
 * client sends it again later. A BAD_REQUEST for a malformed envelope records
 * nothing either (it has no usable `seq`).
 *
 * Every other answer, applied or refused, uses up the `seq` and is recorded
 * in the same commit as the write's changes: under (user, mutation id) for 7
 * days, or, for a mutation id that is malformed or already used for another
 * change, under (client, seq) for 7 days. Sent again, the same envelope gets
 * the recorded answer. So OUT_OF_ORDER means the server has no answer for
 * this mutation id, and the client may send the write again with
 * `expectedSeq`. */
export const UNRECORDED: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "UPGRADE_REQUIRED",
  "UNAUTHORIZED",
  "WRONG_CLIENT",
  "OUT_OF_ORDER",
  "CLOCK_SKEW",
  "TOO_MANY_REQUESTS",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
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

export type RegisterResult = { ok: true; clientId: string } | { ok: false; error: ApiError };

/** Where a replica of one log stands. `version` is a position in the server's
 * single version sequence; `epoch` changes when the log's history is replaced
 * (here: a space's visibility changes), which invalidates every cursor. */
export interface Cursor {
  epoch: string;
  version: number;
}

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
  /** In order of the server's `createdAt`, then key. */
  records: { key: string; record: StoredRecord }[];
  version: number;
  epoch: string;
  lastSeq: LastSeq;
}

export type Pull =
  | {
      changes: Change[];
      version: number;
      epoch: string;
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

/** Test-only access the suite needs besides the API: the stored records (the
 * oracles read them as facts), a log's rows, and the post-commit jobs the
 * server started. */
export interface TestServer extends ServerHalf {
  dump(): ReadonlyMap<string, StoredRecord>;
  logRows(log: LogId): Awaitable<LogRow[]>;
  jobs(): readonly { kind: string; id: string }[];
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface ServerOptions {
  clock: Clock;
  /** The server's random source (invite codes, client ids, server-made ids). */
  random?: () => number;
  /** The mutator definitions the server runs, by name (default: `MUTATORS`).
   * The suite passes a set with a faulty definition to test that a fault
   * writes nothing. */
  mutators?: Readonly<Record<string, AnyMutator>>;
}

export type ServerFactory = (options: ServerOptions) => TestServer;
