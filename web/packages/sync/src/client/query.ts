// Reactive queries (`01` Y12): a selector over the client's view, re-run
// when a key it read, or a record of a kind it listed, changes, or when what
// the replica holds changed shape (a log, a thread's tier, the outbox),
// which can change what is known. The client notifies once per confirming
// batch, and a query whose value comes out equal (shallowly, for arrays and
// plain objects) does not notify, so a component re-renders once per batch
// that changed what it shows.

import type { Index, Kind, RecordOf, StoredRecord } from "@session/mutators";
import { useMemo, useSyncExternalStore } from "react";

import type { SyncClient } from "./client.js";

/** What a selector reads the view with. */
export interface QueryReader {
  get(key: string): StoredRecord | undefined;
  /** The records of `kind` the person sees, in key order. */
  list<K extends Kind>(kind: K): RecordOf<K>[];
  /** Whether the view can answer for a key, or an index (`SyncClient.loaded`). */
  loaded(key: string): boolean;
  loadedIndex(kind: Kind, index: Index): boolean;
}

/** The kind a key names: every key is `<kind>:…` (`keyOf`). */
const kindOfKey = (key: string) => key.slice(0, key.indexOf(":"));

/** Equal values, or arrays and plain objects whose items are identical. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    Object.getPrototypeOf(a) === Object.prototype &&
    Object.getPrototypeOf(b) === Object.prototype
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

/** A selector kept current over a client's view. */
export class LiveQuery<T> {
  private value!: T;
  private keys = new Set<string>();
  private kinds = new Set<string>();
  /** The client's view version the value was computed at. */
  private at = -1;
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

  /** The client's notification: re-run when it names what the selector read,
   * or the replica changed shape; tell the listeners when the value changed. */
  private readonly changed = (changed: ReadonlySet<string>, info: { structural: boolean }) => {
    let hit = info.structural;
    for (const k of changed)
      if (hit || this.keys.has(k) || this.kinds.has(kindOfKey(k))) {
        hit = true;
        break;
      }
    if (!hit) {
      this.at = this.client.version;
      return;
    }
    if (this.run()) for (const f of [...this.listeners]) f();
  };

  /** Run the selector; whether its value changed. */
  private run(): boolean {
    const keys = new Set<string>();
    const kinds = new Set<string>();
    const client = this.client;
    this.runs++;
    this.at = client.version;
    const next = this.selector({
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
      loaded: (key) => {
        keys.add(key);
        return client.loaded(key);
      },
      loadedIndex: (kind, index) => {
        kinds.add(kind);
        return client.loadedIndex(kind, index);
      },
    });
    this.keys = keys;
    this.kinds = kinds;
    if (this.runs > 1 && shallowEqual(next, this.value)) return false;
    this.value = next;
    return true;
  }

  current = (): T => this.value;

  /** Listen for a new value. The query follows the client while it has a
   * listener; the first one re-runs it only when the view changed since the
   * value was computed. */
  subscribe = (listener: () => void): (() => void) => {
    if (!this.detach) {
      this.detach = this.client.subscribe(this.changed);
      if (this.at !== this.client.version) this.run();
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
