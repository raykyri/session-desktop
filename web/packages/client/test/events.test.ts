import type {
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
  SessionEvent,
} from "@session/shared";
import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import test from "ava";

import { queryKeys } from "../src/api/cache.js";
import {
  addNodeInterest,
  applyEventBatch,
  connectEventBridge,
  INTEREST_DEBOUNCE_MS,
  resetNodeInterest,
} from "../src/api/events.js";
import { useConnectionStore } from "../src/stores/connection.js";
import { useLiveTurnsStore } from "../src/stores/liveTurns.js";
import { useNotificationsStore } from "../src/stores/notifications.js";
import { useSettingsStore } from "../src/stores/settings.js";

import { node, summary, tree } from "./fixtures.js";
import { createTrpcStub } from "./trpcStub.js";

const TREES_SCOPE = { workspaceId: "w1", includeArchived: false };

function event(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: 1_700_000_100_000 };
}

/** `gcTime: Infinity` is what keeps a cache out of Node's timer queue: any
 * finite value schedules a five-minute collection per query, and AVA then
 * waits for it. */
function client(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
        retry: false,
      },
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.beforeEach(() => {
  useLiveTurnsStore.setState({ byNode: {} });
  useNotificationsStore.getState().clear();
  useSettingsStore.setState({ settings: { ...DEFAULT_USER_SETTINGS } });
  useConnectionStore.setState({ status: "connecting", disconnectedSince: null });
  resetNodeInterest();
});

test.serial("run events reach the live buffer and never the cache", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);
  useLiveTurnsStore.getState().seed("n1", { turns: [], seq: 0 });

  applyEventBatch(
    [
      event("research.run.started", { nodeId: "n1", seq: 1, attempt: 1, model: "gemini-flash" }),
      event("research.turn.delta", { nodeId: "n1", seq: 2, turnId: "turn-1", text: "Hel" }),
      event("research.turn.delta", { nodeId: "n1", seq: 3, turnId: "turn-1", text: "lo" }),
    ],
    queryClient,
  );

  const live = useLiveTurnsStore.getState().byNode["n1"];
  t.is(live?.inFlightText, "Hello");
  t.is(live?.lastSeq, 3);
  t.deepEqual(
    queryClient.getQueryData<ResearchTreeSummary[]>(queryKeys.trees(TREES_SCOPE)),
    [summary()],
    "a delta is not a list change",
  );
});

test.serial("a committed turn whose shape is wrong is a malformed event", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);

  applyEventBatch(
    [event("research.turn.committed", { nodeId: "n1", seq: 1, turn: { id: "turn-1" } })],
    queryClient,
  );

  t.is(useLiveTurnsStore.getState().byNode["n1"], undefined, "nothing was applied from it");
  t.true(
    queryClient.getQueryState(queryKeys.trees(TREES_SCOPE))?.isInvalidated,
    "the scope refetches instead",
  );
});

test.serial("an unsupported event invalidates the research scope", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);
  queryClient.setQueryData(queryKeys.activeNodes(), []);

  applyEventBatch([event("research.something.new", { nodeId: "n1" })], queryClient);

  t.true(queryClient.getQueryState(queryKeys.trees(TREES_SCOPE))?.isInvalidated);
  t.true(queryClient.getQueryState(queryKeys.activeNodes())?.isInvalidated);
});

test.serial("a node update patches the summary counts from the cached previous node", (t) => {
  const queryClient = client();
  const running = node({ status: "running" });
  const detail: ResearchTreeDetail = { tree: tree(), nodes: [running] };
  queryClient.setQueryData(queryKeys.tree("t1"), detail);
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);
  queryClient.setQueryData(queryKeys.activeNodes(), [running]);

  const completed = node({ status: "complete", completedAt: 1_700_000_100_000 });
  applyEventBatch([event("research.node.updated", { node: completed })], queryClient);

  const [patched] = queryClient.getQueryData<ResearchTreeSummary[]>(
    queryKeys.trees(TREES_SCOPE),
  ) as ResearchTreeSummary[];
  t.is(patched?.runningCount, 0);
  t.is(patched?.completedCount, 1);
  t.true(patched?.hasUnseenUpdate, "a settlement the reader has not seen raises the flag");

  t.deepEqual(
    queryClient.getQueryData<ResearchNode[]>(queryKeys.activeNodes()),
    [],
    "a settled node leaves the activity list",
  );
  t.is(
    queryClient.getQueryData<ResearchTreeDetail>(queryKeys.tree("t1"))?.nodes[0]?.status,
    "complete",
  );
});

