import type { RecentActivityCursor, RecentActivityItem } from "@session/shared";
import test from "ava";

import {
  feedgen,
  feedItems,
  feeds,
  nodes,
  posts,
  sharing,
  trash,
  trees,
  workspaces,
} from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

function itemId(item: RecentActivityItem): string {
  return item.query.nodeId;
}

/** A root question whose `created_at` is pinned, so the feed order is known. */
function rootAt(fixture: ReturnType<typeof createFixture>, nodeId: string, at: number): void {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: `Question ${nodeId}` },
    agent: { model: "gemini-flash" },
    nodeId,
  });
  fixture.db.$client
    .prepare(`UPDATE nodes SET created_at = ? WHERE id = ?`)
    .run(at, detail.tree.rootNodeId);
  feedgen.upsertResearchRoot(fixture.db, detail.tree.rootNodeId);
}

test("the feed lists root questions newest first", (t) => {
  const fixture = createFixture(t);
  const base = 1_700_000_000_000;
  rootAt(fixture, "n1", base + 1000);
  rootAt(fixture, "n2", base + 3000);
  rootAt(fixture, "n3", base + 2000);

  const page = feeds.recentActivity(fixture.db, fixture.userId, { limit: 10 });
  t.deepEqual(page.items.map(itemId), ["n2", "n3", "n1"]);
  t.is(page.nextCursor, null);
});

test("pagination walks the whole feed exactly once across ties", (t) => {
  const fixture = createFixture(t);
  const at = 1_700_000_000_000;
  for (let index = 0; index < 8; index += 1) {
    rootAt(fixture, `n${index}`, at);
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
  t.deepEqual(seen, ["n7", "n6", "n5", "n4", "n3", "n2", "n1", "n0"]);
});

test("the limit is clamped to 1..100", (t) => {
  const fixture = createFixture(t);
  for (let index = 0; index < 3; index += 1) {
    rootAt(fixture, `n${index}`, 1_700_000_000_000 + index);
  }
  t.is(feeds.recentActivity(fixture.db, fixture.userId, { limit: 0 }).items.length, 1);
  t.is(feeds.recentActivity(fixture.db, fixture.userId, { limit: -5 }).items.length, 1);
  t.is(feeds.recentActivity(fixture.db, fixture.userId, { limit: 1000 }).items.length, 3);
});

test("excludes archived threads and follow-ups from the feed while including thread children", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Root" },
    agent: { model: "gemini-flash" },
    nodeId: "root-1",
    status: "complete",
  });
  const first = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: "root-1",
    message: { text: "First follow-up" },
    nodeId: "child-1",
  });
  nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: "root-1",
    message: { text: "Second follow-up" },
    nodeId: "child-2",
  });
  t.is(first.parentNodeId, "root-1");

  const page = feeds.recentActivity(fixture.db, fixture.userId, { limit: 10 });
  t.deepEqual(page.items.map(itemId), ["root-1"]);
  const item = page.items[0];
  t.is(item?.kind, "research-query");
  t.deepEqual(
    (item?.query.children ?? []).map((child) => child.nodeId),
    ["child-1", "child-2"],
  );

  trees.archive(fixture.db, fixture.userId, detail.tree.id);
  t.deepEqual(feeds.recentActivity(fixture.db, fixture.userId, { limit: 10 }).items, []);
});

test("the workspace filter narrows the feed to one workspace", (t) => {
  const fixture = createFixture(t);
  const other = workspaces.create(fixture.db, fixture.userId, "Reading");
  trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Here" },
    agent: { model: "gemini-flash" },
    nodeId: "here",
  });
  trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: other.id,
    message: { text: "There" },
    agent: { model: "gemini-flash" },
    nodeId: "there",
  });
  const page = feeds.recentActivity(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    limit: 10,
  });
  t.deepEqual(page.items.map(itemId), ["here"]);
});

test("feedgen materializes writes and removes archived or deleted sources", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Root" },
    agent: { model: "gemini-flash" },
    nodeId: "root-row",
    status: "complete",
  });
  nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: "root-row",
    message: { text: "Child" },
    nodeId: "child-row",
  });
  nodes.setStatus(fixture.db, fixture.userId, "child-row", "cancelled");

  t.is(feedItems.forNode(fixture.db, "root-row")?.authorId, fixture.userId);
  t.is(feedItems.forNode(fixture.db, "root-row")?.workspaceId, fixture.workspaceId);
  t.is(feedItems.forNode(fixture.db, "child-row"), null);

  trees.archive(fixture.db, fixture.userId, detail.tree.id);
  t.is(feedItems.forNode(fixture.db, "root-row"), null);
  trees.restore(fixture.db, fixture.userId, detail.tree.id);
  t.truthy(feedItems.forNode(fixture.db, "root-row"));
  trees.remove(fixture.db, fixture.userId, detail.tree.id);
  t.is(feedItems.forNode(fixture.db, "root-row"), null);
});

