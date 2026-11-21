// The HTTP transport's refusals and waits (01 S1, Y5, Y7; the sync routes'
// 429 contract), the tab's client id around sign-out (01 Y3), the text of
// "Not sent" writes across a reload (02 §9.2, §9.4), and the live build's
// wiring of the `UPGRADE_REQUIRED` reload (02 §9.2).

import { CLIENT_ID_KEY, clientLockName, type RegisterResult } from "@session/sync/client";
import test from "ava";

import {
  HttpSyncTransport,
  SyncHttpError,
  packReads,
  parseRetryAfter,
  retryAfterOf,
} from "../src/replica/http.js";
import { liveReplicaConfig } from "../src/replica/live.js";
import {
  forgetTabClientId,
  keepTabClientId,
  resetTabClientForTests,
  tabClientId,
} from "../src/replica/tabClient.js";
import { UPGRADE_RELOAD_KEY, resetUpgradeForTests } from "../src/replica/upgrade.js";
import { restoreUnsent, resetDrafts, useDraftsStore } from "../src/stores/drafts.js";

import { FakeLocks, FakeStorage, FakeSync, until } from "./syncFake.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const refusal429 = () =>
  json(
    429,
    { code: "TOO_MANY_REQUESTS", message: "Slow down.", serverTime: 1 },
    { "Retry-After": "7" },
  );

const envelope = {
  clientId: "c",
  seq: 1,
  mutationId: "m",
  name: "prefs.set",
  input: { layout: "wide" },
  protocolVersion: 4,
  clientTime: 1,
  queuedAt: 1,
};

// ---- Retry-After (item 10) ----

test("Retry-After: seconds or an HTTP date, in milliseconds", (t) => {
  t.is(parseRetryAfter("7"), 7000);
  t.is(parseRetryAfter(new Date(61_000).toUTCString(), 1000), 60_000);
  t.is(parseRetryAfter(null), undefined);
  t.is(parseRetryAfter("soon"), undefined);
});

test("a 429 on register, apply and read carries its Retry-After", async (t) => {
  const transport = new HttpSyncTransport({ fetch: () => Promise.resolve(refusal429()) });
  const reg = await transport.register();
  t.false(reg.ok);
  t.like(!reg.ok && reg.error, { code: "TOO_MANY_REQUESTS", retryAfterMs: 7000 });
  const applied = await transport.apply(envelope);
  t.like(!applied.ok && applied.error, { code: "TOO_MANY_REQUESTS", retryAfterMs: 7000 });
  const error = await t.throwsAsync(transport.snapshot("user:mona"));
  t.true(error instanceof SyncHttpError);
  t.is(retryAfterOf(error), 7000);
  t.is((error as SyncHttpError).code, "TOO_MANY_REQUESTS");
});

test("a 429 of apply with answers keeps the answer and adds the wait", async (t) => {
  const answer = {
    ok: false,
    error: { code: "TOO_MANY_REQUESTS", message: "Slow down.", serverTime: 1 },
  };
  const transport = new HttpSyncTransport({
    fetch: () => Promise.resolve(json(429, { answers: [answer] }, { "Retry-After": "3" })),
  });
  const r = await transport.apply(envelope);
  t.like(!r.ok && r.error, { code: "TOO_MANY_REQUESTS", retryAfterMs: 3000 });
});

test("a read answered with an error in its place: a transient one is asked again, another fails the read", async (t) => {
  let calls = 0;
  const transport = new HttpSyncTransport({
    readRetryMs: 5,
    fetch: (_input, init) => {
      calls += 1;
      const reads = (
        JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
          reads: { log: string }[];
        }
      ).reads;
      return Promise.resolve(
        json(200, {
          answers: reads.map((r) =>
            r.log === "space:bad"
              ? { error: { code: "BAD_REQUEST", message: "" } }
              : calls === 1
                ? { error: { code: "INTERNAL_SERVER_ERROR", message: "" } }
                : { records: [], cursor: "c", lastSeq: null },
          ),
          serverTime: 1,
        }),
      );
    },
  });
  const [good, bad] = await Promise.allSettled([
    transport.snapshot("space:good"),
    transport.snapshot("space:bad"),
  ]);
  t.is(good.status, "fulfilled");
  t.is(bad.status, "rejected");
  t.is(bad.status === "rejected" && (bad.reason as SyncHttpError).code, "BAD_REQUEST");
  t.is(calls, 2, "the transient read was asked again; the refused one was not");
});

test("a read answered with a transient error every time fails after its retries", async (t) => {
  let calls = 0;
  const transport = new HttpSyncTransport({
    readRetryMs: 2,
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        json(200, { answers: [{ error: { code: "TOO_MANY_REQUESTS", message: "" } }] }),
      );
    },
  });
  const error = await t.throwsAsync(transport.snapshot("space:x"));
  t.is((error as SyncHttpError).code, "TOO_MANY_REQUESTS");
  t.is(calls, 4, "the first ask and three more");
});

