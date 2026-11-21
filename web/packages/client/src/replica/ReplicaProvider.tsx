// The replica in React (02 §9.1): `ReplicaProvider` holds the viewer's
// `ReplicaSource`, and `useReplicaQuery` reads it reactively. A query is a
// function of the source; its answer is recomputed when the replica changes
// and handed to the component only when it differs (structural equality), so
// a write to one thread does not re-render another thread's row (W9.1).

import { QueryClientContext, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { queryKeys, useModels, useWeeklyUsage } from "../api/account.js";
import { viewerHandle, type Viewer } from "../features/shell/viewer.js";
import { outOfTokensText } from "../features/usage/usageText.js";
import { useThreadUiStore } from "../stores/threadUi.js";

import {
  defaultOnlineData,
  outOfTokens,
  withServerData,
  type ModelListing,
  type OnlineData,
  type WeeklyUsage,
} from "./online.js";
import { UNKNOWN, emptyReplica, runQuery, type ReplicaSource, type Unknown } from "./source.js";

/** How a build makes the viewer's replica. `create` may run more than once
 * per viewer (React can discard a render, and does under StrictMode), so it
 * should not start work: `activate` runs when the provider mounts with the
 * replica and `dispose` when it unmounts, possibly more than once each. */
export interface ReplicaConfig {
  create: (viewer: Viewer) => ReplicaSource & { activate?: () => void; dispose?: () => void };
  online?: Partial<OnlineData>;
}

let config: ReplicaConfig | null = null;

/** Sets how replicas are made (the fixture build and tests); without it
 * every viewer gets the empty replica. */
export function configureReplica(next: ReplicaConfig | null): void {
  config = next;
}

interface ReplicaContextValue {
  source: ReplicaSource;
  online: OnlineData;
  /** A member reads `models.list` and `usage.get` from the server. */
  member: boolean;
}

const ReplicaContext = createContext<ReplicaContextValue>({
  source: emptyReplica(null),
  online: defaultOnlineData(),
  member: false,
});

const viewerKey = (viewer: Viewer) =>
  viewer.kind === "signedOut" ? "out" : `${viewer.kind}:${viewer.user.id}`;

export function ReplicaProvider({
  viewer,
  source: given,
  children,
}: {
  viewer: Viewer;
  /** A source to use instead of the configured one (tests). */
  source?: ReplicaSource;
  children: ReactNode;
}) {
  const key = viewerKey(viewer);
  const made = useMemo(
    () =>
      given ??
      config?.create(viewer) ??
      emptyReplica(viewer.kind === "signedOut" ? null : viewerHandle(viewer.user)),
    // One replica per viewer: a sign-in or sign-out makes a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, given],
  );
  useEffect(() => {
    const lifecycle = made as { activate?: () => void; dispose?: () => void };
    lifecycle.activate?.();
    return () => lifecycle.dispose?.();
  }, [made]);
  // Another viewer (a sign-in or sign-out without a reload): no selection or
  // open composer of the previous one stays.
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current !== key) useThreadUiStore.getState().reset();
    previous.current = key;
  }, [key]);
  const member = viewer.kind === "member";
  const value = useMemo(
    () => ({ source: made, online: { ...defaultOnlineData(), ...config?.online }, member }),
    [made, member],
  );
  // `usage.get` is refreshed from one place, not from each reader.
  const client = useContext(QueryClientContext);
  return (
    <ReplicaContext.Provider value={value}>
      {member && client ? <UsageRefresh /> : null}
      {children}
    </ReplicaContext.Provider>
  );
}

/** How long after a reading's `resetAt` it is fetched again: the server's
 * week has turned by then (03 K3). */
export const RESET_REFETCH_DELAY_MS = 1_000;

/** The longest wait `setTimeout` takes (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Refetches the member's `usage.get` reading (03 K6): when one of their runs
 * ends in the replica (with the Usage page's recent runs), and when the
 * reading's week resets, so a tab left open across the reset does not keep
 * the previous week's reading. Rendered once, by the provider, inside a
 * query client.
 */
