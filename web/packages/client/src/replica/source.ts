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
// interface; nothing above this file changes. What it must provide:
//
// - `me`: the handle the replica belongs to (null signed out: the
//   ephemeral read-only replica of 02 §9.5);
// - `ready()`: false until the first snapshot is applied;
// - `get`, `list`, `all`: records as the viewer may read them (filtered by
//   read scope and redacted, `@session/mutators` `view`), the prediction of
//   unconfirmed writes included;
// - `subscribe` and `version`: a change counter and a listener for it, the
//   reactive half of 01 Y12;
// - `mutate(name, input)`: make the prediction, keep it, send the write;
//   resolves with the server's answer (or the prediction's, offline);
// - `now()`: the server's clock in milliseconds, for relative times.

import type { ApiError, Index, Kind, RecordOf, StoredRecord } from "@session/mutators";
import type { Spaces } from "@session/shared";

type SpaceMutatorName = Spaces.SpaceMutatorName;

/** A write's outcome. `result` is the mutator's (with the server's values,
 * such as the mentions it notified, 02 N16). */
export type WriteOutcome = { ok: true; result: unknown } | { ok: false; error: ApiError };

export interface ReplicaSource {
  /** The handle the replica belongs to; null signed out. */
  readonly me: string | null;
  /** False until the first snapshot is in: every query is `UNKNOWN`. */
  ready(): boolean;
  /** The record at `key` as the viewer may read it. */
  get(key: string): StoredRecord | undefined;
  /** Records of `kind` in one index (by space, thread or person), key order. */
  list<K extends Kind>(kind: K, index: Index): RecordOf<K>[];
  /** Every readable record of a kind. */
  all<K extends Kind>(kind: K): RecordOf<K>[];
  /** Increments on every change of any record. */
  version(): number;
  subscribe(listener: () => void): () => void;
  mutate(name: SpaceMutatorName, input: unknown): Promise<WriteOutcome>;
  /** The server's clock, in milliseconds. */
  now(): number;
}

/** What a query answers when the replica cannot (02 §9.1): the caller shows
 * a loading row, never an empty state. */
export const UNKNOWN: unique symbol = Symbol("unknown");
export type Unknown = typeof UNKNOWN;

/** A source with nothing loaded. */
export function emptyReplica(me: string | null): ReplicaSource {
  return {
    me,
    ready: () => false,
    get: () => undefined,
    list: () => [],
    all: () => [],
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