test("packReads: a log once per request, threads reads apart, at most 20 logs and 100 ids", (t) => {
  const e = (read: Record<string, unknown>) => ({ read: read as never });
  const groups = packReads([
    e({ log: "space:a", cursor: "1" }),
    e({ log: "space:a", tier: "window" }),
    e({ log: "space:b", tier: "threads", threads: ["1", "2"] }),
    ...Array.from({ length: 21 }, (_, i) =>
      e({ log: `space:t${i}`, tier: "threads", threads: ["x"] }),
    ),
    e({ log: "space:big", tier: "threads", threads: Array.from({ length: 99 }, String) }),
  ]);
  const logs = groups.map((g) => g.map((x) => (x.read as { log: string }).log));
  for (const g of logs) t.is(new Set(g).size, g.length, "each log once");
  t.deepEqual(logs.slice(0, 2), [["space:a"], ["space:a"]]);
  for (const g of groups.slice(2)) {
    const reads = g.map((x) => x.read as { tier?: string; threads?: string[] });
    t.true(reads.every((r) => r.tier === "threads"));
    t.true(reads.length <= 20);
    t.true(reads.reduce((n, r) => n + (r.threads?.length ?? 0), 0) <= 100);
  }
});

// ---- the event stream (items 9, 10, review 11) ----

test("events: a 426 is reported, and a 429 carries its Retry-After", async (t) => {
  let upgrades = 0;
  let status = 426;
  const transport = new HttpSyncTransport({
    onUpgrade: () => upgrades++,
    fetch: () =>
      Promise.resolve(
        status === 426
          ? json(426, { code: "UPGRADE_REQUIRED", message: "Update.", serverTime: 1 })
          : refusal429(),
      ),
  });
  const o = { clientId: "c", cursors: new Map(), signal: new AbortController().signal };
  const a = await transport.events({ ...o, onEvent: () => {} });
  t.is(a.status, 426);
  t.is(upgrades, 1);
  status = 429;
  const b = await transport.events({ ...o, onEvent: () => {} });
  t.like(b, { status: 429, code: "TOO_MANY_REQUESTS", retryAfterMs: 7000 });
});

