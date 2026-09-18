import test from "ava";

import { nodes, queue, runs, snapshots, trees } from "../src/index.js";

import { answerTurn, createFixture } from "./helpers.js";

function completedRoot(fixture: ReturnType<typeof createFixture>, prompt = "Root question") {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt,
    model: "gemini-flash",
  });
  nodes.setStatus(fixture.db, fixture.userId, detail.tree.rootNodeId, "complete");
  return detail;
}

test("a follow-up requires a completed parent and a live thread", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  t.throws(
    () =>
      nodes.admitChild(fixture.db, fixture.userId, {
        parentNodeId: detail.tree.rootNodeId,
        prompt: "Too early",
      }),
    { message: /parent research run has not completed/ },
  );
  nodes.setStatus(fixture.db, fixture.userId, detail.tree.rootNodeId, "complete");
  trees.archive(fixture.db, fixture.userId, detail.tree.id);
  t.throws(
    () =>
      nodes.admitChild(fixture.db, fixture.userId, {
        parentNodeId: detail.tree.rootNodeId,
        prompt: "Archived",
      }),
    { message: /Cannot create follow-up on archived research/ },
  );
});

test("a follow-up inherits the parent's model unless it names one", (t) => {
  const fixture = createFixture(t);
  const detail = completedRoot(fixture);
  const inherited = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: detail.tree.rootNodeId,
    prompt: "Inherits",
  });
  t.is(inherited.model, "gemini-flash");
  const chosen = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: detail.tree.rootNodeId,
    prompt: "Chooses",
    model: "claude-fable",
  });
  t.is(chosen.model, "claude-fable");
});

test("the partial unique index allows one inline child per parent", (t) => {
  const fixture = createFixture(t);
  const detail = completedRoot(fixture);
  const inline = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: detail.tree.rootNodeId,
    prompt: "Continues",
    inline: true,
  });
  t.true(inline.inline);
  t.throws(
    () =>
      nodes.admitChild(fixture.db, fixture.userId, {
        parentNodeId: detail.tree.rootNodeId,
        prompt: "Also continues",
        inline: true,
      }),
    { message: nodes.INLINE_SLOT_TAKEN },
  );
  // Branching children are unlimited.
  nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: detail.tree.rootNodeId,
    prompt: "Branch one",
  });
  nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: detail.tree.rootNodeId,
    prompt: "Branch two",
  });
  // A failed inline child still holds the slot; removing it reopens one.
  nodes.setStatus(fixture.db, fixture.userId, inline.id, "failed", { error: "x" });
  t.throws(
    () =>
      nodes.admitChild(fixture.db, fixture.userId, {
        parentNodeId: detail.tree.rootNodeId,
        prompt: "Third",
        inline: true,
      }),
    { message: nodes.INLINE_SLOT_TAKEN },
  );
  nodes.removeBranch(fixture.db, fixture.userId, inline.id);
  const replacement = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: detail.tree.rootNodeId,
    prompt: "Third",
    inline: true,
  });
  t.true(replacement.inline);
});

test("terminal statuses are monotonic", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running", { startedAt: Date.now() });
  const complete = nodes.setStatus(fixture.db, fixture.userId, rootId, "complete");
  t.not(complete.completedAt, null);
  for (const status of ["running", "failed", "cancelled", "queued"] as const) {
    t.throws(() => nodes.setStatus(fixture.db, fixture.userId, rootId, status), {
      message: /already has terminal status 'complete'/,
    });
  }
});

test("every status change bumps run_seq", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  const before = runs.liveWindow(fixture.db, fixture.userId, rootId).seq;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running");
  const after = runs.liveWindow(fixture.db, fixture.userId, rootId).seq;
  t.is(after, before + 1);
});

