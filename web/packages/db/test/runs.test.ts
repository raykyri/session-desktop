import test from "ava";

import { messages, nodes, runs, snapshots, trees } from "../src/index.js";

import { answerTurn, createFixture } from "./helpers.js";

function startedRoot(fixture: ReturnType<typeof createFixture>) {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  nodes.setStatus(fixture.db, fixture.userId, detail.tree.rootNodeId, "running");
  return detail.tree.rootNodeId;
}

test("committing a turn advances run_seq by exactly one", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  const before = runs.liveWindow(fixture.db, fixture.userId, nodeId).seq;
  const first = runs.commitTurn(fixture.db, fixture.userId, {
    nodeId,
    turn: answerTurn(nodeId, "one", "t1"),
  });
  const second = runs.commitTurn(fixture.db, fixture.userId, {
    nodeId,
    turn: answerTurn(nodeId, "two", "t2"),
  });
  t.is(first.seq, before + 1);
  t.is(second.seq, first.seq + 1);
  t.is(first.position, 0);
  t.is(second.position, 1);
});

test("the live window is the committed turns plus the checkpoint text", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  runs.commitTurn(fixture.db, fixture.userId, { nodeId, turn: answerTurn(nodeId, "done", "t1") });
  runs.checkpointInFlight(fixture.db, fixture.userId, {
    nodeId,
    seq: runs.liveWindow(fixture.db, fixture.userId, nodeId).seq,
    turn: answerTurn(nodeId, "still writ", "t2"),
  });
  const window = runs.liveWindow(fixture.db, fixture.userId, nodeId);
  t.is(window.turns.length, 1);
  t.is(window.inFlightText, "still writ");
  t.is(window.inFlightTurnId, "t2");

  // The checkpoint keeps its slot as it grows, then becomes the committed turn.
  runs.checkpointInFlight(fixture.db, fixture.userId, {
    nodeId,
    seq: runs.liveWindow(fixture.db, fixture.userId, nodeId).seq,
    turn: answerTurn(nodeId, "still writing", "t2"),
  });
  t.is(runs.liveWindow(fixture.db, fixture.userId, nodeId).inFlightText, "still writing");
  runs.commitTurn(fixture.db, fixture.userId, {
    nodeId,
    turn: answerTurn(nodeId, "still writing now", "t2"),
  });
  const settled = runs.liveWindow(fixture.db, fixture.userId, nodeId);
  t.is(settled.turns.length, 2);
  t.is(settled.inFlightText, undefined);
});

test("the live window shows only the current attempt", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  runs.commitTurn(fixture.db, fixture.userId, {
    nodeId,
    turn: answerTurn(nodeId, "attempt one", "t1"),
    attempt: 1,
  });
  fixture.db.$client.prepare(`UPDATE nodes SET attempt = 2 WHERE id = ?`).run(nodeId);
  t.deepEqual(runs.liveWindow(fixture.db, fixture.userId, nodeId).turns, []);
});

test("the attempt record opens and closes", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  runs.startAttempt(fixture.db, { nodeId, attempt: 1, kind: "fresh", model: "gemini-flash" });
  runs.finishAttempt(fixture.db, {
    nodeId,
    attempt: 1,
    outcome: "complete",
    steps: 3,
    toolCalls: 2,
    usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5, cachedTokens: 0 },
    costEstimateMicros: 42,
  });
  const [attempt] = runs.listAttempts(fixture.db, nodeId);
  t.is(attempt?.kind, "fresh");
  t.is(attempt?.outcome, "complete");
  t.is(attempt?.steps, 3);
  t.deepEqual(attempt?.usageJson, {
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    cachedTokens: 0,
  });
  t.not(attempt?.endedAt, null);
});

