// Mutations and the events they cause write the same caches (07 §4.1).
//
// Summary counts are deltas, so an optimistic update and the server event for
// the same change must not both apply it. These tests apply
// both halves in the order the browser sees them: the mutation's own reply
// first, then the event the server published for the same change, which this
// tab receives like any other (`03-api-and-events.md` §3).

import type {
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
  SessionEvent,
} from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import test from "ava";
import type { ReactNode } from "react";

import { queryKeys } from "../src/api/cache.js";
import { applyEventBatch } from "../src/api/events.js";
import {
  queryClientDefaults,
  useAskResearchFollowup,
  useCancelResearchNode,
  useCreateResearchTree,
  useForkResearchNode,
  useRemoveResearchBranch,
  useRetryResearchNode,
} from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { AppProviders } from "../src/app/providers.js";
import { useHighlightMutations } from "../src/features/thread/mutations.js";

import { node, summary, tree } from "./fixtures.js";
import { resetDocumentRoot } from "./helpers.js";
import { createTrpcStub, type TrpcStub } from "./trpcStub.js";

const TREES_SCOPE = { workspaceId: "w1", includeArchived: false };

function event(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: 1_700_000_100_000 };
}

function seeded(nodes: ResearchNode[], counts: Partial<ResearchTreeSummary> = {}): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY, retry: false },
      // A finite `gcTime` — the five-minute default — puts a collection timer
      // in Node's queue per mutation, and AVA waits for it before exiting.
      mutations: { gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const detail: ResearchTreeDetail = { tree: tree(), nodes };
  queryClient.setQueryData(queryKeys.tree("t1"), detail);
  queryClient.setQueryData(queryKeys.trees(TREES_SCOPE), [summary(counts)]);
  queryClient.setQueryData(queryKeys.activeNodes(), nodes);
  return queryClient;
}

function counts(queryClient: QueryClient): ResearchTreeSummary | undefined {
  return queryClient.getQueryData<ResearchTreeSummary[]>(queryKeys.trees(TREES_SCOPE))?.[0];
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <AppProviders queryClient={queryClient}>{children}</AppProviders>
  );
}

function install(responses: Record<string, unknown>): TrpcStub {
  const stub = createTrpcStub(responses);
  setTrpcClient(stub.client);
  return stub;
}

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial(
  "cancelling a node updates summary counts once without duplicate event increments",
  async (t) => {
    const running = node({ status: "running" });
    const cancelled = node({ status: "cancelled", completedAt: 1_700_000_100_000 });
    install({ "research.cancelNode": cancelled });
    const queryClient = seeded([running]);

    const { result } = renderHook(() => useCancelResearchNode(), { wrapper: wrapper(queryClient) });
    await act(async () => {
      await result.current.mutateAsync("n1");
    });

    t.is(counts(queryClient)?.runningCount, 0, "the delta is applied from the node it replaced");
    t.is(counts(queryClient)?.cancelledCount, 1);

    // The `research.node.updated` the same call published.
    act(() => {
      applyEventBatch([event("research.node.updated", { node: cancelled })], queryClient);
    });

    t.is(counts(queryClient)?.runningCount, 0, "the event finds its own work done");
    t.is(counts(queryClient)?.cancelledCount, 1);
    t.deepEqual(
      queryClient.getQueryData(queryKeys.activeNodes()),
      [],
      "and the node left activity",
    );
  },
);

test.serial("forking counts the new question once", async (t) => {
  const forked = node({ id: "n2", parentNodeId: "n1", status: "queued" });
  install({ "research.forkNode": forked });
  const queryClient = seeded([node({ status: "running" })]);

  const { result } = renderHook(() => useForkResearchNode(), { wrapper: wrapper(queryClient) });
  await act(async () => {
    await result.current.mutateAsync({ parentNodeId: "n1", prompt: "and then?" });
  });

  t.is(counts(queryClient)?.runningCount, 2, "a queued node counts as running on the summary");
  t.is(
    queryClient.getQueryData<ResearchTreeDetail>(queryKeys.tree("t1"))?.nodes.length,
    2,
    "and it is in the detail the user is looking at",
  );

  act(() => {
    applyEventBatch([event("research.node.created", { node: forked })], queryClient);
  });

  t.is(counts(queryClient)?.runningCount, 2, "the event does not count it a second time");
  t.false(
    queryClient.getQueryState(queryKeys.trees(TREES_SCOPE))?.isInvalidated,
    "and no refetch races the patch for the same +1",
  );
});

test.serial("removing a branch subtracts its counts once", async (t) => {
  const child = node({ id: "n2", parentNodeId: "n1", status: "running" });
  install({
    "research.removeBranch": { treeId: "t1", parentNodeId: "n1", removedNodeIds: ["n2"] },
  });
  const queryClient = seeded([node({ status: "running" }), child], { runningCount: 2 });

  const { result } = renderHook(() => useRemoveResearchBranch(), { wrapper: wrapper(queryClient) });
  await act(async () => {
    await result.current.mutateAsync("n2");
  });

  t.is(counts(queryClient)?.runningCount, 1);
  t.is(queryClient.getQueryData<ResearchTreeDetail>(queryKeys.tree("t1"))?.nodes.length, 1);

  act(() => {
    applyEventBatch(
      [
        event("research.node.removed", {
          treeId: "t1",
          parentNodeId: "n1",
          removedNodeIds: ["n2"],
        }),
      ],
      queryClient,
    );
  });

  t.is(counts(queryClient)?.runningCount, 1, "the rows are gone, so the event subtracts nothing");
});

