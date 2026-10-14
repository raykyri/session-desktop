// Rerun, chain order, edited questions, and when an interrupted node can be
// removed (`docs/02-domain-model-and-database.md` §5.3, §5.4).

import { nodeEffort, nodeModelId } from "@session/shared";
import { nodeRecap } from "@session/shared/lib/researchNodeTypes";
import test from "ava";

import { highlights, nodes, queue, recaps, snapshots, trees } from "../src/index.js";

import { anchorFor, answerTurn, createFixture, runOf } from "./helpers.js";

type Fixture = ReturnType<typeof createFixture>;

/** Runs a queued exchange to a committed answer. */
function answer(fixture: Fixture, nodeId: string, text = "The answer about bloom filters.") {
  nodes.setStatus(fixture.db, fixture.userId, nodeId, "running");
  return snapshots.commit(fixture.db, fixture.userId, {
    nodeId,
    turns: [answerTurn(nodeId, text)],
    outcome: { status: "complete" },
  });
}

function root(fixture: Fixture) {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Root question" },
    agent: { model: "gemini-flash", effort: "high" },
  });
  return detail.tree;
}

function inlineChild(fixture: Fixture, parentNodeId: string, text: string) {
  return nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId,
    message: { text },
    inline: true,
  });
}

test("rerun replaces a complete answer and keeps its highlights", (t) => {
  const fixture = createFixture(t);
  const tree = root(fixture);
  const committed = answer(fixture, tree.rootNodeId);
  const highlight = highlights.create(
    fixture.db,
    fixture.userId,
    tree.rootNodeId,
    anchorFor(committed.revision, "bloom filters", 17),
  );
  recaps.save(fixture.db, fixture.userId, {
    nodeId: tree.rootNodeId,
    text: "A recap.",
    responseRevision: committed.revision,
    model: "gemini-flash",
    expectedSnapshotAt: committed.responseSnapshotAt,
    expectedCurrentRecapId: null,
  });
  t.truthy(nodeRecap(nodes.get(fixture.db, fixture.userId, tree.rootNodeId)!));

  const rerun = nodes.resetForRerun(fixture.db, fixture.userId, tree.rootNodeId);
  t.is(runOf(rerun).status, "queued");
  t.is(runOf(rerun).attempt, 2);
  t.is(runOf(rerun).responseSnapshotAt, null);
  t.is(nodeRecap(rerun), null);
  t.is(snapshots.read(fixture.db, fixture.userId, tree.rootNodeId), null);
  t.deepEqual(
    rerun.highlights.map((entry) => entry.id),
    [highlight.id],
    "highlights stay and re-anchor by quote on the client",
  );
  t.is(queue.position(fixture.db, fixture.userId, tree.rootNodeId), 1);
  t.is(nodeEffort(rerun), "high", "the agent is unchanged");

  t.throws(() => nodes.resetForRerun(fixture.db, fixture.userId, tree.rootNodeId), {
    message: "A queued or running question cannot be rerun.",
  });
});

test("rerun needs a complete parent unless it is an inline follow-up behind an active one", (t) => {
  const fixture = createFixture(t);
  const tree = root(fixture);
  answer(fixture, tree.rootNodeId);
  const inline = inlineChild(fixture, tree.rootNodeId, "Inline");
  answer(fixture, inline.id);
  const branch = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "Branch" },
  });
  answer(fixture, branch.id);

  // The parent is rerun: the inline follow-up may be rerun behind it, a
  // branch may not.
  nodes.resetForRerun(fixture.db, fixture.userId, tree.rootNodeId);
  t.throws(() => nodes.resetForRerun(fixture.db, fixture.userId, branch.id), {
    message: "Wait for the answer this question follows to finish.",
  });
  t.is(runOf(nodes.resetForRerun(fixture.db, fixture.userId, inline.id)).status, "queued");

  // A parent that settled without an answer anchors nothing.
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "failed", { error: "boom" });
  t.throws(() => nodes.resetForRerun(fixture.db, fixture.userId, branch.id), {
    message: "The answer this question follows did not complete.",
  });
});

test("rerun refuses posts, archived threads, and a pending resume", (t) => {
  const fixture = createFixture(t);
  const tree = root(fixture);
  nodes.setStatus(fixture.db, fixture.userId, tree.rootNodeId, "running");
  nodes.markInterrupted(fixture.db, fixture.userId, tree.rootNodeId);
  t.throws(() => nodes.resetForRerun(fixture.db, fixture.userId, tree.rootNodeId), {
    message: "A queued or running question cannot be rerun.",
  });
  nodes.clearResumePending(fixture.db, fixture.userId, tree.rootNodeId);
  t.is(runOf(nodes.resetForRerun(fixture.db, fixture.userId, tree.rootNodeId)).status, "queued");

  const post = trees.admitRoot(fixture.db, fixture.userId, {
    type: "post",
    workspaceId: fixture.workspaceId,
    message: { text: "A note" },
    agent: { model: "gemini-flash" },
  });
  t.throws(() => nodes.resetForRerun(fixture.db, fixture.userId, post.tree.rootNodeId), {
    message: "Only questions answered by an agent can be rerun.",
  });

  const archived = root(fixture);
  answer(fixture, archived.rootNodeId);
  trees.archive(fixture.db, fixture.userId, archived.id);
  t.throws(() => nodes.resetForRerun(fixture.db, fixture.userId, archived.rootNodeId), {
    message: "Restore archived research before rerunning a question.",
  });
});