test("retry needs a terminal-but-retryable status and clears the attempt", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  t.throws(() => nodes.resetForRetry(fixture.db, fixture.userId, rootId), {
    message: /only runs with status 'failed', 'cancelled', or 'interrupted'/,
  });
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running");
  runs.commitTurn(fixture.db, fixture.userId, { nodeId: rootId, turn: answerTurn(rootId, "hi") });
  snapshots.commit(fixture.db, fixture.userId, {
    nodeId: rootId,
    turns: [answerTurn(rootId, "hi")],
    outcome: { status: "failed", error: "provider fell over" },
  });
  const retried = nodes.resetForRetry(fixture.db, fixture.userId, rootId, "gpt-luna");
  t.is(retried.status, "queued");
  t.is(retried.attempt, 2);
  t.is(retried.error, null);
  t.is(retried.completedAt, null);
  t.is(retried.responseSnapshotAt, null);
  t.is(retried.model, "gpt-luna");
  t.is(snapshots.read(fixture.db, fixture.userId, rootId), null);
  t.deepEqual(runs.liveWindow(fixture.db, fixture.userId, rootId).turns, []);
  // A node put back to `queued` has something to admit it again, and a retry
  // joins the back of the queue rather than jumping it.
  const queued = fixture.db.$client
    .prepare(`SELECT provider, enqueued_at, claimed_at FROM run_queue WHERE node_id = ?`)
    .get(rootId) as { provider: string; enqueued_at: number; claimed_at: number | null };
  t.is(queued.claimed_at, null);
  t.true(queued.enqueued_at > 0, "a retry takes its place at the back");
  t.is(queued.provider, "openrouter", "the new model's provider, not the old one's");
});

test("resume keeps the committed turns and drops the checkpoint", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running");
  runs.commitTurn(fixture.db, fixture.userId, {
    nodeId: rootId,
    turn: answerTurn(rootId, "settled step", "turn-1"),
  });
  runs.checkpointInFlight(fixture.db, fixture.userId, {
    nodeId: rootId,
    seq: runs.liveWindow(fixture.db, fixture.userId, rootId).seq,
    turn: answerTurn(rootId, "half a sentence", "turn-2"),
  });
  const interrupted = nodes.markInterrupted(fixture.db, fixture.userId, rootId);
  t.is(interrupted.status, "interrupted");

  const resumed = nodes.resumeAttempt(fixture.db, fixture.userId, rootId);
  t.is(resumed.status, "queued");
  t.is(resumed.attempt, 2);
  const window = runs.liveWindow(fixture.db, fixture.userId, rootId);
  t.is(window.turns.length, 1);
  t.is(window.turns[0]?.id, "turn-1");
  t.is(window.inFlightText, undefined);
  const queued = fixture.db.$client
    .prepare(`SELECT provider, enqueued_at, claimed_at FROM run_queue WHERE node_id = ?`)
    .get(rootId) as { provider: string; enqueued_at: number; claimed_at: number | null };
  t.is(queued.claimed_at, null);
  t.is(queued.enqueued_at, 0, "a resume goes back to the head of the queue");
  t.is(queued.provider, "vertex");
  t.throws(() => nodes.resumeAttempt(fixture.db, fixture.userId, rootId), {
    message: /only runs with status 'interrupted'/,
  });
});

test("reconciles in-flight runs at startup by marking them interrupted and re-enqueuing", (t) => {
  const fixture = createFixture(t);
  const running = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Running",
    model: "gemini-flash",
  });
  const queued = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Queued",
    model: "gemini-flash",
  });
  const runningId = running.tree.rootNodeId;
  const queuedId = queued.tree.rootNodeId;
  queue.enqueue(fixture.db, fixture.userId, { nodeId: runningId, provider: "vertex" });
  queue.enqueue(fixture.db, fixture.userId, { nodeId: queuedId, provider: "vertex" });
  queue.claim(fixture.db, { limit: 1, perUser: 1 });
  nodes.setStatus(fixture.db, fixture.userId, runningId, "running");

  const result = nodes.reconcileOnBoot(fixture.db);
  t.deepEqual(result.interruptedNodeIds, [runningId]);
  t.deepEqual(result.requeuedNodeIds, [runningId]);
  const reconciled = nodes.get(fixture.db, fixture.userId, runningId);
  t.is(reconciled?.status, "interrupted");
  t.is(nodes.get(fixture.db, fixture.userId, queuedId)?.status, "queued");
  // The resumed node is ahead of the one that was merely waiting.
  t.is(queue.position(fixture.db, fixture.userId, runningId), 1);
  t.is(queue.position(fixture.db, fixture.userId, queuedId), 2);
});

