import { nodeModelId } from "@session/shared";
import test from "ava";

import { followups, nodes, queue, tableRowCount, trees } from "../src/index.js";

import { createFixture, runOf } from "./helpers.js";

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
