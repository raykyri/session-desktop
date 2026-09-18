import { MAX_RESEARCH_HIGHLIGHTS_PER_NODE } from "@session/shared";
import test from "ava";

import { highlights, nodes, snapshots, trees } from "../src/index.js";

import { anchorFor, answerTurn, createFixture } from "./helpers.js";

const ANSWER = "Birds sing at dawn because the cool, still air carries sound much further.";

function answeredRoot(fixture: ReturnType<typeof createFixture>, text = ANSWER) {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Why do birds sing at dawn?",
    model: "gemini-flash",
  });
  const nodeId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, nodeId, "running");
  const result = snapshots.commit(fixture.db, fixture.userId, {
    nodeId,
    turns: [answerTurn(nodeId, text)],
    outcome: { status: "complete" },
  });
  return { treeId: detail.tree.id, nodeId, revision: result.revision };
}

test("a highlight is saved against the answer's current revision", (t) => {
  const fixture = createFixture(t);
  const { nodeId, revision } = answeredRoot(fixture);
  const highlight = highlights.create(
    fixture.db,
    fixture.userId,
    nodeId,
    anchorFor(revision, "cool, still air", 30),
  );
  t.is(highlight.anchor.exact, "cool, still air");
  t.deepEqual(
    highlights.listForNode(fixture.db, fixture.userId, nodeId).map((entry) => entry.id),
    [highlight.id],
  );
  t.is(highlights.countForNode(fixture.db, fixture.userId, nodeId), 1);
});

test("an anchor from a replaced answer is refused", (t) => {
  const fixture = createFixture(t);
  const { nodeId } = answeredRoot(fixture);
  t.throws(
    () =>
      highlights.create(
        fixture.db,
        fixture.userId,
        nodeId,
        anchorFor("f".repeat(64), "cool, still air", 30),
      ),
    { message: highlights.REVISION_MISMATCH },
  );
});

test("the anchor validator runs before the revision lookup, in its own order", (t) => {
  const fixture = createFixture(t);
  const { nodeId, revision } = answeredRoot(fixture);
  t.throws(
    () =>
      highlights.create(fixture.db, fixture.userId, nodeId, {
        ...anchorFor(revision, "x"),
        start: 5,
        end: 5,
      }),
    { message: /selection cannot be empty/ },
  );
  t.throws(
    () =>
      highlights.create(fixture.db, fixture.userId, nodeId, {
        ...anchorFor(revision, "abc"),
        end: 9,
      }),
    { message: /invalid selection offsets/ },
  );
  t.throws(
    () =>
      highlights.create(fixture.db, fixture.userId, nodeId, {
        ...anchorFor(revision, "abc"),
        prefix: "p".repeat(600),
      }),
    { message: /selection is too large/ },
  );
  t.throws(
    () => highlights.create(fixture.db, fixture.userId, nodeId, anchorFor("NOTHEX", "abc")),
    { message: /invalid response revision/ },
  );
});

test("the per-node byte cap binds before the count cap", (t) => {
  const fixture = createFixture(t);
  const { nodeId, revision } = answeredRoot(fixture);
  const exact = "x".repeat(200);
  let created = 0;
  const error = t.throws(() => {
    for (let index = 0; index < MAX_RESEARCH_HIGHLIGHTS_PER_NODE; index += 1) {
      highlights.create(fixture.db, fixture.userId, nodeId, anchorFor(revision, exact, index));
      created += 1;
    }
  });
  t.is(error?.message, "a research answer contains too much highlight data");
  t.true(created > 0);
  t.true(created < MAX_RESEARCH_HIGHLIGHTS_PER_NODE);
});

test("highlights are removed one at a time and in bulk", (t) => {
  const fixture = createFixture(t);
  const { nodeId, revision } = answeredRoot(fixture);
  const first = highlights.create(fixture.db, fixture.userId, nodeId, anchorFor(revision, "Birds"));
  const second = highlights.create(
    fixture.db,
    fixture.userId,
    nodeId,
    anchorFor(revision, "dawn", 14),
  );
  const third = highlights.create(
    fixture.db,
    fixture.userId,
    nodeId,
    anchorFor(revision, "sound", 55),
  );
  t.is(highlights.remove(fixture.db, fixture.userId, nodeId, first.id).id, first.id);
  t.throws(() => highlights.remove(fixture.db, fixture.userId, nodeId, first.id), {
    message: /was not found/,
  });
  t.is(highlights.removeMany(fixture.db, fixture.userId, nodeId, [second.id, third.id]).length, 2);
  t.is(highlights.countForNode(fixture.db, fixture.userId, nodeId), 0);
});

test("the feed is newest first, skips archived threads, and labels documents", (t) => {
  const fixture = createFixture(t);
  const answered = answeredRoot(fixture);
  highlights.create(
    fixture.db,
    fixture.userId,
    answered.nodeId,
    anchorFor(answered.revision, "Birds"),
  );

  const document = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "An imported report",
    title: "Quarterly report",
    model: "gemini-flash",
    kind: "document",
    origin: "imported",
    status: "complete",
  });
  const documentNodeId = document.tree.rootNodeId;
  const documentSnapshot = snapshots.commit(fixture.db, fixture.userId, {
    nodeId: documentNodeId,
    turns: [answerTurn(documentNodeId, "Report body with a finding.")],
    outcome: { status: "complete" },
  });
  fixture.db.$client.prepare(`UPDATE nodes SET prompt = '' WHERE id = ?`).run(documentNodeId);
  highlights.create(
    fixture.db,
    fixture.userId,
    documentNodeId,
    anchorFor(documentSnapshot.revision, "finding", 17),
  );

  const feed = highlights.feed(fixture.db, fixture.userId);
  t.is(feed.length, 2);
  t.is(feed[0]?.nodeId, documentNodeId);
  t.is(feed[0]?.nodeLabel, "Quarterly report", "a document falls back to the thread title");
  t.is(feed[1]?.nodeLabel, "Why do birds sing at dawn?");

  trees.archive(fixture.db, fixture.userId, answered.treeId);
  t.deepEqual(
    highlights.feed(fixture.db, fixture.userId).map((item) => item.nodeId),
    [documentNodeId],
  );
});

test("removing every highlight of a node reports how many went", (t) => {
  const fixture = createFixture(t);
  const { nodeId, revision } = answeredRoot(fixture);
  highlights.create(fixture.db, fixture.userId, nodeId, anchorFor(revision, "Birds"));
  highlights.create(fixture.db, fixture.userId, nodeId, anchorFor(revision, "dawn", 14));
  t.is(highlights.removeAllForNode(fixture.db, fixture.userId, nodeId), 2);
  t.is(highlights.userStorageBytes(fixture.db, fixture.userId), 0);
});
