// The streaming protocol's client half (`05-run-lifecycle-and-streaming.md`
// §4, §9): a snapshot seeds the buffer, ordered deltas extend it, and when the
// run settles the durable snapshot replaces the buffer without dropping a turn
// on the way through.

import type { SessionEvent, Turn } from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import test from "ava";

import { applyEventBatch } from "../src/api/events.js";
import { SNAPSHOT_POLL_MS, queryClientDefaults, useNodeContent } from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { AppProviders } from "../src/app/providers.js";
import { CONNECTION_FALLBACK_DELAY_MS, useConnectionStore } from "../src/stores/connection.js";
import { useLiveTurnsStore } from "../src/stores/liveTurns.js";

import { node } from "./fixtures.js";
import { resetDocumentRoot, waitUntil } from "./helpers.js";
import { createTrpcStub, type TrpcStub } from "./trpcStub.js";

function turn(id: string): Turn {
  return { id, agentId: "n1", role: "assistant", blocks: [], sourceIndex: 0 };
}

function event(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: 1_700_000_100_000 };
}

function Probe() {
  const view = useNodeContent("n1");
  return (
    <div>
      <span data-testid="source">{view.source}</span>
      <span data-testid="turns">{view.turns.map((item) => item.id).join(",")}</span>
      <span data-testid="inflight">{view.inFlightText}</span>
      <span data-testid="status">{view.status}</span>
    </div>
  );
}

function text(id: string): string {
  return screen.getByTestId(id).textContent ?? "";
}

function mount(stub: TrpcStub) {
  setTrpcClient(stub.client);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  render(
    <AppProviders queryClient={queryClient}>
      <Probe />
    </AppProviders>,
  );
  return queryClient;
}

test.beforeEach(() => {
  useLiveTurnsStore.setState({ byNode: {} });
  // Open, so the 2 s snapshot poll stays off (05 §9).
  useConnectionStore.setState({ status: "open", disconnectedSince: null });
});

// `always`, so one failing assertion does not leave its tree mounted and turn
// every later `getByTestId` into "found multiple elements".
test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial("a live run keeps its turns across the swap to the durable snapshot", async (t) => {
  const stub = createTrpcStub({
    "research.getNodeContent": {
      node: node({ status: "running" }),
      turns: [turn("turn-a")],
      children: [],
      inFlightText: "",
      seq: 5,
    },
  });
  const queryClient = mount(stub);

  await waitUntil(t, () => text("turns") === "turn-a", "the snapshot seeded the buffer");
  t.is(text("source"), "live", "an active node reads from the buffer");

  act(() => {
    applyEventBatch(
      [
        event("research.turn.delta", { nodeId: "n1", seq: 6, turnId: "turn-b", text: "Hel" }),
        event("research.turn.delta", { nodeId: "n1", seq: 7, turnId: "turn-b", text: "lo" }),
      ],
      queryClient,
    );
  });
  t.is(text("inflight"), "Hello");
  t.is(text("turns"), "turn-a", "an in-flight turn is not committed");

  act(() => {
    applyEventBatch(
      [event("research.turn.committed", { nodeId: "n1", seq: 8, turn: turn("turn-b") })],
      queryClient,
    );
  });
  t.is(text("turns"), "turn-a,turn-b");
  t.is(text("inflight"), "");

  // What the refetch after the terminal update will find.
  const settled = node({
    status: "complete",
    completedAt: 1_700_000_200_000,
    responseSnapshotAt: 1_700_000_200_000,
  });
  stub.responses.set("research.getNodeContent", {
    node: settled,
    turns: [turn("turn-a"), turn("turn-b")],
    children: [],
    responseRevision: "r1",
  });

  const readsBeforeFinish = stub.calls.filter(
    (call) => call.path === "research.getNodeContent",
  ).length;

  act(() => {
    applyEventBatch(
      [
        event("research.run.finished", {
          nodeId: "n1",
          seq: 9,
          attempt: 1,
          status: "complete",
        }),
      ],
      queryClient,
    );
  });

  // `run.finished` precedes the snapshot transaction, so reading here would
  // race it (05 §4): the buffer holds until the node carries the stamp.
  t.is(
    stub.calls.filter((call) => call.path === "research.getNodeContent").length,
    readsBeforeFinish,
    "the durable read waits for the terminal node update",
  );
  t.is(text("source"), "live", "and the streamed turns stay on screen meanwhile");

  act(() => {
    applyEventBatch([event("research.node.updated", { node: settled })], queryClient);
  });

  await waitUntil(t, () => text("source") === "snapshot", "the durable snapshot took over");
  t.is(text("turns"), "turn-a,turn-b", "no turn was lost in the swap");
  t.is(
    useLiveTurnsStore.getState().byNode["n1"],
    undefined,
    "the live buffer is dropped once the snapshot holds the same turns",
  );
});

