import test from "ava";

import {
  JOURNAL_ACTIVITY_SOURCE_RANK,
  RESEARCH_ACTIVITY_SOURCE_RANK,
  activityCursorIsBefore,
  compareRecentActivityItems,
  recentActivityItemCursor,
  recentActivityItemId,
} from "../src/journal/cursor.js";
import type { RecentActivityItem } from "../src/types/activity.js";
import type { RecentActivityCursor } from "../src/types/research.js";

function journalItem(id: string, occurredAt: number): RecentActivityItem {
  return {
    kind: "journal",
    occurredAt,
    entry: {
      kind: "link",
      id,
      createdAt: new Date(occurredAt).toISOString(),
      url: "https://e.com",
    },
  };
}

function researchItem(nodeId: string, occurredAt: number): RecentActivityItem {
  return {
    kind: "research-query",
    occurredAt,
    query: {
      nodeId,
      treeId: "tree",
      parentNodeId: null,
      inline: false,
      prompt: "Question",
      model: "gemini-flash",
      status: "complete",
      createdAt: occurredAt,
    },
  };
}

const cursor = (occurredAt: number, sourceRank: number, id: string): RecentActivityCursor => ({
  occurredAt,
  sourceRank,
  id,
});

test("item identity and cursor carry the source", (t) => {
  t.is(recentActivityItemId(journalItem("a", 1)), "journal:a");
  t.is(recentActivityItemId(researchItem("a", 1)), "research:a");
  t.deepEqual(recentActivityItemCursor(journalItem("a", 5)), {
    occurredAt: 5,
    sourceRank: JOURNAL_ACTIVITY_SOURCE_RANK,
    id: "a",
  });
  t.deepEqual(recentActivityItemCursor(researchItem("a", 5)), {
    occurredAt: 5,
    sourceRank: RESEARCH_ACTIVITY_SOURCE_RANK,
    id: "a",
  });
});

test("items sort by occurredAt descending", (t) => {
  const items = [journalItem("old", 100), journalItem("new", 300), journalItem("mid", 200)];
  t.deepEqual([...items].sort(compareRecentActivityItems).map(recentActivityItemId), [
    "journal:new",
    "journal:mid",
    "journal:old",
  ]);
});

test("a tie on occurredAt puts research ahead of journal", (t) => {
  const items = [journalItem("a", 200), researchItem("z", 200)];
  t.deepEqual([...items].sort(compareRecentActivityItems).map(recentActivityItemId), [
    "research:z",
    "journal:a",
  ]);
});

test("a tie on occurredAt and source falls back to id descending", (t) => {
  const items = [journalItem("a", 200), journalItem("c", 200), journalItem("b", 200)];
  t.deepEqual([...items].sort(compareRecentActivityItems).map(recentActivityItemId), [
    "journal:c",
    "journal:b",
    "journal:a",
  ]);
  // The order is by code unit, the same comparison the cursor predicate uses,
  // so an uppercase id does not sort as if it were lowercase.
  const mixed = [journalItem("B", 200), journalItem("a", 200)];
  t.deepEqual([...mixed].sort(compareRecentActivityItems).map(recentActivityItemId), [
    "journal:a",
    "journal:B",
  ]);
});

test("the cursor predicate agrees with the sort on every component", (t) => {
  const boundary = cursor(200, RESEARCH_ACTIVITY_SOURCE_RANK, "m");
  // Older by time.
  t.true(activityCursorIsBefore(cursor(199, RESEARCH_ACTIVITY_SOURCE_RANK, "m"), boundary));
  t.false(activityCursorIsBefore(cursor(201, JOURNAL_ACTIVITY_SOURCE_RANK, "a"), boundary));
  // Same time, lower source rank sorts after the boundary.
  t.true(activityCursorIsBefore(cursor(200, JOURNAL_ACTIVITY_SOURCE_RANK, "z"), boundary));
  // Same time and source, lower id sorts after the boundary.
  t.true(activityCursorIsBefore(cursor(200, RESEARCH_ACTIVITY_SOURCE_RANK, "l"), boundary));
  t.false(activityCursorIsBefore(cursor(200, RESEARCH_ACTIVITY_SOURCE_RANK, "n"), boundary));
  // The boundary itself is not before itself, so a page never repeats it.
  t.false(activityCursorIsBefore(boundary, boundary));
});

test("the predicate holds for every ordered pair the sort produces", (t) => {
  const items = [
    journalItem("a", 200),
    journalItem("b", 200),
    researchItem("a", 200),
    journalItem("a", 100),
    researchItem("z", 300),
  ].sort(compareRecentActivityItems);
  for (let index = 0; index + 1 < items.length; index += 1) {
    const earlier = items[index];
    const later = items[index + 1];
    if (!earlier || !later) continue;
    t.true(
      activityCursorIsBefore(recentActivityItemCursor(later), recentActivityItemCursor(earlier)),
      `${recentActivityItemId(later)} should page after ${recentActivityItemId(earlier)}`,
    );
  }
});
