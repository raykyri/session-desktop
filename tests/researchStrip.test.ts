import assert from "node:assert/strict";
import test from "node:test";
import {
  branchGroupOf,
  columnAttributes,
  columnKey,
  columnLevelIndex,
  columnMessageIds,
  columnScrollKey,
  columnSelector,
  isMessagesColumnId,
  researchRestoredSelection,
  researchSelectionAfterRemoval,
  researchSelectionPath,
  researchSelectionWith,
  researchStrip,
  researchStripSettleLeft,
  sameResearchStrip,
} from "@session/shared/lib/researchColumns";
import type { ResearchHighlightAnchor, ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

function node(id: string, overrides: NodeFixture = {}): ResearchNode {
  return researchNode({
    id,
    treeId: "tree",
    prompt: id,
    adapter: "claude",
    groupId: "ws",
    status: "complete",
    sessionReady: true,
    createdAt: 0,
    highlights: [],
    ...overrides,
  });
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
    {
      index: 0,
      headId: "root",
      chainIds: ["root"],
      displayIds: ["root"],
      selectedId: "root",
      sourceId: null,
      anchor: null,
      kind: "root",
    },
  ]);
  assert.equal(strip.endsWithAnswer, true);
  assert.deepEqual(columnAttributes(strip.columns[0]), {
    "data-research-column": "T0",
    "data-research-pair": "messages",
    "data-research-level": "0",
  });
  assert.deepEqual(columnAttributes(strip.columns[1]), {
    "data-research-column": "A0",
    "data-research-pair": "answer",
    "data-research-level": "0",
  });
  assert.deepEqual(columnScrollKey(strip.columns[0]), { kind: "messages", key: "root" });
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
    node("b1", { parentNodeId: "c2", anchor: { kind: "passage", anchor }, createdAt: 2 }),
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
      { index: 0, headId: "root", chainIds: ["root", "c2"], selectedId: "c2", sourceId: null, kind: "root" },
      { index: 1, headId: "b1", chainIds: ["b1", "b1f"], selectedId: "b1f", sourceId: "c2", kind: "branch" },
      { index: 2, headId: "b2", chainIds: ["b2"], selectedId: "b2", sourceId: "b1f", kind: "branch" },
    ],
  );
  assert.equal(strip.levels[1].anchor, anchor);
  assert.equal(strip.levels[2].anchor, null);
  assert.equal(strip.endsWithAnswer, true);
  assert.deepEqual(columnAttributes(strip.columns[5]), {
    "data-research-column": "A2",
    "data-research-pair": "answer",
    "data-research-level": "2",
  });
  // Each branch level's messages column is the branches column after its
  // source level.
  assert.deepEqual(strip.columns.map((column) => column.role), [
    "messages",
    "answer",
    "branches",
    "answer",
    "branches",
    "answer",
  ]);
  // A branches column's offset is kept under its first branch.
  assert.deepEqual(columnScrollKey(strip.columns[2]), { kind: "branches", key: "b1" });
  assert.deepEqual(columnScrollKey(strip.columns[3]), { kind: "answer", key: "b1f" });
  assert.deepEqual(columnScrollKey(strip.columns[4]), { kind: "branches", key: "b2" });
  // Selecting the root closes the branch levels; the branches column stays,
  // with no branch open.
  const closed = researchStrip(nodes, "root", null);
  assert.deepEqual(ids(closed), ["T0", "A0", "T1"]);
  assert.equal(closed.endsWithAnswer, false);
  assert.deepEqual(closed.levels[0].chainIds, ["root", "c2"]);
  const branches = closed.columns[2];
  assert.equal(branches.role, "branches");
  if (branches.role === "branches") {
    assert.equal(branches.level, null);
    assert.deepEqual(branches.groups.map((group) => group.kind === "branch" && [group.headId, group.selectedId]), [
      ["b1", null],
    ]);
  }
  // The column keeps its element whichever branch is open.
  assert.equal(columnKey(branches), columnKey(strip.columns[2]));
  assert.equal(columnKey(branches), "T1:branches");
});

