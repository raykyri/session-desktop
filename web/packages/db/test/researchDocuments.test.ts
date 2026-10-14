import test from "ava";
import { eq } from "drizzle-orm";

import { highlights, nodes, researchDocuments, schema, snapshots, trees } from "../src/index.js";

import { anchorFor, createFixture, snapshotAtOf } from "./helpers.js";

const BODY = "# Quarterly report\n\nRevenue grew by a third.";

function importedDocument(fixture: ReturnType<typeof createFixture>, body = BODY) {
  const detail = researchDocuments.importReport(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "An imported report",
    markdown: body,
    agent: { model: "gemini-flash" },
  });
  const nodeId = detail.tree.rootNodeId;
  const revision = snapshots.revision(fixture.db, fixture.userId, nodeId);
  if (revision === null) throw new Error("the import wrote no snapshot");
  return { treeId: detail.tree.id, nodeId, revision };
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

test("a markdown change writes a new revision and moves highlights with their quote", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture);
  const kept = highlights.create(
    fixture.db,
    fixture.userId,
    document.nodeId,
    anchorFor(document.revision, "Revenue", 20),
  );
  const gone = highlights.create(
    fixture.db,
    fixture.userId,
    document.nodeId,
    anchorFor(document.revision, "grew", 28),
  );
  const before = snapshotAtOf(nodes.get(fixture.db, fixture.userId, document.nodeId)) ?? 0;
  const result = researchDocuments.update(fixture.db, fixture.userId, {
    nodeId: document.nodeId,
    markdown: "# Quarterly report\n\nIn Q3 Revenue fell by a third.",
    expectedTitle: "Quarterly report",
    expectedResponseRevision: document.revision,
    expectedHighlightIds: [kept.id, gone.id],
  });
  t.true(result.markdownChanged);
  t.is(result.removedHighlightCount, 1, "the highlight whose quote is gone is removed");
  t.not(result.responseRevision, document.revision);
  t.is(result.tree.title, "Quarterly report", "the derived title comes from the heading");
  const remaining = highlights.listForNode(fixture.db, fixture.userId, document.nodeId);
  t.deepEqual(
    remaining.map((entry) => entry.id),
    [kept.id],
  );
  t.like(remaining[0]?.anchor, {
    start: 26,
    end: 33,
    exact: "Revenue",
    responseRevision: result.responseRevision,
  });
  t.deepEqual(
    result.node.highlights.map((entry) => entry.anchor.start),
    [26],
    "the returned node carries the moved highlight",
  );
  const after = snapshotAtOf(nodes.get(fixture.db, fixture.userId, document.nodeId)) ?? 0;
  t.true(after > before);
  t.is(
    snapshots.read(fixture.db, fixture.userId, document.nodeId)?.revision,
    result.responseRevision,
  );
});

test("each of the four checks rejects with its own message", (t) => {
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
    { message: /Document title conflict/ },
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
    { message: /Document content conflict/ },
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
    { message: /Highlight conflict/ },
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
    { message: /Cannot edit document in archived research/ },
  );
});

test("only a root document node is editable", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "A question" },
    agent: { model: "gemini-flash" },
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
    { message: /Cannot edit non-root node: only root research documents can be edited./ },
  );
});

test("a body stored with surrounding whitespace is unchanged by a title-only save", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture, `${BODY}\n`);
  const highlight = highlights.create(
    fixture.db,
    fixture.userId,
    document.nodeId,
    anchorFor(document.revision, "Revenue", 20),
  );
  // The editor sends the trimmed body it shows, and no highlight ids: it
  // knows the body did not change.
  const result = researchDocuments.update(fixture.db, fixture.userId, {
    nodeId: document.nodeId,
    markdown: BODY,
    title: "Q3 report",
    expectedTitle: "Quarterly report",
    expectedResponseRevision: document.revision,
  });
  t.false(result.markdownChanged);
  t.is(result.responseRevision, document.revision);
  t.is(result.tree.title, "Q3 report");
  t.deepEqual(
    highlights.listForNode(fixture.db, fixture.userId, document.nodeId).map((entry) => entry.id),
    [highlight.id],
  );
});

test("a new body moves passage branches with their quote and clears the recap", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture);
  const moved = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: document.nodeId,
    message: { text: "Why did revenue grow?" },
    anchor: { kind: "passage", anchor: anchorFor(document.revision, "Revenue", 20) },
  });
  const unmatched = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: document.nodeId,
    message: { text: "By how much?" },
    anchor: { kind: "passage", anchor: anchorFor(document.revision, "grew", 28) },
  });
  fixture.db
    .update(schema.nodes)
    .set({
      recapJson: {
        id: "recap-1",
        text: "Revenue grew.",
        responseRevision: document.revision,
        generatedAt: 1,
        adapter: "gemini",
        model: "gemini-flash",
      },
    })
    .where(eq(schema.nodes.id, document.nodeId))
    .run();
  const result = researchDocuments.update(fixture.db, fixture.userId, {
    nodeId: document.nodeId,
    markdown: "# Quarterly report\n\nIn Q3 Revenue fell by a third.",
    expectedTitle: "Quarterly report",
    expectedResponseRevision: document.revision,
    expectedHighlightIds: [],
  });
  t.is(result.unmatchedBranchCount, 1);
  t.deepEqual(
    result.movedBranches.map((node) => node.id),
    [moved.id],
  );
  t.like(result.movedBranches[0]?.anchor?.anchor, {
    start: 26,
    responseRevision: result.responseRevision,
  });
  t.like(
    nodes.get(fixture.db, fixture.userId, unmatched.id)?.anchor?.anchor,
    { start: 28, responseRevision: document.revision },
    "a branch whose quote is gone keeps its anchor",
  );
  t.is(
    fixture.db
      .select({ recap: schema.nodes.recapJson })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, document.nodeId))
      .get()?.recap,
    null,
  );
});

test("an imported report over the word limit keeps an editable title", (t) => {
  const fixture = createFixture(t);
  const document = importedDocument(fixture);
  // Stored past the editor's limit, as an import from before the limit was.
  const long = `# Quarterly report\n\n${"word ".repeat(10_001).trim()}`;
  const revision = snapshots.replaceTurns(fixture.db, fixture.userId, document.nodeId, [
    researchDocuments.documentTurn(document.nodeId, long),
  ]).revision;
  const result = researchDocuments.update(fixture.db, fixture.userId, {
    nodeId: document.nodeId,
    markdown: long,
    title: "Long report",
    expectedTitle: "Quarterly report",
    expectedResponseRevision: revision,
  });
  t.false(result.markdownChanged);
  t.is(result.tree.title, "Long report");
});

test("a new body is held to the document limits", (t) => {
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
