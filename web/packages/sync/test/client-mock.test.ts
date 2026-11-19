// The client half against the mockup's mock backend
// (`docs/mockups/session-web-spaces-mock-api.js`), whose sync endpoints are
// the contract the server follows: a reminted envelope is answered from an
// id it replaces, and Send again after EXPIRED is a new write (review round
// 1, reviewer B finding 7). The mock is classic scripts that define globals
// on `window`; they run here with `window` as `globalThis` and stubs for
// `localStorage` and `EventSource`, with `fetch`, which the backend patches.

import test from "ava";

import { MockTransport, SyncClient, type MockPost } from "../src/client/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
   the mock is untyped JavaScript */
type Any = any;

const storage = new Map<string, string>();
const g = globalThis as Any;
g.window = globalThis;
g.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};
g.EventSource = function EventSource() {};
for (const name of ["fixtures", "jobs", "mock-api"])
  await import(`../../../../docs/mockups/session-web-spaces-${name}.js`);
const M = g.SessionMockApi;
const backend = M.createBackend({
  seed: () => M.dec(M.enc(g.SessionFixtures.data)),
  latency: 0,
  dev: false,
});

const request = async (method: string, url: string, body?: unknown) => {
  const init =
    body === undefined ? { method, headers: {} } : { method, headers: {}, body: M.enc(body) };
  const res = await g.fetch(url, init);
  const text = await res.text();
  return { ok: res.status < 400, status: res.status as number, body: text ? M.dec(text) : {} };
};
const post: MockPost = (path, body) => request("POST", path, body);

const DAY = 864e5;

async function fresh() {
  backend.wipe();
  const now = Date.parse((await request("GET", "/api/dev/config")).body.now);
  const thread = g.SessionFixtures.data.posts.find((p: Any) => p.k === "post" && !p.gone && !p.del);
  const clientId = (await post("/api/sync/register", {})).body["clientId"] as string;
  // the client's next seq: a replayed answer uses none
  let seq = 0;
  const env = (mutationId: string, t: string, replaces: string[] = [], replay = false) => ({
    clientId,
    seq: replay ? seq + 1 : ++seq,
    mutationId,
    clientTime: now,
    queuedAt: now,
    replaces,
    name: "research.createPostFollowUp",
    input: { thread: thread.id, t },
  });
  // the replies under the thread with text `t`, as the mock stores them
  const copies = (t: string) => {
    const s = storage.get("session-mock-db-v6");
    const rp = s ? (M.dec(s).data.rp?.[thread.id] ?? []) : [];
    return Promise.resolve((rp as { t: string }[]).filter((r) => r.t === t).length);
  };
  return { now, thread, env, copies };
}

test.serial(
  "the mock answers a reminted envelope from an id it replaces; a delayed copy of the old one gets the remint's answer",
  async (t) => {
    const { now, env, copies } = await fresh();
    // the first envelope applies; its remint is answered from it
    const m1 = M.ulid(now, 1);
    t.is((await post("/api/sync/write", env(m1, "once"))).status, 200);
    const again = await post("/api/sync/write", env(M.ulid(now, 2), "once", [m1], true));
    t.like(again, { status: 200, body: { replayed: true } });
    t.is(await copies("once"), 1);
    // the remint arrives first; the old envelope, late, replays its answer
    const m3 = M.ulid(now, 3);
    const first = await post("/api/sync/write", env(M.ulid(now, 4), "late copy", [m3]));
    t.is(first.status, 200, JSON.stringify(first.body));
    const late = await post("/api/sync/write", env(m3, "late copy", [], true));
    t.like(late, { status: 200, body: { replayed: true } });
    t.is(await copies("late copy"), 1);
  },
);

test.serial(
  "Send again after EXPIRED: the mock replays the refusal for an envelope that lists the expired id, and the client sends a new write",
  async (t) => {
    const { now, thread, env, copies } = await fresh();
    const old = M.ulid(now - 5 * DAY, 5);
    t.like(await post("/api/sync/write", env(old, "x")), {
      status: 422,
      body: { code: "EXPIRED" },
    });
    t.like(await post("/api/sync/write", env(M.ulid(now, 6), "x", [old])), {
      body: { code: "EXPIRED", replayed: true },
    });
    // the client: EXPIRED is shown; Send again lists nothing and is applied.
    // (Ids made 5 days ago and never sent are made again before the first
    // send, so the write carries the expired id in `replaces`, as a remint
    // of it would.)
    const c = new SyncClient({
      user: "me",
      transport: new MockTransport(post),
      clock: { now: () => now },
      monotonic: () => now,
      timer: null,
    });
    await c.init();
    const { local } = c.write(
      "research.createPostFollowUp",
      { id: M.ulid(now, 7), thread: thread.id, t: "sent again" },
      { mutationId: M.ulid(now, 8), queuedAt: now, replaces: [old] },
    );
    await c.flush();
    t.like(c.outbox()[0] ?? {}, { state: "expired" });
    t.true(c.sendAgain(local));
    await c.flush();
    t.like(c.outbox()[0] ?? {}, { state: "answered", replaces: [] });
    t.is(await copies("sent again"), 1);
  },
);
