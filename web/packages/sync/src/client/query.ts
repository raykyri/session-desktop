// Reactive queries (`01` Y12): a selector over the client's view, re-run
// when a key it read, or a record of a kind it listed, changes. The client
// notifies once per confirming batch (a pull, a snapshot, an outbox change),
// so a component re-renders once per batch, not once per record.

import type { Kind, RecordOf, StoredRecord } from "@session/mutators";
import { useMemo, useSyncExternalStore } from "react";

import type { SyncClient } from "./client.js";

/** What a selector reads the view with. */
export interface QueryReader {
  get(key: string): StoredRecord | undefined;
  /** The records of `kind` the person sees, in key order. */
  list<K extends Kind>(kind: K): RecordOf<K>[];
}

/** The kind a key names: every key is `<kind>:…` (`keyOf`). */
const kindOfKey = (key: string) => key.slice(0, key.indexOf(":"));

/** A selector kept current over a client's view. */
export class LiveQuery<T> {
  private value!: T;
  private keys = new Set<string>();
  private kinds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;
  /** How many times the selector ran (for tests). */
  runs = 0;

  constructor(
    private readonly client: SyncClient,
    private readonly selector: (q: QueryReader) => T,
  ) {
    this.run();
  }

  /** The client's notification: re-run when it names what the selector read. */
  private readonly changed = (changed: ReadonlySet<string>) => {
    for (const k of changed)
      if (this.keys.has(k) || this.kinds.has(kindOfKey(k))) {
        this.run();
        for (const f of this.listeners) f();
        return;
      }
  };

  private run() {
    const keys = new Set<string>();
    const kinds = new Set<string>();
    const client = this.client;
    this.runs++;
    this.value = this.selector({
      get: (key) => {
        keys.add(key);
        return client.get(key);
      },
      list: <K extends Kind>(kind: K) => {
        kinds.add(kind);
        return client
          .keysOfKind(kind)
          .sort()
          .flatMap((k) => {
            const r = client.get(k);
            return r?.kind === kind ? [r as RecordOf<K>] : [];
          });
      },
    });
    this.keys = keys;
    this.kinds = kinds;
  }

  current = (): T => this.value;

  /** Listen for a new value. The query follows the client while it has a
   * listener; the first one re-runs it, so nothing changed in between is
   * missed. */
  subscribe = (listener: () => void): (() => void) => {
    if (!this.detach) {
      this.detach = this.client.subscribe(this.changed);
      this.run();
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.detach) {
        this.detach();
        this.detach = null;
      }
    };
  };
}

/** A selector's value over the client's view, re-rendering the component
 * when what it read changes. `deps` are the selector's own inputs (a thread
 * id, a filter): a change makes a new query. */
export function useQuery<T>(
  client: SyncClient,
  selector: (q: QueryReader) => T,
  deps: readonly unknown[] = [],
): T {
  // the query is keyed by the client and the selector's own inputs
  const query = useMemo(() => new LiveQuery(client, selector), [client, ...deps]);
  return useSyncExternalStore(query.subscribe, query.current, query.current);
}
