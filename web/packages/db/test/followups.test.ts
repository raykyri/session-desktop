import { nodeModelId } from "@session/shared";
import test from "ava";

import { followups, nodes, queue, tableRowCount, trees } from "../src/index.js";

import { addUser, createFixture, runOf } from "./helpers.js";

type Fixture = ReturnType<typeof createFixture>;

/** A thread whose root is still running. */
function runningRoot(fixture: Fixture) {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Root question" },
    agent: { model: "gemini-flash" },
  });
  nodes.setStatus(fixture.db, fixture.userId, detail.tree.rootNodeId, "running");
  return detail.tree;
}

function ask(fixture: Fixture, headNodeId: string, text: string, model = "gemini-flash") {
  return followups.ask(fixture.db, fixture.userId, {
    headNodeId,
    message: { text },
    agent: { model },
  });
}

test("ask queues behind a running answer and sends at once when the chain is free", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);

  const first = ask(fixture, tree.rootNodeId, "First follow-up");
  t.is(first.kind, "queued");
  const second = ask(fixture, tree.rootNodeId, "Second follow-up", "deepseek-flash");
  t.is(second.kind, "queued");
  const queues = followups.listForTree(fixture.db, fixture.userId, tree.id);
  t.deepEqual(
    queues[tree.rootNodeId]?.map((item) => [item.message.text, item.agent.model, item.position]),
    [
      ["First follow-up", "gemini-flash", 0],
      ["Second follow-up", "deepseek-flash", 1],
    ],
  );
  t.deepEqual(followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId), { kind: "wait" });

  // Once the answer completes the first item can go, as the tail's inline child.
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "complete");
  const step = followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId);
  if (step.kind !== "send") {
    t.fail(`expected a send, got ${step.kind}`);
    return;
  }
  t.is(step.tailId, tree.rootNodeId);
  t.is(step.item.message.text, "First follow-up");
  const sent = followups.send(fixture.db, fixture.userId, step.item.id, step.tailId);
  t.true(sent.node.inline);
  t.is(sent.node.parentNodeId, tree.rootNodeId);
  t.is(runOf(sent.node).status, "queued");
  t.is(queue.position(fixture.db, fixture.userId, sent.node.id), 1, "the run is in the run queue");
  t.deepEqual(
    followups.listForHead(fixture.db, fixture.userId, tree.rootNodeId).map((item) => item.position),
    [1],
  );

  // The second waits for the first's answer, then continues the chain from it.
  t.deepEqual(followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId), { kind: "wait" });
  nodes.setStatus(fixture.db, fixture.userId, sent.node.id, "running");
  nodes.setStatus(fixture.db, fixture.userId, sent.node.id, "complete");
  const next = followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId);
  t.is(next.kind, "send");
  if (next.kind === "send") {
    t.is(next.tailId, sent.node.id);
    const second = followups.send(fixture.db, fixture.userId, next.item.id, next.tailId);
    t.is(nodeModelId(second.node), "deepseek-flash");
    t.is(second.node.parentNodeId, sent.node.id);
  }
  t.deepEqual(followups.listForTree(fixture.db, fixture.userId, tree.id), {});

  // With nothing queued and a complete tail, asking sends at once.
  const tail = followups.listForHead(fixture.db, fixture.userId, tree.rootNodeId);
  t.deepEqual(tail, []);
});

test("ask sends at once when nothing is queued and the tail is complete", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "complete");
  const result = ask(fixture, tree.rootNodeId, "Now");
  if (result.kind !== "sent") {
    t.fail("expected the follow-up to be sent");
    return;
  }
  t.true(result.node.inline);
  t.is(result.headNodeId, tree.rootNodeId);
  // Asking from any node of the chain keeps the queue under its head.
  const queued = ask(fixture, result.node.id, "Later");
  t.is(queued.kind, "queued");
  t.is(queued.headNodeId, tree.rootNodeId);
});

