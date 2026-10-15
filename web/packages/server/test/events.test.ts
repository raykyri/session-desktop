// The event bus and the SSE endpoint (`03-api-and-events.md` §3,
// `05-run-lifecycle-and-streaming.md` §4).

import { auth } from "@session/db";
import type { SessionEvent } from "@session/shared";
import test from "ava";

import { closeEndedSessionStreams } from "../src/auth/session.js";
import { EventBus, sessionEvent } from "../src/events/bus.js";

import { createHarness } from "./helpers.js";

function drain(subscription: { events: AsyncIterableIterator<SessionEvent> }, count: number) {
  const collected: SessionEvent[] = [];
  return (async () => {
    for await (const event of subscription.events) {
      collected.push(event);
      if (collected.length === count) {
        break;
      }
    }
    return collected;
  })();
}

test("turn deltas reach only the connections interested in that node", async (t) => {
  const bus = new EventBus();
  const interested = bus.subscribe("user-1", "a");
  const bystander = bus.subscribe("user-1", "b");
  const otherUser = bus.subscribe("user-2", "c");
  bus.setInterest("user-1", "a", ["node-1"]);

  t.is(bus.connectionCount("user-1"), 2);
  t.is(bus.connectionCount("user-2"), 1);

  const interestedEvents = drain(interested, 2);
  const bystanderEvents = drain(bystander, 1);

  bus.emit("user-1", sessionEvent("research.turn.delta", { nodeId: "node-1", seq: 1, text: "hi" }));
  bus.emit("user-1", sessionEvent("research.turn.delta", { nodeId: "node-2", seq: 1, text: "no" }));
  bus.emit("user-1", sessionEvent("research.node.updated", { node: { id: "node-1" } }));

  t.deepEqual(
    (await interestedEvents).map((event) => event.type),
    ["research.turn.delta", "research.node.updated"],
  );
  t.deepEqual(
    (await bystanderEvents).map((event) => event.type),
    ["research.node.updated"],
  );

  // Breaking out of `for await` returns the iterator, which closes the
  // connection; only the third one is still open.
  t.is(bus.connectionCount(), 1);
  interested.close();
  bystander.close();
  otherUser.close();
  t.is(bus.connectionCount(), 0);
});

test("events are queued for a connection that is not reading yet", async (t) => {
  const bus = new EventBus();
  const subscription = bus.subscribe("user-1", "a");
  bus.emit("user-1", sessionEvent("workspace.updated", { workspace: { id: "w1" } }));
  bus.emit("user-1", sessionEvent("workspace.updated", { workspace: { id: "w2" } }));
  const events = await drain(subscription, 2);
  t.deepEqual(
    events.map((event) => (event.payload["workspace"] as { id: string }).id),
    ["w1", "w2"],
  );
  subscription.close();
});

test("closing every connection ends the iterators", async (t) => {
  const bus = new EventBus();
  const subscription = bus.subscribe("user-1", "a");
  const pending = subscription.events.next();
  bus.closeAll();
  t.true((await pending).done);
});

test("setInterest reports an unknown connection rather than failing", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("watcher");
  const caller = harness.caller(user);
  t.deepEqual(await caller.events.setInterest({ connectionId: "gone", nodeIds: [] }), {
    applied: false,
  });
  const subscription = harness.eventBus.subscribe(user.id, "live");
  t.deepEqual(await caller.events.setInterest({ connectionId: "live", nodeIds: ["n1"] }), {
    applied: true,
  });
  subscription.close();
});

test("the subscription streams server-sent events over HTTP", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("streamer");
  const cookie = harness.signIn(user);
  const input = encodeURIComponent(JSON.stringify({ connectionId: "conn-http" }));
  const response = await harness.request(`/api/trpc/events.subscribe?input=${input}`, {
    headers: { Accept: "text/event-stream" },
    cookie,
  });
  t.is(response.status, 200);
  t.true(response.headers.get("content-type")?.startsWith("text/event-stream"));

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const readUntil = async (predicate: (text: string) => boolean): Promise<string> => {
    while (!predicate(buffered)) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    return buffered;
  };

  await readUntil((text) => text.includes("connection.ready"));
  harness.eventBus.emit(
    user.id,
    sessionEvent("research.node.updated", { node: { id: "node-9", status: "running" } }),
  );
  const text = await readUntil((value) => value.includes("research.node.updated"));
  t.true(text.includes("connection.ready"));
  t.true(text.includes("node-9"));
  await reader.cancel();
});

