// The seam between the screens and the replica (02 §9.1, §9.6).
//
// Screens never read records directly: they read named queries
// (`queries.ts`) through `useReplicaQuery`, and write through `writes.ts`.
// Both go through one object, a `ReplicaSource`. The client provides three:
//
// - the sync replica (`syncReplica.ts`): `@session/sync`'s client over the
//   sync routes, which every build without the fixtures reads;
// - the fixture replica (`fixtureReplica.ts`): the members mockup's fixtures
//   converted to the stored shape, with writes applied by the real mutators
//   of `@session/mutators` and runs answered by a scripted executor, for the
//   fixture build and the unit tests;
// - the empty replica (`emptyReplica` below): nothing is loaded, every query
//   answers `UNKNOWN`, and a write is refused (a provider with no
//   configuration).
//
// The contract:
//
// - `me`: the handle the replica belongs to (null signed out: the
//   ephemeral read-only replica of 02 §9.5).
// - `ready()`: false until the first snapshot is applied. While it is false
//   every query answers `UNKNOWN`.
// - Known versus absent. A replica holds part of what its user may read (the
//   web window of 01 R1, the logs it has pulled). A read it cannot answer
//   must say so, never answer "absent":
//   - `get(key)` answers the record, `undefined` when the replica knows there
//     is none (its index is loaded and the key is not in it, or it was
//     deleted), and `UNKNOWN` when the key lies outside what is loaded;
//   - `list(kind, index)` answers the records of one index (a space, a
//     thread, a person), or `UNKNOWN` while that index is not loaded (a
//     thread outside the window, a summary-only thread whose records were
//     not requested, a space whose log was not pulled);
//   - `all(kind)` answers the loaded records of a kind; `complete(kind)`
//     says whether that is every record of the kind the user may read (the
//     space directory is complete once `spaces.directory` and the user log
//     are in).
//   Records are as the viewer may read them (filtered by read scope and
//   redacted, `@session/mutators` `view`), with the prediction of
//   unconfirmed writes applied.
// - `subscribe` and `version`: a change counter and a listener for it, the
//   reactive half of 01 Y12; loading an index is a change.
// - `mutate(name, input)`: make the prediction, keep it, send the write;
//   resolves with the server's answer (or the prediction's, offline).
// - `now()`: the server's clock in milliseconds.
//
// Queries call `known()` on a read that must be answered: an `UNKNOWN` read
// stops the query, and `useReplicaQuery` answers `UNKNOWN` for it, so the
// screen shows a loading row rather than an empty state or a not-found
// panel.

import type { ApiError, Index, Kind, RecordOf, StoredRecord } from "@session/mutators";
import type { Spaces } from "@session/shared";

type SpaceMutatorName = Spaces.SpaceMutatorName;

/** A write's outcome. `result` is the mutator's (with the server's values,
 * such as the mentions it notified, 02 N16). `unsent`: the request failed
 * and the write is "Not sent" (02 §9.2): its prediction stays, and the
 * person retries or discards it from the outbox. */
export type WriteOutcome =
  { ok: true; result: unknown; unsent?: true } | { ok: false; error: ApiError };

/** The composer a write's text came from, to put it back when the write is
 * discarded or refused (02 §9.2). */
export interface DraftRef {
  key: string;
  text: string;
}

/** A write whose request failed: "Not sent" (02 §9.2). `item`: the id of
 * the thread, branch, reply or comment it created, under which it is shown;
 * null for a write with no item (a save, a join), shown in a toast. */
export interface UnsentWrite {
  local: string;
  name: SpaceMutatorName;
  input: unknown;
  item: string | null;
  error: ApiError | null;
}

/** The text of a summary row whose records could not be fetched (02 §9.1,
 * 01 R3). */
export const UNAVAILABLE_TEXT = "Couldn't load the rest of this thread.";

/** What a read answers when the replica has not loaded it. */
export const UNKNOWN: unique symbol = Symbol("unknown");
export type Unknown = typeof UNKNOWN;

