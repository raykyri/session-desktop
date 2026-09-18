import type { JournalEntry, RecentActivityCursor, RecentActivityItem } from "@session/shared";
import test from "ava";

import { feeds, journal, nodes, trees, workspaces } from "../src/index.js";

import { createFixture } from "./helpers.js";

function linkEntry(id: string, at: number): JournalEntry {
  return {
    id,
    kind: "link",
    url: `https://example.com/${id}`,
    createdAt: new Date(at).toISOString(),
  };
}

function itemId(item: RecentActivityItem): string {
  return item.kind === "journal" ? item.entry.id : item.query.nodeId;
}

test("the feed merges both sources under one cursor, newest first", (t) => {
  const fixture = createFixture(t);
  const base = 1_700_000_000_000;
  journal.add(fixture.db, fixture.userId, linkEntry("j1", base + 1000));
  const research = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "A question",
    model: "gemini-flash",
    nodeId: "n1",
  });
  fixture.db.$client
    .prepare(`UPDATE nodes SET created_at = ? WHERE id = ?`)
    .run(base + 2000, research.tree.rootNodeId);
  journal.add(fixture.db, fixture.userId, linkEntry("j2", base + 3000));

  const page = feeds.recentActivity(fixture.db, fixture.userId, { limit: 10 });
  t.deepEqual(page.items.map(itemId), ["j2", "n1", "j1"]);
  t.is(page.nextCursor, null);
});

test("a tie in occurredAt is broken by source rank, research first", (t) => {
  const fixture = createFixture(t);
  const at = 1_700_000_000_000;
  journal.add(fixture.db, fixture.userId, linkEntry("j1", at));
  const research = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "A question",
    model: "gemini-flash",
    nodeId: "n1",
  });
  fixture.db.$client
    .prepare(`UPDATE nodes SET created_at = ? WHERE id = ?`)
    .run(at, research.tree.rootNodeId);
  const page = feeds.recentActivity(fixture.db, fixture.userId, { limit: 10 });
  t.deepEqual(page.items.map(itemId), ["n1", "j1"]);
});

test("pagination walks the whole feed exactly once across ties", (t) => {
  const fixture = createFixture(t);
  const at = 1_700_000_000_000;
  for (let index = 0; index < 4; index += 1) {
    journal.add(fixture.db, fixture.userId, linkEntry(`j${index}`, at));
  }
  for (let index = 0; index < 4; index += 1) {
    const detail = trees.admitRoot(fixture.db, fixture.userId, {
      workspaceId: fixture.workspaceId,
      prompt: `Question ${index}`,
      model: "gemini-flash",
      nodeId: `n${index}`,
    });
    fixture.db.$client
      .prepare(`UPDATE nodes SET created_at = ? WHERE id = ?`)
      .run(at, detail.tree.rootNodeId);
  }
  const seen: string[] = [];
  let cursor: RecentActivityCursor | null = null;
  for (let page = 0; page < 10; page += 1) {
    const result = feeds.recentActivity(fixture.db, fixture.userId, { limit: 3, before: cursor });
    seen.push(...result.items.map(itemId));
    if (!result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
  }
  t.is(seen.length, 8);
  t.is(new Set(seen).size, 8);
  t.deepEqual(seen, ["n3", "n2", "n1", "n0", "j3", "j2", "j1", "j0"]);
});

test("the limit is clamped to 1..100", (t) => {
  const fixture = createFixture(t);
  for (let index = 0; index < 3; index += 1) {
    journal.add(fixture.db, fixture.userId, linkEntry(`j${index}`, 1_700_000_000_000 + index));
  }
  t.is(feeds.recentActivity(fixture.db, fixture.userId, { limit: 0 }).items.length, 1);
  t.is(feeds.recentActivity(fixture.db, fixture.userId, { limit: -5 }).items.length, 1);
  t.is(feeds.recentActivity(fixture.db, fixture.userId, { limit: 1000 }).items.length, 3);
});

test("excludes archived threads and follow-ups from the feed while including thread children", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Root",
    model: "gemini-flash",
    nodeId: "root-1",
    status: "complete",
  });
  const first = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: "root-1",
    prompt: "First follow-up",
    nodeId: "child-1",
  });
  nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: "root-1",
    prompt: "Second follow-up",
    nodeId: "child-2",
  });
  t.is(first.parentNodeId, "root-1");

  const page = feeds.recentActivity(fixture.db, fixture.userId, { limit: 10 });
  t.deepEqual(page.items.map(itemId), ["root-1"]);
  const item = page.items[0];
  t.is(item?.kind, "research-query");
  if (item?.kind === "research-query") {
    t.deepEqual(
      (item.query.children ?? []).map((child) => child.nodeId),
      ["child-1", "child-2"],
    );
  }

  trees.archive(fixture.db, fixture.userId, detail.tree.id);
  t.deepEqual(feeds.recentActivity(fixture.db, fixture.userId, { limit: 10 }).items, []);
});

