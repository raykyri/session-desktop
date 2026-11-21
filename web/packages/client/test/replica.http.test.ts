// The sync routes' client side (01 S1, Y3, Y7; 02 §9.2): the HTTP transport
// against the routes on the in-memory server half, the event stream parser,
// the tab's client id and the `UPGRADE_REQUIRED` reload.

import { PROTOCOL_VERSION } from "@session/sync/client";
import test from "ava";

import {
  HttpSyncTransport,
  parseStreamEvent,
  readEvents,
  type RawEvent,
} from "../src/replica/http.js";
import {
  forgetTabClientId,
  resetTabClientForTests,
  tabClientId,
} from "../src/replica/tabClient.js";
import {
  UPGRADE_RELOAD_KEY,
  beforeUpgradeReload,
  resetUpgradeForTests,
  upgradeRequired,
  useUpgradeStore,
} from "../src/replica/upgrade.js";

import { FakeLocks, FakeStorage, FakeSync } from "./syncFake.js";

test("every request names the protocol version; a POST carries the CSRF header", async (t) => {
  const f = new FakeSync();
  const transport = new HttpSyncTransport({ fetch: f.fetchFor("mona") });
  const r = await transport.register();
  t.true(r.ok);
  await transport.snapshot("user:mona");
  for (const x of f.requests) t.is(x.headers["session-protocol"], String(PROTOCOL_VERSION));
  t.true(
    f.requests.every((x) => x.method !== "POST" || x.headers["x-requested-with"] === "session"),
  );
});

test("register, apply, snapshot and pull over the routes", async (t) => {
  const f = new FakeSync();
  const transport = new HttpSyncTransport({ fetch: f.fetchFor("mona") });
  const reg = await transport.register();
  if (!reg.ok) throw new Error(reg.error.code);
  t.false(reg.reattached);
  const again = await transport.register({ clientId: reg.clientId });
  t.true(again.ok && again.reattached && again.clientId === reg.clientId);
  const now = f.clock.now();
  const space = f.id();
  const answer = await transport.apply({
    clientId: reg.clientId,
    seq: 1,
    mutationId: f.id(),
    name: "spaces.create",
    input: { id: space, name: "den" },
    protocolVersion: PROTOCOL_VERSION,
    clientTime: now,
    queuedAt: now,
  });
  t.true(answer.ok);
  const snap = await transport.snapshot(`space:${space}`, {
    tier: "window",
    clientId: reg.clientId,
  });
  t.true(snap.records.some((x) => x.key === `space:${space}`));
  t.is(snap.lastSeq, 1);
  const pull = await transport.pull(`space:${space}`, snap.cursor, { clientId: reg.clientId });
  t.false("resync" in pull);
  t.deepEqual("changes" in pull ? pull.changes : null, []);
});

test("a signed-out caller: register and apply are refused, reads answer", async (t) => {
  const f = new FakeSync();
  const transport = new HttpSyncTransport({ fetch: f.fetchFor(null) });
  const r = await transport.register();
  t.false(r.ok);
  t.is(!r.ok && r.error.code, "UNAUTHORIZED");
  const snap = await transport.snapshot("space:01M7YC40KD0CWWSYC3M6FT4G1J");
  t.deepEqual(snap.records, []);
});

test("426 on any route calls onUpgrade; apply answers it as an unrecorded refusal", async (t) => {
  const f = new FakeSync();
  let upgrades = 0;
  const transport = new HttpSyncTransport({
    fetch: f.fetchFor("mona"),
    onUpgrade: () => upgrades++,
  });
  const reg = await transport.register();
  if (!reg.ok) throw new Error(reg.error.code);
  f.upgrade = true;
  const now = f.clock.now();
  const answer = await transport.apply({
    clientId: reg.clientId,
    seq: 1,
    mutationId: f.id(),
    name: "prefs.set",
    input: { layout: "wide" },
    protocolVersion: PROTOCOL_VERSION,
    clientTime: now,
    queuedAt: now,
  });
  t.false(answer.ok);
  t.is(!answer.ok && answer.error.code, "UPGRADE_REQUIRED");
  await t.throwsAsync(transport.snapshot("user:mona"));
  t.is(upgrades, 2);
});