test("a branches column stacks the document's and the answers' branches in reading order", () => {
  // A document, an inline answer after it, two passage branches of each and
  // a whole-answer branch of the document; the second passage of each is
  // the older branch.
  const at = (start: number) => ({ kind: "passage" as const, anchor: { ...anchor, start, end: start + 7 } });
  const nodes = [
    node("doc", { type: "document", createdAt: 0 }),
    node("ans", { parentNodeId: "doc", inline: true, createdAt: 1 }),
    node("d-late", { parentNodeId: "doc", anchor: at(40), createdAt: 2 }),
    node("d-whole", { parentNodeId: "doc", createdAt: 3 }),
    node("d-early", { parentNodeId: "doc", anchor: at(5), createdAt: 4 }),
    node("a-late", { parentNodeId: "ans", anchor: at(30), createdAt: 5 }),
    node("a-early", { parentNodeId: "ans", anchor: at(2), createdAt: 6 }),
    node("a-early-2", { parentNodeId: "a-early", inline: true, createdAt: 7 }),
  ];
  const heads = (strip: ReturnType<typeof researchStrip>) => {
    const column = strip.columns.find((candidate) => candidate.role === "branches");
    return column?.role === "branches"
      ? column.groups.map((group) => (group.kind === "branch" ? group.headId : `pending:${group.parentNodeId}`))
      : [];
  };
  // With the document selected or the answer, the same stack.
  const fromDoc = researchStrip(nodes, "doc", null);
  assert.deepEqual(ids(fromDoc), ["T0", "A0", "T1"]);
  assert.deepEqual(heads(fromDoc), ["d-early", "d-late", "d-whole", "a-early", "a-late"]);
  assert.deepEqual(heads(researchStrip(nodes, "ans", null)), heads(fromDoc));
  // Opening a message of an answer's branch: its group is the open level,
  // the document's branches stay listed, and the source answer is level 0's
  // selection.
  const open = researchStrip(nodes, "a-early-2", null);
  assert.deepEqual(ids(open), ["T0", "A0", "T1", "A1"]);
  assert.equal(open.levels[0].selectedId, "ans");
  assert.deepEqual(heads(open), heads(fromDoc));
  const column = open.columns[2];
  assert.equal(column.role, "branches");
  if (column.role !== "branches") return;
  assert.equal(column.level?.headId, "a-early");
  assert.equal(column.source.headId, "doc");
  const group = branchGroupOf(column, "a-early-2");
  assert.deepEqual(group && { ...group, anchor: null }, {
    kind: "branch",
    headId: "a-early",
    chainIds: ["a-early", "a-early-2"],
    displayIds: ["a-early", "a-early-2"],
    sourceId: "ans",
    anchor: null,
    selectedId: "a-early-2",
  });
  assert.equal(group?.anchor?.start, 2);
  // Only the open group has a selection; ↑/↓ and ⌃Tab follow every group's
  // messages top to bottom.
  assert.deepEqual(
    column.groups.flatMap((candidate) => (candidate.kind === "branch" && candidate.selectedId ? [candidate.headId] : [])),
    ["a-early"],
  );
  assert.deepEqual(columnMessageIds(column), ["d-early", "d-late", "d-whole", "a-early", "a-early-2", "a-late"]);
  assert.equal(branchGroupOf(column, "ans"), null);
  // A new branch changes the stack, and so the strip.
  const more = [...nodes, node("a-new", { parentNodeId: "ans", createdAt: 8 })];
  assert.equal(sameResearchStrip(open, researchStrip(more, "a-early-2", null)), false);
  assert.equal(sameResearchStrip(open, researchStrip(nodes, "a-early-2", null)), true);
  assert.deepEqual(heads(researchStrip(more, "doc", null)).slice(-1), ["a-new"]);
  // Selecting another group's message is a different strip.
  assert.equal(sameResearchStrip(open, researchStrip(nodes, "d-late", null)), false);
});