test.serial("a node update with no cached predecessor refetches rather than guesses", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);

  applyEventBatch(
    [event("research.node.updated", { node: node({ status: "complete" }) })],
    queryClient,
  );

  t.true(queryClient.getQueryState(queryKeys.trees(TREES_SCOPE))?.isInvalidated);
});

test.serial("a created thread lands in every tree list and in the detail cache", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), []);
  queryClient.setQueryData(queryKeys.activeNodes(), []);

  applyEventBatch([event("research.tree.created", { tree: tree(), node: node() })], queryClient);

  const summaries = queryClient.getQueryData<ResearchTreeSummary[]>(queryKeys.trees(TREES_SCOPE));
  t.is(summaries?.length, 1);
  t.is(summaries?.[0]?.runningCount, 1);
  t.is(queryClient.getQueryData<ResearchTreeDetail>(queryKeys.tree("t1"))?.nodes.length, 1);
  t.is(queryClient.getQueryData<ResearchNode[]>(queryKeys.activeNodes())?.length, 1);
});

test.serial("a removed thread leaves the lists and takes its detail with it", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);
  queryClient.setQueryData(queryKeys.tree("t1"), { tree: tree(), nodes: [node()] });
  queryClient.setQueryData(queryKeys.activeNodes(), [node()]);

  applyEventBatch([event("research.tree.removed", { treeId: "t1" })], queryClient);

  t.deepEqual(queryClient.getQueryData(queryKeys.trees(TREES_SCOPE)), []);
  t.is(queryClient.getQueryData(queryKeys.tree("t1")), undefined);
  t.deepEqual(queryClient.getQueryData(queryKeys.activeNodes()), []);
});

test.serial("a settings event writes the cache and the local mirror", (t) => {
  const queryClient = client();

  applyEventBatch(
    [
      event("settings.updated", {
        settings: { ...DEFAULT_USER_SETTINGS, appearance: "light", textSize: 18 },
      }),
    ],
    queryClient,
  );

  t.is(useSettingsStore.getState().settings.appearance, "light");
  t.is(useSettingsStore.getState().settings.textSize, 18);
  t.truthy(queryClient.getQueryData(queryKeys.settings()));
});

test.serial("a folders event replaces the workspace's folder state", (t) => {
  const queryClient = client();
  const state = { folders: [], membership: {}, starred: ["t1"], collapsed: [] };

  applyEventBatch([event("folders.updated", { workspaceId: "w1", state })], queryClient);

  t.deepEqual(queryClient.getQueryData(queryKeys.folders("w1")), state);
});

test.serial("a toast is pushed, and silenced by the preference", (t) => {
  const queryClient = client();
  const toast = {
    id: "toast-1",
    title: "Run finished",
    body: "Collective memory",
    tone: "success",
    timeoutMs: 5_000,
  };

  applyEventBatch([event("notification.requested", toast)], queryClient);
  t.deepEqual(
    useNotificationsStore.getState().items.map((item) => item.id),
    ["toast-1"],
  );

  useNotificationsStore.getState().clear();
  useSettingsStore.getState().set("showNotifications", false);
  applyEventBatch([event("notification.requested", toast)], queryClient);
  t.is(useNotificationsStore.getState().items.length, 0);
});

test.serial("a malformed notification payload produces no toast", (t) => {
  applyEventBatch([event("notification.requested", { id: "x", title: "Only a title" })], client());
  t.is(useNotificationsStore.getState().items.length, 0);
});

