// The client's answer to "was this id ever used" (phase 1a.2, decision 9).
//
// A replica holds only part of the server's id registry, so its
// `RecordSource.idUsed` answers UNKNOWN for most ids, and a prediction that
// creates a record would stop there. Two kinds of ids are known to be unused
// without the registry:
// - the ids the client minted itself (a write's first new id): a ULID with 80
//   random bits from the client's own source, which no other writer has;
// - the ids derived from the client's own fresh mutation ids (`deriveId`):
//   they hash the user and the mutation id, so only that mutation makes them,
//   and a mutation the server has not applied yet has made none.
// `withOwnIds` wraps a replica's source with that knowledge. "Fresh" means
// the server has not answered the write yet: once it has, the replica holds
// what the write created, and the id is answered from the replica as any
// other. A record the client's earlier pending writes created with such an
// id is in the replica's overlay, so `create` still finds it (CONFLICT).

import { UNKNOWN, type RecordSource } from "./engine.js";
import { deriveId } from "./ids.js";

/** The ids a client knows to be unused: those it minted and those derived
 * from its own mutation ids, of the writes the server has not answered. */
export interface OwnIds {
  /** The user the client writes as (part of every derived id). */
  readonly user: string;
  /** The ids the client minted for its unanswered writes. */
  readonly minted: ReadonlySet<string>;
  /** The mutation ids of its unanswered writes. */
  readonly mutations: ReadonlySet<string>;
  /** Whether `id` is derived from one of `mutations`, in place of hashing
   * up to MAX_DERIVED candidates per mutation on each check: a client that
   * caches each mutation's derived ids passes its lookup here. */
  readonly derived?: (id: string) => boolean;
}

/** The ids derived from one mutation id, up to MAX_DERIVED: a client
 * computes them once per mutation and keeps them. */
export function derivedIds(user: string, mutationId: string): Set<string> {
  const out = new Set<string>();
  for (let k = 1; k <= MAX_DERIVED; k++) out.add(deriveId(user, mutationId, k));
  return out;
}

/** The most derived ids one mutation makes that `withOwnIds` checks (a
 * branch made a thread copies its asks with one derived id each). */
export const MAX_DERIVED = 1024;

/** Whether `id` is derived from one of `mutations` (by `user`), at an
 * ordinal up to MAX_DERIVED. A derived id starts with its mutation id's time
 * (10 characters), so only those mutation ids are hashed. */
export function derivedFrom(id: string, user: string, mutations: Iterable<string>): boolean {
  const time = id.slice(0, 10);
  for (const m of mutations) {
    if (m.slice(0, 10) !== time) continue;
    for (let k = 1; k <= MAX_DERIVED; k++) if (deriveId(user, m, k) === id) return true;
  }
  return false;
}

/** `source` with the client's own fresh ids answered as unused. An id the
 * source knows to be used stays used. */
export function withOwnIds(source: RecordSource, own: OwnIds): RecordSource {
  return {
    get: (kind, id) => source.get(kind, id),
    scan: (index, value) => source.scan(index, value),
    idUsed: (id) => {
      const known = source.idUsed(id);
      if (known === true) return true;
      const derived = own.derived ? own.derived(id) : derivedFrom(id, own.user, own.mutations);
      if (own.minted.has(id) || derived) return false;
      return known === false ? false : UNKNOWN;
    },
  };
}