export interface ReplicaSource {
  /** The handle the replica belongs to; null signed out. */
  readonly me: string | null;
  /** False until the first snapshot is in: every query is `UNKNOWN`. */
  ready(): boolean;
  /** The record at `key` as the viewer may read it; `undefined` when known
   * absent, `UNKNOWN` when not loaded. */
  get(key: string): StoredRecord | undefined | Unknown;
  /** Records of `kind` in one index (by space, thread or person), key order;
   * `UNKNOWN` while the index is not loaded. */
  list<K extends Kind>(kind: K, index: Index): RecordOf<K>[] | Unknown;
  /** The loaded readable records of a kind. */
  all<K extends Kind>(kind: K): RecordOf<K>[];
  /** Whether `all(kind)` is every record of the kind the user may read. */
  complete(kind: Kind): boolean;
  /** Increments on every change of any record and every index loaded. */
  version(): number;
  subscribe(listener: () => void): () => void;
  mutate(
    name: SpaceMutatorName,
    input: unknown,
    options?: { draft?: DraftRef },
  ): Promise<WriteOutcome>;
  /** The server's clock, in milliseconds. */
  now(): number;
  // ---- the sync replica's (the fixture replica answers every write at
  // once and holds every record, so it has none of these) ----
  /** The writes that are "Not sent", in outbox order. */
  unsent?(): readonly UnsentWrite[];
  /** Send a "Not sent" write again with the same mutation id; resolves its
   * new outcome. */
  retry?(local: string): Promise<WriteOutcome>;
  /** Drop a "Not sent" write: its prediction is rolled back and its text
   * returns to its composer. */
  discard?(local: string): void;
  /** Ask for a thread's full records (01 R3): a summary thread, or a thread
   * of a thread address outside the window (`space` names its channel). */
  open?(thread: string, space?: string): void;
  /** Whether `open` could not fetch a thread's records (offline, a refused
   * read): its row shows "Couldn't load the rest of this thread." while it is retried. */
  unavailable?(thread: string): boolean;
  /** Read a channel's records while its view is open (01 R5); the returned
   * function ends the view. */
  watch?(space: string): () => void;
  /** Whether the replica can say there is no channel of this name besides
   * those it holds: it asked the server (a private channel's landing, 04
   * I5). The first call asks. */
  lookUp?(name: string): boolean;
  /** The streaming text of a run's current attempt while it runs (`03`
   * T2, T3): the turn number it belongs to and its text so far. */
  liveText?(run: string): { attempt: number; n: number; text: string } | null;
}

/** Thrown by `known` for a read the replica cannot answer; `useReplicaQuery`
 * turns it into `UNKNOWN`. */
export class NotLoaded extends Error {
  constructor() {
    super("not loaded on this replica");
  }
}

/** A read that the query cannot do without. */
export function known<T>(value: T | Unknown): T {
  if (value === UNKNOWN) throw new NotLoaded();
  return value;
}

/** A read that may stay unanswered: `UNKNOWN` reads as `undefined`. */
export function loose<T>(value: T | Unknown): T | undefined {
  return value === UNKNOWN ? undefined : value;
}

/** Runs a query, answering `UNKNOWN` when it needs a read the replica has not
 * loaded. */
export function runQuery<T>(select: () => T): T | Unknown {
  try {
    return select();
  } catch (error) {
    if (error instanceof NotLoaded) return UNKNOWN;
    throw error;
  }
}

/** A source with nothing loaded. */
export function emptyReplica(me: string | null): ReplicaSource {
  return {
    me,
    ready: () => false,
    get: () => UNKNOWN,
    list: () => UNKNOWN,
    all: () => [],
    complete: () => false,
    version: () => 0,
    subscribe: () => () => {},
    mutate: () =>
      Promise.resolve({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "Not connected." },
      }),
    now: () => Date.now(),
  };
}