test("the workspace filter narrows research and keeps journal entries", (t) => {
  const fixture = createFixture(t);
  const other = workspaces.create(fixture.db, fixture.userId, "Reading");
  journal.add(fixture.db, fixture.userId, linkEntry("j1", 1_700_000_000_000));
  trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Here",
    model: "gemini-flash",
    nodeId: "here",
  });
  trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: other.id,
    prompt: "There",
    model: "gemini-flash",
    nodeId: "there",
  });
  fixture.db.$client
    .prepare(`UPDATE nodes SET created_at = ? WHERE id = ?`)
    .run(1_700_000_002_000, "here");
  const page = feeds.recentActivity(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    limit: 10,
  });
  t.deepEqual(page.items.map(itemId), ["here", "j1"], "the journal keeps its place in the order");
});

test("bookmarkedOnly shows bookmarked threads and no journal entries", (t) => {
  const fixture = createFixture(t);
  journal.add(fixture.db, fixture.userId, linkEntry("j1", 1_700_000_000_000));
  const bookmarked = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Kept",
    model: "gemini-flash",
    nodeId: "kept",
  });
  trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Not kept",
    model: "gemini-flash",
    nodeId: "not-kept",
  });
  trees.setBookmarked(fixture.db, fixture.userId, bookmarked.tree.id, true);
  const page = feeds.recentActivity(fixture.db, fixture.userId, {
    bookmarkedOnly: true,
    limit: 10,
  });
  t.deepEqual(page.items.map(itemId), ["kept"]);
});

test("paginates only root research questions in recentQueries", (t) => {
  const fixture = createFixture(t);
  const at = 1_700_000_000_000;
  for (let index = 0; index < 3; index += 1) {
    const detail = trees.admitRoot(fixture.db, fixture.userId, {
      workspaceId: fixture.workspaceId,
      prompt: `Question ${index}`,
      model: "gemini-flash",
      nodeId: `n${index}`,
    });
    fixture.db.$client
      .prepare(`UPDATE nodes SET created_at = ? WHERE id = ?`)
      .run(at + index, detail.tree.rootNodeId);
  }
  const first = feeds.recentQueries(fixture.db, fixture.userId, { limit: 2 });
  t.deepEqual(
    first.items.map((item) => item.nodeId),
    ["n2", "n1"],
  );
  t.not(first.nextCursor, null);
  const second = feeds.recentQueries(fixture.db, fixture.userId, {
    limit: 2,
    before: first.nextCursor,
  });
  t.deepEqual(
    second.items.map((item) => item.nodeId),
    ["n0"],
  );
  t.is(second.nextCursor, null);
});

test("another account's rows never appear", (t) => {
  const fixture = createFixture(t);
  journal.add(fixture.db, fixture.userId, linkEntry("j1", 1_700_000_000_000));
  t.deepEqual(feeds.recentActivity(fixture.db, "someone-else", { limit: 10 }).items, []);
});
