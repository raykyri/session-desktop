// Stopping runs whose asker can no longer read the thread, and a boot that
// one bad row cannot stop.

import test from "ava";

import { followups, nodes, queue, sharing, snapshots, trees } from "../src/index.js";

import { answerTurn, createFixture, runOf, sharedThreadFixture } from "./helpers.js";

const AGENT = { model: "gemini-flash" };

function queueRow(db: ReturnType<typeof createFixture>["db"], nodeId: string): unknown {
  return db.$client.prepare("SELECT node_id FROM run_queue WHERE node_id = ?").get(nodeId);
}

/** A member's question in a shared thread, running, then interrupted by a
 * shutdown with a resume pending. */
function interruptedMemberQuestion(t: Parameters<typeof sharedThreadFixture>[0]) {
  const shared = sharedThreadFixture(t);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) throw new Error("the fixture has no member");
  const sent = followups.ask(db, member.userId, {
    headNodeId: shared.rootId,
    message: { text: "And a cuckoo filter?" },
    agent: AGENT,
  });
  if (sent.kind !== "sent") throw new Error("the follow-up was queued");
  nodes.setStatus(db, member.userId, sent.node.id, "running");
  nodes.markInterrupted(db, member.userId, sent.node.id);
  return { shared, member, nodeId: sent.node.id };
}

test("stopRun ends an interrupted run with its resume and queue row", (t) => {
  const { shared, member, nodeId } = interruptedMemberQuestion(t);
  const { db } = shared.fixture;
  t.truthy(queueRow(db, nodeId));
  // `setStatus` refuses interrupted → cancelled; stopRun is the way out.
  t.throws(() => nodes.setStatus(db, member.userId, nodeId, "cancelled"));
  const stopped = nodes.stopRun(db, nodeId, nodes.ASKER_GONE_ERROR);
  t.is(runOf(stopped).status, "cancelled");
  t.is(runOf(stopped).error, nodes.ASKER_GONE_ERROR);
  t.false(runOf(stopped).resumePending === true);
  t.is(queueRow(db, nodeId), undefined);
  // Settled now: nothing to stop.
  t.is(nodes.stopRun(db, nodeId), null);
  t.is(nodes.stopRun(db, shared.rootId), null, "a complete answer is not stopped");
});

test("leaving lists an interrupted question among the runs to stop", (t) => {
  const { shared, member, nodeId } = interruptedMemberQuestion(t);
  const departure = sharing.leave(shared.fixture.db, member.userId, shared.treeId);
  t.deepEqual(departure.activeNodeIds, [nodeId]);
});

test("restart with an interrupted run in a shared thread after a member left", (t) => {
  const { shared, member, nodeId } = interruptedMemberQuestion(t);
  const { db } = shared.fixture;
  // The member left, and the process stopped before it stopped their run.
  sharing.leave(db, member.userId, shared.treeId);
  db.$client.prepare("DELETE FROM run_queue WHERE node_id = ?").run(nodeId);

  // The owner's own interrupted question resumes as usual.
  const own = nodes.admitChild(db, shared.fixture.userId, {
    parentNodeId: shared.rootId,
    message: { text: "The owner's branch" },
  });
  nodes.setStatus(db, shared.fixture.userId, own.id, "running");
  nodes.markInterrupted(db, shared.fixture.userId, own.id);

  const result = nodes.reconcileOnBoot(db);
  t.deepEqual(result.stoppedNodeIds, [nodeId]);
  t.deepEqual(result.requeuedNodeIds, [own.id]);
  t.deepEqual(result.failures, []);
  const stopped = nodes.get(db, shared.fixture.userId, nodeId);
  t.is(runOf(stopped).status, "cancelled");
  t.is(runOf(stopped).error, nodes.ASKER_GONE_ERROR);
  t.is(queueRow(db, nodeId), undefined);
  // A second boot has nothing left to do for it.
  t.deepEqual(nodes.reconcileOnBoot(db).stoppedNodeIds, []);
  t.is(queue.position(db, null, own.id), 1);
});

test("one node that cannot be reconciled does not stop the boot", (t) => {
  const fixture = createFixture(t);
  const admit = (text: string) =>
    trees.admitRoot(fixture.db, fixture.userId, {
      type: "exchange",
      workspaceId: fixture.workspaceId,
      message: { text },
      agent: AGENT,
    }).tree.rootNodeId;
  const broken = admit("Broken");
  const healthy = admit("Healthy");
  for (const nodeId of [broken, healthy]) {
    nodes.setStatus(fixture.db, fixture.userId, nodeId, "running");
  }
  snapshots.commit(fixture.db, fixture.userId, {
    nodeId: broken,
    turns: [answerTurn(broken, "Partial.")],
    outcome: { status: "complete" },
  });
  fixture.db.$client
    .prepare("UPDATE response_snapshots SET outcome_json = ? WHERE node_id = ?")
    .run(JSON.stringify({ status: 42 }), broken);
  // As a crash between the snapshot and the node row would leave it.
  fixture.db.$client.prepare("UPDATE nodes SET status = 'running' WHERE id = ?").run(broken);

  const result = nodes.reconcileOnBoot(fixture.db);
  t.deepEqual(
    result.failures.map((failure) => failure.nodeId),
    [broken],
  );
  t.deepEqual(result.interruptedNodeIds, [healthy]);
  t.deepEqual(result.requeuedNodeIds, [healthy]);
  t.is(runOf(nodes.get(fixture.db, fixture.userId, broken)).status, "running", "left as it was");
});
