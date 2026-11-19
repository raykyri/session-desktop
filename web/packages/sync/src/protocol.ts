// The sync protocol both halves speak: the write envelope, its answers, the
// reads (`snapshot`, `pull`), the replication tiers and the constants
// AGENTS.md fixes. Nothing here uses Node or the DOM, so the client half
// (web, desktop, React Native) imports it as the server half does.

import type { ApiError, ErrorCode, LogId, StoredRecord } from "@session/mutators";

export type { ApiError, ErrorCode, LogId, StoredRecord };

/** The protocol version this package speaks, and the lowest a server takes.
 * Version 4 added `queuedAt` and `replaces` to the envelope and `serverTime`
 * to every answer (phase 1b). A request below the minimum answers
 * UPDATE_REQUIRED, which a client shows as "Update Session". */
export const PROTOCOL_VERSION = 4;
export const MIN_PROTOCOL_VERSION = 4;
/** The request header that carries the client's protocol version. */
export const PROTOCOL_HEADER = "X-Session-Protocol";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A device's clock may be this far from the server's (CLOCK_SKEW beyond). */
export const CLOCK_MAX_SKEW = MINUTE;
/** The age window of a client-made id and of `queuedAt`, on the device's
 * clock: at most 4 days old, at most a minute ahead. */
export const ID_MAX_AGE = 4 * DAY;
export const ID_MAX_AHEAD = MINUTE;
/** How long the outbox keeps a write, in server time. */
export const OUTBOX_TTL = 3 * DAY;
/** How long the server keeps a recorded answer. */
export const ANSWER_TTL = 7 * DAY;
/** How long the server keeps a tombstone; a cursor served longer ago resyncs. */
export const TOMBSTONE_TTL = 30 * DAY;
/** A client record idle this long expires (WRONG_CLIENT). */
export const CLIENT_IDLE_TTL = 90 * DAY;
/** The most clients one person registers in a day. */
export const REGISTRATIONS_PER_DAY = 20;
/** The largest envelope, as JSON, and the deepest its input nests. */
export const MAX_ENVELOPE_BYTES = 256 * 1024;
export const MAX_INPUT_DEPTH = 32;
/** The most mutation ids a reminted envelope replaces. */
export const MAX_REPLACES = 64;
/** The client's retry backoff after a transient answer: 1 s, doubled, at
 * most 10 minutes; after this many failures the write is shown as failed and
 * the outbox goes on. */
export const RETRY_MIN = 1000;
export const RETRY_MAX = 10 * MINUTE;
export const MAX_TRIES = 5;
/** How long a thread the person opened (`hydrate`) stays pinned in full:
 * the client reports it in `tier.opened` for this long. */
export const OPENED_TTL = 14 * DAY;
/** The most thread ids of `tier.opened` the server pins: it reads the first
 * this many and ignores the rest (review round 2 of phase 1). */
export const OPENED_MAX = 500;

/** The signed-in person a request is for (null: signed out), and the device
 * whose token authenticated it (absent for a browser session). */
export interface Actor {
  readonly u: string;
  readonly device?: string | null;
}

/** One write as the client sends it. There is no field for client-computed
 * changes; an envelope with any other field is BAD_REQUEST.
 * - `clientId`: from `register`, bound to one user (and device).
 * - `seq`: the client's last processed seq + 1, given when it is sent.
 * - `clientTime`: the device's clock, corrected by the offset it learned
 *   from the first answer of its process or from CLOCK_SKEW (ms). The
 *   server measures ages on it.
 * - `queuedAt`: when the write was queued, on the same clock. The server
 *   checks it like an id's age (EXPIRED).
 * - `replaces`: the mutation ids this write was sent under before it was
 *   reminted, whose outcome the client does not know. The server stores its
 *   answer under each of them in the same commit, and a stored answer under
 *   any of them is this write's answer, so no copy of the write applies
 *   twice. An id with a recorded refusal is never listed (its refusal would
 *   be the answer): Send again after one is a new write. */
export interface Envelope {
  clientId: string;
  seq: number;
  mutationId: string;
  name: string;
  input: unknown;
  protocolVersion: number;
  clientTime: number;
  queuedAt: number;
  replaces: string[];
}

/** One change of a log: a record as the reader may read it now, or a key the
 * reader no longer holds. */
export type Change =
  | { key: string; op: "put"; record: StoredRecord }
  | { key: string; op: "del"; ended?: MembershipEnd };

/** How a membership ended: the member left, or was removed (or banned), so
 * each of the person's devices can tell a voluntary leave (the device
 * deletes its copy of a closed space) from a removal (the device keeps a
 * frozen copy). A read of a user log carries it in `ended` (by space id, for
 * the reader's memberships that ended within the tombstone window), or a
 * `del` of the reader's member key (`member:<space>:<user>`) carries it;
 * without either, an ended membership reads as a removal. */
export type MembershipEnd = "left" | "removed";

/** An error answer: `@session/mutators`' `ApiError` with what the protocol
 * adds. `expectedSeq` comes with OUT_OF_ORDER; `current` and `changes` with
 * STALE (the target as the caller reads it now, and the records the answer
 * is about, as changes to apply); `retryAt` with a limit. */
export interface AnswerError extends ApiError {
  expectedSeq?: number;
  changes?: Change[];
}