test("synchronizes node status with existing terminal snapshot outcome at startup", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running");
  snapshots.commit(fixture.db, fixture.userId, {
    nodeId: rootId,
    turns: [answerTurn(rootId, "The answer landed.")],
    outcome: { status: "complete", completedAt: 1_700_000_000_000 },
  });
  // The row is put back to `running` as a crash between the two writes would
  // have left it.
  fixture.db.$client.prepare(`UPDATE nodes SET status = 'running' WHERE id = ?`).run(rootId);
  const result = nodes.reconcileOnBoot(fixture.db);
  t.deepEqual(result.adoptedNodeIds, [rootId]);
  t.deepEqual(result.interruptedNodeIds, []);
  const adopted = nodes.get(fixture.db, fixture.userId, rootId);
  t.is(adopted?.status, "complete");
  t.is(adopted?.completedAt, 1_700_000_000_000);
});

test("deletes child subtree while disallowing root node deletion", (t) => {
  const fixture = createFixture(t);
  const detail = completedRoot(fixture);
  const child = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: detail.tree.rootNodeId,
    prompt: "Child",
  });
  nodes.setStatus(fixture.db, fixture.userId, child.id, "complete");
  const grandchild = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: child.id,
    prompt: "Grandchild",
  });
  nodes.setStatus(fixture.db, fixture.userId, grandchild.id, "cancelled");
  t.throws(() => nodes.removeBranch(fixture.db, fixture.userId, detail.tree.rootNodeId), {
    message: /delete the entire research thread/,
  });
  const removal = nodes.removeBranch(fixture.db, fixture.userId, child.id);
  t.is(removal.parentNodeId, detail.tree.rootNodeId);
  t.deepEqual([...removal.removedNodeIds].sort(), [child.id, grandchild.id].sort());
  t.is(trees.detail(fixture.db, fixture.userId, detail.tree.id).nodes.length, 1);
});

test("nodes of another account are invisible", (t) => {
  const fixture = createFixture(t);
  const detail = completedRoot(fixture);
  t.is(nodes.get(fixture.db, "someone-else", detail.tree.rootNodeId), null);
  t.throws(() => nodes.setStatus(fixture.db, "someone-else", detail.tree.rootNodeId, "cancelled"), {
    message: /was not found/,
  });
});

test("a boot re-queue with no queue row records the model's provider", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running");
  nodes.markInterrupted(fixture.db, fixture.userId, rootId);
  t.deepEqual(nodes.reconcileOnBoot(fixture.db).requeuedNodeIds, [rootId]);
  const row = fixture.db.$client
    .prepare(`SELECT provider, enqueued_at FROM run_queue WHERE node_id = ?`)
    .get(rootId) as { provider: string; enqueued_at: number };
  t.is(row.provider, "vertex", "the per-provider cap keys on the provider, not the model id");
  t.is(row.enqueued_at, 0, "a resume goes to the head of the queue");
});

test("halts automatic re-enqueuing once retry attempt limit is reached", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running");
  nodes.markInterrupted(fixture.db, fixture.userId, rootId);
  t.deepEqual(nodes.reconcileOnBoot(fixture.db).requeuedNodeIds, [rootId]);

  nodes.clearResumePending(fixture.db, fixture.userId, rootId);
  t.is(
    fixture.db.$client.prepare(`SELECT 1 FROM run_queue WHERE node_id = ?`).get(rootId),
    undefined,
    "the queue row goes with the flag",
  );
  t.is(
    nodes.get(fixture.db, fixture.userId, rootId)?.status,
    "interrupted",
    "the node keeps its status and its partial output for Retry",
  );
  t.deepEqual(nodes.reconcileOnBoot(fixture.db).requeuedNodeIds, [], "no later boot re-queues it");
});