test("events: a stream with nothing for two heartbeats is closed", async (t) => {
  const transport = new HttpSyncTransport({
    streamStallMs: 60,
    fetch: (_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
  });
  const started = Date.now();
  const r = await transport.events({
    clientId: "c",
    cursors: new Map(),
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  await r.done;
  const took = Date.now() - started;
  t.true(took >= 50 && took < 1000, `closed after ${took} ms`);
});

test("events: a stream that does not answer within the connect timeout fails", async (t) => {
  const transport = new HttpSyncTransport({
    streamConnectTimeoutMs: 40,
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  });
  await t.throwsAsync(
    transport.events({
      clientId: "c",
      cursors: new Map(),
      signal: new AbortController().signal,
      onEvent: () => {},
    }),
  );
});

// ---- the tab's client id (item 9, review 15) ----

test.serial("sign-out releases the lock of the tab's client id", async (t) => {
  resetTabClientForTests();
  const f = new FakeSync();
  const transport = new HttpSyncTransport({ fetch: f.fetchFor("mona") });
  const deps = { storage: new FakeStorage(), locks: new FakeLocks() };
  const held = await tabClientId("u-mona", (o) => transport.register(o), deps);
  if ("error" in held) throw new Error(held.error.code);
  t.true(deps.locks.held.has(clientLockName(held.clientId)));
  forgetTabClientId(deps);
  await until(() => !deps.locks.held.has(clientLockName(held.clientId)));
  t.is(deps.storage.getItem(CLIENT_ID_KEY), null);
  resetTabClientForTests();
});

test.serial("a claim pending at sign-out writes no id and releases its lock", async (t) => {
  resetTabClientForTests();
  const deps = { storage: new FakeStorage(), locks: new FakeLocks() };
  let answer: (r: RegisterResult) => void = () => {};
  const pending = tabClientId(
    "u-mona",
    () => new Promise<RegisterResult>((done) => (answer = done)),
    deps,
  );
  forgetTabClientId(deps);
  answer({ ok: true, clientId: "late", lastSeq: 0, reattached: false });
  const claim = await pending;
  t.true("error" in claim);
  t.is(deps.storage.getItem(CLIENT_ID_KEY), null, "no id written after sign-out");
  await until(() => !deps.locks.held.has(clientLockName("late")));
  resetTabClientForTests();
});

test.serial(
  "keepTabClientId writes nothing after sign-out, nor when sign-out comes while it waits",
  async (t) => {
    resetTabClientForTests();
    const f = new FakeSync();
    const transport = new HttpSyncTransport({ fetch: f.fetchFor("mona") });
    const deps = { storage: new FakeStorage(), locks: new FakeLocks() };
    await tabClientId("u-mona", (o) => transport.register(o), deps);
    forgetTabClientId(deps);
    await keepTabClientId("u-mona", "after", 0, deps);
    t.is(deps.storage.getItem(CLIENT_ID_KEY), null);

    // signed in again; sign-out while the lock is being taken
    await tabClientId("u-mona", (o) => transport.register(o), deps);
    const keeping = keepTabClientId("u-mona", "during", 0, deps);
    forgetTabClientId(deps);
    await keeping;
    t.is(deps.storage.getItem(CLIENT_ID_KEY), null);
    await until(() => !deps.locks.held.has(clientLockName("during")));

    // signed in: the id is kept
    await tabClientId("u-mona", (o) => transport.register(o), deps);
    await keepTabClientId("u-mona", "kept", 0, deps);
    t.like(JSON.parse(deps.storage.getItem(CLIENT_ID_KEY) ?? "null"), { clientId: "kept" });
    t.true(deps.locks.held.has(clientLockName("kept")));
    resetTabClientForTests();
  },
);

// ---- the text of Not sent writes across a reload (item 6) ----

test.serial(
  "a load puts the text of the writes that were Not sent back in their empty composers",
  (t) => {
    const restored = restoreUnsent({
      owner: "u1",
      byKey: { typed: { text: "newer", updatedAt: 1 } },
      unsent: {
        a: { key: "new", text: "My post" },
        b: { key: "typed", text: "older" },
      },
    });
    t.is(restored.byKey["new"]?.text, "My post");
    t.is(restored.byKey["typed"]?.text, "newer", "text typed since is kept");
    t.deepEqual(restored.unsent, {});
  },
);

test.serial(
  "the drafts store keeps unsent text in sessionStorage and restores it on rehydrate",
  async (t) => {
    sessionStorage.clear();
    resetDrafts("u1");
    useDraftsStore.getState().keepUnsent("local-1", { key: "new", text: "Kept across a reload" });
    t.is(useDraftsStore.getState().get("new"), undefined, "not in the composer while Not sent");
    const saved = sessionStorage.getItem("session.drafts.v3") ?? "{}";
    const stored = JSON.parse(saved) as { state: { unsent: Record<string, unknown> } };
    t.truthy(stored.state.unsent["local-1"]);
    // the page goes away; the next load reads sessionStorage
    useDraftsStore.setState({ byKey: {}, unsent: {} }, false);
    sessionStorage.setItem("session.drafts.v3", saved);
    await useDraftsStore.persist.rehydrate();
    t.is(useDraftsStore.getState().get("new")?.text, "Kept across a reload");
    useDraftsStore.getState().dropUnsent("local-1");
    resetDrafts(undefined);
    sessionStorage.clear();
  },
);

// ---- the live build's wiring (review 11) ----

test.serial(
  "the live replica config: a 426 from the sync routes keeps the drafts and reloads once",
  async (t) => {
    resetUpgradeForTests();
    sessionStorage.clear();
    resetDrafts("u-mona");
    const f = new FakeSync();
    const lounge = f.id();
    f.ok("olga", "spaces.create", { id: lounge, name: "lounge" });
    f.ok("mona", "spaces.join", { space: lounge });
    const post = f.id();
    f.ok("olga", "threads.create", { id: post, space: lounge, kind: "post", q: "Hi" });
    const config = liveReplicaConfig({
      fetch: f.fetchFor("mona"),
      whoAmI: () => Promise.resolve("mona"),
    });
    const r = config.create({
      kind: "member",
      isAdmin: false,
      user: { id: "u-mona", handle: "mona", login: "mona" } as never,
    }) as ReturnType<typeof config.create> & { activate(): void; dispose(): void };
    t.teardown(() => {
      r.dispose();
      resetTabClientForTests();
      resetUpgradeForTests();
    });
    // the live config reads the directory over tRPC, which this test has
    // not: the member's own logs are enough for the write
    r.activate();
    await until(() => r.ready(), 5000);
    f.offline = true;
    const draft = { key: "new", text: "Before the deploy" };
    await r.mutate(
      "threads.create",
      { id: f.id(), space: lounge, kind: "post", q: "x" },
      { draft },
    );
    t.like(useDraftsStore.getState().unsent, {
      [Object.keys(useDraftsStore.getState().unsent)[0] ?? ""]: draft,
    });
    f.offline = false;
    f.upgrade = true;
    const reloadedBefore = sessionStorage.getItem(UPGRADE_RELOAD_KEY);
    t.is(reloadedBefore, null);
    await r.retry?.(r.unsent?.()[0]?.local ?? "");
    t.truthy(sessionStorage.getItem(UPGRADE_RELOAD_KEY), "the reload time is written");
    t.is(useDraftsStore.getState().get("new")?.text, "Before the deploy", "the draft is kept");
  },
);
