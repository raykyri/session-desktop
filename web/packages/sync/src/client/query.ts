// Reactive queries: `query(fn)` gives `{ get, subscribe }`. `get` runs `fn`
// over the client's view (the replica with its pending writes) and keeps the
// result until the view changes; `subscribe` calls back when a change gives
// `fn` a different result. Nothing here uses the DOM, so React (`react.ts`'s
// `useQuery`, over `useSyncExternalStore`) and React Native use it alike.

/** Something that changes, with a version that moves on each change. */
export interface Changing {
  version(): number;
  onChange(listener: () => void): () => void;
}

export interface Query<T> {
  /** The current result; the same value until the view changes and `fn`
   * gives a different one (so `useSyncExternalStore` sees a stable value). */
  get(): T;
  subscribe(listener: () => void): () => void;
}

/** Equal JSON values: how a query decides that its result changed. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function makeQuery<V, T>(source: Changing, view: () => V, fn: (view: V) => T): Query<T> {
  let at = -1;
  let value: T;
  const get = (): T => {
    const v = source.version();
    if (v !== at) {
      const next = fn(view());
      if (at === -1 || !same(next, value)) value = next;
      at = v;
    }
    return value;
  };
  return {
    get,
    subscribe(listener) {
      let last = get();
      return source.onChange(() => {
        const next = get();
        if (next !== last) {
          last = next;
          listener();
        }
      });
    },
  };
}