test.serial("the first event carries the connection id, and opens the stream", async (t) => {
  const queryClient = client();
  const stub = createTrpcStub();
  const bridge = connectEventBridge({
    queryClient,
    client: stub.client,
    setInterest: () => Promise.resolve(undefined),
  });

  t.is(bridge.connectionId(), null);
  stub.emit(event("connection.ready", { connectionId: "c1" }));

  t.is(bridge.connectionId(), "c1");
  t.is(useConnectionStore.getState().status, "open");

  bridge.close();
  await Promise.resolve();
  t.is(stub.unsubscribes, 1);
  t.is(useConnectionStore.getState().status, "closed");
});

test.serial("a reconnect invalidates the lists and re-reads displayed nodes", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);
  queryClient.setQueryData(queryKeys.nodeContent("n1"), { node: node(), turns: [], children: [] });
  const stub = createTrpcStub();
  const bridge = connectEventBridge({
    queryClient,
    client: stub.client,
    setInterest: () => Promise.resolve(undefined),
  });
  addNodeInterest("n1");

  stub.emit(event("connection.ready", { connectionId: "c1" }));
  t.false(
    queryClient.getQueryState(queryKeys.trees(TREES_SCOPE))?.isInvalidated,
    "the first connection has nothing to catch up on",
  );

  stub.emit(event("connection.ready", { connectionId: "c2" }));
  t.true(queryClient.getQueryState(queryKeys.trees(TREES_SCOPE))?.isInvalidated);
  t.true(queryClient.getQueryState(queryKeys.nodeContent("n1"))?.isInvalidated);

  bridge.close();
});

test.serial("interest is published once for a burst of mounts", async (t) => {
  const queryClient = client();
  const stub = createTrpcStub();
  const published: { connectionId: string; nodeIds: string[] }[] = [];
  const bridge = connectEventBridge({
    queryClient,
    client: stub.client,
    setInterest: (connectionId, nodeIds) => {
      published.push({ connectionId, nodeIds: [...nodeIds] });
      return Promise.resolve(undefined);
    },
  });
  stub.emit(event("connection.ready", { connectionId: "c1" }));
  published.length = 0;

  const releaseFirst = addNodeInterest("n1");
  addNodeInterest("n2");
  addNodeInterest("n2");
  await sleep(INTEREST_DEBOUNCE_MS * 2);

  t.deepEqual(published, [{ connectionId: "c1", nodeIds: ["n1", "n2"] }]);

  releaseFirst();
  await sleep(INTEREST_DEBOUNCE_MS * 2);
  t.deepEqual(published[1], { connectionId: "c1", nodeIds: ["n2"] });

  bridge.close();
});

test.serial("a batch is coalesced and applied through the subscription", async (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.activeNodes(), []);
  const stub = createTrpcStub();
  const bridge = connectEventBridge({
    queryClient,
    client: stub.client,
    setInterest: () => Promise.resolve(undefined),
  });
  stub.emit(event("connection.ready", { connectionId: "c1" }));

  stub.emit(event("research.node.created", { node: node({ id: "n2", status: "queued" }) }));
  t.deepEqual(
    queryClient.getQueryData(queryKeys.activeNodes()),
    [],
    "nothing is applied before the trailing flush",
  );

  await sleep(40);
  t.is(queryClient.getQueryData<ResearchNode[]>(queryKeys.activeNodes())?.length, 1);

  bridge.close();
});

test.serial("a redelivered node.created counts the node once", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary({ runningCount: 1 })]);
  queryClient.setQueryData(queryKeys.tree("t1"), { tree: tree(), nodes: [node()] });
  queryClient.setQueryData(queryKeys.activeNodes(), [node()]);

  const created = event("research.node.created", {
    node: node({ id: "n2", parentNodeId: "n1", status: "running" }),
  });
  applyEventBatch([created], queryClient);
  applyEventBatch([created], queryClient);

  const [patched] = queryClient.getQueryData<ResearchTreeSummary[]>(
    queryKeys.trees(TREES_SCOPE),
  ) as ResearchTreeSummary[];
  t.is(patched?.runningCount, 2, "the second delivery is a replay, not a second question");
});

