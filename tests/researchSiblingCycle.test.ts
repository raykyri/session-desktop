import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleIndex,
  feedCycleStep,
  researchCycleColumn,
  researchCycleDirection,
} from "../src/lib/researchSiblingCycle";
import { researchStrip, type ResearchColumnId } from "../src/lib/researchColumns";
import type { ResearchNode } from "../src/types";

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

const node = (id: string, overrides: Partial<ResearchNode> = {}): ResearchNode => ({
  id,
  treeId: "tree",
  prompt: id,
  adapter: "claude",
  groupId: "ws",
  worktreeDir: "/ws",
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

test("an answer column cycles its level's messages column", () => {
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
  const candidates = strip.columns.filter((column) => column.role === "messages").map((column) => column.id);
  assert.equal(researchCycleColumn(candidates, "A0"), "T0");
  assert.equal(researchCycleColumn(candidates, "A1"), "T1");
});

test("a column without rows falls back to the nearest column with rows to its left", () => {
  // An unsent branch after level 1, and the root's editor after level 0.
  const nodes = [node("root"), node("branch", { parentNodeId: "root", inline: false })];
  const pending = researchStrip(nodes, "branch", { parentNodeId: "branch", anchor: null }, "root");
  assert.deepEqual(
    pending.columns.map((column) => column.id),
    ["T0", "A0", "E0", "T1", "A1", "P2"],
  );
  const candidates = pending.columns.filter((column) => column.role === "messages").map((column) => column.id);
  assert.equal(researchCycleColumn(candidates, "E0"), "T0");
  assert.equal(researchCycleColumn(candidates, "P2"), "T1");
  // A level that closed since: the nearest remaining column to its left.
  assert.equal(researchCycleColumn(candidates, "T4"), "T1");
  assert.equal(researchCycleColumn(candidates, "A3"), "T1");
});

test("a post's own column and an empty thread fall back to the feed", () => {
  const nodes = [node("post", { kind: "note" })];
  const strip = researchStrip(nodes, "post", null, "post");
  assert.deepEqual(
    strip.columns.map((column) => column.id),
    ["N0", "T0", "E0"],
  );
  // The thread has rows: the editor and the thread cycle it; the post is
  // left of it.
  assert.equal(researchCycleColumn(["T0"], "E0"), "T0");
  assert.equal(researchCycleColumn(["T0"], "T0"), "T0");
  assert.equal(researchCycleColumn(["T0"], "N0"), "feed");
  // No replies or follow-ups: nothing to cycle in the strip.
  assert.equal(researchCycleColumn([], "T0"), "feed");
  assert.equal(researchCycleColumn([], "E0"), "feed");
});

const lists = [
  [
    { key: "tree:a", children: [] },
    { key: "tree:b", children: ["b1", "b2", "b3"] },
    { key: "tree:c", children: [] },
  ],
  [
    { key: "draft:d", children: [] },
    { key: "tree:e", children: [] },
  ],
];

test("a feed card steps among the cards of its own list, wrapping", () => {
  assert.deepEqual(feedCycleStep(lists, { key: "tree:a", child: null }, 1), { key: "tree:b", child: null });
  assert.deepEqual(feedCycleStep(lists, { key: "tree:c", child: null }, 1), { key: "tree:a", child: null });
  assert.deepEqual(feedCycleStep(lists, { key: "tree:a", child: null }, -1), { key: "tree:c", child: null });
  // A card with child rows steps to the next card, not into its children.
  assert.deepEqual(feedCycleStep(lists, { key: "tree:b", child: null }, 1), { key: "tree:c", child: null });
  // The second list (a tray) keeps to itself.
  assert.deepEqual(feedCycleStep(lists, { key: "tree:e", child: null }, 1), { key: "draft:d", child: null });
  assert.deepEqual(feedCycleStep(lists, { key: "draft:d", child: null }, -1), { key: "tree:e", child: null });
});

test("a feed child row steps among its card's child rows, wrapping", () => {
  assert.deepEqual(feedCycleStep(lists, { key: "tree:b", child: "b1" }, 1), { key: "tree:b", child: "b2" });
  assert.deepEqual(feedCycleStep(lists, { key: "tree:b", child: "b3" }, 1), { key: "tree:b", child: "b1" });
  assert.deepEqual(feedCycleStep(lists, { key: "tree:b", child: "b1" }, -1), { key: "tree:b", child: "b3" });
  // A child row no longer listed: the card steps instead.
  assert.deepEqual(feedCycleStep(lists, { key: "tree:b", child: "gone" }, 1), { key: "tree:c", child: null });
});

test("with no current feed row, the step starts at an end of the first non-empty list", () => {
  assert.deepEqual(feedCycleStep(lists, null, 1), { key: "tree:a", child: null });
  assert.deepEqual(feedCycleStep(lists, null, -1), { key: "tree:c", child: null });
  assert.deepEqual(feedCycleStep(lists, { key: "tree:unlisted", child: null }, 1), { key: "tree:a", child: null });
  assert.deepEqual(feedCycleStep([[], lists[1]], null, 1), { key: "draft:d", child: null });
  assert.equal(feedCycleStep([[], []], null, 1), null);
  assert.equal(feedCycleStep([], { key: "tree:a", child: null }, -1), null);
});