function UsageRefresh() {
  const source = useReplica();
  const client = useQueryClient();
  const usage = useWeeklyUsage(true);
  const ended = useReplicaQuery(endedRunsOf, []);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (ended === UNKNOWN) return;
    if (seen.current !== null && seen.current !== ended) {
      // The ring's reading and the Usage page's recent runs both moved.
      void client.invalidateQueries({ queryKey: queryKeys.weeklyUsage() });
      void client.invalidateQueries({ queryKey: queryKeys.usageRuns() });
    }
    seen.current = ended;
  }, [ended, client]);
  const resetAt = usage.data?.resetAt;
  useEffect(() => {
    if (resetAt === undefined) return;
    const wait = Math.min(
      MAX_TIMER_MS,
      Math.max(0, resetAt - source.now() + RESET_REFETCH_DELAY_MS),
    );
    const timer = setTimeout(() => {
      void client.invalidateQueries({ queryKey: queryKeys.weeklyUsage() });
      void client.invalidateQueries({ queryKey: queryKeys.usageRuns() });
    }, wait);
    return () => clearTimeout(timer);
  }, [resetAt, source, client]);
  return null;
}

export function useReplica(): ReplicaSource {
  return useContext(ReplicaContext).source;
}

/** The viewer's run records that have ended: a change means the ring's
 * reading may have moved (03 K6). */
function endedRunsOf(source: ReplicaSource): number {
  return source
    .all("run")
    .filter((run) => run.u === source.me && run.status !== "queued" && run.status !== "running")
    .length;
}

/**
 * The online-only data (02 §9.1): for a member, `models.list` and
 * `usage.get` from the server over the build's values (03 K6, K15). The
 * provider's `UsageRefresh` decides when the reading is fetched again.
 * Must be rendered inside the app's query client.
 */
export function useOnlineData(): OnlineData {
  const { online, member } = useContext(ReplicaContext);
  const models = useModels(member);
  const usage = useWeeklyUsage(member);
  const usageData = usage.data;
  const readAt = usage.dataUpdatedAt;
  return useMemo(
    () =>
      withServerData(
        online,
        models.data,
        usageData === undefined ? undefined : { ...usageData, readAt },
      ),
    [online, models.data, usageData, readAt],
  );
}

/**
 * The out-of-tokens toast for a run on a model when nothing can pay for it
 * now (03 K8, `outOfTokens`), else null; read when a write is about to be
 * sent, from the latest `models.list` and `usage.get` answers in the query
 * cache over the build's values. A refusal fetches the reading again, so a
 * reading that no longer holds refuses at most until its refetch answers.
 * Outside a query client (a test that renders without one) nothing is
 * refused here.
 */
export function useOutOfTokensToast(): (model: string) => string | null {
  const { source, online, member } = useContext(ReplicaContext);
  const client = useContext(QueryClientContext);
  return useCallback(
    (model: string) => {
      const listing = member ? client?.getQueryData<ModelListing>(queryKeys.models()) : undefined;
      const usage = member ? client?.getQueryData<WeeklyUsage>(queryKeys.weeklyUsage()) : undefined;
      const data = withServerData(online, listing, usage);
      if (!outOfTokens(data, model, source.now())) return null;
      if (member) void client?.invalidateQueries({ queryKey: queryKeys.weeklyUsage() });
      return outOfTokensText(data.usage?.resetsAt ?? null);
    },
    [source, online, member, client],
  );
}

/** Structural equality over plain data (records, arrays, objects). */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => sameData(x, b[i]));
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Reads `select(source)` and re-renders only when its answer changes. A
 * source that is not ready answers `UNKNOWN`. `deps` are the values
 * `select` closes over. */
export function useReplicaQuery<T>(
  select: (source: ReplicaSource) => T,
  deps: readonly unknown[],
): T | Unknown {
  const source = useReplica();
  const cache = useRef<{
    source: ReplicaSource;
    version: number;
    deps: readonly unknown[];
    value: T | Unknown;
  } | null>(null);
  const read = (): T | Unknown => {
    const version = source.version();
    const hit = cache.current?.source === source ? cache.current : null;
    if (hit && hit.version === version && sameData(hit.deps, deps)) return hit.value;
    const value = source.ready() ? runQuery(() => select(source)) : UNKNOWN;
    if (hit && sameData(hit.value, value)) {
      cache.current = { source, version, deps, value: hit.value };
      return hit.value;
    }
    cache.current = { source, version, deps, value };
    return value;
  };
  return useSyncExternalStore((listener) => source.subscribe(listener), read, read);
}
