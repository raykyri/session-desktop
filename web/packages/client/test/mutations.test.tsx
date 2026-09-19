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
  useCancelResearchNode,
  useForkResearchNode,
  useRemoveResearchBranch,
} from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { AppProviders } from "../src/app/providers.js";

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