test.serial("a gap in the sequence refetches instead of rendering a hole", async (t) => {
  const stub = createTrpcStub({
    "research.getNodeContent": {
      node: node({ status: "running" }),
      turns: [turn("turn-a")],
      children: [],
      inFlightText: "",
      seq: 5,
    },
  });
  const queryClient = mount(stub);
  await waitUntil(t, () => text("turns") === "turn-a", "the snapshot seeded the buffer");
  const reads = stub.calls.filter((call) => call.path === "research.getNodeContent").length;

  act(() => {
    // 6 is missing, so 7 must not be applied.
    applyEventBatch(
      [event("research.turn.delta", { nodeId: "n1", seq: 7, turnId: "turn-b", text: "lo" })],
      queryClient,
    );
  });

  t.is(text("inflight"), "", "the buffer froze rather than render text with a hole");
  await waitUntil(
    t,
    () => stub.calls.filter((call) => call.path === "research.getNodeContent").length > reads,
    "the snapshot was re-read",
  );
});

test.serial("the snapshot poll waits out the connection grace", async (t) => {
  const stub = createTrpcStub({
    "research.getNodeContent": {
      node: node({ status: "running" }),
      turns: [turn("turn-a")],
      children: [],
      inFlightText: "",
      seq: 5,
    },
  });
  const reads = (): number =>
    stub.calls.filter((call) => call.path === "research.getNodeContent").length;

  // The stream has just dropped: 05 §9 gives it ten seconds to come back
  // before a displayed run is polled, and a poll inside that window is two
  // requests a second per open document for a blip nobody saw.
  useConnectionStore.setState({ status: "closed", disconnectedSince: Date.now() });
  mount(stub);
  await waitUntil(t, () => text("turns") === "turn-a", "the snapshot seeded the buffer");
  const onMount = reads();

  // `act` around the wait, so a refetch that resolves during it is flushed
  // inside the test rather than warned about after it.
  await act(() => new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_MS + 300)));
  t.is(reads(), onMount, "a stream that just dropped is not polled");

  act(() => {
    useConnectionStore.setState({
      status: "closed",
      disconnectedSince: Date.now() - CONNECTION_FALLBACK_DELAY_MS,
    });
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_MS + 300)));
  t.true(reads() > onMount, "once the grace elapses the snapshot is polled");
});

test.serial("a finished run whose durable read fails keeps the streamed turns", async (t) => {
  const running = {
    node: node({ status: "running" }),
    turns: [turn("turn-a")],
    children: [],
    inFlightText: "",
    seq: 5,
  };
  const stub = createTrpcStub({ "research.getNodeContent": running });
  const queryClient = mount(stub);
  await waitUntil(t, () => text("turns") === "turn-a", "the snapshot seeded the buffer");

  const settled = node({
    status: "failed",
    completedAt: 1_700_000_200_000,
    responseSnapshotAt: null,
  });
  stub.responses.delete("research.getNodeContent");
  act(() => {
    applyEventBatch(
      [
        event("research.run.finished", { nodeId: "n1", seq: 6, attempt: 1, status: "failed" }),
        event("research.node.updated", { node: settled }),
      ],
      queryClient,
    );
  });

  // A run that fails never writes a snapshot, so the terminal status is the
  // signal; the read that follows it answers with nothing usable here, and the
  // buffer is what the reader keeps looking at rather than an empty document.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  t.is(text("turns"), "turn-a");
  t.is(text("source"), "live");
});
