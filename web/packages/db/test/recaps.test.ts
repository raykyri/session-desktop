import test from "ava";

import { nodes, recaps, snapshots, trees } from "../src/index.js";

import { answerTurn, createFixture } from "./helpers.js";

function answered(fixture: ReturnType<typeof createFixture>) {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
  });
  const nodeId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, nodeId, "running");
  const committed = snapshots.commit(fixture.db, fixture.userId, {
    nodeId,
    turns: [answerTurn(nodeId, "A long answer about birdsong.")],
    outcome: { status: "complete" },
  });
  const node = nodes.get(fixture.db, fixture.userId, nodeId);
  return {
    treeId: detail.tree.id,
    nodeId,
    revision: committed.revision,
    snapshotAt: node?.responseSnapshotAt ?? null,
  };
}

test("an automatic recap commits only against the answer it summarized", (t) => {
  const fixture = createFixture(t);
  const target = answered(fixture);
  const saved = recaps.save(fixture.db, fixture.userId, {
    nodeId: target.nodeId,
    text: "Summary: birds sing at dawn.",
    responseRevision: target.revision,
    model: "gemini-flash",
    expectedSnapshotAt: target.snapshotAt,
  });
  t.is(saved?.recap?.text, "birds sing at dawn.", "the Summary: label is stripped");
  t.is(saved?.recap?.responseRevision, target.revision);
});

test("a stale recap is a no-op rather than an error", (t) => {
  const fixture = createFixture(t);
  const target = answered(fixture);
  t.is(
    recaps.save(fixture.db, fixture.userId, {
      nodeId: target.nodeId,
      text: "Some summary.",
      responseRevision: "0".repeat(64),
      model: "gemini-flash",
      expectedSnapshotAt: target.snapshotAt,
    }),
    null,
    "a revision that is no longer the answer's",
  );
  t.is(
    recaps.save(fixture.db, fixture.userId, {
      nodeId: target.nodeId,
      text: "Some summary.",
      responseRevision: target.revision,
      model: "gemini-flash",
      expectedSnapshotAt: (target.snapshotAt ?? 0) - 1,
    }),
    null,
    "a snapshot timestamp that moved",
  );
  t.is(
    recaps.save(fixture.db, fixture.userId, {
      nodeId: target.nodeId,
      text: "   ",
      responseRevision: target.revision,
      model: "gemini-flash",
      expectedSnapshotAt: target.snapshotAt,
    }),
    null,
    "an empty summary",
  );
  t.is(nodes.get(fixture.db, fixture.userId, target.nodeId)?.recap, undefined);
});

test("a recap over the length cap is rejected", (t) => {
  const fixture = createFixture(t);
  const target = answered(fixture);
  t.is(
    recaps.save(fixture.db, fixture.userId, {
      nodeId: target.nodeId,
      text: "x".repeat(1201),
      responseRevision: target.revision,
      model: "gemini-flash",
      expectedSnapshotAt: target.snapshotAt,
    }),
    null,
  );
});

test("applying a previewed recap checks the recap identity and the answer", (t) => {
  const fixture = createFixture(t);
  const target = answered(fixture);
  const candidate = {
    id: "candidate-1",
    text: "A user-directed summary.",
    responseRevision: target.revision,
    generatedAt: Date.now(),
    model: "gemini-flash",
    instructions: "Focus on the mechanism.",
  };
  t.throws(
    () =>
      recaps.applyCandidate(fixture.db, fixture.userId, {
        nodeId: target.nodeId,
        expectedResponseRevision: target.revision,
        expectedCurrentRecapId: "something-else",
        candidate,
      }),
    { message: /summary changed while the preview was open/ },
  );
  t.throws(
    () =>
      recaps.applyCandidate(fixture.db, fixture.userId, {
        nodeId: target.nodeId,
        expectedResponseRevision: "0".repeat(64),
        candidate,
      }),
    { message: /belongs to a different answer/ },
  );
  t.throws(
    () =>
      recaps.applyCandidate(fixture.db, fixture.userId, {
        nodeId: target.nodeId,
        expectedResponseRevision: target.revision,
        candidate: { ...candidate, instructions: "   " },
      }),
    { message: /instructions cannot be empty/ },
  );

  const applied = recaps.applyCandidate(fixture.db, fixture.userId, {
    nodeId: target.nodeId,
    expectedResponseRevision: target.revision,
    candidate,
  });
  t.is(applied.recap?.id, "candidate-1");
  t.is(applied.recap?.instructions, "Focus on the mechanism.");

  // The next apply has to name the recap it is replacing.
  t.throws(
    () =>
      recaps.applyCandidate(fixture.db, fixture.userId, {
        nodeId: target.nodeId,
        expectedResponseRevision: target.revision,
        candidate: { ...candidate, id: "candidate-2" },
      }),
    { message: /summary changed while the preview was open/ },
  );
});

test("an archived thread refuses a recap replacement", (t) => {
  const fixture = createFixture(t);
  const target = answered(fixture);
  trees.archive(fixture.db, fixture.userId, target.treeId);
  t.throws(
    () =>
      recaps.applyCandidate(fixture.db, fixture.userId, {
        nodeId: target.nodeId,
        expectedResponseRevision: target.revision,
        candidate: {
          id: "c",
          text: "x",
          responseRevision: target.revision,
          generatedAt: Date.now(),
          model: "gemini-flash",
          instructions: "y",
        },
      }),
    { message: /restore archived research/ },
  );
});
