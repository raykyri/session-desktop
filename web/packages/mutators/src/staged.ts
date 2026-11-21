// A transaction that stages a mutation's writes over a source of committed
// records: the server half reads its store through it, and a client replica
// its working set. Nothing reaches the source until the caller commits
// `staged`, so a refused or failed mutation writes nothing.

import { refuse } from "./errors.js";
import { deriveId } from "./ids.js";
import {
  audienceOf,
  idOf,
  inIndex,
  keyOf,
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
}

/** The answer to a write of a new record whose id or key exists: one message,
 * whether or not the caller may read the record that holds it. */
export const ID_TAKEN = "An item with this id exists.";

export class StagedTx implements Tx {
  /** key → the record after the mutation, or null: deleted. */
  readonly staged = new Map<string, StoredRecord | null>();
  private readonly newIds = new Set<string>();

  constructor(
    private readonly source: Source,
    readonly me: string,
    readonly now: string,
    private readonly mutationId: string,
  ) {}

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
    if (prev && audienceOf(prev) !== audienceOf(r))
      throw new Error(`a write changed the audience of ${key}`);
    this.write(key, r);
  }

  del(key: string): void {
    if (this.byKey(key)) this.staged.set(key, null);
  }

  id(ordinal: number): string {
    return deriveId(this.me, this.mutationId, ordinal);
  }

  private write(key: string, r: Draft) {
    this.staged.set(key, { ...r, rev: 0 });
  }
}