test("an anonymous subscription carries an error rather than a stream", async (t) => {
  const harness = createHarness(t);
  const response = await harness.request("/api/trpc/events.subscribe", {
    headers: { Accept: "text/event-stream" },
  });
  // SSE cannot report a status after the headers, so tRPC opens the stream and
  // sends the error as an event; the client surfaces it as UNAUTHORIZED.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("UNAUTHORIZED")) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  t.true(text.includes("serialized-error"));
  t.true(text.includes("UNAUTHORIZED"));
});

test("a reused connection id replaces the older stream rather than unseating the new one", async (t) => {
  const bus = new EventBus();
  const first = bus.subscribe("user-1", "same");
  const ended = first.events.next();
  const second = bus.subscribe("user-1", "same");
  t.true((await ended).done);
  t.is(bus.connectionCount("user-1"), 1);

  // Closing the connection that was replaced must not deregister its successor.
  first.close();
  t.is(bus.connectionCount("user-1"), 1);
  const delivered = second.events.next();
  bus.emit("user-1", sessionEvent("workspace.updated", { workspace: { id: "w1" } }));
  const received = (await delivered) as IteratorYieldResult<SessionEvent>;
  t.is(received.value.type, "workspace.updated");
  second.close();
  t.is(bus.connectionCount("user-1"), 0);
});

test("emitToTree reaches the owner, the members and declared public readers", async (t) => {
  let isPublic = true;
  let now = 1_000;
  const bus = new EventBus(
    {
      audience: () => ({ ownerId: "owner", memberIds: ["member"], public: isPublic }),
      viewer: (userId) => ({ userId, login: userId, name: null, avatarUrl: null }),
    },
    { now: () => now },
  );
  const owner = bus.subscribe("owner", "o");
  const member = bus.subscribe("member", "m");
  const reader = bus.subscribe("reader", "r");
  const watcher = bus.subscribe("watcher", "w");
  bus.setInterest("watcher", "w", [], ["tree-1"]);
  bus.setInterest("reader", "r", [], ["tree-1"]);
  t.deepEqual(
    bus.viewers("tree-1").map((viewer) => viewer.userId),
    ["reader", "watcher"],
  );
  // A declaration that is not renewed lapses; renewing keeps it.
  now += 60_000;
  bus.setInterest("reader", "r", [], ["tree-1"]);
  now += 40_000;
  bus.expirePresence();
  t.deepEqual(
    bus.viewers("tree-1").map((viewer) => viewer.userId),
    ["reader"],
  );
  watcher.close();
  const ownerEvents = drain(owner, 4);
  const memberEvents = drain(member, 4);

  isPublic = false;
  bus.emitToTree("tree-1", sessionEvent("research.node.updated", { node: { id: "n" } }));
  isPublic = true;
  const readerEvents = drain(reader, 3);
  bus.emitToTree("tree-1", sessionEvent("research.tree.updated", { tree: { id: "tree-1" } }));

  // Presence changes (two arrivals, one lapse) reached the audience before
  // the node update; the reader got the presence after their own arrival,
  // and nothing while the thread was private.
  t.deepEqual(
    (await ownerEvents).map((event) => event.type),
    [
      "research.presence.changed",
      "research.presence.changed",
      "research.presence.changed",
      "research.node.updated",
    ],
  );
  t.deepEqual((await memberEvents).map((event) => event.type).at(-1), "research.node.updated");
  t.deepEqual(
    (await readerEvents).map((event) => event.type),
    ["research.presence.changed", "research.presence.changed", "research.tree.updated"],
  );
  bus.closeAll();
});

test("presence lists only readers in the audience, and losing access drops the declaration", async (t) => {
  let isPublic = true;
  const bus = new EventBus({
    audience: () => ({ ownerId: "owner", memberIds: ["member"], public: isPublic }),
    viewer: (userId) => ({ userId, login: userId, name: null, avatarUrl: null }),
  });
  const owner = bus.subscribe("owner", "o");
  const reader = bus.subscribe("reader", "r");
  bus.subscribe("member", "m");
  bus.setInterest("reader", "r", [], ["tree-1"]);
  bus.setInterest("member", "m", [], ["tree-1"]);
  t.deepEqual(
    bus.viewers("tree-1").map((viewer) => viewer.userId),
    ["member", "reader"],
  );
  // The thread turns private: the reader is no longer presence at once,
  // before any declaration lapses.
  isPublic = false;
  t.deepEqual(
    bus.viewers("tree-1").map((viewer) => viewer.userId),
    ["member"],
  );
  // They are told, and their declaration is dropped.
  const told = drain(reader, 3);
  bus.emitToOpenReaders("tree-1", sessionEvent("research.sharing.changed", { treeId: "tree-1" }), [
    "owner",
    "member",
  ]);
  bus.refreshAudience("tree-1");
  t.deepEqual(
    (await told).map((event) => event.type),
    ["research.presence.changed", "research.presence.changed", "research.sharing.changed"],
  );
  isPublic = true;
  t.deepEqual(
    bus.viewers("tree-1").map((viewer) => viewer.userId),
    ["member"],
    "the dropped declaration does not come back with the thread",
  );
  const ownerEvents = drain(owner, 3);
  t.deepEqual(
    (await ownerEvents).map((event) => event.type),
    ["research.presence.changed", "research.presence.changed", "research.presence.changed"],
  );
  bus.closeAll();
});