test("creates a new attempt record on rate-limited re-enqueue to preserve prior attempt history", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running");
  runs.startAttempt(fixture.db, {
    nodeId: rootId,
    attempt: 1,
    kind: "fresh",
    model: "gemini-flash",
  });
  runs.finishAttempt(fixture.db, { nodeId: rootId, attempt: 1, outcome: "rate_limited" });
  runs.commitTurn(fixture.db, fixture.userId, {
    nodeId: rootId,
    turn: answerTurn(rootId, "a partial the retry will not reuse", "turn-1"),
  });
  const seqOf = (): number =>
    (
      fixture.db.$client.prepare(`SELECT run_seq FROM nodes WHERE id = ?`).get(rootId) as {
        run_seq: number;
      }
    ).run_seq;
  const before = seqOf();

  const requeued = nodes.requeueAfterRateLimit(fixture.db, fixture.userId, rootId);
  t.is(requeued.status, "queued");
  t.is(requeued.attempt, 2);
  t.is(requeued.startedAt ?? null, null, "the new attempt has not started");

  // The next attempt writes under attempt 2, so the throttled row is still
  // there to count the backoff from after a restart.
  runs.startAttempt(fixture.db, {
    nodeId: rootId,
    attempt: 2,
    kind: "fresh",
    model: "gemini-flash",
  });
  t.deepEqual(
    runs.listAttempts(fixture.db, rootId).map((attempt) => attempt.outcome),
    ["rate_limited", null],
  );
  t.deepEqual(runs.liveWindow(fixture.db, fixture.userId, rootId).turns, []);
  t.true(seqOf() > before, "the sequence counter moves forward rather than rewinding");

  nodes.setStatus(fixture.db, fixture.userId, rootId, "cancelled");
  t.throws(() => nodes.requeueAfterRateLimit(fixture.db, fixture.userId, rootId), {
    message: /already finished as cancelled/,
  });
});

test("re-enqueues queued nodes missing queue table records during startup reconciliation", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const rootId = detail.tree.rootNodeId;
  // The node row and its queue row are separate transactions under
  // `synchronous = NORMAL` (`routers/research.ts`: `createTree` then
  // `enqueueRun`), so a crash between them leaves the node `queued` with
  // nothing to admit it. The claim loop reads the queue, so it waits forever,
  // and Retry is offered only on failed, cancelled and interrupted — there is
  // no way out of it from the client at all.
  t.is(queue.position(fixture.db, fixture.userId, rootId), 0, "nothing is waiting for it");

  const result = nodes.reconcileOnBoot(fixture.db);
  t.deepEqual(result.reenqueuedNodeIds, [rootId]);
  t.deepEqual(result.requeuedNodeIds, [], "it is not a resume");
  t.is(nodes.get(fixture.db, fixture.userId, rootId)?.status, "queued");
  t.is(queue.position(fixture.db, fixture.userId, rootId), 1, "it is in the queue now");

  // Idempotent: a second boot leaves it alone rather than re-enqueueing it.
  t.deepEqual(nodes.reconcileOnBoot(fixture.db).reenqueuedNodeIds, []);
});

test("marks imported document as failed if markdown content was not saved", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "An import",
    model: "gemini-flash",
    kind: "document",
    origin: "imported",
    status: "complete",
  });
  const rootId = detail.tree.rootNodeId;
  // `importReport` writes the row `complete` and the snapshot after it. A
  // crash in between leaves a document that reads as "this research produced
  // no readable response" and that `updateDocument` and `retryNode` both
  // refuse — permanently unreadable and unrepairable.
  const result = nodes.reconcileOnBoot(fixture.db);
  t.deepEqual(result.emptyDocumentNodeIds, [rootId]);
  const failed = nodes.get(fixture.db, fixture.userId, rootId);
  t.is(failed?.status, "failed");
  t.regex(failed?.error ?? "", /import it again/);

  // A document that does have its markdown is untouched.
  const good = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "A complete import",
    model: "gemini-flash",
    kind: "document",
    origin: "imported",
    status: "complete",
  });
  snapshots.commit(fixture.db, fixture.userId, {
    nodeId: good.tree.rootNodeId,
    turns: [answerTurn(good.tree.rootNodeId, "# A report")],
    outcome: { status: "complete" },
  });
  t.deepEqual(nodes.reconcileOnBoot(fixture.db).emptyDocumentNodeIds, []);
  t.is(nodes.get(fixture.db, fixture.userId, good.tree.rootNodeId)?.status, "complete");
});