test("an unsent branch is a group at its source's position in the stack", () => {
  const at = (start: number) => ({ ...anchor, start, end: start + 7 });
  const nodes = [
    node("doc", { type: "document", createdAt: 0 }),
    node("ans", { parentNodeId: "doc", inline: true, createdAt: 1 }),
    node("d1", { parentNodeId: "doc", anchor: { kind: "passage", anchor: at(5) }, createdAt: 2 }),
    node("d2", { parentNodeId: "doc", anchor: { kind: "passage", anchor: at(50) }, createdAt: 3 }),
    node("a1", { parentNodeId: "ans", createdAt: 4 }),
  ];
  const kinds = (strip: ReturnType<typeof researchStrip>) => {
    const column = strip.columns.find((candidate) => candidate.role === "branches");
    return column?.role === "branches"
      ? column.groups.map((group) => (group.kind === "branch" ? group.headId : "new"))
      : [];
  };
  // A passage between the document's two branches.
  const between = researchStrip(nodes, "doc", { parentNodeId: "doc", anchor: at(20) });
  assert.deepEqual(kinds(between), ["d1", "new", "d2", "a1"]);
  assert.deepEqual(between.pending, { kind: "pending", levelIndex: 1, parentNodeId: "doc", anchor: between.pending?.anchor });
  // The whole document: after its passages.
  assert.deepEqual(kinds(researchStrip(nodes, "doc", { parentNodeId: "doc", anchor: null })), ["d1", "d2", "new", "a1"]);
  // The answer: after the document's branches.
  assert.deepEqual(kinds(researchStrip(nodes, "ans", { parentNodeId: "ans", anchor: at(0) })), ["d1", "d2", "new", "a1"]);
  // Not the deepest selection: not shown.
  const hidden = researchStrip(nodes, "a1", { parentNodeId: "ans", anchor: null });
  assert.equal(hidden.pending, null);
  assert.deepEqual(kinds(hidden), ["d1", "d2", "a1"]);
  // A message with no branches at all: a branches column with the unsent
  // branch alone.
  const lone = [node("root")];
  const alone = researchStrip(lone, "root", { parentNodeId: "root", anchor: null });
  assert.deepEqual(ids(alone), ["T0", "A0", "T1"]);
  assert.deepEqual(kinds(alone), ["new"]);
  assert.equal(columnMessageIds(alone.columns[2]).length, 0);
  // The column's scroll key is its first created branch, with or without an
  // unsent branch listed before it; the unsent branch's parent when it is
  // the only group.
  const before = researchStrip(nodes, "doc", { parentNodeId: "doc", anchor: at(0) });
  assert.deepEqual(kinds(before), ["new", "d1", "d2", "a1"]);
  const branchesOf = (strip: ReturnType<typeof researchStrip>) =>
    strip.columns.find((candidate) => candidate.role === "branches")!;
  assert.deepEqual(columnScrollKey(branchesOf(before)), { kind: "branches", key: "d1" });
  assert.deepEqual(columnScrollKey(branchesOf(researchStrip(nodes, "doc", null))), { kind: "branches", key: "d1" });
  assert.deepEqual(columnScrollKey(branchesOf(alone)), { kind: "branches", key: "root" });
});

test("a level lists its messages oldest first, or in its head's stored order", () => {
  const nodes = [
    node("root", { createdAt: 0 }),
    node("c1", { parentNodeId: "root", inline: true, createdAt: 1 }),
    node("c2", { parentNodeId: "c1", inline: true, createdAt: 2 }),
    node("b1", { parentNodeId: "c1", createdAt: 3 }),
  ];
  const fresh = researchStrip(nodes, "c2", null);
  assert.deepEqual(fresh.levels[0].chainIds, ["root", "c1", "c2"]);
  assert.deepEqual(fresh.levels[0].displayIds, ["root", "c1", "c2"]);
  // A stored order; a follow-up added after it lists last.
  const ordered = nodes.map((candidate) =>
    candidate.id === "root" ? { ...candidate, chainOrder: ["c1", "root"] } : candidate,
  );
  const strip = researchStrip(ordered, "c2", null);
  assert.deepEqual(strip.levels[0].chainIds, ["root", "c1", "c2"]);
  assert.deepEqual(strip.levels[0].displayIds, ["c1", "root", "c2"]);
  const reordered = ordered.map((candidate) =>
    candidate.id === "root" ? { ...candidate, chainOrder: ["c2", "c1", "root"] } : candidate,
  );
  assert.deepEqual(researchStrip(reordered, "c2", null).levels[0].displayIds, ["c2", "c1", "root"]);
  // A new order alone is a different strip.
  assert.equal(sameResearchStrip(strip, researchStrip(reordered, "c2", null)), false);
  assert.equal(sameResearchStrip(strip, researchStrip(ordered, "c2", null)), true);
  // A branch is a chain of one.
  assert.deepEqual(researchStrip(nodes, "b1", null).levels[1].displayIds, ["b1"]);
});

