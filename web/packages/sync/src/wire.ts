// The sync protocol both halves speak (`01` §4.1): the envelope a client
// sends (Y1), the answers it gets (Y2), `register` (Y3) and the reads
// (`snapshot`, `pull`, Y5). Everything here is shared by
// `@session/sync/client` and `@session/sync/server`; it reads no clock and
// imports nothing from Node.

import type { ApiError, ErrorCode, LogId, StoredRecord } from "@session/mutators";
import { spaces } from "@session/shared";
import { z } from "zod";

export type Awaitable<T> = T | Promise<T>;

/** The signed-in person a request is made for; `null` is a signed-out caller. */
export interface Actor {
  readonly u: string;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** The protocol version the build speaks, and the lowest the server accepts
 * (`Session-Protocol`, `05` §3.4). Version 4 added `queuedAt`, `replaces`
 * and `TOO_LARGE`. */
export const PROTOCOL_VERSION = 4;
export const MIN_PROTOCOL_VERSION = 4;

/** The most mutation ids a reminted envelope may name in `replaces`: a client
 * keeps the newest ones. */
export const MAX_REPLACES = 16;
/** The deepest an envelope's input may nest, and the largest an envelope may
 * be as JSON (Y1). */
export const MAX_INPUT_DEPTH = 32;
export const MAX_ENVELOPE_BYTES = 256 * 1024;

/** One write as a client sends it (Y1): a mutator's name and input, the
 * client that sends it and its place in that client's sequence, the device's
 * time when it was sent (`clientTime`, corrected by the offset the client
 * learned from CLOCK_SKEW) and when it was queued (`queuedAt`, same clock).
 * `seq` is given when the write is sent, from the last seq the server
 * acknowledged. `replaces` lists the mutation ids of the same write that the
 * client reminted after CLOCK_SKEW. There is no field for client-computed
 * changes; an envelope with any other field is refused. */
export interface Envelope {
  clientId: string;
  seq: number;
  mutationId: string;
  replaces?: string[];
  name: string;
  input: unknown;
  protocolVersion: number;
  clientTime: number;
  queuedAt: number;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** The envelope's strict shape (unrecorded BAD_REQUEST when it fails). */
export const envelopeSchema = z.strictObject({
  clientId: z.string(),
  seq: z.number().int().positive(),
  mutationId: z.string(),
  replaces: z.array(z.string().regex(ULID)).max(MAX_REPLACES).optional(),
  name: z.string(),
  input: z.unknown(),
  protocolVersion: z.number().int(),
  clientTime: z.number().int().nonnegative(),
  queuedAt: z.number().int().nonnegative(),
});

/** The answers that record nothing (Y2): the envelope's `seq` is not used
 * up, the same `seq` may be sent again, and the client keeps the write. The
 * transient ones (TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE,
 * INTERNAL_SERVER_ERROR, CLOCK_SKEW) say nothing about the write itself.
 * TOO_LARGE, and a BAD_REQUEST for a malformed or too deep envelope, record
 * nothing either (it has no usable `seq`). Every other answer, applied or
 * refused, uses up the `seq` and is recorded in the commit of the write. */
export const UNRECORDED: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "UPGRADE_REQUIRED",
  "UNAUTHORIZED",
  "WRONG_CLIENT",
  "OUT_OF_ORDER",
  "CLOCK_SKEW",
  "TOO_MANY_REQUESTS",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
  "TOO_LARGE",
]);

/** An answer as the server keeps it for replays (`replay` is set only on
 * the way out, on an answer given again without using a seq). */
export type StoredAnswer =
  { ok: true; result: unknown; replay?: true } | { ok: false; error: ApiError; replay?: true };

/** An answer as the server sends it (`spaces.spaceApplyAnswerSchema`): every
 * answer, a replayed one and a refusal included, carries `serverTime`, the
 * server's time when it answered. `replay`: the answer recorded for this
 * mutation id before (sent from any client id or seq, or stored for the id a
 * reminted envelope replaced), given again without using the envelope's
 * seq; the client keeps its acknowledged seq. Optional and additive: a
 * client that does not read it learns the seq from OUT_OF_ORDER, so the
 * protocol version is unchanged. */
export type ApplyResult =
  | { ok: true; result: unknown; serverTime: number; replay?: true }
  | { ok: false; error: ApiError & { serverTime: number }; replay?: true };

