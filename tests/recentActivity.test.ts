import assert from "node:assert/strict";
import test from "node:test";
import {
  cappedPostDelivery,
  mergeRecentActivityItems,
  reconcileRecentActivityHead,
  recentResearchQueryFromNode,
  upsertRecentActivityItem,
  upsertRecentActivityResearchNode,
} from "../src/lib/activity";
import { formatResearchModelSummary } from "../src/lib/researchModelSummary";
import {
  researchFeedRows,
  virtualActivityRange,
} from "../src/components/research/ResearchActivityFeed";
import type {
  PostReply,
  RecentResearchQuery,
  ResearchTreeSummary,
} from "../src/types";
import { researchNode, type NodeFixture } from "./researchNodeFixture";

const tree: ResearchTreeSummary = {
  id: "tree-1",
  title: "Collective memory",
  rootNodeId: "root",
  type: "exchange",
  workspaceId: "workspace",
  runningCount: 0,
  failedCount: 0,
  completedCount: 2,
  cancelledCount: 0,
  updatedAt: 200,
  hasUnseenUpdate: false,
  hasUnseenFailure: false,
};

const query: RecentResearchQuery = {
  nodeId: "child",
  treeId: tree.id,
  parentNodeId: "root",
  inline: false,
  prompt: "How does retrieval change the result?",
  title: "Retrieval",
  adapter: "codex",
  model: "gpt-5",
  status: "running",
  createdAt: 200,
};

test("model summaries use readable model names where available", () => {
  assert.equal(formatResearchModelSummary("claude", "fable"), "Claude Fable");
  assert.equal(formatResearchModelSummary("claude", null), "Claude");
  assert.equal(formatResearchModelSummary("claude", "claude-opus-4-6"), "Claude");
  assert.equal(formatResearchModelSummary("", null), "");
});

test("Home lists Unfiled trees in the tree order, a just-created root first", () => {
  const root = (treeId: string, createdAt: number): RecentResearchQuery => ({
    ...query, nodeId: `${treeId}-root`, treeId, parentNodeId: null, createdAt,
  });
  const trees = ["a", "b", "filed", "archived", "c"].map((id) => ({
    ...tree, id, rootNodeId: `${id}-root`, archivedAt: id === "archived" ? 300 : null,
    bookmarked: id === "b" || id === "filed",
  }));
  const roots = new Map(
    [root("a", 100), root("c", 300), root("new", 400), root("filed", 200)].map((item) => [item.treeId, item]),
  );
  const placeOf = (candidate: ResearchTreeSummary) => (candidate.id === "filed" ? "f-read" : "system:unfiled");
  const home = researchFeedRows("home", roots, trees.filter((candidate) => !candidate.archivedAt), placeOf);
  // Not by creation time: "a" before "c". An unloaded root ("b") still lists.
  assert.deepEqual(home.map((row) => row.treeId), ["new", "a", "b", "c"]);
  assert.deepEqual(home.map((row) => row.key), ["tree:new", "tree:a", "tree:b", "tree:c"]);
  assert.deepEqual(home.map((row) => row.position), [1, 2, 3, 4]);
  assert.equal(home[0].tree, undefined);
  assert.equal(home[2].query, undefined);
  assert.equal(home[3].query?.nodeId, "c-root");
  // Bookmarks: bookmarked active trees in the tree order, from any place.
  assert.deepEqual(
    researchFeedRows("bookmarks", roots, trees, placeOf).map((row) => row.treeId),
    ["b", "filed"],
  );
});