test.serial("an unauthorized stream error sends the tab to sign-in", (t) => {
  const queryClient = client();
  const stub = createTrpcStub();
  let signedOut = 0;
  const bridge = connectEventBridge({
    queryClient,
    client: stub.client,
    setInterest: () => Promise.resolve(undefined),
    onUnauthorized: () => (signedOut += 1),
  });

  for (const observer of stub.observers) {
    observer.onError?.({ data: { code: "UNAUTHORIZED" } });
    observer.onError?.({ data: { code: "UNAUTHORIZED" } });
  }

  t.is(signedOut, 1, "the sign-out is announced once, however often the link retries");
  t.is(useConnectionStore.getState().status, "connecting");
  bridge.close();
});

test.serial("an ordinary stream error asks whether the session survived", async (t) => {
  const queryClient = client();
  // The session is gone, which a native `EventSource` cannot report: it fires
  // the same opaque error for a 401 and for a dropped connection, so the
  // bridge asks `auth.me` rather than guessing (`06-auth-and-users.md` §2).
  const stub = createTrpcStub({ "auth.me": null });
  let signedOut = 0;
  const bridge = connectEventBridge({
    queryClient,
    client: stub.client,
    setInterest: () => Promise.resolve(undefined),
    onUnauthorized: () => (signedOut += 1),
  });

  for (const observer of stub.observers) {
    observer.onError?.(new Error("network"));
    observer.onError?.(new Error("network"));
  }
  await sleep(10);

  t.is(stub.calls.filter((call) => call.path === "auth.me").length, 1, "asked once per drop");
  t.is(signedOut, 1);
  t.is(queryClient.getQueryData(queryKeys.me()), null, "and the answer lands in the cache");
  bridge.close();
});

test.serial("a stream error on a live session does not sign the tab out", async (t) => {
  const queryClient = client();
  const stub = createTrpcStub({ "auth.me": { id: "u1", login: "raymond" } });
  let signedOut = 0;
  const bridge = connectEventBridge({
    queryClient,
    client: stub.client,
    setInterest: () => Promise.resolve(undefined),
    onUnauthorized: () => (signedOut += 1),
  });

  for (const observer of stub.observers) observer.onError?.(new Error("network"));
  await sleep(10);

  t.is(signedOut, 0, "a dropped connection is the ordinary case");
  bridge.close();
});

test.serial("a rename refetches the highlights feed, whose rows carry the label", (t) => {
  const queryClient = client();
  queryClient.setQueryData(queryKeys.tree("t1"), { tree: tree(), nodes: [node()] });
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);
  queryClient.setQueryData(queryKeys.highlightsFeed("w1"), []);

  applyEventBatch(
    [event("research.tree.updated", { tree: tree({ title: "Renamed" }) })],
    queryClient,
  );

  t.true(queryClient.getQueryState(queryKeys.highlightsFeed("w1"))?.isInvalidated);
});

test.serial("a status change leaves the highlights feed alone", (t) => {
  const queryClient = client();
  const running = node({ status: "running" });
  queryClient.setQueryData(queryKeys.tree("t1"), { tree: tree(), nodes: [running] });
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);
  queryClient.setQueryData(queryKeys.highlightsFeed("w1"), []);

  applyEventBatch(
    [event("research.node.updated", { node: node({ status: "complete" }) })],
    queryClient,
  );

  t.false(
    queryClient.getQueryState(queryKeys.highlightsFeed("w1"))?.isInvalidated,
    "the labels on those rows did not change",
  );
});

test.serial("archiving a thread retires its highlights, and restoring brings them back", (t) => {
  for (const type of ["research.tree.archived", "research.tree.restored"] as const) {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.tree("t1"), { tree: tree(), nodes: [node()] });
    queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary()]);
    queryClient.setQueryData(queryKeys.highlightsFeed("w1"), []);

    const archivedAt = type === "research.tree.archived" ? 1_700_000_200_000 : null;
    applyEventBatch([event(type, { tree: tree({ archivedAt }) })], queryClient);

    t.true(
      queryClient.getQueryState(queryKeys.highlightsFeed("w1"))?.isInvalidated,
      `${type} moves the thread in or out of the feed's unarchived scope`,
    );
  }
});
