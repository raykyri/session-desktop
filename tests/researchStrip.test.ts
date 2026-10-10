import assert from "node:assert/strict";
import test from "node:test";
import {
  columnAttributes,
  columnKey,
  columnLevelIndex,
  columnScrollKey,
  columnSelector,
  isMessagesColumnId,
  researchStrip,
  sameResearchStrip,
} from "../src/lib/researchColumns";
import type { ResearchHighlightAnchor, ResearchNode } from "../src/types";

function node(id: string, overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id,
    treeId: "tree",
    prompt: id,
    adapter: "claude",
    groupId: "ws",
    worktreeDir: "/ws",
    status: "complete",
    nativeSessionId: `session-${id}`,
    createdAt: 0,
    highlights: [],
    ...overrides,
  };
}

const anchor = {
  version: 1,
  projection: "answer-v1",
  responseRevision: "rev",
  start: 0,
  end: 7,
  exact: "passage",
  prefix: "",
  suffix: "",
} as ResearchHighlightAnchor;

const ids = (strip: ReturnType<typeof researchStrip>) => strip.columns.map((column) => column.id);

test("a root alone is one messages column and its answer", () => {
  const nodes = [node("root")];
  const strip = researchStrip(nodes, "root", null);
  assert.deepEqual(ids(strip), ["T0", "A0"]);
  assert.deepEqual(strip.levels, [
    { index: 0, headId: "root", chainIds: ["root"], selectedId: "root", sourceId: null, anchor: null, kind: "conversation" },
  ]);
  assert.equal(strip.endsWithAnswer, true);
  assert.deepEqual(strip.openNodeIds, ["root"]);
  assert.deepEqual(columnAttributes(strip.columns[0]), {
    "data-research-column": "T0",
    "data-research-pair": "turns",
    "data-research-level": "0",
  });
  assert.deepEqual(columnAttributes(strip.columns[1]), {
    "data-research-column": "A0",
    "data-research-pair": "answer",
    "data-research-level": "0",
  });
  assert.deepEqual(columnScrollKey(strip.columns[0]), { kind: "turns", key: "root" });
  assert.deepEqual(columnScrollKey(strip.columns[1]), { kind: "answer", key: "root" });
  assert.deepEqual(strip.columns.map(columnKey), ["T0:root", "A0:root"]);
  // A selection the tree does not hold (yet) shows nothing.
  assert.deepEqual(researchStrip(nodes, "missing", null).columns, []);
  assert.deepEqual(researchStrip(nodes, null, null).columns, []);
});

test("a root with two levels of branches is three pairs, deepest last", () => {
  // root → c2 (inline); b1 branches from c2 on a passage and continues with
  // b1f; b2 branches from b1f.
  const nodes = [
    node("root", { createdAt: 0 }),
    node("c2", { parentNodeId: "root", inline: true, createdAt: 1 }),
    node("b1", { parentNodeId: "c2", queryAnchor: anchor, createdAt: 2 }),
    node("b1f", { parentNodeId: "b1", inline: true, createdAt: 3 }),
    node("b2", { parentNodeId: "b1f", createdAt: 4 }),
  ];
  const strip = researchStrip(nodes, "b2", null);
  assert.deepEqual(ids(strip), ["T0", "A0", "T1", "A1", "T2", "A2"]);
  assert.deepEqual(
    strip.levels.map(({ index, headId, chainIds, selectedId, sourceId, kind }) => ({
      index,
      headId,
      chainIds,
      selectedId,
      sourceId,
      kind,
    })),
    [
      { index: 0, headId: "root", chainIds: ["root", "c2"], selectedId: "c2", sourceId: null, kind: "conversation" },
      { index: 1, headId: "b1", chainIds: ["b1", "b1f"], selectedId: "b1f", sourceId: "c2", kind: "branch" },
      { index: 2, headId: "b2", chainIds: ["b2"], selectedId: "b2", sourceId: "b1f", kind: "branch" },
    ],
  );
  assert.equal(strip.levels[1].anchor, anchor);
  assert.equal(strip.levels[2].anchor, null);
  // The feed selects the root level's message and each branch's head.
  assert.deepEqual(strip.openNodeIds, ["c2", "b1", "b2"]);
  assert.equal(strip.endsWithAnswer, true);
  assert.deepEqual(columnAttributes(strip.columns[5]), {
    "data-research-column": "A2",
    "data-research-pair": "answer",
    "data-research-level": "2",
  });
  assert.deepEqual(columnScrollKey(strip.columns[2]), { kind: "turns", key: "b1" });
  assert.deepEqual(columnScrollKey(strip.columns[3]), { kind: "answer", key: "b1f" });
  // Selecting the root closes the branches.
  assert.deepEqual(ids(researchStrip(nodes, "root", null)), ["T0", "A0"]);
  assert.deepEqual(researchStrip(nodes, "root", null).levels[0].chainIds, ["root", "c2"]);
});

