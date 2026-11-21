// The tab's client id (`01` Y3, `02` §9.2): `{clientId, userId}` in
// sessionStorage, guarded by the Web Lock `session-client:<clientId>`
// (`claimClientId` of `@session/sync/client`). A reload takes the lock again
// and re-attaches the id with `register`; a duplicated tab, which copies
// sessionStorage, finds the lock held and registers a new id. One claim per
// tab and account: the replica of a later render, and the one React makes
// twice under StrictMode, share it. The lock is held until the page goes
// away; sign-out releases it and clears the stored id.

import {
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

let current: { userId: string; claim: Promise<Claim>; held: HeldClientId | null } | null = null;

/** The tab's client id for `userId`, claimed once per tab and account. A
 * claim that failed (no answer, a refusal) is tried again on the next call. */
export function tabClientId(
  userId: string,
  register: (options?: RegisterOptions) => Promise<RegisterResult>,
  deps: TabClientDeps = browserTabDeps(),
): Promise<Claim> {
  if (current?.userId === userId) return current.claim;
  if (current?.held) current.held.release();
  const entry: { userId: string; claim: Promise<Claim>; held: HeldClientId | null } = {
    userId,
    claim: Promise.resolve({ error: { code: "SERVICE_UNAVAILABLE", message: "" } }),
    held: null,
  };
  entry.claim = claimClientId({ userId, storage: deps.storage, locks: deps.locks, register }).then(
    (claim) => {
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
 * tab keeps it instead of the previous one. */
export async function keepTabClientId(
  userId: string,
  clientId: string,
  lastSeq: number,
  deps: TabClientDeps = browserTabDeps(),
): Promise<void> {
  const previous = current?.userId === userId ? (current.held ?? undefined) : undefined;
  const held = await storeClientId({
    userId,
    clientId,
    lastSeq,
    storage: deps.storage,
    locks: deps.locks,
    ...(previous ? { previous } : {}),
  });
  current = { userId, claim: Promise.resolve(held), held };
}

/** Sign-out: clear the stored id and release its lock. */
export function forgetTabClientId(deps: Pick<TabClientDeps, "storage"> = browserTabDeps()): void {
  const held = current?.held ?? undefined;
  current = null;
  try {
    forgetClientId(deps.storage, held);
  } catch {
    // no sessionStorage: nothing stored
  }
}

/** Forget the claim without touching storage (tests). */
export function resetTabClientForTests(): void {
  current?.held?.release();
  current = null;
}