/** The answer to a write. Every answer carries the server's time (ms).
 * `seq` is the seq the answer used (absent when it used none); `replayed`
 * marks a recorded answer served again, and `recordedAs` on it names the
 * mutation id the write was processed under (review round 2 of phase 1,
 * finding 1): the ids the server derived for it come from that id, which
 * differs from the envelope's when the answer is an earlier envelope's
 * (`replaces`) or a later remint's.
 *
 * An input id that already exists answers CONFLICT, recorded, before the
 * ages of the ids are checked (review round 2 of phase 1, findings 2 and
 * 8a): to a client that minted the id, CONFLICT means its write was applied
 * before, and EXPIRED that its ids were never used. */
export type Answer =
  | {
      ok: true;
      result: unknown;
      serverTime: number;
      seq?: number;
      replayed?: true;
      recordedAs?: string;
    }
  | {
      ok: false;
      error: AnswerError;
      serverTime: number;
      seq?: number;
      replayed?: true;
      recordedAs?: string;
    };

export type RegisterAnswer =
  | { ok: true; clientId: string; serverTime: number }
  | { ok: false; error: ApiError; serverTime: number };

/** The answers that record nothing: the envelope's seq is not used up, the
 * write stays queued, and the same envelope may be sent again. The transient
 * ones say nothing about the write itself. */
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

/** The unrecorded answers a client waits out and sends again. */
export const TRANSIENT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "TOO_MANY_REQUESTS",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
]);

/** An opaque cursor token (AES-256-GCM, sealed by the server). */
export type Cursor = string;

/** The last seq the server processed for the reading client; null when no
 * client id was given or it is not the caller's. A read sent with a client
 * id that answers null came from no session of that client's person (a
 * session that ended reaches the server as no actor): the client takes it
 * as UNAUTHORIZED and changes no log (review round 2 of phase 1, finding
 * 7). */
export type LastSeq = number | null;

/** Which records of a space log a read serves in full (AGENTS.md,
 * "Replication"):
 * - `desktop`: full records for the threads of the past 90 days or the
 *   newest 500, whichever covers more, at most 5,000;
 * - `phone`: the past 30 days or the newest 200;
 * - `full`: every thread in full (tests, and small spaces);
 * - `summary`: no thread in full.
 * A read without `tier` (or without `window`) serves every thread in full,
 * as `full`; the client sends `desktop` unless it is made with another
 * window. Every thread the reader wrote or saved, and those in `opened`
 * (threads opened in the past 14 days, as the client reports them, the
 * latest first; the server pins the first OPENED_MAX) are pinned: in full
 * whatever their age. Every other readable thread is a summary: its
 * thread and counts records, without follow-ups, replies or runs. In a space
 * of more than 5,000 threads, summaries reach back 2 years. */
export interface TierOptions {
  window?: "desktop" | "phone" | "full" | "summary";
  opened?: string[];
}

export interface ReadOptions {
  clientId?: string;
  tier?: TierOptions;
  /** A snapshot of these threads only (a thread the client hydrates when it
   * opens it): each in full, with everything under it. */
  threads?: string[];
}

/** A read's answer. Optional fields (a client works without them):
 * - `summaries`: in a tiered read of a space log, the threads served as
 *   summaries. A snapshot lists every such thread; a pull lists every
 *   summary thread with a row after the cursor, whether the row's record
 *   was served (its thread or counts) or withheld (a follow-up, reply or run
 *   under it), so a client drops what it holds under a thread that left the
 *   full tier (review round 2 of phase 1, finding 6). Without it the client
 *   tells summaries by their records.
 * - `ended`: in a read of a user log, how the reader's memberships that
 *   ended came to an end, by space id (`MembershipEnd`). */
export interface Snapshot {
  ok?: true;
  /** By the server's creation time, then the commit that created the record. */
  records: { key: string; record: StoredRecord }[];
  cursor: Cursor;
  lastSeq: LastSeq;
  serverTime: number;
  summaries?: string[];
  ended?: Record<string, MembershipEnd>;
}

export type Pull =
  | {
      ok?: true;
      changes: Change[];
      cursor: Cursor;
      lastSeq: LastSeq;
      serverTime: number;
      summaries?: string[];
      ended?: Record<string, MembershipEnd>;
    }
  | { ok?: true; resync: true; serverTime: number };

/** A read the server did not serve: UPDATE_REQUIRED (the client is below
 * the minimum protocol version), UNAUTHORIZED (no valid session or device
 * token), or a transient error. The client changes no log on it. */
export interface ReadError {
  ok: false;
  error: ApiError;
  serverTime: number;
}

export type SnapshotAnswer = Snapshot | ReadError;
export type PullAnswer = Pull | ReadError;

export const isReadError = (a: SnapshotAnswer | PullAnswer): a is ReadError => a.ok === false;

/** The answer to an online-only call (`NOT_MUTATORS`). */
export type CallAnswer =
  | { ok: true; result: unknown; serverTime: number }
  | { ok: false; error: ApiError; serverTime: number };

/** The SSE events: a poke names the logs that changed for the reader (the
 * client pulls them); a run event carries in-flight text of a run, keyed by
 * run, attempt and a per-attempt sequence (ADR-22). The event id of a poke is
 * the stream's cursor tokens by log, JSON-encoded. */
export type SseEvent =
  | { type: "poke"; logs: LogId[] }
  | { type: "run"; run: string; attempt: number; seq: number; text: string };

/** Whether a time is within the age window of `deviceNow`. */
export const timeOk = (at: number, deviceNow: number) =>
  deviceNow - at <= ID_MAX_AGE && deviceNow - at >= -ID_MAX_AHEAD;

/** The retry backoff after `tries` transient answers. */
export const backoff = (tries: number) =>
  Math.min(RETRY_MAX, RETRY_MIN * 2 ** Math.max(0, tries - 1));