test("every top-level node enters the Home feed; follow-ups do not", () => {
  const node = {
    id: "root",
    treeId: tree.id,
    parentNodeId: null,
    prompt: "Question",
    adapter: "codex",
    groupId: "workspace",
    status: "complete",
    createdAt: 100,
  } satisfies NodeFixture;
  assert.equal(recentResearchQueryFromNode(researchNode(node))?.nodeId, "root");
  assert.equal(recentResearchQueryFromNode(researchNode({ ...node, parentNodeId: "root" })), null);
  const imported = recentResearchQueryFromNode(
    researchNode({ ...node, type: "document", source: "imported" }),
  );
  assert.equal(imported?.type, "document");
  assert.equal(imported?.source, "imported");
  assert.equal(imported?.prompt, "Question");
  const transcript = recentResearchQueryFromNode(
    researchNode({ ...node, type: "document", source: "transcript" }),
  );
  assert.equal(transcript?.source, "transcript");
  const post = recentResearchQueryFromNode(researchNode({ ...node, type: "post", format: "link" }));
  assert.equal(post?.type, "post");
  assert.equal(post?.format, "link");
});

test("live follow-ups stay under their root and survive root updates", () => {
  const root = {
    id: "root", treeId: tree.id, parentNodeId: null, prompt: "Root",
    adapter: "codex", groupId: "workspace",
    status: "complete", createdAt: 100,
  } satisfies NodeFixture;
  let items = upsertRecentActivityResearchNode([], researchNode(root));
  const child = { ...root, id: "child", parentNodeId: root.id, prompt: "Follow up", createdAt: 300 };
  const upsert = (fields: NodeFixture) => {
    items = upsertRecentActivityResearchNode(items, researchNode(fields));
  };
  upsert(child);
  upsert({ ...child, id: "earlier", createdAt: 200 });
  upsert({ ...child, prompt: "Updated follow up" });
  upsert({ ...child, id: "grandchild", parentNodeId: child.id });
  upsert({ ...root, prompt: "Updated root" });
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.prompt, "Updated root");
  assert.deepEqual(item.children?.map((entry) => entry.nodeId), ["earlier", "child"]);
  assert.equal(item.children?.[1].prompt, "Updated follow up");
  assert.equal(item.createdAt, 100);
  assert.deepEqual(upsertRecentActivityResearchNode([], researchNode(child)), []);
});

test("live activity upserts insert into the sorted position without disturbing peers", () => {
  const asItem = (nodeId: string, createdAt: number) => ({ ...query, nodeId, createdAt });
  const current = [asItem("newest", 300), asItem("oldest", 100)];
  const next = upsertRecentActivityItem(current, asItem("middle", 200));
  assert.deepEqual(next.map((item) => item.nodeId), ["newest", "middle", "oldest"]);
  // Equal timestamps order by descending node id, as the backend pages.
  assert.deepEqual(
    mergeRecentActivityItems([asItem("a", 100)], [asItem("b", 100)]).map((item) => item.nodeId),
    ["b", "a"],
  );
});

test("head reconciliation preserves a loaded tail without retaining stale head rows", () => {
  const head = { ...query, nodeId: "head", createdAt: 300 };
  const stale = { ...query, nodeId: "stale", createdAt: 250 };
  const tail = { ...query, nodeId: "tail", createdAt: 100 };
  const reconciled = reconcileRecentActivityHead(
    [stale, tail],
    [head],
    { createdAt: 200, nodeId: "boundary" },
  );
  assert.deepEqual(reconciled.map((item) => item.nodeId), ["head", "tail"]);
});

test("restoring a tree archived before load drops the tail so the next page refetches it", () => {
  const head = { ...query, nodeId: "head", createdAt: 300 };
  const tail = { ...query, nodeId: "tail", createdAt: 100 };
  // Archived trees are omitted from activity pages, so the loaded tail did not include this item.
  const restored = { ...query, nodeId: "restored", treeId: "restored-tree", createdAt: 200 };
  const headCursor = { createdAt: 250, nodeId: "boundary" };
  const nodeIds = (items: RecentResearchQuery[]) => items.map((item) => item.nodeId);

  assert.deepEqual(
    nodeIds(reconcileRecentActivityHead([head, tail], [head], headCursor)),
    ["head", "tail"],
  );
  const reset = reconcileRecentActivityHead([head, tail], [head], null);
  assert.deepEqual(nodeIds(reset), ["head"]);
  assert.deepEqual(
    nodeIds(mergeRecentActivityItems(reset, [restored, tail])),
    ["head", "restored", "tail"],
  );
});