test("a send refused once waits on its item until it is retried or cancelled", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  const first = ask(fixture, tree.rootNodeId, "Refused");
  const second = ask(fixture, tree.rootNodeId, "Behind it");
  if (first.kind !== "queued" || second.kind !== "queued") {
    t.fail("expected both to be queued");
    return;
  }
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "complete");
  const failed = followups.markFailed(fixture.db, first.item.id, "daily limit");
  t.is(failed.failedReason, "daily limit");
  t.deepEqual(followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId), { kind: "wait" });
  t.throws(() => followups.send(fixture.db, fixture.userId, first.item.id, tree.rootNodeId), {
    message: /The conversation changed/,
  });

  const retried = followups.retry(fixture.db, fixture.userId, first.item.id);
  t.is(retried.failedReason, null);
  t.is(followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId).kind, "send");

  followups.markFailed(fixture.db, first.item.id, "daily limit");
  followups.cancel(fixture.db, fixture.userId, first.item.id);
  const step = followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId);
  t.is(step.kind === "send" ? step.item.id : null, second.item.id, "the next item moves up");
});

test("queues skip archived threads, refuse foreign accounts, and go with their head", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  const item = ask(fixture, tree.rootNodeId, "Waiting");
  if (item.kind !== "queued") {
    t.fail("expected a queued item");
    return;
  }
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "complete");
  t.is(followups.pendingChains(fixture.db).length, 1);
  trees.archive(fixture.db, fixture.userId, tree.id);
  t.deepEqual(followups.pendingChains(fixture.db), []);
  t.deepEqual(followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId), { kind: "wait" });
  t.throws(() => ask(fixture, tree.rootNodeId, "Archived"), {
    message: /Cannot create follow-up on archived research/,
  });
  trees.restore(fixture.db, fixture.userId, tree.id);
  t.deepEqual(followups.pendingChains(fixture.db, { treeId: tree.id }), [
    { headNodeId: tree.rootNodeId, treeId: tree.id, ownerId: fixture.userId },
  ]);

  t.throws(() => followups.cancel(fixture.db, "someone-else", item.item.id), {
    message: /was not found$/,
  });
  t.deepEqual(followups.listForHead(fixture.db, "someone-else", tree.rootNodeId), []);

  trees.remove(fixture.db, fixture.userId, tree.id);
  t.is(tableRowCount(fixture.db, "followup_queue"), 0);
});

test("the queue's own bound refuses queueing, not sending", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  followups.ask(fixture.db, fixture.userId, {
    headNodeId: tree.rootNodeId,
    message: { text: "One" },
    agent: { model: "gemini-flash" },
    maxQueued: 1,
  });
  t.throws(
    () =>
      followups.ask(fixture.db, fixture.userId, {
        headNodeId: tree.rootNodeId,
        message: { text: "Two" },
        agent: { model: "gemini-flash" },
        maxQueued: 1,
      }),
    { message: /follow-ups queued\. Wait/ },
  );
});

test("a failed tail stalls its queue until it is removed", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "complete");
  const sent = ask(fixture, tree.rootNodeId, "Will fail");
  if (sent.kind !== "sent") {
    t.fail("expected a send");
    return;
  }
  ask(fixture, tree.rootNodeId, "Behind the failure");
  nodes.setStatus(fixture.db, fixture.userId, sent.node.id, "failed", { error: "boom" });
  t.deepEqual(followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId), { kind: "wait" });
  nodes.removeBranch(fixture.db, fixture.userId, sent.node.id);
  const step = followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId);
  t.is(step.kind === "send" ? step.tailId : null, tree.rootNodeId);
});

test("asking behind an answer that stopped is refused with the desktop's words", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "failed", { error: "boom" });
  t.throws(() => ask(fixture, tree.rootNodeId, "After the failure"), {
    message: followups.STALLED_TAIL_MESSAGES.failed,
  });
  const stopped = runningRoot(fixture);
  nodes.setStatus(fixture.db, fixture.userId, stopped.rootNodeId, "cancelled");
  t.throws(() => ask(fixture, stopped.rootNodeId, "After the stop"), {
    message: followups.STALLED_TAIL_MESSAGES.stopped,
  });
  // Web only: an interrupted answer waits while the server will resume it,
  // and stalls once it will not.
  const interrupted = runningRoot(fixture);
  const setResume = fixture.db.$client.prepare(
    "UPDATE nodes SET status = 'interrupted', resume_pending = ? WHERE id = ?",
  );
  setResume.run(0, interrupted.rootNodeId);
  t.throws(() => ask(fixture, interrupted.rootNodeId, "After the interruption"), {
    message: followups.STALLED_TAIL_MESSAGES.failed,
  });
  t.is(tableRowCount(fixture.db, "followup_queue"), 0, "nothing was queued");
  setResume.run(1, interrupted.rootNodeId);
  t.is(ask(fixture, interrupted.rootNodeId, "While it resumes").kind, "queued");
});

