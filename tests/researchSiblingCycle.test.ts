import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleIndex,
  feedCycleStep,
  researchCycleColumn,
  researchCycleDirection,
} from "../src/lib/researchSiblingCycle";
import { columnMessageIds, researchStrip, type ResearchColumnId } from "../src/lib/researchColumns";
import type { ResearchNode } from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

const key = (overrides: Partial<Parameters<typeof researchCycleDirection>[0]> = {}) => ({
  key: "Tab",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("⌃Tab steps forward and ⌃⇧Tab backward; ⌥, ⌘ and plain Tab are not cycle keys", () => {
  assert.equal(researchCycleDirection(key()), 1);
  assert.equal(researchCycleDirection(key({ shiftKey: true })), -1);
  assert.equal(researchCycleDirection(key({ ctrlKey: false })), null);
  assert.equal(researchCycleDirection(key({ ctrlKey: false, shiftKey: true })), null);
  assert.equal(researchCycleDirection(key({ metaKey: true })), null);
  assert.equal(researchCycleDirection(key({ altKey: true })), null);
  assert.equal(researchCycleDirection(key({ altKey: true, shiftKey: true })), null);
  assert.equal(researchCycleDirection(key({ key: "a" })), null);
});

test("cycleIndex wraps at both ends and starts at an end with no current item", () => {
  assert.equal(cycleIndex(3, 0, 1), 1);
  assert.equal(cycleIndex(3, 2, 1), 0);
  assert.equal(cycleIndex(3, 0, -1), 2);
  assert.equal(cycleIndex(3, 1, -1), 0);
  assert.equal(cycleIndex(1, 0, 1), 0);
  assert.equal(cycleIndex(3, -1, 1), 0);
  assert.equal(cycleIndex(3, -1, -1), 2);
  assert.equal(cycleIndex(3, 7, 1), 0);
  assert.equal(cycleIndex(0, 0, 1), -1);
  assert.equal(cycleIndex(0, -1, -1), -1);
});

const node = (id: string, overrides: NodeFixture = {}): ResearchNode =>
  researchNode({
  id,
  treeId: "tree",
  prompt: id,
  adapter: "claude",
  groupId: "ws",
  status: "complete",
  createdAt: 1,
  highlights: [],
  ...overrides,
  });

test("the cycled column is the one last interacted with when it has rows", () => {
  const candidates: ResearchColumnId[] = ["T0", "T1"];
  assert.equal(researchCycleColumn(candidates, "T0"), "T0");
  assert.equal(researchCycleColumn(candidates, "T1"), "T1");
  assert.equal(researchCycleColumn(candidates, "feed"), "feed");
  assert.equal(researchCycleColumn(candidates, null), "feed");
  assert.equal(researchCycleColumn(candidates, "placeholder"), "feed");
});

/** The columns ⌃Tab can cycle, as useResearchPairsKeyboard lists them
 * (without follow-ups columns, which these strips do not have). */
const cycleCandidates = (strip: ReturnType<typeof researchStrip>) =>
  strip.columns.flatMap((column) =>
    column.role === "messages" || (column.role === "branches" && columnMessageIds(column).length > 0)
      ? [column.id]
      : [],
  );

test("an answer column cycles its level's messages column, and a branch's answer the branches column", () => {
  // A root with an inline follow-up, and a branch from the follow-up.
  const nodes = [
    node("root"),
    node("next", { parentNodeId: "root", inline: true }),
    node("branch", { parentNodeId: "next", inline: false }),
  ];
  const strip = researchStrip(nodes, "branch", null);
  assert.deepEqual(
    strip.columns.map((column) => column.id),
    ["T0", "A0", "T1", "A1"],
  );
  assert.deepEqual(strip.columns.map((column) => column.role), ["messages", "answer", "branches", "answer"]);
  const candidates = cycleCandidates(strip);
  assert.equal(researchCycleColumn(candidates, "A0"), "T0");
  assert.equal(researchCycleColumn(candidates, "A1"), "T1");
});

test("a column without rows falls back to the nearest column with rows to its left", () => {
  // An unsent branch after level 1, and the root's editor after level 0.
  const nodes = [node("root"), node("branch", { parentNodeId: "root", inline: false })];
  const pending = researchStrip(nodes, "branch", { parentNodeId: "branch", anchor: null }, "root");
  assert.deepEqual(
    pending.columns.map((column) => column.id),
    ["T0", "A0", "E0", "T1", "A1", "T2"],
  );
  // T2 holds only the unsent branch: it has no rows to cycle.
  const candidates = cycleCandidates(pending);
  assert.deepEqual(candidates, ["T0", "T1"]);
  assert.equal(researchCycleColumn(candidates, "E0"), "T0");
  assert.equal(researchCycleColumn(candidates, "T2"), "T1");
  // A level that closed since: the nearest remaining column to its left.
  assert.equal(researchCycleColumn(candidates, "T4"), "T1");
  assert.equal(researchCycleColumn(candidates, "A3"), "T1");
});

test("a post's own column and an empty thread fall back to the feed", () => {
  const nodes = [node("post", { type: "post" })];
  const strip = researchStrip(nodes, "post", null, "post");
  assert.deepEqual(
    strip.columns.map((column) => column.id),
    ["E0", "T0"],
  );
  // The follow-ups column has rows: the editor (in the note column's place)
  // and the follow-ups column cycle it, so ⌃Tab in the editor keeps the
  // thread open; the note is left of it and cycles the feed.
  assert.equal(researchCycleColumn(["T0"], "E0"), "T0");
  assert.equal(researchCycleColumn(["T0"], "T0"), "T0");
  assert.equal(researchCycleColumn(["T0"], "N0"), "feed");
  // No follow-ups: nothing to cycle in the strip.
  assert.equal(researchCycleColumn([], "T0"), "feed");
  assert.equal(researchCycleColumn([], "E0"), "feed");
});

const lists = [
  ["tree:a", "tree:b", "tree:c"],
  ["draft:d", "tree:e"],
];

test("a feed card steps among the cards of its own list, wrapping", () => {
  assert.equal(feedCycleStep(lists, "tree:a", 1), "tree:b");
  assert.equal(feedCycleStep(lists, "tree:c", 1), "tree:a");
  assert.equal(feedCycleStep(lists, "tree:a", -1), "tree:c");
  // The second list (a tray) keeps to itself.
  assert.equal(feedCycleStep(lists, "tree:e", 1), "draft:d");
  assert.equal(feedCycleStep(lists, "draft:d", -1), "tree:e");
});

test("with no current feed row, the step starts at an end of the first non-empty list", () => {
  assert.equal(feedCycleStep(lists, null, 1), "tree:a");
  assert.equal(feedCycleStep(lists, null, -1), "tree:c");
  assert.equal(feedCycleStep(lists, "tree:unlisted", 1), "tree:a");
  assert.equal(feedCycleStep([[], lists[1]], null, 1), "draft:d");
  assert.equal(feedCycleStep([[], []], null, 1), null);
  assert.equal(feedCycleStep([], "tree:a", -1), null);
});
