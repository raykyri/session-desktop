// The spaces session in React: one session per signed-in person (or one for
// a guest), made when `/api/me` has answered, and the hooks screens read it
// with.

import { useQuery } from "@session/sync/react";
import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { meResource, useMe } from "../api/account.js";
import { useResource, type ResourceState } from "../api/resource.js";

import type { Reader } from "./reader.js";
import { SpacesSession, type Directory, type SessionStatus } from "./session.js";

const SessionContext = createContext<SpacesSession | null>(null);

type MakeSession = (me: string | null) => SpacesSession;
let factory: MakeSession | null = null;

/** Installs how sessions are made (tests: no event stream, a stub fetch);
 * null restores the default. */
export function setSessionFactory(f: MakeSession | null): void {
  factory = f;
}

/** Makes the session once `/api/me` has answered, and a new one when the
 * person changes (a sign-in, a sign-out). */
export function SpacesProvider({
  children,
  make,
}: {
  children: ReactNode;
  /** Tests: a session of their own. */
  make?: (me: string | null) => SpacesSession;
}) {
  const me = useMe();
  const known = me.status === "ready" || me.status === "error";
  const handle = me.data?.handle ?? null;
  const [session, setSession] = useState<SpacesSession | null>(null);
  useEffect(() => {
    if (!known) return;
    const s =
      make?.(handle) ??
      factory?.(handle) ??
      new SpacesSession(handle, {
        // the server no longer takes the session: ask who is signed in
        onUnauthorized: () => void meResource.load(true).catch(() => undefined),
      });
    // the session belongs to this effect: it is made, started and stopped here
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(s);
    void s.start();
    return () => s.stop();
  }, [known, handle, make]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** The session, or null while `/api/me` has not answered. */
export function useSession(): SpacesSession | null {
  return useContext(SessionContext);
}

const EMPTY_STATUS: SessionStatus = {
  online: true,
  updateRequired: false,
  signedOut: false,
  ready: false,
};

export function useStatus(): SessionStatus {
  const s = useSession();
  return useSyncExternalStore(
    (l) => (s ? s.onStatus(l) : () => undefined),
    () => (s ? s.status() : EMPTY_STATUS),
    () => (s ? s.status() : EMPTY_STATUS),
  );
}

const NO_QUERY = {
  get: () => undefined,
  subscribe: () => () => undefined,
};

/** A query over the records: `fn` runs again when they change, and the
 * component renders again when its result changes (compared as JSON). Null
 * before the session exists. */
export function useRecords<T>(fn: (r: Reader) => T, deps: readonly unknown[]): T | undefined {
  const s = useSession();
  // `fn` is new on each render; `deps` say when it means something new
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  const q = useMemo(() => (s ? s.query(fn) : NO_QUERY), [s, ...deps]);
  return useQuery(q as { get(): T | undefined; subscribe(l: () => void): () => void });
}

/** The directory's state before a session exists: one value, so
 * `useSyncExternalStore` reads the same snapshot each time. */
const IDLE = { status: "idle" as const, data: undefined, error: null };

export function useDirectory(): ResourceState<Directory> & { session: SpacesSession | null } {
  const s = useSession();
  const fallback = useMemo(
    () => ({
      get: () => IDLE,
      subscribe: () => () => undefined,
      load: () => Promise.reject(new Error("no session")),
      set: () => undefined,
      reset: () => undefined,
    }),
    [],
  );
  const state = useResource<Directory>(s ? s.directory : fallback, Boolean(s));
  return { ...state, session: s };
}

/** In-flight text of a run (its attempt), or null. */
export function useRunText(run: string | null, attempt?: number): string | null {
  const s = useSession();
  return useSyncExternalStore(
    (l) => (s ? s.runs.onChange(l) : () => undefined),
    () => (s && run ? s.runs.get(run, attempt) : null),
    () => null,
  );
}

/** The server's time as the client estimates it, ticking each `ms`. */
export function useNow(ms = 30_000): number {
  const s = useSession();
  const read = useCallback(() => (s ? s.now() : Date.now()), [s]);
  const [now, setNow] = useState(read);
  useEffect(() => {
    const h = setInterval(() => setNow(read()), ms);
    return () => clearInterval(h);
  }, [ms, read]);
  return now;
}