test("a pending branch adds the branches column after the level that shows its parent", () => {
  const nodes = [node("root"), node("b1", { parentNodeId: "root", createdAt: 1 })];
  const strip = researchStrip(nodes, "b1", { parentNodeId: "b1", anchor });
  assert.deepEqual(ids(strip), ["T0", "A0", "T1", "A1", "T2"]);
  const column = strip.columns[4];
  const group = { kind: "pending", levelIndex: 2, parentNodeId: "b1", anchor } as const;
  assert.deepEqual(column, {
    id: "T2",
    role: "branches",
    levelIndex: 2,
    source: strip.levels[1],
    level: null,
    groups: [group],
  });
  assert.deepEqual(strip.pending, group);
  assert.equal(strip.endsWithAnswer, false);
  assert.deepEqual(columnAttributes(column), {
    "data-research-column": "T2",
    "data-research-pair": "messages",
    "data-research-level": "2",
  });
  assert.deepEqual(columnScrollKey(column), { kind: "branches", key: "b1" });
  assert.equal(columnKey(column), "T2:branches");
  // A pending branch whose source is not the deepest selected message
  // is not shown.
  const elsewhere = researchStrip(nodes, "b1", { parentNodeId: "root", anchor: null });
  assert.deepEqual(ids(elsewhere), ["T0", "A0", "T1", "A1"]);
  assert.equal(elsewhere.pending, null);
  // The same strip compares equal; a different passage does not.
  assert.equal(sameResearchStrip(strip, researchStrip(nodes, "b1", { parentNodeId: "b1", anchor })), true);
  assert.equal(
    sameResearchStrip(strip, researchStrip(nodes, "b1", { parentNodeId: "b1", anchor: { ...anchor } })),
    false,
  );
  assert.equal(sameResearchStrip(strip, researchStrip(nodes, "b1", null)), false);
});

test("a post root is a post column and its thread column; its follow-ups open as ordinary pairs", () => {
  const nodes = [
    node("post", { type: "post" }),
    node("run", { parentNodeId: "post", createdAt: 1 }),
  ];
  const root = researchStrip(nodes, "post", null);
  assert.deepEqual(ids(root), ["N0", "T0"]);
  assert.deepEqual(root.columns.map((column) => column.role), ["post", "thread"]);
  assert.equal(root.levels[0].kind, "post");
  assert.equal(root.endsWithAnswer, false);
  // The post is its own kind of column; the thread is the level's
  // messages-side ("messages") column, which focus, settling and the row
  // selector look up as T0.
  assert.deepEqual(columnAttributes(root.columns[0]), {
    "data-research-column": "N0",
    "data-research-pair": "post",
    "data-research-level": "0",
  });
  assert.deepEqual(columnAttributes(root.columns[1]), {
    "data-research-column": "T0",
    "data-research-pair": "messages",
    "data-research-level": "0",
  });
  assert.deepEqual(root.columns.map(columnKey), ["N0:post", "T0:post"]);
  assert.equal(columnScrollKey(root.columns[0]), null);
  assert.equal(columnScrollKey(root.columns[1]), null);
  assert.equal(columnLevelIndex("N0"), 0);
  assert.equal(isMessagesColumnId("N0"), false);
  assert.equal(isMessagesColumnId("T0"), true);

  const withRun = researchStrip(nodes, "run", null);
  assert.deepEqual(ids(withRun), ["N0", "T0", "T1", "A1"]);
  assert.deepEqual(withRun.columns.map((column) => column.role), ["post", "thread", "messages", "answer"]);
  assert.equal(withRun.endsWithAnswer, true);
  // Closing the follow-up leaves the post and its thread.
  assert.equal(sameResearchStrip(root, researchStrip(nodes, "post", null)), true);
  assert.equal(sameResearchStrip(root, withRun), false);
});

test("a follow-up note (a post under a post) opens as a post column and its thread column", () => {
  const nodes = [
    node("post", { type: "post" }),
    node("net", { type: "post", parentNodeId: "post", createdAt: 1 }),
    node("run", { parentNodeId: "net", createdAt: 2 }),
  ];
  const opened = researchStrip(nodes, "net", null);
  assert.deepEqual(ids(opened), ["N0", "T0", "N1", "T1"]);
  assert.equal(opened.levels[1].kind, "post");
  assert.equal(opened.levels[1].sourceId, "post");
  assert.equal(opened.endsWithAnswer, false);
  // Its own AI follow-up is an ordinary pair after it.
  assert.deepEqual(ids(researchStrip(nodes, "run", null)), ["N0", "T0", "N1", "T1", "T2", "A2"]);
});

