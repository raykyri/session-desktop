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
  researchStrip,
  researchStripSettleLeft,
  sameResearchStrip,
} from "../src/lib/researchColumns";
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
  assert.deepEqual(strip.openNodeIds, ["root"]);
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
  // The feed selects the root level's message and each branch's head.
  assert.deepEqual(strip.openNodeIds, ["c2", "b1", "b2"]);
  assert.equal(strip.endsWithAnswer, true);
  assert.deepEqual(columnAttributes(strip.columns[5]), {
    "data-research-column": "A2",
    "data-research-pair": "answer",
    "data-research-level": "2",
  });
  // Each branch level's messages column is the branches column after the
  // level it was asked from.
  assert.deepEqual(strip.columns.map((column) => column.role), [
    "messages",
    "answer",
    "branches",
    "answer",
    "branches",
    "answer",
  ]);
  assert.deepEqual(columnScrollKey(strip.columns[2]), { kind: "branches", key: "root" });
  assert.deepEqual(columnScrollKey(strip.columns[3]), { kind: "answer", key: "b1f" });
  assert.deepEqual(columnScrollKey(strip.columns[4]), { kind: "branches", key: "b1" });
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
  assert.equal(columnKey(branches), "T1:branches:root");
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
  assert.equal(columnKey(column), "T2:branches:b1");
  // The open nodes do not include the unsent branch.
  assert.deepEqual(strip.openNodeIds, ["root", "b1"]);
  // A pending branch asked from a message that is not the deepest selection
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
    node("post", { type: "post", delivery: { status: "posted", postedAt: 1, replies: [] } }),
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
  assert.deepEqual(withRun.openNodeIds, ["post", "run"]);
  // Closing the follow-up leaves the post and its thread.
  assert.equal(sameResearchStrip(root, researchStrip(nodes, "post", null)), true);
  assert.equal(sameResearchStrip(root, withRun), false);
});

test("a network follow-up (a post under a post) opens as a post column and its thread column", () => {
  const delivery = { status: "posted" as const, postedAt: 1, replies: [] };
  const nodes = [
    node("post", { type: "post", delivery }),
    node("net", { type: "post", parentNodeId: "post", createdAt: 1, delivery }),
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
  const delivery = { status: "posted" as const, postedAt: 1, replies: [] };
  const nodes = [
    node("post", { type: "post", delivery }),
    node("run", { parentNodeId: "post", createdAt: 1 }),
    node("net", { type: "post", parentNodeId: "post", createdAt: 2, delivery }),
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
