// Recaps on imported reports, as the desktop keeps them
// (`recap_eligible`): saved and applied like an answer's; an authored
// document takes none.

import test from "ava";

import { recaps, researchDocuments, snapshots } from "../src/index.js";

import { createFixture, recapOf, snapshotAtOf } from "./helpers.js";

const MARKDOWN = "# Report\n\nA long report body about bloom filters and their false positives.";

function importReport(fixture: ReturnType<typeof createFixture>) {
  const detail = researchDocuments.importReport(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "What are bloom filters?",
    markdown: MARKDOWN,
    agent: { model: "gemini-flash" },
  });
  const node = detail.nodes[0];
  if (!node) throw new Error("the import has no root");
  const snapshot = snapshots.read(fixture.db, fixture.userId, node.id);
  if (!snapshot) throw new Error("the import has no body");
  return { node, revision: snapshot.revision };
}

test("an imported report takes an automatic recap and a previewed one", (t) => {
  const fixture = createFixture(t);
  const { node, revision } = importReport(fixture);
  const saved = recaps.save(fixture.db, fixture.userId, {
    nodeId: node.id,
    text: "Bloom filters trade false positives for space.",
    responseRevision: revision,
    model: "gemini-flash",
    expectedSnapshotAt: snapshotAtOf(node),
    expectedCurrentRecapId: null,
  });
  t.is(recapOf(saved)?.text, "Bloom filters trade false positives for space.");
  const applied = recaps.applyCandidate(fixture.db, fixture.userId, {
    nodeId: node.id,
    expectedResponseRevision: revision,
    expectedCurrentRecapId: recapOf(saved)?.id ?? null,
    candidate: {
      id: "candidate-1",
      text: "A second recap.",
      responseRevision: revision,
      generatedAt: Date.now(),
      adapter: "gemini",
      model: "gemini-flash",
      instructions: "Summarize.",
    },
  });
  t.is(recapOf(applied)?.text, "A second recap.");
});

test("an authored document takes no recap", (t) => {
  const fixture = createFixture(t);
  const { node, revision } = importReport(fixture);
  fixture.db.$client.prepare("UPDATE nodes SET source = 'authored' WHERE id = ?").run(node.id);
  t.is(
    recaps.save(fixture.db, fixture.userId, {
      nodeId: node.id,
      text: "A recap.",
      responseRevision: revision,
      model: "gemini-flash",
      expectedSnapshotAt: snapshotAtOf(node),
    }),
    null,
  );
});
