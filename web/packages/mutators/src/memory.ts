// An in-memory record store: a `RecordSource` over a map, and a commit that
// sets revs as a server store does. The package's tests run the mutators
// over it; it is also the smallest example of a source.

import { UNKNOWN, type RecordSource, type Unknown, type Write } from "./engine.js";
import {
  type Draft,
  type IndexName,
  type Kind,
  type StoredRecord,
  INDEXES,
  inIndex,
  keyFor,
  registryKey,
} from "./records.js";

const same = (a: StoredRecord, b: Draft) =>
  JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });

export class MemoryStore implements RecordSource {
  readonly records = new Map<string, StoredRecord>();
  /** Every id and key ever written (`registryKey`), with its last rev. */
  readonly registry = new Map<string, number>();

  get(kind: Kind, id: string): StoredRecord | undefined {
    return this.records.get(keyFor(kind, id));
  }

  scan(index: IndexName, value: string): readonly StoredRecord[] | Unknown {
    if (!(index in INDEXES)) return UNKNOWN;
    return [...this.records.values()].filter((r) => inIndex(r, index, value));
  }

  idUsed(id: string): boolean {
    return this.registry.has(id);
  }

  /** Write a mutation's staged writes. A write equal to the stored record
   * (rev aside) changes nothing; a new or changed record gets the next rev
   * of its key or id, which continues across a delete. Answers the keys
   * that changed. */
  commit(writes: readonly Write[]): string[] {
    const changed: string[] = [];
    for (const [key, next] of writes) {
      const prev = this.records.get(key);
      if (next === null) {
        if (prev) {
          this.records.delete(key);
          changed.push(key);
        }
        continue;
      }
      if (prev && same(prev, next)) continue;
      const reg = registryKey(next);
      const rev = (prev?.rev ?? this.registry.get(reg) ?? 0) + 1;
      this.records.set(key, { ...next, rev } as StoredRecord);
      this.registry.set(reg, rev);
      changed.push(key);
    }
    return changed;
  }

  /** A copy of the store. */
  clone(): MemoryStore {
    const c = new MemoryStore();
    for (const [k, r] of this.records) c.records.set(k, structuredClone(r));
    for (const [k, v] of this.registry) c.registry.set(k, v);
    return c;
  }
}
