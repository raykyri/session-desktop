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
    { message: /Summary conflict: the summary was modified while the preview was open/ },
  );
  t.throws(
    () =>
      recaps.applyCandidate(fixture.db, fixture.userId, {
        nodeId: target.nodeId,
        expectedResponseRevision: "0".repeat(64),
        candidate,
      }),
    { message: /candidate response revision does not match the current answer revision/ },
  );
  t.throws(
    () =>
      recaps.applyCandidate(fixture.db, fixture.userId, {
        nodeId: target.nodeId,
        expectedResponseRevision: target.revision,
        candidate: { ...candidate, instructions: "   " },
      }),
    { message: /Summary instructions are required/ },
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
    { message: /Summary conflict: the summary was modified while the preview was open/ },
  );
});

test("rejects summary replacement on archived threads", (t) => {
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
    { message: /Cannot update summary of archived research/ },
  );
});

test("prevents background recap from overwriting user-applied summary", (t) => {
  const fixture = createFixture(t);
  const target = answered(fixture);
  // The scheduled job read the node here: no recap yet.
  const startedWith = nodes.get(fixture.db, fixture.userId, target.nodeId)?.recap?.id ?? null;
  t.is(startedWith, null);

  // While the model was generating, the user previewed and applied their own.
  const applied = recaps.applyCandidate(fixture.db, fixture.userId, {
    nodeId: target.nodeId,
    expectedResponseRevision: target.revision,
    expectedCurrentRecapId: null,
    candidate: {
      id: "candidate-1",
      text: "The user's own summary.",
      responseRevision: target.revision,
      instructions: "Three sentences, plain language.",
      generatedAt: 1_700_000_000_000,
      model: "gemini-flash",
    },
  });
  t.is(applied.recap?.text, "The user's own summary.");

  // Applying a recap changes neither the snapshot nor the revision, so the
  // three older guards all still pass; only the recap identity has moved.
  const late = recaps.save(fixture.db, fixture.userId, {
    nodeId: target.nodeId,
    text: "The automatic summary.",
    responseRevision: target.revision,
    model: "gemini-flash",
    expectedSnapshotAt: target.snapshotAt,
    expectedCurrentRecapId: startedWith,
  });
  t.is(late, null, "the stale automatic recap is a no-op");
  t.is(
    nodes.get(fixture.db, fixture.userId, target.nodeId)?.recap?.text,
    "The user's own summary.",
    "and the user's summary is untouched",
  );
  t.is(
    nodes.get(fixture.db, fixture.userId, target.nodeId)?.recap?.instructions,
    "Three sentences, plain language.",
  );

  // Nothing raced: the same save against the recap that is actually there
  // commits.
  const current = nodes.get(fixture.db, fixture.userId, target.nodeId)?.recap?.id ?? null;
  const saved = recaps.save(fixture.db, fixture.userId, {
    nodeId: target.nodeId,
    text: "The automatic summary.",
    responseRevision: target.revision,
    model: "gemini-flash",
    expectedSnapshotAt: target.snapshotAt,
    expectedCurrentRecapId: current,
  });
  t.is(saved?.recap?.text, "The automatic summary.");
});