test("a draft is the T0 messages column, and every column has one selector", () => {
  const draft = { id: "T0", role: "draft", draftId: "draft-1" } as const;
  assert.deepEqual(columnAttributes(draft), {
    "data-research-column": "T0",
    "data-research-pair": "messages",
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
  assert.equal(columnLevelIndex("P2"), null);
  assert.equal(columnLevelIndex("feed"), null);
  assert.equal(columnLevelIndex(undefined), null);
  assert.equal(isMessagesColumnId("T1"), true);
  assert.equal(isMessagesColumnId("P1"), false);
  assert.equal(isMessagesColumnId("A1"), false);
  assert.equal(isMessagesColumnId("feed"), false);
});

test("editing a document root adds the editor column after the root level's columns", () => {
  const doc = [
    node("doc", { type: "document" }),
    node("b1", { parentNodeId: "doc", createdAt: 1 }),
  ];
  const editing = researchStrip(doc, "doc", null, "doc");
  assert.deepEqual(ids(editing), ["T0", "A0", "E0", "T1"]);
  // The editor sits between the answer and the branches column.
  const editor = editing.columns[2];
  assert.deepEqual(editor, { id: "E0", role: "editor", levelIndex: 0, nodeId: "doc" });
  assert.equal(editing.columns[3].role, "branches");
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
});

test("editing the root note shows the editor column in place of the note column", () => {
  const nodes = [
    node("post", { type: "post" }),
    node("run", { parentNodeId: "post", createdAt: 1 }),
    node("net", { type: "post", parentNodeId: "post", createdAt: 2 }),
  ];
  const editing = researchStrip(nodes, "post", null, "post");
  assert.deepEqual(ids(editing), ["E0", "T0"]);
  assert.deepEqual(editing.columns[0], { id: "E0", role: "editor", levelIndex: 0, nodeId: "post" });
  assert.deepEqual(editing.columns.map((column) => column.role), ["editor", "thread"]);
  // The note column returns when editing ends; the swap changes the strip.
  const closed = researchStrip(nodes, "post", null);
  assert.deepEqual(ids(closed), ["N0", "T0"]);
  assert.equal(sameResearchStrip(editing, closed), false);
  assert.equal(sameResearchStrip(editing, researchStrip(nodes, "post", null, "post")), true);
  // An open follow-up stays open beside the editor.
  assert.deepEqual(ids(researchStrip(nodes, "run", null, "post")), ["E0", "T0", "T1", "A1"]);
  assert.deepEqual(ids(researchStrip(nodes, "net", null, "post")), ["E0", "T0", "N1", "T1"]);
  // A follow-up note's editor takes its level's note column; the root note
  // keeps its column.
  const followUp = researchStrip(nodes, "net", null, "net");
  assert.deepEqual(ids(followUp), ["N0", "T0", "E1", "T1"]);
  assert.deepEqual(followUp.columns[2], { id: "E1", role: "editor", levelIndex: 1, nodeId: "net" });
  assert.equal(columnLevelIndex("E1"), 1);
  assert.equal(columnKey(followUp.columns[2]), "E1:net");
  assert.equal(sameResearchStrip(followUp, researchStrip(nodes, "net", null)), false);
  // A follow-up note that is not open has no editor column.
  assert.deepEqual(ids(researchStrip(nodes, "run", null, "net")), ["N0", "T0", "T1", "A1"]);
  // An AI follow-up's level is not a note: it has no editor column.
  assert.deepEqual(ids(researchStrip(nodes, "run", null, "run")), ["N0", "T0", "T1", "A1"]);
});

test("settling the strip aligns the final column, or the column before a branches column holding only a pending branch", () => {
  const columns = [
    { id: "feed", left: 0, width: 300 },
    { id: "T0", left: 300, width: 300 },
    { id: "A0", left: 600, width: 400 },
    { id: "T1", left: 1000, width: 300, pendingOnly: true },
  ];
  // The pending branch is the final column: the strip scrolls to show it.
  assert.equal(researchStripSettleLeft(columns, 1100, null), 200);
  // Skipping it, the strip settles as it would without the branch.
  assert.equal(researchStripSettleLeft(columns, 1100, null, true), 0);
  assert.equal(researchStripSettleLeft(columns.slice(0, 3), 1100, null), 0);
  assert.equal(researchStripSettleLeft(columns, 700, null, true), 300);
  // A focused column stays in view, including a pending one.
  assert.equal(researchStripSettleLeft(columns, 700, "T0", true), 300);
  assert.equal(researchStripSettleLeft(columns, 700, "feed", true), 0);
  assert.equal(researchStripSettleLeft(columns, 700, "T1", true), 600);
  assert.equal(researchStripSettleLeft([], 700, null), null);
});

// root → c2 (inline). b1 branches from root and continues with b1f; x1
// branches from c2. b2 branches from b1f, y2 from x1.
const selectionNodes = () => [
  node("root", { createdAt: 0 }),
  node("c2", { parentNodeId: "root", inline: true, createdAt: 1 }),
  node("b1", { parentNodeId: "root", anchor: { kind: "passage", anchor }, createdAt: 2 }),
  node("b1f", { parentNodeId: "b1", inline: true, createdAt: 3 }),
  node("x1", { parentNodeId: "c2", createdAt: 4 }),
  node("b2", { parentNodeId: "b1f", createdAt: 5 }),
  node("y2", { parentNodeId: "x1", createdAt: 6 }),
];

const groupHeads = (column: ReturnType<typeof researchStrip>["columns"][number] | undefined) =>
  column?.role === "branches" ? column.groups.map((group) => (group.kind === "branch" ? group.headId : "pending")) : [];

test("each column keeps its own selection, and a branches column lists the branches of every message of the column before it", () => {
  const nodes = selectionNodes();
  // Column 0 selects c2 while column 1 selects b1f, a branch of root.
  const strip = researchStrip(nodes, ["c2", "b1f", "y2"], null);
  assert.deepEqual(ids(strip), ["T0", "A0", "T1", "A1", "T2", "A2"]);
  assert.deepEqual(strip.levels.map((level) => [level.headId, level.selectedId, level.sourceId]), [
    ["root", "c2", null],
    ["b1", "b1f", "root"],
    ["y2", "y2", "x1"],
  ]);
  // Column 1: the branches of root, then of c2, as column 0 lists them.
  assert.deepEqual(groupHeads(strip.columns[2]), ["b1", "x1"]);
  // Column 2: the branches of every message column 1 lists, in all of its
  // groups, not only the selected one.
  assert.deepEqual(groupHeads(strip.columns[4]), ["b2", "y2"]);
  assert.deepEqual(columnMessageIds(strip.columns[2]), ["b1", "b1f", "x1"]);
  // The answer columns show each column's selection.
  assert.deepEqual(
    strip.columns.flatMap((column) => (column.role === "answer" ? [column.nodeId] : [])),
    ["c2", "b1f", "y2"],
  );
  // Changing a column's selection leaves the listing of the columns after it
  // unchanged.
  const other = researchStrip(nodes, ["root", "x1", "y2"], null);
  assert.deepEqual(groupHeads(other.columns[2]), ["b1", "x1"]);
  assert.deepEqual(groupHeads(other.columns[4]), ["b2", "y2"]);
  assert.equal(columnKey(other.columns[2]), columnKey(strip.columns[2]));
  // A single id opens its source path.
  assert.deepEqual(researchStrip(nodes, "b2", null).levels.map((level) => level.selectedId), ["root", "b1f", "b2"]);
});

test("a selection is cut at the first message its column does not list", () => {
  const nodes = selectionNodes();
  assert.deepEqual(researchSelectionPath(nodes, ["c2", "b1f", "y2"]), ["c2", "b1f", "y2"]);
  // b2 is a branch of a column 2 message, not of column 1's.
  assert.deepEqual(researchSelectionPath(nodes, ["root", "b2"]), ["root"]);
  // Column 0 lists only the root's chain.
  assert.deepEqual(researchSelectionPath(nodes, ["b1", "b2"]), []);
  assert.deepEqual(researchSelectionPath(nodes, ["root", "missing", "b2"]), ["root"]);
  assert.deepEqual(researchStrip(nodes, ["root", "b2"], null).levels.length, 1);
});

test("selecting a node keeps the other columns' selections", () => {
  const nodes = selectionNodes();
  // A message of column 0: column 1 and 2 keep theirs.
  assert.deepEqual(researchSelectionWith(nodes, ["c2", "b1f", "y2"], "root"), ["root", "b1f", "y2"]);
  // A message of another group in column 1.
  assert.deepEqual(researchSelectionWith(nodes, ["c2", "b1f", "y2"], "x1"), ["c2", "x1", "y2"]);
  // A message of the first column without a selection.
  assert.deepEqual(researchSelectionWith(nodes, ["c2"], "b1"), ["c2", "b1"]);
  // A node no open column lists opens its source path.
  assert.deepEqual(researchSelectionWith(nodes, ["c2"], "b2"), ["root", "b1f", "b2"]);
});

test("selecting a node that no open column lists falls back to its source path", () => {
  const nodes = selectionNodes();
  // Nothing is open.
  assert.deepEqual(researchSelectionWith(nodes, [], "y2"), ["c2", "x1", "y2"]);
  // A selection that names a removed message is cut first; y2 is then not
  // listed by any column it leaves open.
  assert.deepEqual(researchSelectionWith(nodes, ["missing", "b1f"], "y2"), ["c2", "x1", "y2"]);
  // A node the next column lists is selected there, keeping the columns
  // before it; column 2 lists the branches of every group of column 1, so
  // y2 (a branch of x1) replaces b2 while column 1 keeps b1f.
  assert.deepEqual(researchSelectionWith(nodes, ["root", "b1f"], "b2"), ["root", "b1f", "b2"]);
  assert.deepEqual(researchSelectionWith(nodes, ["c2", "b1f", "b2"], "y2"), ["c2", "b1f", "y2"]);
  // A node the tree does not hold opens nothing.
  assert.deepEqual(researchSelectionWith(nodes, ["c2"], "missing"), []);
});

test("a removed selection falls back to its source or preceding message", () => {
  const nodes = selectionNodes();
  const parents = new Map(nodes.map((candidate) => [candidate.id, candidate.parentNodeId ?? null]));
  const survivor = (remaining: ResearchNode[]) => (nodeId: string) => {
    const ids = new Set(remaining.map((candidate) => candidate.id));
    for (let current = parents.get(nodeId) ?? null; current; current = parents.get(current) ?? null) {
      if (ids.has(current)) return current;
    }
    return null;
  };
  // b1f removed: column 1 selects b1, and column 2 keeps y2 (a branch of x1).
  const withoutB1f = nodes.filter((candidate) => candidate.id !== "b1f" && candidate.id !== "b2");
  assert.deepEqual(researchSelectionAfterRemoval(withoutB1f, ["c2", "b1f", "y2"], survivor(withoutB1f)), [
    "c2",
    "b1",
    "y2",
  ]);
  // x1 removed with y2: column 1's selection falls back to c2, which column
  // 1 does not list, so column 1 and the columns after it close.
  const withoutX1 = nodes.filter((candidate) => candidate.id !== "x1" && candidate.id !== "y2");
  assert.deepEqual(researchSelectionAfterRemoval(withoutX1, ["c2", "x1", "y2"], survivor(withoutX1)), ["c2"]);
});

test("a thread reopens with its saved selection, in either saved format", () => {
  const nodes = selectionNodes();
  const levelsOf = (selection: string | readonly string[]) =>
    researchStrip(nodes, selection, null).levels.map((level) => level.selectedId);
  // Saved before each column kept its selection: the deepest message alone
  // opens its source path.
  const legacy = researchRestoredSelection(nodes, "root", "b2");
  assert.equal(legacy, "b2");
  assert.deepEqual(levelsOf(legacy), ["root", "b1f", "b2"]);
  // Every column's selection.
  assert.deepEqual(researchRestoredSelection(nodes, "root", ["c2", "b1f", "b2"]), ["c2", "b1f", "b2"]);
  // A path the tree no longer lists in full is cut where it stops.
  assert.deepEqual(researchRestoredSelection(nodes, "root", ["c2", "missing", "b2"]), ["c2"]);
  // Nothing saved, or nothing the tree shows: the last message of the
  // root's chain.
  assert.equal(researchRestoredSelection(nodes, "root", null), "c2");
  assert.equal(researchRestoredSelection(nodes, "root", "missing"), "c2");
  assert.equal(researchRestoredSelection(nodes, "root", ["b1", "b2"]), "c2");
});