/** The wire schema of an answer, for a client reading it over HTTP. */
export const applyResultSchema = spaces.spaceApplyAnswerSchema;

/** `register`'s options: the client id the tab kept (Y3), to re-attach. */
export interface RegisterOptions {
  clientId?: string;
}

/** A client id bound to the caller, new or re-attached, with the last seq
 * the server processed for it (0 for a new one); or TOO_MANY_REQUESTS (50
 * new ids in the past day), WRONG_CLIENT (a stored id that is unknown,
 * another user's or idle for 7 days), FORBIDDEN (a waiting account),
 * UNAUTHORIZED or INTERNAL_SERVER_ERROR. */
export type RegisterResult =
  | { ok: true; clientId: string; lastSeq: number; reattached: boolean }
  | { ok: false; error: ApiError };

/** Where a replica of one log stands: an opaque token the server sealed with
 * AES-256-GCM (Y6). Nothing of it can be read without the key, and its length
 * depends only on the lengths of the log id and the reader's handle. */
export type Cursor = string;

export type Change = { key: string; op: "put"; record: StoredRecord } | { key: string; op: "del" };

/** Replication tier of a snapshot (`01` R1-R3):
 * - `full`: every record the reader may read;
 * - `summary`: threads without their nodes, answers, replies, comments and
 *   runs;
 * - `window`: the web window, computed by the server: full records for the
 *   threads in the window (per space the last 30 days or the newest 100
 *   threads, whichever covers more, capped at 500; the threads the reader
 *   wrote or saved in the past 90 days; the `threads` the tab opened), and
 *   summaries of the other threads of the past 2 years;
 * - `threads`: only the named `threads`, in full (promotion of a summary
 *   thread when it is opened, R3).
 * Pulls are not tiered. */
export type Tier = "full" | "summary" | "window" | "threads";

export interface ReadOptions {
  tier?: Tier;
  /** The threads the tab opened (at most 500 ids), for `window` and
   * `threads`. */
  threads?: string[];
  /** The reading client: its last processed `seq` comes back as `lastSeq`. */
  clientId?: string;
}

/** The most thread ids a snapshot request may name. */
export const MAX_OPENED_THREADS = 500;

/** The last `seq` the server processed for the reading client; 0 before its
 * first. Null when no client id was given, or it is not the caller's. */
export type LastSeq = number | null;

export interface Snapshot {
  /** In order of the server's `createdAt`, then the version of the commit
   * that created the record. */
  records: { key: string; record: StoredRecord }[];
  cursor: Cursor;
  lastSeq: LastSeq;
  /** For a `summary`, `window` or `threads` snapshot: the threads served in
   * full. A client drops pulled node, answer, reply, comment and run changes
   * of threads outside it (R2). Absent: every thread is full. */
  full?: string[];
  /** The server's time when it read (optional: the prototype sends none). */
  serverTime?: number;
}

export type Pull =
  | { changes: Change[]; cursor: Cursor; lastSeq: LastSeq; serverTime?: number }
  | { resync: true; serverTime?: number };

/** The server half as a client reaches it, for one caller. */
export interface SyncTransport {
  register(options?: RegisterOptions): Awaitable<RegisterResult>;
  apply(envelope: Envelope): Awaitable<ApplyResult>;
  snapshot(log: LogId, options?: ReadOptions): Awaitable<Snapshot>;
  pull(log: LogId, cursor: Cursor, options?: ReadOptions): Awaitable<Pull>;
}

/** The server half with the caller named on each call (the in-process form
 * of the sync routes, `01` §6). */
export interface ServerHalf {
  register(actor: Actor | null, options?: RegisterOptions): Awaitable<RegisterResult>;
  apply(actor: Actor | null, envelope: Envelope): Awaitable<ApplyResult>;
  snapshot(actor: Actor | null, log: LogId, options?: ReadOptions): Awaitable<Snapshot>;
  pull(actor: Actor | null, log: LogId, cursor: Cursor, options?: ReadOptions): Awaitable<Pull>;
}

/** A `ServerHalf` as one caller reaches it. */
export function transportFor(server: ServerHalf, actor: Actor | null): SyncTransport {
  return {
    register: (o) => server.register(actor, o),
    apply: (e) => server.apply(actor, e),
    snapshot: (log, o) => server.snapshot(actor, log, o),
    pull: (log, cursor, o) => server.pull(actor, log, cursor, o),
  };
}
