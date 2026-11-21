// The event streams after the M3 review (`01` Y7, S5): every live stream is
// tracked in one set and removed when it ends, a closed stream's response is
// aborted, the queue is bounded in events and bytes, a `resync` event's id
// holds the cursors from before its flush, the session check does not renew
// a session, and event ids open only for their reader, their kind and their
// history.

import { connect, type Socket } from "node:net";

import { serve, type ServerType } from "@hono/node-server";
import { DAY, type LogId } from "@session/mutators";
import { PROTOCOL_VERSION } from "@session/sync/server";
import test from "ava";

import { CONNECTION_GRACE_MS, closeServer } from "../src/main.js";
import { EventIds } from "../src/sync/eventIds.js";
import { MAX_QUEUED_BYTES, MAX_QUEUED_EVENTS, type StreamEvent } from "../src/sync/hub.js";

import { createHarness, type Harness } from "./helpers.js";
import { channels, keysOf, newId, Person } from "./syncHttp.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Holds the event loop open: `closeServer` waits on unref'd timers, which
 * alone would let the worker end before the test does. */
function holdOpen(t: { teardown(fn: () => void): void }) {
  const keep = setInterval(() => undefined, 1000);
  t.teardown(() => clearInterval(keep));
}

/** How many pulls the server half ran under `u`'s scope. */
function countPulls(h: Harness, u: string) {
  const counter = { n: 0 };
  const pull = h.sync.server.pull.bind(h.sync.server);
  h.sync.server.pull = (...a: Parameters<typeof pull>) => {
    if (a[0]?.u === u) counter.n += 1;
    return pull(...a);
  };
  return counter;
}

test("a client id's replaced stream leaves the hub at once: one stream, one pull per commit", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_STREAM_OPENS_PER_MINUTE: "1000" } });
  const { olga, mona, open } = await channels(h);
  await mona.register();
  const log = `space:${open}`;
  const cursor = (await mona.snapshot(log)).cursor;
  const pulls = countPulls(h, "mona");
  const opened = [];
  // twenty opens of one client id, none of them read
  for (let k = 0; k < 20; k += 1) opened.push(await mona.events({ [log]: cursor }));
  t.true(opened.every((s) => s.status === 200));
  t.is(h.sync.hub.size(), 1);
  t.is(h.sync.hub.streamsOf("mona"), 1);
  pulls.n = 0;
  await olga.ok("threads.create", { id: newId(), space: open, kind: "post", q: "one commit" });
  await sleep(300);
  t.is(pulls.n, 1);
  h.sync.drain();
  pulls.n = 0;
  h.sync.draining = false;
  await olga.ok("threads.create", { id: newId(), space: open, kind: "post", q: "after" });
  await sleep(300);
  t.is(pulls.n, 0, "no stream is left after the drain");
  for (const s of opened) await s.close();
});

/** A raw HTTP connection that sends a stream request and never reads. */
function stalled(port: number, cookie: string, clientId: string, cursors: object): Promise<Socket> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => {
      s.write(
        `GET /api/sync/events?clientId=${clientId} HTTP/1.1\r\nHost: localhost:8787\r\n` +
          `Session-Protocol: ${PROTOCOL_VERSION}\r\nCookie: session=${cookie}\r\n` +
          `Session-Cursors: ${JSON.stringify(cursors)}\r\n\r\n`,
      );
      s.pause();
      resolve(s);
    });
  });
}

test("a stream whose client stops reading is closed at its queue bound, leaves the hub, and its route ends", async (t) => {
  holdOpen(t);
  const h = createHarness(t);
  const { mona, open } = await channels(h);
  await mona.register();
  const log: LogId = `space:${open}`;
  const cursor = (await mona.snapshot(log)).cursor;
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const socket = await stalled(port, mona.cookie, mona.clientId, { [log]: cursor });
  t.teardown(() => socket.destroy());
  // calls of `remove` for this stream: the hub's, then the route's own
  const ended = { n: 0 };
  const remove = h.sync.hub.remove.bind(h.sync.hub);
  h.sync.hub.remove = (st) => {
    if (st.u === "mona") ended.n += 1;
    remove(st);
  };
  for (let k = 0; k < 50 && h.sync.hub.size() === 0; k += 1) await sleep(20);
  t.is(h.sync.hub.size(), 1);
  // deltas the socket cannot take: the writes block, the queue fills
  const big = "x".repeat(256 * 1024);
  for (let k = 0; k < 40 && h.sync.hub.size() > 0; k += 1) {
    h.sync.hub.ephemeral(log, "run.delta", { big }, () => true);
    await sleep(5);
  }
  t.is(h.sync.hub.size(), 0, "the stream was closed and removed");
  t.is(h.sync.hub.streamsOf("mona"), 0);
  // the response was aborted: the route's write, blocked on the socket, was
  // released and the route ended (its last step removes the stream again)
  for (let k = 0; k < 50 && ended.n < 2; k += 1) await sleep(20);
  t.is(ended.n, 2, "the route ended");
  await closeServer(server, 300);
  t.true(CONNECTION_GRACE_MS > 0);
});

