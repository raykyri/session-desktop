// A cached read of a plain route, for the account state the replica does
// not hold (`/api/me`, the appearance settings, the runtime configuration,
// the space directory, the admin list). One request at a time per resource;
// components read it with `useResource`, which loads it on first use. It
// replaces TanStack Query, which the shell used for the same few reads
// (phase 2b).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export interface ResourceState<T> {
  status: "idle" | "loading" | "ready" | "error";
  data: T | undefined;
  error: Error | null;
}

export interface Resource<T> {
  get(): ResourceState<T>;
  subscribe(listener: () => void): () => void;
  /** Fetch it unless it is loaded (or `force`); answers the data. */
  load(force?: boolean): Promise<T>;
  /** Replace the data (a write's answer). */
  set(data: T): void;
  /** Forget it: the next use fetches again. */
  reset(): void;
}

export function createResource<T>(fetcher: () => Promise<T>): Resource<T> {
  let state: ResourceState<T> = { status: "idle", data: undefined, error: null };
  let inflight: Promise<T> | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const emit = (next: ResourceState<T>) => {
    state = next;
    for (const l of [...listeners]) l();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load(force = false) {
      if (!force && state.status === "ready") return Promise.resolve(state.data as T);
      if (inflight && !force) return inflight;
      const gen = ++generation;
      emit({ ...state, status: state.status === "ready" ? "ready" : "loading" });
      const p = fetcher().then(
        (data) => {
          if (gen === generation) emit({ status: "ready", data, error: null });
          return data;
        },
        (error: unknown) => {
          if (gen === generation)
            emit({
              status: "error",
              data: state.data,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          throw error;
        },
      );
      inflight = p;
      void p
        .finally(() => {
          if (inflight === p) inflight = null;
        })
        .catch(() => undefined);
      return p;
    },
    set(data) {
      generation++;
      inflight = null;
      emit({ status: "ready", data, error: null });
    },
    reset() {
      generation++;
      inflight = null;
      emit({ status: "idle", data: undefined, error: null });
    },
  };
}

/** The resource's state; it is loaded on first use (when `enabled`). */
export function useResource<T>(r: Resource<T>, enabled = true): ResourceState<T> {
  const state = useSyncExternalStore(
    (l) => r.subscribe(l),
    () => r.get(),
    () => r.get(),
  );
  useEffect(() => {
    if (enabled && r.get().status === "idle") void r.load().catch(() => undefined);
  }, [r, enabled, state.status]);
  return state;
}

export interface Action<I, O> {
  /** Run it; `onSuccess` gets the answer. An error is kept in `error`. */
  mutate: (input: I, o?: { onSuccess?: (out: O) => void; onError?: (e: Error) => void }) => void;
  isPending: boolean;
  error: Error | null;
  /** The last answer. */
  data: O | undefined;
}

/** A write in a component: whether it is running and its last error. */
export function useAction<I, O>(fn: (input: I) => Promise<O>): Action<I, O> {
  const [state, setState] = useState<{
    isPending: boolean;
    error: Error | null;
    data: O | undefined;
  }>({
    isPending: false,
    error: null,
    data: undefined,
  });
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const mutate = useCallback<Action<I, O>["mutate"]>((input, o) => {
    setState((s) => ({ ...s, isPending: true, error: null }));
    fnRef.current(input).then(
      (out) => {
        setState({ isPending: false, error: null, data: out });
        o?.onSuccess?.(out);
      },
      (e: unknown) => {
        const error = e instanceof Error ? e : new Error(String(e));
        setState((s) => ({ ...s, isPending: false, error }));
        o?.onError?.(error);
      },
    );
  }, []);
  return { mutate, ...state };
}