test("variable-height virtualization returns a small overscanned window", () => {
  const sizes = Array.from({ length: 10_000 }, (_, index) => 40 + (index % 3) * 10);
  const offsets: number[] = [];
  let offset = 0;
  for (const size of sizes) {
    offsets.push(offset);
    offset += size;
  }
  const range = virtualActivityRange(offsets, sizes, 200_000, 800, 600);
  assert.ok(range.start > 0);
  assert.ok(range.end < sizes.length);
  assert.ok(range.end - range.start < 50);
});

test("live summary events retain imported report provenance", () => {
  const fields = {
    id: "imported", treeId: "imported-tree", prompt: "Original prompt", adapter: "codex",
    groupId: "workspace", createdAt: 100, type: "document", source: "imported", model: null,
  } satisfies NodeFixture;
  const node = researchNode(fields);
  const query = recentResearchQueryFromNode(node)!;
  assert.equal(query.source, "imported");
  const items = upsertRecentActivityResearchNode([], node);
  const updated = upsertRecentActivityResearchNode(
    items,
    researchNode({ ...fields, recap: { text: "Summary", responseRevision: "revision" } }),
  );
  assert.equal(updated[0].source, "imported");
  assert.equal(updated[0].model, null);
});

const memberReply = (id: string, createdAt: number, inReplyTo?: string): PostReply => ({
  id,
  author: inReplyTo ? { kind: "author" } : { kind: "member", id: `m-${id}`, displayName: `Member ${id}` },
  body: id,
  inReplyTo,
  createdAt,
});

test("live post updates cut replies to five threads like the backend", () => {
  const replies = [
    ...Array.from({ length: 7 }, (_, index) => memberReply(`r${index}`, index)),
    memberReply("response", 10, "r1"),
    memberReply("late-response", 11, "r6"),
  ];
  const capped = cappedPostDelivery({ status: "posted", postedAt: 0, replies }, 5);
  assert.deepEqual(capped.replies?.map((reply) => reply.id), ["r0", "r1", "r2", "r3", "r4", "response"]);

  const post = researchNode({
    id: "post", treeId: "post-tree", prompt: "Question", adapter: "claude",
    groupId: "workspace", createdAt: 100,
    type: "post", delivery: { status: "posted", postedAt: 100, replies },
  });
  const [item] = upsertRecentActivityResearchNode([], post);
  assert.equal(item.type, "post");
  assert.equal(item.replyCount, 7);
  assert.equal(item.delivery?.replies?.length, 6);
});

test("follow-ups about a reply resolve its author from the loaded post", () => {
  const post = researchNode({
    id: "post", treeId: "post-tree", prompt: "Question", adapter: "claude",
    groupId: "workspace", createdAt: 100, type: "post",
    delivery: { status: "posted", postedAt: 100, replies: [memberReply("r0", 110)] },
  });
  let items = upsertRecentActivityResearchNode([], post);
  const childFields = {
    id: "child", treeId: "post-tree", parentNodeId: "post", prompt: "Question", groupId: "workspace",
    anchor: { kind: "reply", replyId: "r0" }, status: "running", createdAt: 120,
  } satisfies NodeFixture;
  const child = researchNode(childFields);
  items = upsertRecentActivityResearchNode(items, child);
  assert.equal(items[0].children?.[0].replyAnchorAuthor, "Member r0");
  // A target outside the loaded replies keeps the name the backend sent.
  const withBackendName = [{
    ...items[0],
    delivery: { status: "posted" as const, postedAt: 100 },
    children: [{ ...items[0].children![0], replyAnchorAuthor: "Ana" }],
  }];
  const refreshed = upsertRecentActivityResearchNode(
    withBackendName,
    researchNode({ ...childFields, status: "complete" }),
  );
  assert.equal(refreshed[0].children?.[0].replyAnchorAuthor, "Ana");
  assert.equal(refreshed[0].children?.[0].status, "complete");
});