test("closeServer closes a connection that never ends after the grace", async (t) => {
  holdOpen(t);
  const server = await new Promise<ServerType>((resolve) => {
    // a handler that never answers
    const s = serve(
      { fetch: () => new Promise<Response>(() => undefined), port: 0, hostname: "127.0.0.1" },
      () => resolve(s),
    );
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const pending = fetch(`http://127.0.0.1:${port}/`).catch(() => "closed");
  await sleep(100);
  const started = Date.now();
  await closeServer(server, 300);
  const took = Date.now() - started;
  t.true(took >= 250 && took < 1500, `took ${took} ms`);
  // closed by the server, not by the client's own timeout
  t.is(await Promise.race([pending, sleep(1000).then(() => "still open")]), "closed");
});

test("the queue is bounded in bytes as well as events", async (t) => {
  const h = createHarness(t);
  const { mona, open } = await channels(h);
  await mona.register();
  const log = `space:${open}` as const;
  const cursor = (await mona.snapshot(log)).cursor;
  const open1 = (queued: () => number, bytes: () => number) => {
    const sent: StreamEvent[] = [];
    let closed: string | null = null;
    const s = h.sync.hub.open({
      u: "mona",
      clientId: mona.clientId,
      sessionToken: null,
      cursors: new Map([[log, cursor]]),
      sink: {
        send: (e) => sent.push(e),
        queued,
        queuedBytes: bytes,
        close: (why) => (closed = why),
      },
    });
    return { s, sent, closed: () => closed };
  };
  const byBytes = open1(
    () => 0,
    () => MAX_QUEUED_BYTES,
  );
  h.sync.hub.ephemeral(log, "run.delta", { x: 1 }, () => true);
  t.is(byBytes.closed(), "too many queued events");
  t.true(byBytes.s.closed);
  const byEvents = open1(
    () => MAX_QUEUED_EVENTS,
    () => 0,
  );
  h.sync.hub.ephemeral(log, "run.delta", { x: 1 }, () => true);
  t.is(byEvents.closed(), "too many queued events");
  t.is(h.sync.hub.size(), 0);
});

test("a resync event's id holds the other logs' cursors from before the flush: a reconnect after it loses no change", async (t) => {
  const h = createHarness(t);
  const { olga, open, closed } = await channels(h);
  const kim = new Person(h, h.addUser("kim"));
  await kim.ok("spaces.join", { space: open });
  const link = (await olga.ok("invites.create", { id: newId(), space: closed, days: 7 })) as {
    code: string;
  };
  await kim.ok("spaces.join", { space: closed, invite: link.code });
  const lounge = `space:${open}`;
  const lab = `space:${closed}`;
  const s = await kim.events({
    [lounge]: (await kim.snapshot(lounge)).cursor,
    [lab]: (await kim.snapshot(lab)).cursor,
  });
  t.is((await s.until("ready"))?.event, "ready");
  await sleep(150);
  const member = h.sync.store.byKey(`member:${closed}:kim`) as { adm: string };
  const lost = newId();
  // both commits in one flush: kim removed from #lab, a thread in #lounge
  const r = await olga.send([
    olga.envelope("members.remove", { space: closed, user: "kim", base: { adm: member.adm } }),
    olga.envelope("threads.create", { id: lost, space: open, kind: "post", q: "at risk" }),
  ]);
  t.true(r.answers.every((a) => a.ok));
  const resync = await s.until("resync");
  t.deepEqual(JSON.parse(resync?.data ?? "{}"), { log: lab });
  // the stream ends after the resync, before the changes event
  await s.close();
  const again = await kim.events({}, resync?.id);
  t.is(again.status, 200);
  const ready = JSON.parse((await again.until("ready"))?.data ?? "{}") as { logs: string[] };
  t.deepEqual(ready.logs, [lounge]);
  t.true(keysOf(await again.until("changes"), lounge).includes(`thread:${lost}`));
  await again.close();
});

test("after a resync a stream is unsubscribed from the log: one resync, then nothing and no pulls", async (t) => {
  const h = createHarness(t);
  const { olga, mel, closed } = await channels(h);
  const log = `space:${closed}`;
  const s = await mel.events({ [log]: (await mel.snapshot(log)).cursor });
  await s.until("ready");
  const member = h.sync.store.byKey(`member:${closed}:mel`) as { adm: string };
  await olga.ok("members.remove", { space: closed, user: "mel", base: { adm: member.adm } });
  t.truthy(await s.until("resync"));
  const pulls = countPulls(h, "mel");
  for (let k = 0; k < 3; k += 1)
    await olga.ok("threads.create", { id: newId(), space: closed, kind: "post", q: `p${k}` });
  await sleep(300);
  t.is(pulls.n, 0);
  t.is(await s.until("resync", 300), null);
  // nor does a run's delta of that log reach it
  h.sync.hub.ephemeral(log as LogId, "run.delta", { text: "after the removal" }, () => true);
  t.is(await s.until("run.delta", 300), null);
  await s.close();
});

test("the session check ends a stream whose session expired, and does not renew a live one", async (t) => {
  const h = createHarness(t);
  const p = new Person(h, h.addUser("quinn"));
  await p.register();
  const s = await p.events({ "user:quinn": (await p.snapshot("user:quinn")).cursor });
  await s.until("ready");
  const old = Date.now() - 29 * DAY;
  h.db.$client.prepare("UPDATE sessions SET last_seen_at = ?").run(old);
  h.sync.hub.checkSessions();
  const seen = h.db.$client.prepare("SELECT max(last_seen_at) AS at FROM sessions").get() as {
    at: number;
  };
  t.is(seen.at, old, "the check read the session without renewing it");
  t.is(h.sync.hub.size(), 1);
  h.db.$client.prepare("UPDATE sessions SET last_seen_at = ?").run(Date.now() - 31 * DAY);
  h.sync.hub.checkSessions();
  t.is(h.sync.hub.size(), 0);
  t.is(await s.until("never", 1000), null);
  t.true(s.ended);
});

test("a client id idle past its lifetime cannot open a stream (409 WRONG_CLIENT)", async (t) => {
  const h = createHarness(t);
  const p = new Person(h, h.addUser("idle"));
  await p.register();
  const cursor = (await p.snapshot("user:idle")).cursor;
  h.db.$client
    .prepare("UPDATE sync_clients SET last_used_at = ? WHERE client_id = ?")
    .run(Date.now() - h.sync.clientIdleTtl - 1000, p.clientId);
  const s = await p.events({ "user:idle": cursor });
  t.is(s.status, 409);
});

test("an event id opens for its reader only, is not a cursor token, and resyncs every log after a new history", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open } = await channels(h);
  const log: LogId = `space:${open}`;
  const first = await mel.events({ [log]: (await mel.snapshot(log)).cursor });
  await first.until("ready");
  await olga.ok("threads.create", { id: newId(), space: open, kind: "post", q: "x" });
  const id = (await first.until("changes"))?.id ?? "";
  await first.close();
  t.truthy(id);
  // another reader's id names nothing for mona
  await mona.register();
  t.is((await mona.events({}, id)).status, 400);
  t.is(h.sync.hub.ids.open(id, { u: "mona", history: h.sync.store.history() }), null);
  // an event id is not a cursor, nor a cursor an event id
  t.deepEqual(h.sync.server.pull({ u: "mel" }, log, id), { resync: true });
  const token = (await mel.snapshot(log)).cursor;
  t.is(h.sync.hub.ids.open(token, { u: "mel", history: h.sync.store.history() }), null);
  // under a new history the id's logs come back, each to resync
  h.sync.store.setHistory("ab".repeat(16));
  const after = await mel.events({}, id);
  t.is(after.status, 200);
  t.deepEqual(JSON.parse((await after.until("resync"))?.data ?? "{}"), { log });
  await after.close();
});