/** Opens `events.subscribe` over HTTP with `cookie` and reads it as text. */
async function openStream(harness: ReturnType<typeof createHarness>, cookie: string) {
  const input = encodeURIComponent(JSON.stringify({ connectionId: `conn-${cookie.slice(0, 8)}` }));
  const response = await harness.request(`/api/trpc/events.subscribe?input=${input}`, {
    headers: { Accept: "text/event-stream" },
    cookie,
  });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const stream = { text: "", ended: false };
  let pending: ReturnType<typeof reader.read> | null = null;
  /** Reads until `predicate` holds, the stream ends, or two seconds pass. */
  const readUntil = async (predicate: (text: string) => boolean): Promise<string> => {
    const deadline = Date.now() + 2000;
    while (!predicate(stream.text) && !stream.ended) {
      pending ??= reader.read();
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        pending,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, remaining))),
      ]);
      if (chunk === null) {
        break;
      }
      pending = null;
      if (chunk.done) {
        stream.ended = true;
        break;
      }
      stream.text += decoder.decode(chunk.value, { stream: true });
    }
    return stream.text;
  };
  await readUntil((text) => text.includes("connection.ready"));
  return { stream, readUntil, cancel: () => reader.cancel() };
}

const SESSION_ENDED = (text: string): boolean => text.includes("UNAUTHORIZED");

test("signing out ends the event streams opened with that session", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("leaver");
  const laptop = harness.signIn(user);
  const phone = harness.signIn(user);
  const closed = await openStream(harness, laptop);
  const kept = await openStream(harness, phone);

  const logout = await harness.request("/api/trpc/auth.logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cookie: laptop,
  });
  t.is(logout.status, 200);
  harness.eventBus.emit(
    user.id,
    sessionEvent("research.node.updated", { node: { id: "private-node" } }),
  );

  const text = await closed.readUntil(SESSION_ENDED);
  t.true(text.includes("UNAUTHORIZED"), "the stream reports the ended session");
  await closed.readUntil(() => false);
  t.true(closed.stream.ended, "the stream is closed");
  t.false(closed.stream.text.includes("private-node"), "nothing is delivered after sign-out");

  const other = await kept.readUntil((value) => value.includes("private-node"));
  t.true(other.includes("private-node"), "the account's other session keeps its stream");
  await kept.cancel();
});

test("the cookie-clearing sign-out ends the session's streams too", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("form-leaver");
  const cookie = harness.signIn(user);
  const open = await openStream(harness, cookie);
  const logout = await harness.request("/auth/logout", { method: "POST", cookie });
  t.is(logout.status, 204);
  t.true((await open.readUntil(SESSION_ENDED)).includes("UNAUTHORIZED"));
});

test("a stream whose session expired or was deleted ends at the next check", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("expiring");
  const revoked = harness.signIn(user);
  const expired = harness.signIn(user);
  const live = harness.signIn(user);
  const revokedStream = await openStream(harness, revoked);
  const expiredStream = await openStream(harness, expired);
  const liveStream = await openStream(harness, live);

  harness.db.$client
    .prepare("DELETE FROM sessions WHERE id = ?")
    .run(auth.hashSessionToken(revoked));
  harness.db.$client
    .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
    .run(Date.now() - 1, auth.hashSessionToken(expired));

  t.is(closeEndedSessionStreams(harness.deps), 2);
  t.true((await revokedStream.readUntil(SESSION_ENDED)).includes("UNAUTHORIZED"));
  t.true((await expiredStream.readUntil(SESSION_ENDED)).includes("UNAUTHORIZED"));

  harness.eventBus.emit(user.id, sessionEvent("research.node.updated", { node: { id: "n-1" } }));
  t.true((await liveStream.readUntil((text) => text.includes("n-1"))).includes("n-1"));
  t.false(liveStream.stream.text.includes("UNAUTHORIZED"));
  await liveStream.cancel();
});