test.serial("a fork whose event arrived before the response is counted once", async (t) => {
  const forked = node({ id: "n2", parentNodeId: "n1", status: "queued" });
  install({ "research.forkNode": forked });
  const queryClient = seeded([node({ status: "running" })]);

  act(() => {
    applyEventBatch([event("research.node.created", { node: forked })], queryClient);
  });
  t.is(counts(queryClient)?.runningCount, 2, "the event counts the new question");

  const { result } = renderHook(() => useForkResearchNode(), { wrapper: wrapper(queryClient) });
  await act(async () => {
    await result.current.mutateAsync({ parentNodeId: "n1", prompt: "and then?" });
  });
  t.is(counts(queryClient)?.runningCount, 2, "the response finds it counted");
});

test.serial("a follow-up sent at once is counted once whichever half lands first", async (t) => {
  const sent = node({ id: "n2", parentNodeId: "n1", status: "queued", inline: true });
  install({ "followups.ask": { kind: "sent", node: sent } });
  const queryClient = seeded([node({ status: "complete", completedAt: 1 })], { runningCount: 0 });

  act(() => {
    applyEventBatch([event("research.node.created", { node: sent })], queryClient);
  });
  const { result } = renderHook(() => useAskResearchFollowup(), { wrapper: wrapper(queryClient) });
  await act(async () => {
    await result.current.mutateAsync({ headNodeId: "n1", prompt: "and then?" });
  });
  t.is(counts(queryClient)?.runningCount, 1);
});

test.serial(
  "retrying in someone else's thread updates the lists that hold it and adds it to none",
  async (t) => {
    const shared = tree({ id: "t9", rootNodeId: "n9", ownerId: "owner", role: "commenter" });
    const detail: ResearchTreeDetail = {
      tree: shared,
      nodes: [node({ id: "n9", treeId: "t9", status: "queued" })],
    };
    install({ "research.retryNode": detail });
    const queryClient = seeded([node({ status: "running" })]);
    // The reader's other workspace, and the shared list that holds the thread.
    queryClient.setQueryData(queryKeys.trees({ workspaceId: "w2", includeArchived: false }), []);
    queryClient.setQueryData(queryKeys.shared("shared"), [
      summary({ id: "t9", rootNodeId: "n9", workspaceId: "owner-ws", role: "commenter" }),
    ]);

    const { result } = renderHook(() => useRetryResearchNode(), { wrapper: wrapper(queryClient) });
    await act(async () => {
      await result.current.mutateAsync({ nodeId: "n9" });
    });

    t.deepEqual(
      queryClient
        .getQueryData<ResearchTreeSummary[]>(queryKeys.trees(TREES_SCOPE))
        ?.map((entry) => entry.id),
      ["t1"],
      "not added to the reader's own workspace",
    );
    t.deepEqual(
      queryClient.getQueryData(queryKeys.trees({ workspaceId: "w2", includeArchived: false })),
      [],
    );
    const sharedRow = queryClient.getQueryData<ResearchTreeSummary[]>(
      queryKeys.shared("shared"),
    )?.[0];
    t.is(sharedRow?.runningCount, 1, "the shared row takes the new counts");
    t.is(sharedRow?.role, "commenter", "and keeps the reader's role");
    t.is(sharedRow?.workspaceId, "owner-ws");
  },
);

test.serial("a thread created in another workspace is added only to its lists", async (t) => {
  const created = tree({ id: "t2", rootNodeId: "n2", workspaceId: "w2", role: "owner" });
  const detail: ResearchTreeDetail = {
    tree: created,
    nodes: [node({ id: "n2", treeId: "t2", groupId: "w2", status: "queued" })],
  };
  install({ "research.createTree": detail });
  const queryClient = seeded([node({ status: "running" })]);
  const w2 = queryKeys.trees({ workspaceId: "w2", includeArchived: false });
  queryClient.setQueryData(w2, []);

  const { result } = renderHook(() => useCreateResearchTree(), { wrapper: wrapper(queryClient) });
  await act(async () => {
    await result.current.mutateAsync({ prompt: "q", model: "gemini-flash", workspaceId: "w2" });
  });

  t.deepEqual(
    queryClient
      .getQueryData<ResearchTreeSummary[]>(queryKeys.trees(TREES_SCOPE))
      ?.map((entry) => entry.id),
    ["t1"],
  );
  const added = queryClient.getQueryData<ResearchTreeSummary[]>(w2);
  t.deepEqual(
    added?.map((entry) => entry.id),
    ["t2"],
  );
  t.is(added?.[0]?.role, "owner", "with the reader's role");
});

test.serial("a highlight the event already added is not added twice", async (t) => {
  const anchor = {
    version: 1 as const,
    projection: "answer-v1" as const,
    responseRevision: "r",
    start: 0,
    end: 4,
    exact: "Some",
    prefix: "",
    suffix: "",
  };
  const highlight = { id: "h1", nodeId: "n1", anchor, createdAt: 1 };
  install({ "highlights.create": highlight });
  const queryClient = seeded([node({ status: "complete", completedAt: 1 })]);
  act(() => {
    applyEventBatch(
      [event("research.highlight.created", { nodeId: "n1", highlight })],
      queryClient,
    );
  });
  const { result } = renderHook(() => useHighlightMutations("t1"), {
    wrapper: wrapper(queryClient),
  });
  await act(async () => {
    await result.current.create("n1", anchor);
  });
  t.is(
    queryClient.getQueryData<ResearchTreeDetail>(queryKeys.tree("t1"))?.nodes[0]?.highlights.length,
    1,
  );
});
