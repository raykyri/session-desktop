import type { Turn } from "@session/shared";
import test from "ava";

import { useLiveTurnsStore, type RunEvent } from "../src/stores/liveTurns.js";

const NODE = "node-1";

function turn(id: string): Turn {
  return { id, agentId: NODE, role: "assistant", blocks: [], sourceIndex: 0 };
}

function seed(seq = 0) {
  useLiveTurnsStore.setState({ byNode: {} });
  useLiveTurnsStore.getState().seed(NODE, { turns: [], seq });
}

function apply(...events: RunEvent[]) {
  for (const event of events) useLiveTurnsStore.getState().applyRunEvent(event);
}

function state() {
  const node = useLiveTurnsStore.getState().byNode[NODE];
  if (!node) throw new Error("node buffer missing");
  return node;
}

test.beforeEach(() => seed());

test.serial("in-order deltas accumulate and advance the sequence", (t) => {
  apply(
    { type: "run.started", nodeId: NODE, seq: 1 },
    { type: "turn.delta", nodeId: NODE, seq: 2, text: "Hello" },
    { type: "turn.delta", nodeId: NODE, seq: 3, text: ", world" },
  );

  t.is(state().inFlightText, "Hello, world");
  t.is(state().lastSeq, 3);
  t.is(state().status, "running");
  t.false(state().gap);
});

test.serial("a replayed delta is dropped rather than appended twice", (t) => {
  apply(
    { type: "turn.delta", nodeId: NODE, seq: 1, text: "a" },
    { type: "turn.delta", nodeId: NODE, seq: 2, text: "b" },
    // The same two events again, as a reconnect would deliver them.
    { type: "turn.delta", nodeId: NODE, seq: 1, text: "a" },
    { type: "turn.delta", nodeId: NODE, seq: 2, text: "b" },
  );

  t.is(state().inFlightText, "ab");
  t.is(state().lastSeq, 2);
  t.false(state().gap);
});

test.serial("missing sequence numbers set the gap flag and halt buffer updates", (t) => {
  apply(
    { type: "turn.delta", nodeId: NODE, seq: 1, text: "a" },
    { type: "turn.delta", nodeId: NODE, seq: 3, text: "c" },
  );

  t.true(state().gap, "seq 2 never arrived");
  t.is(state().inFlightText, "a", "ignores subsequent deltas after detecting a sequence gap");
  t.is(state().lastSeq, 1);
});

test.serial("re-seeding from a snapshot clears the gap and resets the baseline", (t) => {
  apply(
    { type: "turn.delta", nodeId: NODE, seq: 1, text: "a" },
    { type: "turn.delta", nodeId: NODE, seq: 9, text: "z" },
  );
  t.true(state().gap);

  useLiveTurnsStore.getState().seed(NODE, { turns: [turn("t1")], inFlightText: "abc", seq: 9 });

  t.false(state().gap);
  t.is(state().lastSeq, 9);
  t.is(state().inFlightText, "abc");
  t.is(state().turns.length, 1);

  apply({ type: "turn.delta", nodeId: NODE, seq: 10, text: "d" });
  t.is(state().inFlightText, "abcd");
});

test.serial("a committed turn moves the in-flight text into the turn list", (t) => {
  apply(
    { type: "turn.delta", nodeId: NODE, seq: 1, text: "partial" },
    { type: "turn.committed", nodeId: NODE, seq: 2, turn: turn("t1") },
  );

  t.is(state().inFlightText, "");
  t.is(state().inFlightTurnId, null);
  t.deepEqual(
    state().turns.map((committed) => committed.id),
    ["t1"],
  );
});

test.serial("a delta for a new turn id restarts the buffer instead of appending", (t) => {
  apply(
    { type: "turn.delta", nodeId: NODE, seq: 1, text: "first", turnId: "t1" },
    { type: "turn.delta", nodeId: NODE, seq: 2, text: " more", turnId: "t1" },
    { type: "turn.delta", nodeId: NODE, seq: 3, text: "second", turnId: "t2" },
  );

  t.is(state().inFlightText, "second");
  t.is(state().inFlightTurnId, "t2");
});

test.serial("finishing a run drops the in-flight text and marks the node finished", (t) => {
  apply(
    { type: "turn.delta", nodeId: NODE, seq: 1, text: "x" },
    { type: "run.finished", nodeId: NODE, seq: 2 },
  );

  t.is(state().status, "finished");
  t.is(state().inFlightText, "");
});

test.serial("clear removes only the named node's buffer", (t) => {
  useLiveTurnsStore.getState().seed("other", { turns: [], seq: 0 });
  useLiveTurnsStore.getState().clear(NODE);

  t.is(useLiveTurnsStore.getState().byNode[NODE], undefined);
  t.truthy(useLiveTurnsStore.getState().byNode["other"]);

  useLiveTurnsStore.getState().clearAll();
  t.deepEqual(useLiveTurnsStore.getState().byNode, {});
});

test.serial("a run event for a node no view seeded is dropped", (t) => {
  useLiveTurnsStore.setState({ byNode: {} });

  // `research.run.*` reaches every connection of the account, not just the
  // ones watching this node (`03-api-and-events.md` §3). Buffering those would
  // grow the map with every run the user starts anywhere, and the turn-less
  // buffer would then shadow the snapshot when the node is finally opened.
  apply(
    { type: "run.started", nodeId: "unwatched", seq: 1 },
    { type: "turn.delta", nodeId: "unwatched", seq: 2, text: "ignored" },
    { type: "run.finished", nodeId: "unwatched", seq: 3 },
  );

  t.is(useLiveTurnsStore.getState().byNode["unwatched"], undefined);

  useLiveTurnsStore.getState().seed("unwatched", { turns: [turn("t1")], seq: 3 });
  apply({ type: "turn.delta", nodeId: "unwatched", seq: 4, text: "kept" });

  const buffered = useLiveTurnsStore.getState().byNode["unwatched"];
  t.is(buffered?.inFlightText, "kept", "the snapshot's baseline is what deltas extend");
  t.is(buffered?.turns.length, 1);
});
