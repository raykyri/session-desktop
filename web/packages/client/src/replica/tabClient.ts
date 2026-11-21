// The tab's client id (`01` Y3, `02` §9.2): `{clientId, userId}` in
// sessionStorage, guarded by the Web Lock `session-client:<clientId>`
// (`claimClientId` of `@session/sync/client`). A reload takes the lock again
// and re-attaches the id with `register`; a duplicated tab, which copies
// sessionStorage, finds the lock held and registers a new id. One claim per
// tab and account: the replica of a later render, and the one React makes
// twice under StrictMode, share it. The lock is held until the page goes
// away; sign-out releases it and clears the stored id.

import {
  CLIENT_ID_KEY,
  claimClientId,
  forgetClientId,
  storeClientId,
  type HeldClientId,
  type LockManagerLike,
  type RegisterOptions,
  type RegisterResult,
  type SessionStorageLike,
} from "@session/sync/client";

export interface TabClientDeps {
  storage: SessionStorageLike;
  locks: LockManagerLike;
}

/** The browser's sessionStorage and lock manager. Without a lock manager
 * (an old browser, a non-secure origin) every load registers a new id. */
export function browserTabDeps(): TabClientDeps {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  return {
    storage: globalThis.sessionStorage,
    locks: locks ?? {
      request: (_name, _options, callback) => callback(null),
    },
  };
}

type Claim = HeldClientId | { error: Extract<RegisterResult, { ok: false }>["error"] };

interface Entry {
  userId: string;
  claim: Promise<Claim>;
  held: HeldClientId | null;
  /** A sign-out, or a claim for another account, came after it: it writes
   * nothing and keeps no lock. */
  ended: boolean;
}

let current: Entry | null = null;
/** The account the tab's client id is for now; null after sign-out. */
let account: string | null = null;

/** A refusal for a claim that a sign-out overtook. */
const SIGNED_OUT = { code: "UNAUTHORIZED", message: "Signed out." } as const;

function end(entry: Entry | null): void {
  if (!entry) return;
  entry.ended = true;
  entry.held?.release();
  entry.held = null;
}

/** The tab's client id for `userId`, claimed once per tab and account. A
 * claim that failed (no answer, a refusal) is tried again on the next call.
 * A claim still pending at sign-out (or at a claim for another account)
 * writes no id when it settles and releases its lock. */
export function tabClientId(
  userId: string,
  register: (options?: RegisterOptions) => Promise<RegisterResult>,
  deps: TabClientDeps = browserTabDeps(),
): Promise<Claim> {
  account = userId;
  if (current?.userId === userId) return current.claim;
  end(current);
  const entry: Entry = {
    userId,
    claim: Promise.resolve({ error: { code: "SERVICE_UNAVAILABLE", message: "" } }),
    held: null,
    ended: false,
  };
  // writes after the end of the claim are dropped
  const storage = {
    getItem: (k: string) => deps.storage.getItem(k),
    setItem: (k: string, v: string) => {
      if (!entry.ended) deps.storage.setItem(k, v);
    },
    removeItem: (k: string) => {
      if (!entry.ended) deps.storage.removeItem(k);
    },
  };
  entry.claim = claimClientId({ userId, storage, locks: deps.locks, register }).then(
    (claim): Claim => {
      if (entry.ended) {
        if (!("error" in claim)) claim.release();
        return { error: SIGNED_OUT };
      }
      if ("error" in claim) {
        if (current === entry) current = null;
      } else entry.held = claim;
      return claim;
    },
    (error: unknown) => {
      if (current === entry) current = null;
      throw error;
    },
  );
  current = entry;
  return entry.claim;
}

/** A client id the sync client registered itself (after WRONG_CLIENT): the
 * tab keeps it instead of the previous one, unless the account signed out
 * or changed (before or while the lock was taken). */
export async function keepTabClientId(
  userId: string,
  clientId: string,
  lastSeq: number,
  deps: TabClientDeps = browserTabDeps(),
): Promise<void> {
  if (account !== userId) return;
  const previous = current?.userId === userId ? (current.held ?? undefined) : undefined;
  const before = current;
  const held = await storeClientId({
    userId,
    clientId,
    lastSeq,
    storage: deps.storage,
    locks: deps.locks,
    ...(previous ? { previous } : {}),
  });
  if (account !== userId || current !== before || before?.ended) {
    // signed out, or another account claimed meanwhile: keep nothing
    held.release();
    try {
      const stored = JSON.parse(deps.storage.getItem(CLIENT_ID_KEY) ?? "null") as {
        clientId?: string;
      } | null;
      if (stored?.clientId === clientId) deps.storage.removeItem(CLIENT_ID_KEY);
    } catch {
      // nothing readable stored
    }
    return;
  }
  current = { userId, claim: Promise.resolve(held), held, ended: false };
}

/** Sign-out: clear the stored id and release its lock; a claim in progress
 * writes nothing when it settles. */
export function forgetTabClientId(deps: Pick<TabClientDeps, "storage"> = browserTabDeps()): void {
  const entry = current;
  const held = entry?.held ?? undefined;
  current = null;
  account = null;
  if (entry) entry.ended = true;
  try {
    forgetClientId(deps.storage, held);
  } catch {
    // no sessionStorage: nothing stored
  }
  if (entry) entry.held = null;
}

/** Forget the claim without touching storage (tests). */
export function resetTabClientForTests(): void {
  current?.held?.release();
  current = null;
  account = null;
}