test("a pending branch adds its column after the level that shows its parent", () => {
  const nodes = [node("root"), node("b1", { parentNodeId: "root", createdAt: 1 })];
  const strip = researchStrip(nodes, "b1", { parentNodeId: "b1", anchor });
  assert.deepEqual(ids(strip), ["T0", "A0", "T1", "A1", "P2"]);
  const pending = strip.columns[4];
  assert.deepEqual(pending, { id: "P2", role: "pending", levelIndex: 2, parentNodeId: "b1", anchor });
  assert.equal(strip.endsWithAnswer, false);
  assert.deepEqual(columnAttributes(pending), {
    "data-research-column": "P2",
    "data-research-pair": "turns",
    "data-research-level": "2",
  });
  assert.equal(columnScrollKey(pending), null);
  assert.equal(columnKey(pending), "P2:b1");
  // The open nodes do not include the unsent branch.
  assert.deepEqual(strip.openNodeIds, ["root", "b1"]);
  // A pending branch asked from a message that is not the deepest selection
  // opens no column.
  assert.deepEqual(ids(researchStrip(nodes, "b1", { parentNodeId: "root", anchor: null })), ["T0", "A0", "T1", "A1"]);
  // The same strip compares equal; a different passage does not.
  assert.equal(sameResearchStrip(strip, researchStrip(nodes, "b1", { parentNodeId: "b1", anchor })), true);
  assert.equal(
    sameResearchStrip(strip, researchStrip(nodes, "b1", { parentNodeId: "b1", anchor: { ...anchor } })),
    false,
  );
  assert.equal(sameResearchStrip(strip, researchStrip(nodes, "b1", null)), false);
});

test("a note root is a post column and its thread column; its follow-ups open as ordinary pairs", () => {
  const nodes = [
    node("note", { kind: "note", delivery: { status: "posted", postedAt: 1, replies: [] } }),
    node("run", { parentNodeId: "note", createdAt: 1 }),
  ];
  const root = researchStrip(nodes, "note", null);
  assert.deepEqual(ids(root), ["N0", "T0"]);
  assert.deepEqual(root.columns.map((column) => column.role), ["post", "thread"]);
  assert.equal(root.levels[0].kind, "post");
  assert.equal(root.endsWithAnswer, false);
  // The post is its own kind of column; the thread is the level's
  // messages-side ("turns") column, which focus, settling and the row
  // selector look up as T0.
  assert.deepEqual(columnAttributes(root.columns[0]), {
    "data-research-column": "N0",
    "data-research-pair": "post",
    "data-research-level": "0",
  });
  assert.deepEqual(columnAttributes(root.columns[1]), {
    "data-research-column": "T0",
    "data-research-pair": "turns",
    "data-research-level": "0",
  });
  assert.deepEqual(root.columns.map(columnKey), ["N0:note", "T0:note"]);
  assert.equal(columnScrollKey(root.columns[0]), null);
  assert.equal(columnScrollKey(root.columns[1]), null);
  assert.equal(columnLevelIndex("N0"), 0);
  assert.equal(isMessagesColumnId("N0"), false);
  assert.equal(isMessagesColumnId("T0"), true);

  const withRun = researchStrip(nodes, "run", null);
  assert.deepEqual(ids(withRun), ["N0", "T0", "T1", "A1"]);
  assert.deepEqual(withRun.columns.map((column) => column.role), ["post", "thread", "messages", "answer"]);
  assert.equal(withRun.endsWithAnswer, true);
  assert.deepEqual(withRun.openNodeIds, ["note", "run"]);
  // Closing the follow-up leaves the post and its thread.
  assert.equal(sameResearchStrip(root, researchStrip(nodes, "note", null)), true);
  assert.equal(sameResearchStrip(root, withRun), false);
});