test("a dropped connection throws: the sync client reads it as no answer", async (t) => {
  const f = new FakeSync();
  const transport = new HttpSyncTransport({ fetch: f.fetchFor("mona") });
  f.offline = true;
  await t.throwsAsync(transport.register());
});

/** A body that delivers `chunks` one read at a time. */
function bodyOf(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  }).getReader();
}

test("the event stream parser: events split across reads, CRLF, comments and ids", async (t) => {
  const seen: RawEvent[] = [];
  await readEvents(
    bodyOf([
      ": heartbeat\n\nevent: rea",
      'dy\ndata: {"logs":["user:mona"]}\n\n',
      'event: changes\r\ndata: {"batches":[{"log":"user:mona","changes":[],',
      '"cursor":"c2","lastSeq":3}]}\r\nid: sealed-1\r\n\r\n',
      "event: ping\ndata:\n\n",
    ]),
    (e) => seen.push(e),
  );
  t.deepEqual(
    seen.map((e) => [e.event, e.id]),
    [
      ["ready", undefined],
      ["changes", "sealed-1"],
      ["ping", undefined],
    ],
  );
  const changes = parseStreamEvent(seen[1] as RawEvent);
  t.deepEqual(changes, {
    type: "changes",
    batches: [{ log: "user:mona", changes: [], cursor: "c2", lastSeq: 3 }],
    id: "sealed-1",
  });
  t.is(parseStreamEvent({ event: "run.delta", data: "{}", id: undefined }), null);
});

test.serial("the tab's client id: claimed once per account; sign-out clears it", async (t) => {
  resetTabClientForTests();
  const f = new FakeSync();
  const transport = new HttpSyncTransport({ fetch: f.fetchFor("mona") });
  const register = (o?: { clientId?: string }) => transport.register(o);
  const deps = { storage: new FakeStorage(), locks: new FakeLocks() };
  const [a, b] = await Promise.all([
    tabClientId("u-mona", register, deps),
    tabClientId("u-mona", register, deps),
  ]);
  t.is(a, b, "one claim for both replicas");
  t.is(f.requests.filter((x) => x.path === "/api/sync/register").length, 1);
  t.truthy(deps.storage.getItem("session-client"));
  forgetTabClientId(deps);
  t.is(deps.storage.getItem("session-client"), null);
  resetTabClientForTests();
});

test.serial(
  "UPGRADE_REQUIRED: one reload with its time kept; again within 60 s shows the message; after 61 s reloads again",
  (t) => {
    resetUpgradeForTests();
    const storage = new FakeStorage();
    let now = 1_000_000;
    let reloads = 0;
    const kept: string[] = [];
    const deps = { storage, now: () => now, reload: () => reloads++ };
    beforeUpgradeReload(() => kept.push("draft"));
    t.is(upgradeRequired(deps), "reload");
    t.is(reloads, 1);
    t.is(storage.getItem(UPGRADE_RELOAD_KEY), String(now));
    t.deepEqual(kept, ["draft"], "the drafts are kept first");

    // the reloaded page
    resetUpgradeForTests();
    now += 30_000;
    t.is(upgradeRequired(deps), "message");
    t.is(reloads, 1);
    t.true(useUpgradeStore.getState().stuck);

    // another load, 61 s after the reload
    resetUpgradeForTests();
    now += 31_000;
    t.is(upgradeRequired(deps), "reload");
    t.is(reloads, 2);
    t.is(storage.getItem(UPGRADE_RELOAD_KEY), String(now));
    resetUpgradeForTests();
  },
);
