import assert from "node:assert/strict";
import test from "node:test";
import {
  createContentRefresh,
  publishResearchContentChanged,
  reuseUnchangedContent,
  subscribeResearchContentChanged,
  type RefreshTimers,
} from "../src/lib/researchContentRefresh";
import type { ResearchNode, ResearchNodeContent, Turn } from "../src/types";

/** Manual clock: timers fire only from `advance`. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: RefreshTimers = {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      pending.delete(due[0]);
      now = due[1].at;
      due[1].callback();
      await settle();
    }
    now = target;
  };
  return { timers, advance, pendingCount: () => pending.size };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A fetch whose completion the test controls. */
function controlledFetch() {
  const resolvers: Array<(ok: boolean) => void> = [];
  const fetch = () =>
    new Promise<void>((resolve, reject) => {
      resolvers.push((ok) => (ok ? resolve() : reject(new Error("fetch failed"))));
    });
  return {
    fetch,
    get calls() {
      return resolvers.length;
    },
    async finish(index: number, ok = true) {
      resolvers[index](ok);
      await settle();
    },
  };
}

test("a first request fetches immediately", async () => {
  const { timers } = manualTimers();
  const fetch = controlledFetch();
  const refresh = createContentRefresh(fetch.fetch, 1000, timers);
  refresh.request();
  assert.equal(fetch.calls, 1);
});

test("requests during a fetch collapse into one trailing fetch", async () => {
  const { timers, advance } = manualTimers();
  const fetch = controlledFetch();
  const refresh = createContentRefresh(fetch.fetch, 1000, timers);
  refresh.request();
  refresh.request();
  refresh.request();
  refresh.request();
  assert.equal(fetch.calls, 1);
  await advance(200);
  await fetch.finish(0);
  // The trailing fetch waits for the minimum interval from the first start.
  assert.equal(fetch.calls, 1);
  await advance(799);
  assert.equal(fetch.calls, 1);
  await advance(1);
  assert.equal(fetch.calls, 2);
  await fetch.finish(1);
  await advance(5000);
  assert.equal(fetch.calls, 2);
});

test("a trailing fetch starts as soon as a slow fetch settles", async () => {
  const { timers, advance } = manualTimers();
  const fetch = controlledFetch();
  const refresh = createContentRefresh(fetch.fetch, 1000, timers);
  refresh.request();
  await advance(1500);
  refresh.request();
  assert.equal(fetch.calls, 1);
  await fetch.finish(0);
  assert.equal(fetch.calls, 2);
});

test("requests after a quiet period fetch without delay", async () => {
  const { timers, advance } = manualTimers();
  const fetch = controlledFetch();
  const refresh = createContentRefresh(fetch.fetch, 1000, timers);
  refresh.request();
  await fetch.finish(0);
  await advance(3000);
  refresh.request();
  assert.equal(fetch.calls, 2);
});

test("a failed fetch still releases the trailing request", async () => {
  const { timers, advance } = manualTimers();
  const fetch = controlledFetch();
  const refresh = createContentRefresh(fetch.fetch, 1000, timers);
  refresh.request();
  refresh.request();
  await fetch.finish(0, false);
  await advance(1000);
  assert.equal(fetch.calls, 2);
});

test("dispose drops the trailing fetch and ignores later requests", async () => {
  const { timers, advance, pendingCount } = manualTimers();
  const fetch = controlledFetch();
  const refresh = createContentRefresh(fetch.fetch, 1000, timers);
  refresh.request();
  await fetch.finish(0);
  refresh.request();
  assert.equal(pendingCount(), 1);
  refresh.dispose();
  assert.equal(pendingCount(), 0);
  refresh.request();
  await advance(5000);
  assert.equal(fetch.calls, 1);
});

test("content signals reach subscribers until they unsubscribe", () => {
  const received: string[] = [];
  const unsubscribe = subscribeResearchContentChanged((nodeId) => received.push(nodeId));
  publishResearchContentChanged("node-a");
  unsubscribe();
  publishResearchContentChanged("node-b");
  assert.deepEqual(received, ["node-a"]);
});

function exchangeNode(status: "running" | "complete" = "running"): ResearchNode {
  return {
    type: "exchange",
    id: "node-1",
    treeId: "tree-1",
    groupId: "group-1",
    createdAt: 1,
    highlights: [],
    message: { text: "Question" },
    agent: { adapter: "claude" },
    run: { status, sessionReady: true, holdsProcess: status === "running" },
  } as ResearchNode;
}

function turn(id: string, text: string): Turn {
  return {
    id,
    agentId: "agent-1",
    role: "assistant",
    blocks: [{ type: "text", text }],
    sourceIndex: Number(id.split("-").pop()),
  } as Turn;
}

function content(turns: Turn[], node = exchangeNode()): ResearchNodeContent {
  return { node, turns };
}

test("refetched content equal to the loaded content keeps the loaded object", () => {
  const previous = content([turn("t-1", "One"), turn("t-2", "Two")]);
  const next = structuredClone(previous);
  assert.equal(reuseUnchangedContent(previous, next), previous);
});

test("a grown streaming turn keeps the unchanged turns' identity", () => {
  const previous = content([turn("t-1", "One"), turn("t-2", "Tw")]);
  const next = content([turn("t-1", "One"), turn("t-2", "Two")]);
  const merged = reuseUnchangedContent(previous, next);
  assert.notEqual(merged, previous);
  assert.equal(merged.node, previous.node);
  assert.equal(merged.turns[0], previous.turns[0]);
  assert.equal(merged.turns[1], next.turns[1]);
});

test("a changed node or snapshot revision replaces the content", () => {
  const previous = content([turn("t-1", "One")]);
  const settled = reuseUnchangedContent(
    previous,
    content([turn("t-1", "One")], exchangeNode("complete")),
  );
  assert.notEqual(settled, previous);
  assert.equal(settled.turns, previous.turns);
  assert.equal(settled.node.type === "exchange" && settled.node.run.status, "complete");

  const snapshot = reuseUnchangedContent(previous, {
    ...content([turn("t-1", "One")]),
    responseRevision: "rev-1",
  });
  assert.equal(snapshot.responseRevision, "rev-1");
});

test("an added or removed turn replaces the turn list", () => {
  const previous = content([turn("t-1", "One")]);
  const added = reuseUnchangedContent(previous, content([turn("t-1", "One"), turn("t-2", "Two")]));
  assert.equal(added.turns.length, 2);
  assert.equal(added.turns[0], previous.turns[0]);
  const removed = reuseUnchangedContent(previous, content([]));
  assert.deepEqual(removed.turns, []);
});