test("a draft is the T0 messages column, and every column has one selector", () => {
  const draft = { id: "T0", role: "draft", draftId: "draft-1" } as const;
  assert.deepEqual(columnAttributes(draft), {
    "data-research-column": "T0",
    "data-research-pair": "turns",
    "data-research-level": "0",
  });
  assert.equal(columnKey(draft), "T0:draft-1");
  assert.equal(columnScrollKey(draft), null);
  assert.deepEqual(columnAttributes({ id: "feed", role: "feed" }), { "data-research-column": "feed" });
  assert.deepEqual(columnAttributes({ id: "placeholder", role: "placeholder" }), {
    "data-research-column": "placeholder",
  });
  assert.equal(columnSelector("A3"), '[data-research-column="A3"]');
  assert.equal(columnSelector(), "[data-research-column]");
  assert.equal(columnLevelIndex("T0"), 0);
  assert.equal(columnLevelIndex("A12"), 12);
  assert.equal(columnLevelIndex("P2"), 2);
  assert.equal(columnLevelIndex("feed"), null);
  assert.equal(columnLevelIndex(undefined), null);
  assert.equal(isMessagesColumnId("T1"), true);
  assert.equal(isMessagesColumnId("P1"), true);
  assert.equal(isMessagesColumnId("A1"), false);
  assert.equal(isMessagesColumnId("feed"), false);
});

test("editing the root adds the editor column after the root level's columns", () => {
  const doc = [
    node("doc", { kind: "document" }),
    node("b1", { parentNodeId: "doc", createdAt: 1 }),
  ];
  const editing = researchStrip(doc, "doc", null, "doc");
  assert.deepEqual(ids(editing), ["T0", "A0", "E0"]);
  const editor = editing.columns[2];
  assert.deepEqual(editor, { id: "E0", role: "editor", levelIndex: 0, nodeId: "doc" });
  assert.equal(editing.endsWithAnswer, false);
  assert.deepEqual(columnAttributes(editor), {
    "data-research-column": "E0",
    "data-research-pair": "editor",
    "data-research-level": "0",
  });
  assert.equal(columnKey(editor), "E0:doc");
  assert.equal(columnScrollKey(editor), null);
  assert.equal(columnLevelIndex("E0"), 0);
  assert.equal(isMessagesColumnId("E0"), false);
  // A branch level opens after the editor; the editor stays with the root.
  assert.deepEqual(ids(researchStrip(doc, "b1", null, "doc")), ["T0", "A0", "E0", "T1", "A1"]);
  // Only the root can be edited.
  assert.deepEqual(ids(researchStrip(doc, "b1", null, "b1")), ["T0", "A0", "T1", "A1"]);
  assert.equal(sameResearchStrip(editing, researchStrip(doc, "doc", null, "doc")), true);
  assert.equal(sameResearchStrip(editing, researchStrip(doc, "doc", null)), false);

  // A post's editor follows its thread column.
  const post = [node("note", { kind: "note", delivery: { status: "posted", postedAt: 1, replies: [] } })];
  assert.deepEqual(ids(researchStrip(post, "note", null, "note")), ["N0", "T0", "E0"]);
});
