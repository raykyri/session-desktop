// The seam between the screens and the replica (02 §9.1, §9.6).
//
// Screens never read records directly: they read named queries
// (`queries.ts`) through `useReplicaQuery`, and write through `writes.ts`.
// Both go through one object, a `ReplicaSource`. Until `@session/sync` lands
// (05 M2), the client provides two:
//
// - the fixture replica (`fixtureReplica.ts`): the members mockup's fixtures
//   converted to the stored shape, with writes applied by the real mutators
//   of `@session/mutators` and runs answered by a scripted executor;
// - the empty replica (`emptyReplica` below): nothing is loaded, every query
//   answers `UNKNOWN`, and a write is refused. A build without the fixtures
//   shows the loading row.
//
// The sync library's client replica replaces both by implementing this
// interface; nothing above this file changes. The contract:
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
 * such as the mentions it notified, 02 N16). */
export type WriteOutcome = { ok: true; result: unknown } | { ok: false; error: ApiError };

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
  mutate(name: SpaceMutatorName, input: unknown): Promise<WriteOutcome>;
  /** The server's clock, in milliseconds. */
  now(): number;
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