test("EventIds: the previous key opens ids until 30 days after the rotation, to the millisecond", (t) => {
  const a = new Uint8Array(32).fill(1);
  const b = new Uint8Array(32).fill(2);
  const rotatedAt = Date.parse("2026-11-01T00:00:00Z");
  const scope = { u: "mona", history: "0".repeat(32) };
  const old = new EventIds({ current: b }, () => rotatedAt).seal(
    new Map([["space:x", "c"]]),
    scope,
  );
  let now = rotatedAt + 30 * DAY - 1;
  const ids = new EventIds({ current: a, previous: { key: b, rotatedAt } }, () => now);
  t.deepEqual([...(ids.open(old, scope) ?? [])], [["space:x", "c"]]);
  now = rotatedAt + 30 * DAY;
  t.is(ids.open(old, scope), null);
  now = rotatedAt + 30 * DAY + 1;
  t.is(ids.open(old, scope), null);
});

test("open() removes the client id's older stream at once, whatever its sink does", async (t) => {
  const h = createHarness(t);
  const { mona, open } = await channels(h);
  await mona.register();
  const log: LogId = `space:${open}`;
  const cursor = (await mona.snapshot(log)).cursor;
  const closed: string[] = [];
  // a sink that does nothing when closed: only the hub's own removal counts
  const sink = (name: string) => ({
    send: () => undefined,
    queued: () => 0,
    queuedBytes: () => 0,
    close: (why: string) => closed.push(`${name}: ${why}`),
  });
  const spec = {
    u: "mona",
    clientId: mona.clientId,
    sessionToken: null,
    cursors: new Map([[log, cursor]]),
  };
  const first = h.sync.hub.open({ ...spec, sink: sink("first") });
  t.is(h.sync.hub.size(), 1);
  const second = h.sync.hub.open({ ...spec, sink: sink("second") });
  t.deepEqual(closed, ["first: replaced"]);
  t.true(first.closed);
  t.false(second.closed);
  t.is(h.sync.hub.size(), 1);
  t.is(h.sync.hub.streamsOf("mona"), 1);
  h.sync.hub.remove(second);
});