test("final snapshot commit marks node status as terminal and removes live turns", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  runs.commitTurn(fixture.db, fixture.userId, {
    nodeId,
    turn: answerTurn(nodeId, "Birds sing at dawn because sound carries further.", "t1"),
  });
  const before = trees.summaries(fixture.db, fixture.userId)[0]?.updatedAt ?? 0;
  const result = snapshots.commit(fixture.db, fixture.userId, {
    nodeId,
    turns: [answerTurn(nodeId, "Birds sing at dawn because sound carries further.", "t1")],
    outcome: { status: "complete" },
  });
  t.is(result.node.status, "complete");
  t.not(result.node.responseSnapshotAt, null);
  t.regex(result.revision, /^[0-9a-f]{64}$/);
  t.true((result.node.responsePreview ?? "").startsWith("Birds sing at dawn"));
  t.deepEqual(runs.liveWindow(fixture.db, fixture.userId, nodeId).turns, []);
  const stored = snapshots.read(fixture.db, fixture.userId, nodeId);
  t.is(stored?.revision, result.revision);
  t.is(stored?.outcome?.status, "complete");
  t.true(
    (trees.summaries(fixture.db, fixture.userId)[0]?.updatedAt ?? 0) > before,
    "the commit touches the thread, and touchTree moves updated_at strictly forward",
  );
});

test("a snapshot without assistant text is refused", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  t.throws(
    () =>
      snapshots.commit(fixture.db, fixture.userId, {
        nodeId,
        turns: [
          {
            id: "t1",
            agentId: nodeId,
            role: "user",
            blocks: [{ type: "text", text: "a question" }],
            sourceIndex: 0,
          },
        ],
        outcome: { status: "complete" },
      }),
    { message: /must contain assistant output text/ },
  );
});

test("prevents committing duplicate snapshots for nodes in a terminal state", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  snapshots.commit(fixture.db, fixture.userId, {
    nodeId,
    turns: [answerTurn(nodeId, "The answer.")],
    outcome: { status: "complete" },
  });
  t.throws(
    () =>
      snapshots.commit(fixture.db, fixture.userId, {
        nodeId,
        turns: [answerTurn(nodeId, "A different answer.")],
        outcome: { status: "complete" },
      }),
    { message: /cannot be committed again/ },
  );
});

test("messages are appended only for a completed node", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  t.throws(
    () =>
      messages.appendMessages(fixture.db, fixture.userId, nodeId, [
        { message: { role: "assistant" } },
      ]),
    { message: /only completed runs/ },
  );
  snapshots.commit(fixture.db, fixture.userId, {
    nodeId,
    turns: [answerTurn(nodeId, "An answer.")],
    outcome: { status: "complete" },
  });
  messages.appendMessages(fixture.db, fixture.userId, nodeId, [
    { message: { role: "user", content: "the question" } },
    { message: { role: "assistant", content: "the answer" }, model: "gemini-flash" },
  ]);
  const stored = messages.listMessages(fixture.db, fixture.userId, nodeId);
  t.is(stored.length, 2);
  t.deepEqual(
    stored.map((entry) => entry.position),
    [0, 1],
  );
  t.is(stored[1]?.model, "gemini-flash");
  // A second append continues rather than replaces.
  messages.appendMessages(fixture.db, fixture.userId, nodeId, [{ message: { role: "tool" } }]);
  t.is(messages.listMessages(fixture.db, fixture.userId, nodeId).length, 3);
});

test("a node's context is its ancestors' messages, root first", (t) => {
  const fixture = createFixture(t);
  const rootId = startedRoot(fixture);
  snapshots.commit(fixture.db, fixture.userId, {
    nodeId: rootId,
    turns: [answerTurn(rootId, "Root answer.")],
    outcome: { status: "complete" },
  });
  messages.appendMessages(fixture.db, fixture.userId, rootId, [
    { message: { role: "user", content: "root" } },
  ]);
  const child = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: rootId,
    prompt: "Follow-up",
  });
  nodes.setStatus(fixture.db, fixture.userId, child.id, "running");
  snapshots.commit(fixture.db, fixture.userId, {
    nodeId: child.id,
    turns: [answerTurn(child.id, "Child answer.")],
    outcome: { status: "complete" },
  });
  messages.appendMessages(fixture.db, fixture.userId, child.id, [
    { message: { role: "user", content: "child" } },
  ]);
  const grandchild = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: child.id,
    prompt: "Deeper",
  });
  t.deepEqual(messages.ancestorPath(fixture.db, fixture.userId, grandchild.id), [
    rootId,
    child.id,
    grandchild.id,
  ]);
  t.deepEqual(
    messages
      .ancestorMessages(fixture.db, fixture.userId, grandchild.id)
      .map((entry) => entry.message["content"]),
    ["root", "child"],
  );
});