test("chain order must list exactly the chain and is stored on its head", (t) => {
  const fixture = createFixture(t);
  const tree = root(fixture);
  answer(fixture, tree.rootNodeId);
  const second = inlineChild(fixture, tree.rootNodeId, "Second");
  answer(fixture, second.id);
  const third = inlineChild(fixture, second.id, "Third");
  const branch = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "Branch" },
  });

  const order = [third.id, tree.rootNodeId, second.id];
  const stored = nodes.setChainOrder(fixture.db, fixture.userId, tree.rootNodeId, order);
  t.true(stored.changed);
  t.deepEqual(stored.node.chainOrder, order);
  t.false(nodes.setChainOrder(fixture.db, fixture.userId, tree.rootNodeId, order).changed);

  const stale = "The conversation changed; refresh before reordering its messages.";
  t.throws(
    () => nodes.setChainOrder(fixture.db, fixture.userId, tree.rootNodeId, [tree.rootNodeId]),
    { message: stale },
  );
  t.throws(
    () =>
      nodes.setChainOrder(fixture.db, fixture.userId, tree.rootNodeId, [
        tree.rootNodeId,
        second.id,
        second.id,
      ]),
    { message: stale },
  );
  t.throws(
    () =>
      nodes.setChainOrder(fixture.db, fixture.userId, tree.rootNodeId, [
        tree.rootNodeId,
        second.id,
        branch.id,
      ]),
    { message: stale },
  );
  t.throws(() => nodes.setChainOrder(fixture.db, fixture.userId, second.id, [second.id]), {
    message: `Research node ${second.id} does not start a conversation.`,
  });
  // A branch heads its own chain.
  t.true(nodes.setChainOrder(fixture.db, fixture.userId, branch.id, [branch.id]).changed);

  trees.archive(fixture.db, fixture.userId, tree.id);
  t.throws(() => nodes.setChainOrder(fixture.db, fixture.userId, tree.rootNodeId, order), {
    message: "Restore archived research before reordering it.",
  });
});

test("an edited question replaces a failed one in its slot and its place in the order", (t) => {
  const fixture = createFixture(t);
  const tree = root(fixture);
  answer(fixture, tree.rootNodeId);
  const failed = inlineChild(fixture, tree.rootNodeId, "Typo questoin");
  nodes.setStatus(fixture.db, fixture.userId, failed.id, "failed", { error: "boom" });
  nodes.setChainOrder(fixture.db, fixture.userId, tree.rootNodeId, [failed.id, tree.rootNodeId]);

  const admitted = nodes.admitChildDetailed(fixture.db, fixture.userId, {
    parentNodeId: tree.rootNodeId,
    message: { text: "Typo question" },
    inline: true,
    replacesNodeId: failed.id,
    agent: { model: "deepseek-flash", effort: "low" },
  });
  t.is(admitted.replacedNodeId, failed.id);
  t.true(admitted.node.inline);
  t.is(nodeModelId(admitted.node), "deepseek-flash");
  t.is(nodeEffort(admitted.node), "low");
  t.deepEqual(admitted.reorderedHead?.chainOrder, [admitted.node.id, tree.rootNodeId]);
  t.is(nodes.get(fixture.db, fixture.userId, failed.id), null);

  // A complete answer, or one with follow-ups, is not replaceable; the
  // refusal keeps it.
  answer(fixture, admitted.node.id);
  t.throws(
    () =>
      nodes.admitChildDetailed(fixture.db, fixture.userId, {
        parentNodeId: tree.rootNodeId,
        message: { text: "Again" },
        inline: true,
        replacesNodeId: admitted.node.id,
      }),
    { message: "Only a failed or stopped question with no follow-ups can be edited." },
  );
  t.truthy(nodes.get(fixture.db, fixture.userId, admitted.node.id));
});

test("an interrupted node is removable once its resume is no longer pending", (t) => {
  const fixture = createFixture(t);
  const tree = root(fixture);
  answer(fixture, tree.rootNodeId);
  const child = inlineChild(fixture, tree.rootNodeId, "Interrupted");
  nodes.setStatus(fixture.db, fixture.userId, child.id, "running");
  const interrupted = nodes.markInterrupted(fixture.db, fixture.userId, child.id);
  t.true(runOf(interrupted).resumePending);
  t.throws(() => nodes.removeBranch(fixture.db, fixture.userId, child.id), {
    message: /active run/,
  });
  t.throws(() => trees.remove(fixture.db, fixture.userId, tree.id), { message: /active run/ });

  nodes.clearResumePending(fixture.db, fixture.userId, child.id);
  t.false(runOf(nodes.get(fixture.db, fixture.userId, child.id)).resumePending);
  t.deepEqual(nodes.removeBranch(fixture.db, fixture.userId, child.id).removedNodeIds, [child.id]);
  trees.remove(fixture.db, fixture.userId, tree.id);
  t.is(trees.get(fixture.db, fixture.userId, tree.id), null);
});