test("all lists public threads only; mine and workspace read the caller's own", (t) => {
  const fixture = createFixture(t);
  const otherWorkspace = workspaces.create(fixture.db, fixture.userId, "Other");
  const stranger = addUser(fixture.db, "stranger-feed");
  trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Mine here" },
    agent: { model: "gemini-flash" },
    nodeId: "mine-here",
  });
  trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: otherWorkspace.id,
    message: { text: "Mine elsewhere" },
    agent: { model: "gemini-flash" },
    nodeId: "mine-elsewhere",
  });
  const strangerRoot = trees.admitRoot(fixture.db, stranger.userId, {
    type: "exchange",
    workspaceId: stranger.workspaceId,
    message: { text: "Stranger root" },
    agent: { model: "gemini-flash" },
    nodeId: "stranger-root",
  });
  trees.admitRoot(fixture.db, stranger.userId, {
    type: "exchange",
    workspaceId: stranger.workspaceId,
    message: { text: "Stranger private" },
    agent: { model: "gemini-flash" },
    nodeId: "stranger-private",
  });
  sharing.setVisibility(fixture.db, stranger.userId, strangerRoot.tree.id, "public");
  for (const detail of trees.summaries(fixture.db, fixture.userId)) {
    sharing.setVisibility(fixture.db, fixture.userId, detail.id, "public");
  }

  const all = feeds.recentActivity(fixture.db, null, { scope: "all", limit: 20 });
  t.deepEqual(
    all.items.map(itemId).sort(),
    ["mine-here", "mine-elsewhere", "stranger-root"].sort(),
  );

  const mine = feeds.recentActivity(fixture.db, fixture.userId, { scope: "mine", limit: 20 });
  t.deepEqual(mine.items.map(itemId).sort(), ["mine-here", "mine-elsewhere"].sort());
  const workspace = feeds.recentActivity(fixture.db, fixture.userId, {
    scope: "workspace",
    workspaceId: fixture.workspaceId,
    limit: 20,
  });
  t.deepEqual(workspace.items.map(itemId), ["mine-here"]);
});

test("paginates only root research questions in recentQueries", (t) => {
  const fixture = createFixture(t);
  const at = 1_700_000_000_000;
  for (let index = 0; index < 3; index += 1) {
    const detail = trees.admitRoot(fixture.db, fixture.userId, {
      type: "exchange",
      workspaceId: fixture.workspaceId,
      message: { text: `Question ${index}` },
      agent: { model: "gemini-flash" },
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
  rootAt(fixture, "n1", 1_700_000_000_000);
  t.deepEqual(feeds.recentActivity(fixture.db, "someone-else", { limit: 10 }).items, []);
});

test("recentQueriesForTrees reads the named roots in order, with their follow-ups", (t) => {
  const fixture = createFixture(t);
  const at = 1_700_000_000_000;
  rootAt(fixture, "n1", at);
  rootAt(fixture, "n2", at + 1);
  const note = posts.admitPost(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    text: "A note",
    agent: { model: "gemini-flash" },
  });
  posts.admitFollowUpNote(fixture.db, fixture.userId, note.tree.rootNodeId, "A follow-up", []);
  const archived = posts.admitPost(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    text: "Archived",
    agent: { model: "gemini-flash" },
  });
  trees.archive(fixture.db, fixture.userId, archived.tree.id);
  const trashed = posts.admitPost(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    text: "Trashed",
    agent: { model: "gemini-flash" },
  });
  trash.trashTree(fixture.db, fixture.userId, trashed.tree.id);
  const treeOf = (nodeId: string) => nodes.get(fixture.db, fixture.userId, nodeId)?.treeId ?? "";

  const roots = feeds.recentQueriesForTrees(fixture.db, fixture.userId, [
    note.tree.id,
    treeOf("n2"),
    archived.tree.id,
    trashed.tree.id,
    treeOf("n1"),
    note.tree.id,
    "missing",
  ]);
  t.deepEqual(
    roots.map((root) => root.prompt),
    ["A note", "Question n2", "Question n1"],
  );
  t.deepEqual(
    roots[0]?.children?.map((child) => child.prompt),
    ["A follow-up"],
  );
  t.deepEqual(feeds.recentQueriesForTrees(fixture.db, "someone-else", [note.tree.id]), []);
});
