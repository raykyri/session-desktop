// `01` Y3, `02` §9.2: a tab keeps its client id across reloads in
// sessionStorage behind a Web Lock; a fake sessionStorage and lock manager
// stand in for the browser's.

import test from "ava";

import {
  CLIENT_ID_KEY,
  claimClientId,
  forgetClientId,
  type HeldClientId,
  type LockManagerLike,
  type SessionStorageLike,
} from "../src/client/index.js";
import { REGISTRATIONS_PER_DAY } from "../src/server/index.js";

import { DAY, World, actor } from "./world.js";

class FakeStorage implements SessionStorageLike {
  constructor(readonly items = new Map<string, string>()) {}
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
  /** A duplicated tab inherits a copy. */
  copy() {
    return new FakeStorage(new Map(this.items));
  }
}

/** Exclusive locks shared by the tabs of one browser. */
class FakeLocks implements LockManagerLike {
  readonly held = new Set<string>();
  async request(
    name: string,
    _o: { mode: "exclusive"; ifAvailable: true },
    cb: (lock: unknown) => Promise<unknown>,
  ) {
    if (this.held.has(name)) return cb(null);
    this.held.add(name);
    try {
      return await cb({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

/** The page went away: its lock is released once its promise settles. */
const tick = () => new Promise((done) => setImmediate(done));

const claim = (w: World, u: string, storage: SessionStorageLike, locks: LockManagerLike) =>
  claimClientId({
    userId: u,
    storage,
    locks,
    register: (o) => Promise.resolve(w.server.register(actor(u), o)),
  });

const held = (x: Awaited<ReturnType<typeof claim>>): HeldClientId => {
  if ("error" in x) throw new Error(x.error.code);
  return x;
};

test("100 reloads of one tab register one id and re-attach it 99 times", async (t) => {
  const w = new World();
  const storage = new FakeStorage();
  const locks = new FakeLocks();
  const ids = new Set<string>();
  let reattached = 0;
  for (let k = 0; k < 100; k++) {
    const h = held(await claim(w, "mel", storage, locks));
    ids.add(h.clientId);
    if (h.reattached) reattached++;
    // the page goes away: its lock is released
    h.release();
    await tick();
  }
  t.is(ids.size, 1);
  t.is(reattached, 99);
  t.is(w.store.registrationsSince("mel", 0), 1);
});

test("a duplicated tab gets a new id; the first tab keeps its own", async (t) => {
  const w = new World();
  const storage = new FakeStorage();
  const locks = new FakeLocks();
  const first = held(await claim(w, "mel", storage, locks));
  const dup = held(await claim(w, "mel", storage.copy(), locks));
  t.not(dup.clientId, first.clientId);
  t.false(dup.reattached);
  // a reload of the first tab still re-attaches its id
  first.release();
  await tick();
  const again = held(await claim(w, "mel", storage, locks));
  t.is(again.clientId, first.clientId);
});

test("a stored id of another user answers WRONG_CLIENT, and the tab registers anew", async (t) => {
  const w = new World();
  const locks = new FakeLocks();
  const ada = w.server.register(actor("ada"));
  if (!ada.ok) return t.fail();
  // storage claims the id is mel's
  const storage = new FakeStorage(
    new Map([[CLIENT_ID_KEY, JSON.stringify({ clientId: ada.clientId, userId: "mel" })]]),
  );
  const h = held(await claim(w, "mel", storage, locks));
  t.not(h.clientId, ada.clientId);
  t.false(h.reattached);
  t.is(
    (JSON.parse(storage.getItem(CLIENT_ID_KEY) ?? "{}") as { clientId?: string }).clientId,
    h.clientId,
  );
  // the stored id of a user who signed out and another who signed in: not tried
  const other = held(await claim(w, "otto", storage, locks));
  t.not(other.clientId, h.clientId);
});

test("re-attaches are not counted; the 51st new id of a day is refused", async (t) => {
  const w = new World();
  const locks = new FakeLocks();
  const storage = new FakeStorage();
  const h = held(await claim(w, "mel", storage, locks));
  h.release();
  await tick();
  for (let k = 0; k < 10; k++) {
    const again = held(await claim(w, "mel", storage, locks));
    t.true(again.reattached);
    again.release();
    await tick();
  }
  // 49 more new ids: fresh tabs
  for (let k = 1; k < REGISTRATIONS_PER_DAY; k++)
    held(await claim(w, "mel", new FakeStorage(), locks));
  const refused = await claim(w, "mel", new FakeStorage(), locks);
  t.like(refused, { error: { code: "TOO_MANY_REQUESTS" } });
  // the tab with a stored id still re-attaches
  t.true(held(await claim(w, "mel", storage, locks)).reattached);
});

test("an id idle for 7 days is not re-attached; sign-out clears the stored id", async (t) => {
  const w = new World();
  const locks = new FakeLocks();
  const storage = new FakeStorage();
  const h = held(await claim(w, "mel", storage, locks));
  h.release();
  await tick();
  w.clock.advance(7 * DAY);
  const later = held(await claim(w, "mel", storage, locks));
  t.not(later.clientId, h.clientId);
  t.false(later.reattached);
  forgetClientId(storage, later);
  await tick();
  t.is(storage.getItem(CLIENT_ID_KEY), null);
  t.false(locks.held.has(`session-client:${later.clientId}`));
});
