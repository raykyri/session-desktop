// The replica in React (02 §9.1): `ReplicaProvider` holds the viewer's
// `ReplicaSource`, and `useReplicaQuery` reads it reactively. A query is a
// function of the source; its answer is recomputed when the replica changes
// and handed to the component only when it differs (structural equality), so
// a write to one thread does not re-render another thread's row (W9.1).

import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { queryKeys, useModels, useWeeklyUsage } from "../api/account.js";
import type { Viewer } from "../features/shell/viewer.js";

import { defaultOnlineData, withServerData, type OnlineData } from "./online.js";
import { UNKNOWN, emptyReplica, type ReplicaSource, type Unknown } from "./source.js";

/** How a build makes the viewer's replica. */
export interface ReplicaConfig {
  create: (viewer: Viewer) => ReplicaSource & { dispose?: () => void };
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
      emptyReplica(viewer.kind === "signedOut" ? null : viewer.user.login),
    // One replica per viewer: a sign-in or sign-out makes a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, given],
  );
  useEffect(() => () => (made as { dispose?: () => void }).dispose?.(), [made]);
  const member = viewer.kind === "member";
  const value = useMemo(
    () => ({ source: made, online: { ...defaultOnlineData(), ...config?.online }, member }),
    [made, member],
  );
  return <ReplicaContext.Provider value={value}>{children}</ReplicaContext.Provider>;
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
 * usage and the recent runs are refetched when one of the member's runs
 * ends in the replica.
 * Must be rendered inside the app's query client.
 */
export function useOnlineData(): OnlineData {
  const { online, member } = useContext(ReplicaContext);
  const models = useModels(member);
  const usage = useWeeklyUsage(member);
  const ended = useReplicaQuery(endedRunsOf, []);
  const client = useQueryClient();
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
    const value = source.ready() ? select(source) : UNKNOWN;
    if (hit && sameData(hit.value, value)) {
      cache.current = { source, version, deps, value: hit.value };
      return hit.value;
    }
    cache.current = { source, version, deps, value };
    return value;
  };
  return useSyncExternalStore((listener) => source.subscribe(listener), read, read);
}
