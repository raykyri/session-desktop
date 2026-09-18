import test from "ava";

import { highlights, nodes, researchDocuments, snapshots, trees } from "../src/index.js";

import { anchorFor, createFixture } from "./helpers.js";

const BODY = "# Quarterly report\n\nRevenue grew by a third.";

function importedDocument(fixture: ReturnType<typeof createFixture>, body = BODY) {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "An imported report",
    title: "Quarterly report",
    model: "gemini-flash",
    kind: "document",
    origin: "imported",
    status: "complete",
  });
  const nodeId = detail.tree.rootNodeId;
  const committed = snapshots.commit(fixture.db, fixture.userId, {
    nodeId,
    turns: [researchDocuments.documentTurn(nodeId, body)],
    outcome: { status: "complete" },
  });
  return { treeId: detail.tree.id, nodeId, revision: committed.revision };
}

test("a title-only edit keeps the snapshot and the highlights", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture);
  const highlight = highlights.create(
    fixture.db,
    fixture.userId,
    document.nodeId,
    anchorFor(document.revision, "Revenue", 21),
  );
  const result = researchDocuments.update(fixture.db, fixture.userId, {
    nodeId: document.nodeId,
    markdown: BODY,
    title: "Q3 report",
    expectedTitle: "Quarterly report",
    expectedResponseRevision: document.revision,
  });
  t.false(result.markdownChanged);
  t.is(result.removedHighlightCount, 0);
  t.is(result.responseRevision, document.revision);
  t.is(result.tree.title, "Q3 report");
  t.deepEqual(
    highlights.listForNode(fixture.db, fixture.userId, document.nodeId).map((entry) => entry.id),
    [highlight.id],
  );
});

test("a markdown change writes a new revision and drops every highlight", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture);
  const highlight = highlights.create(
    fixture.db,
    fixture.userId,
    document.nodeId,
    anchorFor(document.revision, "Revenue", 21),
  );
  const before = nodes.get(fixture.db, fixture.userId, document.nodeId)?.responseSnapshotAt ?? 0;
  const result = researchDocuments.update(fixture.db, fixture.userId, {
    nodeId: document.nodeId,
    markdown: "# Quarterly report\n\nRevenue fell by a third.",
    expectedTitle: "Quarterly report",
    expectedResponseRevision: document.revision,
    expectedHighlightIds: [highlight.id],
  });
  t.true(result.markdownChanged);
  t.is(result.removedHighlightCount, 1);
  t.not(result.responseRevision, document.revision);
  t.is(result.tree.title, "Quarterly report", "the derived title comes from the heading");
  t.deepEqual(highlights.listForNode(fixture.db, fixture.userId, document.nodeId), []);
  const after = nodes.get(fixture.db, fixture.userId, document.nodeId)?.responseSnapshotAt ?? 0;
  t.true(after > before);
  t.is(
    snapshots.read(fixture.db, fixture.userId, document.nodeId)?.revision,
    result.responseRevision,
  );
});

test("each of the four guards refuses with its own message", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture);
  const highlight = highlights.create(
    fixture.db,
    fixture.userId,
    document.nodeId,
    anchorFor(document.revision, "Revenue", 21),
  );
  const changed = "# Quarterly report\n\nSomething else entirely.";

  t.throws(
    () =>
      researchDocuments.update(fixture.db, fixture.userId, {
        nodeId: document.nodeId,
        markdown: changed,
        expectedTitle: "A different title",
        expectedResponseRevision: document.revision,
        expectedHighlightIds: [highlight.id],
      }),
    { message: /title changed while you were editing/ },
  );
  t.throws(
    () =>
      researchDocuments.update(fixture.db, fixture.userId, {
        nodeId: document.nodeId,
        markdown: changed,
        expectedTitle: "Quarterly report",
        expectedResponseRevision: "0".repeat(64),
        expectedHighlightIds: [highlight.id],
      }),
    { message: /document changed while you were editing/ },
  );
  t.throws(
    () =>
      researchDocuments.update(fixture.db, fixture.userId, {
        nodeId: document.nodeId,
        markdown: changed,
        expectedTitle: "Quarterly report",
        expectedResponseRevision: document.revision,
        expectedHighlightIds: [],
      }),
    { message: /highlights changed while you were editing/ },
  );

  trees.archive(fixture.db, fixture.userId, document.treeId);
  t.throws(
    () =>
      researchDocuments.update(fixture.db, fixture.userId, {
        nodeId: document.nodeId,
        markdown: changed,
        expectedTitle: "Quarterly report",
        expectedResponseRevision: document.revision,
        expectedHighlightIds: [highlight.id],
      }),
    { message: /restore archived research/ },
  );
});

test("only a root document node is editable", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "A question",
    model: "gemini-flash",
    status: "complete",
  });
  t.throws(
    () =>
      researchDocuments.update(fixture.db, fixture.userId, {
        nodeId: detail.tree.rootNodeId,
        markdown: "anything",
        expectedTitle: detail.tree.title,
        expectedResponseRevision: "0".repeat(64),
      }),
    { message: /only root research documents can be edited/ },
  );
});

test("the document limits are enforced before anything is read", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture);
  t.throws(
    () =>
      researchDocuments.update(fixture.db, fixture.userId, {
        nodeId: document.nodeId,
        markdown: `${"word ".repeat(10_001)}`,
        expectedTitle: "Quarterly report",
        expectedResponseRevision: document.revision,
      }),
    { message: /limited to 10000 words/ },
  );
});

test("markdown round-trips through the stored turn", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture);
  const stored = snapshots.read(fixture.db, fixture.userId, document.nodeId);
  t.is(researchDocuments.markdownFromTurns(stored?.turns ?? []), BODY);
});