test("asking behind a queue whose tail then stopped still queues, as on the desktop", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  t.is(ask(fixture, tree.rootNodeId, "First").kind, "queued");
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "failed", { error: "boom" });
  t.is(ask(fixture, tree.rootNodeId, "Second").kind, "queued");
});

test("an edited branch question takes the queue behind it and says so", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "complete");
  const branch = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "A branch" },
  });
  nodes.setStatus(fixture.db, fixture.userId, branch.id, "running");
  t.is(ask(fixture, branch.id, "Queued behind the branch").kind, "queued");
  nodes.setStatus(fixture.db, fixture.userId, branch.id, "failed", { error: "boom" });
  const edited = nodes.admitChildDetailed(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "The branch, edited" },
    replacesNodeId: branch.id,
  });
  t.true(edited.movedQueue);
  t.deepEqual(
    followups
      .listForHead(fixture.db, fixture.userId, edited.node.id)
      .map((item) => item.message.text),
    ["Queued behind the branch"],
  );
  const plain = nodes.admitChildDetailed(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "Another branch" },
  });
  t.false(plain.movedQueue);
});

test("the queue reads one chain's nodes, not the whole thread", (t) => {
  const fixture = createFixture(t);
  const tree = runningRoot(fixture);
  const complete = (nodeId: string) => {
    nodes.setStatus(fixture.db, fixture.userId, nodeId, "running");
    nodes.setStatus(fixture.db, fixture.userId, nodeId, "complete");
  };
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "complete");
  const first = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "First follow-up" },
    inline: true,
  });
  complete(first.id);
  const second = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: first.id,
    message: { text: "Second follow-up" },
    inline: true,
  });
  // Elsewhere in the thread: a branch under the first follow-up, with its
  // own inline chain, which the root's chain does not include.
  const branch = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: first.id,
    message: { text: "A branch" },
  });
  complete(branch.id);
  const branchFollowUp = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: branch.id,
    message: { text: "The branch's follow-up" },
    inline: true,
  });

  const ids = (list: { id: string }[]) => list.map((node) => node.id);
  const workspaceId = fixture.workspaceId;
  t.deepEqual(ids(nodes.chainNodes(fixture.db, second.id, workspaceId)), [
    tree.rootNodeId,
    first.id,
    second.id,
  ]);
  t.deepEqual(ids(nodes.chainNodes(fixture.db, tree.rootNodeId, workspaceId)), [
    tree.rootNodeId,
    first.id,
    second.id,
  ]);
  t.deepEqual(ids(nodes.chainNodes(fixture.db, branchFollowUp.id, workspaceId)), [
    branch.id,
    branchFollowUp.id,
  ]);
  t.deepEqual(nodes.chainNodes(fixture.db, "missing", workspaceId), []);

  t.is(followups.chainTail(fixture.db, fixture.userId, tree.rootNodeId)?.id, second.id);
  t.is(followups.chainTail(fixture.db, fixture.userId, branch.id)?.id, branchFollowUp.id);
  const stranger = addUser(fixture.db, "chain-stranger");
  t.is(followups.chainTail(fixture.db, stranger.userId, tree.rootNodeId), null);

  // The decisions are the same as over the whole thread: the root's chain
  // waits on its running tail, and sends once it completes.
  t.is(ask(fixture, tree.rootNodeId, "Third").kind, "queued");
  t.deepEqual(followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId), { kind: "wait" });
  complete(second.id);
  const step = followups.nextStep(fixture.db, fixture.userId, tree.rootNodeId);
  t.is(step.kind, "send");
  if (step.kind === "send") t.is(step.tailId, second.id);
});
