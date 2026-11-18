// The server half's interface: what a client sends (`apply`) and reads
// (`snapshot`, `pull`). The adversarial suite in `test/` is written against
// these types and `TestServer` only, so a later `@session/sync` server half
// can run the same suite by providing a `ServerFactory`.
//
// Everything is synchronous in this prototype; the suite awaits every call,
// so an implementation may return promises (`Awaitable`).

import type { Spaces } from "@session/shared";

import type { LogId, StoredRecord } from "./records.js";

export type Awaitable<T> = T | Promise<T>;

/** The signed-in person a request is made for; `null` is a signed-out caller. */
export interface Actor {
  readonly u: string;
}

/** The protocol version this prototype speaks, and the lowest it accepts. */
export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

/** One outbox entry as the client sends it: a mutator's name and input. There
 * is no field for client-computed changes; an envelope with any other field is
 * refused. */
export interface Envelope {
  mutationId: string;
  name: string;
  input: unknown;
  protocolVersion: number;
}

export type ErrorCode = Spaces.SpaceErrorCode;

/** An error answer. `message` is fixed per code and cause, so two answers
 * with the same cause are byte-identical. */
export interface ApiError {
  code: ErrorCode;
  message: string;
  issues?: string[];
}

export type ApplyResult = { ok: true; result: unknown } | { ok: false; error: ApiError };

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

export interface Snapshot {
  records: { key: string; record: StoredRecord }[];
  version: number;
  epoch: string;
  /** Prototype addition: the caller's last processed mutation id, as in a pull. */
  lastMutationId: string | null;
}

export type Pull =
  | {
      changes: Change[];
      version: number;
      epoch: string;
      /** The last mutation id the server processed for the caller (applied or
       * refused), or null. */
      lastMutationId: string | null;
    }
  | { resync: true };

export interface ServerHalf {
  apply(actor: Actor | null, envelope: Envelope): Awaitable<ApplyResult>;
  snapshot(actor: Actor | null, log: LogId, tier?: Tier): Awaitable<Snapshot>;
  pull(actor: Actor | null, log: LogId, cursor: Cursor): Awaitable<Pull>;
}

/** One change-log row. Rows hold no record content. */
export interface LogRow {
  key: string;
  op: "put" | "del";
  version: number;
}

/** Test-only access the suite needs besides the API: the stored records (the
 * oracle filters them by its own read rules), a log's rows, and the post-commit
 * jobs the server started. */
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
  /** The server's random source (invite codes, server-made ids). */
  random?: () => number;
}

export type ServerFactory = (options: ServerOptions) => TestServer;
