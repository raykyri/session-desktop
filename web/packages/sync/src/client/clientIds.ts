// A tab's client id (`01` Y3; `02` §9.2). The web client keeps `{clientId,
// userId}` in sessionStorage, which survives a reload of the tab, is per tab
// and is cleared when the tab closes. On load the tab takes the exclusive
// Web Lock `session-client:<clientId>` with `ifAvailable`: a reload gets it
// (the old page released it) and re-attaches the id with `register`, which
// returns its `lastSeq`; a duplicated tab, which inherits a copy of
// sessionStorage, does not get it (the first tab holds it) and registers a
// new id. A stored id of another user, or one idle for 7 days, answers
// WRONG_CLIENT and the tab registers anew. Sign-out clears the stored id.
//
// The lock is held until the page goes away (`release` for tests and
// sign-out).

import type { RegisterOptions, RegisterResult } from "../wire.js";

/** The sessionStorage key. */
export const CLIENT_ID_KEY = "session-client";
/** The Web Lock name of a client id. */
export const clientLockName = (clientId: string) => `session-client:${clientId}`;

/** The part of `Storage` the helper uses. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The part of `LockManager` the helper uses (`navigator.locks`). */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

/** A client id the tab holds, and the lock on it. */
export interface HeldClientId {
  clientId: string;
  lastSeq: number;
  /** Whether `register` re-attached the stored id (not counted against the
   * day's limit). */
  reattached: boolean;
  /** Release the lock (the page is going away, or the person signed out). */
  release(): void;
}

interface Stored {
  clientId: string;
  userId: string;
}

function readStored(storage: SessionStorageLike): Stored | null {
  try {
    const v = JSON.parse(storage.getItem(CLIENT_ID_KEY) ?? "null") as unknown;
    if (
      v !== null &&
      typeof v === "object" &&
      typeof (v as Stored).clientId === "string" &&
      typeof (v as Stored).userId === "string"
    )
      return v as Stored;
  } catch {
    // not ours: overwritten below
  }
  return null;
}

/** Take the lock on `clientId` if no other tab holds it: the release, or
 * null. The lock is held until the release is called. */
async function tryLock(locks: LockManagerLike, clientId: string): Promise<(() => void) | null> {
  let release: () => void = () => {};
  const held = new Promise<void>((done) => (release = done));
  let got = false;
  const granted = new Promise<boolean>((answer) => {
    let request: Promise<unknown>;
    try {
      request = locks.request(
        clientLockName(clientId),
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          got = lock !== null;
          answer(got);
          return got ? held : Promise.resolve();
        },
      );
    } catch {
      // no lock manager: no lock, and no claim of the stored id
      answer(false);
      return;
    }
    // a request refused (a security error, an aborted request): no lock
    request.catch(() => answer(false));
  });
  return (await granted) ? release : null;
}

/** The tab's client id for `userId`: the stored one re-attached when this
 * tab may use it, else a new one. Returns the server's refusal when neither
 * works (TOO_MANY_REQUESTS for the day's 50 new ids, FORBIDDEN for a waiting
 * account, UNAUTHORIZED). */
export async function claimClientId(o: {
  userId: string;
  storage: SessionStorageLike;
  locks: LockManagerLike;
  register: (options?: RegisterOptions) => Promise<RegisterResult>;
}): Promise<HeldClientId | { error: Extract<RegisterResult, { ok: false }>["error"] }> {
  const stored = readStored(o.storage);
  if (stored && stored.userId === o.userId) {
    const release = await tryLock(o.locks, stored.clientId);
    if (release) {
      let r: RegisterResult;
      try {
        r = await o.register({ clientId: stored.clientId });
      } catch (e) {
        release();
        throw e;
      }
      if (r.ok) return { clientId: r.clientId, lastSeq: r.lastSeq, reattached: true, release };
      release();
      if (r.error.code !== "WRONG_CLIENT") return { error: r.error };
    }
  }
  // a new id: the stored one is another user's, expired, unknown, or held by
  // the tab this one was duplicated from
  const r = await o.register();
  if (!r.ok) return { error: r.error };
  o.storage.setItem(CLIENT_ID_KEY, JSON.stringify({ clientId: r.clientId, userId: o.userId }));
  const release = (await tryLock(o.locks, r.clientId)) ?? (() => {});
  return { clientId: r.clientId, lastSeq: r.lastSeq, reattached: false, release };
}

/** Sign-out: forget the tab's client id. */
export function forgetClientId(storage: SessionStorageLike, held?: HeldClientId): void {
  storage.removeItem(CLIENT_ID_KEY);
  held?.release();
}

/** A client id the client registered itself (its `client` event, after
 * WRONG_CLIENT): the tab keeps it in sessionStorage and holds its lock
 * instead of the previous one's. */
export async function storeClientId(o: {
  userId: string;
  clientId: string;
  lastSeq: number;
  storage: SessionStorageLike;
  locks: LockManagerLike;
  previous?: HeldClientId;
}): Promise<HeldClientId> {
  o.previous?.release();
  o.storage.setItem(CLIENT_ID_KEY, JSON.stringify({ clientId: o.clientId, userId: o.userId }));
  const release = (await tryLock(o.locks, o.clientId)) ?? (() => {});
  return { clientId: o.clientId, lastSeq: o.lastSeq, reattached: false, release };
}
