// What the screens read: the records the client holds (the sync client's
// view of its replica and pending writes, or a guest's snapshots), by kind
// and id, as `@session/sync`'s `View` reads them. Queries over it are pure
// functions (`../data/`), so a test runs them over a plain map.

import * as pkg from "@session/mutators";
import type { Changing, StoredRecord } from "@session/sync/client";

/** The records a reader sees: the sync client, or a guest's store. */
export interface RecordSource extends Changing {
  get(key: string): StoredRecord | undefined;
  keys(): Set<string>;
  pendingAt(key: string): boolean;
}

export class Reader {
  private cache: Map<string, StoredRecord[]> | null = null;

  constructor(
    private readonly src: Pick<RecordSource, "get" | "keys" | "pendingAt">,
    /** The signed-in person's handle, or null. */
    readonly me: string | null,
  ) {}

  get<K extends pkg.Kind>(kind: K, id: string): pkg.RecordOf<K> | undefined {
    const r = this.src.get(pkg.keyFor(kind, id));
    return r?.kind === kind ? (r as pkg.RecordOf<K>) : undefined;
  }

  byKey(key: string): StoredRecord | undefined {
    return this.src.get(key);
  }

  /** The records of a kind, by the server's creation time. One pass over the
   * keys serves every kind this reader is asked for. */
  list<K extends pkg.Kind>(kind: K, pred?: (r: pkg.RecordOf<K>) => boolean): pkg.RecordOf<K>[] {
    if (!this.cache) {
      const by = new Map<string, StoredRecord[]>();
      for (const key of this.src.keys()) {
        const r = this.src.get(key);
        if (!r) continue;
        const l = by.get(r.kind) ?? [];
        l.push(r);
        by.set(r.kind, l);
      }
      for (const l of by.values())
        l.sort((a, b) => {
          const x = pkg.createdOf(a);
          const y = pkg.createdOf(b);
          return x < y ? -1 : x > y ? 1 : 0;
        });
      this.cache = by;
    }
    const all = (this.cache.get(kind) ?? []) as pkg.RecordOf<K>[];
    return pred ? all.filter(pred) : [...all];
  }

  pending(key: string): boolean {
    return this.src.pendingAt(key);
  }
}

/** A record source over a plain map (tests, and the frozen reads of a
 * screen). */
export function mapSource(records: Iterable<StoredRecord>): Pick<
  RecordSource,
  "get" | "keys" | "pendingAt"
> {
  const m = new Map<string, StoredRecord>();
  for (const r of records) m.set(pkg.keyOf(r), r);
  return { get: (k) => m.get(k), keys: () => new Set(m.keys()), pendingAt: () => false };
}
