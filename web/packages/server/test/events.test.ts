// The event bus and the SSE endpoint (`03-api-and-events.md` §3,
// `05-run-lifecycle-and-streaming.md` §4).

import type { SessionEvent } from "@session/shared";
import test from "ava";

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
