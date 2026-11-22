// A transaction that stages a mutation's writes over a source of committed
// records: the server half reads its store through it, and a client replica
// its working set. Nothing reaches the source until the caller commits
// `staged`, so a refused or failed mutation writes nothing.
//
// The rev rule lives here, so a client's prediction and the server's apply
// stage the same rev: a write that leaves a record as it is committed writes
// nothing; any other write stages the committed rev + 1 (one bump per
// commit, however often the mutation writes the key). A record written again
// at a key that was deleted continues from the registry's last rev
// (`Source.lastRev`); a client cannot know it and stages rev 1, and takes the
// server's record when the write is confirmed.

import { refuse } from "./errors.js";
import { deriveId } from "./ids.js";
import {
  idOf,
  inIndex,
  keepsAudience,
  keyOf,
  registryKey,
  uniqueOf,
  type Draft,
  type Index,
  type Kind,
  type RecordOf,
  type StoredRecord,
  type UniqueIndex,
  type UniqueKind,
} from "./records.js";
import type { Tx } from "./tx.js";

/** Committed records, read through the indexes (`01` D1). A client replica
 * throws `UnknownRead` from a read outside its working set. */
export interface Source {
  byKey(key: string): StoredRecord | undefined;
  /** The keys of the records of `kind` in the index. */
  keysIn(kind: Kind, index: Index): Iterable<string>;
  /** The key of the record a unique lookup names. */
  uniqueKey(index: UniqueIndex, value: string): string | undefined;
  /** Whether an id was ever used (the id registry). A client cannot know; it
   * answers false, and the server's answer decides. */
  idTaken(id: string): boolean;
  /** The last rev the id registry holds for a record's registry name (its
   * id, or its key: `registryKey`), when the record was deleted since. A
   * client does not implement it. */
  lastRev?(name: string): number | undefined;
}

/** Who runs a transaction: the server (authority: every read is answered,
 * the server-only reads included) or a client (prediction over its replica:
 * the server-only reads and effects are skipped, `Tx.server`). */
export type TxRole = "server" | "client";

/** Whether two records are equal apart from their rev. */
function sameRecord(a: StoredRecord, b: Draft | StoredRecord): boolean {
  const strip = (x: object) => JSON.stringify({ ...x, rev: 0 });
  return strip(a) === strip(b);
}

/** The answer to a write of a new record whose id or key exists: one message,
 * whether or not the caller may read the record that holds it. */
export const ID_TAKEN = "Something went wrong. Try again.";

export class StagedTx implements Tx {
  /** key → the record after the mutation, or null: deleted. */
  readonly staged = new Map<string, StoredRecord | null>();
  private readonly newIds = new Set<string>();

  /** Whether this transaction runs on the server (`Tx.server`). */
  readonly server: boolean;

  constructor(
    private readonly source: Source,
    readonly me: string,
    readonly now: string,
    private readonly mutationId: string,
    role: TxRole,
  ) {
    this.server = role === "server";
  }

  byKey(key: string): StoredRecord | undefined {
    if (this.staged.has(key)) return this.staged.get(key) ?? undefined;
    return this.source.byKey(key);
  }

  list<K extends Kind>(kind: K, index: Index): RecordOf<K>[] {
    const keys = new Set(this.source.keysIn(kind, index));
    for (const [key, r] of this.staged) if (r?.kind === kind) keys.add(key);
    const out: RecordOf<K>[] = [];
    for (const key of [...keys].sort()) {
      const r = this.byKey(key);
      if (r?.kind === kind && inIndex(r, index)) out.push(r as RecordOf<K>);
    }
    return out;
  }

  count(kind: Kind, index: Index): number {
    return this.list(kind, index).length;
  }

  unique<I extends UniqueIndex>(index: I, value: string): RecordOf<UniqueKind<I>> | undefined {
    for (const r of this.staged.values())
      if (r && uniqueOf(r, index) === value) return r as RecordOf<UniqueKind<I>>;
    const key = this.source.uniqueKey(index, value);
    if (key === undefined) return undefined;
    const r = this.byKey(key);
    return r && uniqueOf(r, index) === value ? (r as RecordOf<UniqueKind<I>>) : undefined;
  }

  create(r: Draft): void {
    const key = keyOf(r);
    const id = idOf(r);
    if (this.byKey(key) || (id !== null && (this.source.idTaken(id) || this.newIds.has(id))))
      throw refuse("CONFLICT", ID_TAKEN);
    this.write(key, r);
    if (id !== null) this.newIds.add(id);
  }

  put(r: Draft): void {
    const key = keyOf(r);
    const prev = this.byKey(key);
    if (!prev && idOf(r) !== null) return this.create(r);
    if (prev && !keepsAudience(prev, r)) throw new Error(`a write changed the audience of ${key}`);
    this.write(key, r);
  }

  del(key: string): void {
    if (this.byKey(key)) this.staged.set(key, null);
  }

  touch(key: string): void {
    const r = this.byKey(key);
    if (!r) return;
    const committed = this.source.byKey(key);
    this.staged.set(key, { ...r, rev: (committed?.rev ?? r.rev - 1) + 1 });
  }

  id(ordinal: number): string {
    return deriveId(this.me, this.mutationId, ordinal);
  }

  private write(key: string, r: Draft) {
    const committed = this.source.byKey(key);
    // back to the committed record: nothing to write
    if (committed && sameRecord(committed, r)) {
      this.staged.delete(key);
      return;
    }
    const rev = (committed?.rev ?? this.source.lastRev?.(registryKey(r)) ?? 0) + 1;
    this.staged.set(key, { ...r, rev });
  }
}