test("the compaction summary is cached per node", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  t.is(messages.getSummary(fixture.db, fixture.userId, nodeId), null);
  messages.saveSummary(fixture.db, fixture.userId, nodeId, "A summary.", nodeId);
  t.is(messages.getSummary(fixture.db, fixture.userId, nodeId)?.summary, "A summary.");
  messages.saveSummary(fixture.db, fixture.userId, nodeId, "A newer summary.", nodeId);
  t.is(messages.getSummary(fixture.db, fixture.userId, nodeId)?.summary, "A newer summary.");
});

test("a checkpoint replaces the previous one rather than accumulating", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  runs.checkpointInFlight(fixture.db, fixture.userId, {
    nodeId,
    seq: runs.liveWindow(fixture.db, fixture.userId, nodeId).seq,
    turn: answerTurn(nodeId, "first draft", "t1"),
  });
  // The runtime moved on to a new turn without committing the old checkpoint.
  runs.checkpointInFlight(fixture.db, fixture.userId, {
    nodeId,
    seq: runs.liveWindow(fixture.db, fixture.userId, nodeId).seq,
    turn: answerTurn(nodeId, "second draft", "t2"),
  });
  const rows = fixture.db.$client
    .prepare(`SELECT turn_id FROM run_turns WHERE node_id = ? AND committed = 0`)
    .all(nodeId) as { turn_id: string }[];
  t.deepEqual(
    rows.map((row) => row.turn_id),
    ["t2"],
    "one uncommitted row per attempt",
  );
  t.is(runs.liveWindow(fixture.db, fixture.userId, nodeId).inFlightText, "second draft");
});

test("committing a turn preserves the active in-flight checkpoint", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  runs.checkpointInFlight(fixture.db, fixture.userId, {
    nodeId,
    seq: runs.liveWindow(fixture.db, fixture.userId, nodeId).seq,
    turn: answerTurn(nodeId, "streaming", "t2"),
  });
  runs.commitTurn(fixture.db, fixture.userId, {
    nodeId,
    turn: answerTurn(nodeId, "an earlier step", "t1"),
  });
  const window = runs.liveWindow(fixture.db, fixture.userId, nodeId);
  t.is(window.turns.length, 1);
  t.is(window.inFlightText, "streaming");
});

test("advanceSeq carries the loop's in-memory sequence back into the row", (t) => {
  const fixture = createFixture(t);
  const nodeId = startedRoot(fixture);
  const start = runs.liveWindow(fixture.db, fixture.userId, nodeId).seq;

  // The loop forwarded ten deltas without writing a row.
  t.is(runs.advanceSeq(fixture.db, fixture.userId, nodeId, start + 10), start + 10);
  t.is(runs.liveWindow(fixture.db, fixture.userId, nodeId).seq, start + 10);

  // The next write continues from there rather than from the last row.
  const committed = runs.commitTurn(fixture.db, fixture.userId, {
    nodeId,
    turn: answerTurn(nodeId, "one", "t1"),
  });
  t.is(committed.seq, start + 11);

  // Monotonic: a stale value never moves the counter backwards.
  t.is(runs.advanceSeq(fixture.db, fixture.userId, nodeId, start + 2), start + 11);
  t.is(runs.liveWindow(fixture.db, fixture.userId, nodeId).seq, start + 11);
});
