import assert from "node:assert/strict";
import test from "node:test";
import {
  activityEventFromResearchQuery,
  buildRecentActivityFromItems,
  cappedNoteDelivery,
  mergeRecentActivityItems,
  reconcileRecentActivityHead,
  recentResearchQueryFromNode,
  upsertRecentActivityItem,
  upsertRecentActivityResearchNode,
} from "../src/lib/activity";
import { formatResearchModelSummary } from "../src/lib/researchModelSummary";
import {
  buildRecentActivityVirtualRows,
  virtualActivityRange,
} from "../src/components/research/ResearchActivityFeed";
import type {
  NoteReply,
  RecentResearchQuery,
  ResearchNode,
  ResearchTreeSummary,
} from "../src/types";

const tree: ResearchTreeSummary = {
  id: "tree-1",
  title: "Collective memory",
  rootNodeId: "root",
  kind: "run",
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

test("research metadata follows the shared actor/action/object grammar", () => {
  const event = activityEventFromResearchQuery(query, tree);
  assert.deepEqual(event.actor, { kind: "user", label: "You" });
  assert.deepEqual(event.action, { kind: "asked", label: "asked" });
  assert.equal(event.object.kind, "research-query");
  assert.equal(event.relationship?.label, "Follow-up");
  assert.equal(event.context?.label, tree.title);
  assert.deepEqual(event.execution, { adapter: "codex", model: "gpt-5" });
  assert.equal(event.state?.label, "Running");
});

test("model summaries use readable model names where available", () => {
  assert.equal(formatResearchModelSummary("claude", "fable"), "Claude Fable");
  assert.equal(formatResearchModelSummary("claude", null), "Claude");
  assert.equal(formatResearchModelSummary("claude", "claude-opus-4-6"), "Claude");
  assert.equal(formatResearchModelSummary("", null), "");
});

test("note posts name delivery and saved sources", () => {
  const note: RecentResearchQuery = {
    ...query, nodeId: "note", parentNodeId: null, kind: "note", status: "complete",
    prompt: "Who has shipped this?", delivery: { status: "posted", postedAt: 1 }, replyCount: 3,
  };
  const posted = activityEventFromResearchQuery(note, tree);
  assert.deepEqual(posted.action, { kind: "posted", label: "Posted to network" });
  assert.equal(posted.object.kind, "note");

  const link = activityEventFromResearchQuery({
    ...note, prompt: "https://example.com/paper", delivery: null, replyCount: 0,
  });
  assert.equal(link.object.kind, "link");
  assert.equal(link.context?.label, "example.com");
  assert.equal(link.state, undefined);

  const post = activityEventFromResearchQuery({
    ...note, prompt: "https://x.com/jack/status/20", delivery: null, replyCount: 0,
    attachments: [{
      kind: "tweet", schemaVersion: 1, sourceUrl: "https://x.com/jack/status/20", tweetId: "20",
      placement: "trailing", provider: "xSyndication", status: "resolved", attemptedAt: 1,
      tweet: {
        id: "20", url: "https://x.com/jack/status/20", author: { name: "jack", handle: "jack" },
        runs: [], partial: false, media: [],
      },
    }],
  });
  assert.equal(post.object.kind, "post");
});

test("Home hides archived research and shows it again when restored", () => {
  const items: RecentResearchQuery[] = [
    query,
    { ...query, nodeId: "active", treeId: "active-tree", createdAt: 150 },
    { ...query, nodeId: "saved", treeId: "active-tree", kind: "note", createdAt: 100 },
  ];
  const activeTree = { ...tree, id: "active-tree" };
  assert.deepEqual(
    buildRecentActivityFromItems(items, [{ ...tree, archivedAt: 300 }, activeTree])
      .map((event) => event.id),
    ["research:active", "research:saved"],
  );
  assert.deepEqual(
    buildRecentActivityFromItems(items, [{ ...tree, archivedAt: null }, activeTree])
      .map((event) => event.id),
    ["research:child", "research:active", "research:saved"],
  );
});

test("only top-level runs and notes enter the Home feed", () => {
  const node = {
    id: "root",
    treeId: tree.id,
    parentNodeId: null,
    prompt: "Question",
    adapter: "codex",
    groupId: "workspace",
    worktreeDir: "/tmp/workspace",
    status: "complete",
    createdAt: 100,
    highlights: [],
  } satisfies ResearchNode;
  assert.equal(recentResearchQueryFromNode(node)?.nodeId, "root");
  assert.equal(recentResearchQueryFromNode({ ...node, parentNodeId: "root" }), null);
  assert.equal(recentResearchQueryFromNode({ ...node, kind: "document" }), null);
  assert.equal(recentResearchQueryFromNode({ ...node, kind: "conversation" }), null);
  assert.equal(recentResearchQueryFromNode({ ...node, kind: "note" })?.kind, "note");
});

test("live follow-ups stay under their root and survive root updates", () => {
  const root = {
    id: "root", treeId: tree.id, parentNodeId: null, prompt: "Root",
    adapter: "codex", groupId: "workspace", worktreeDir: "/tmp/workspace",
    status: "complete", createdAt: 100, highlights: [],
  } satisfies ResearchNode;
  let items = upsertRecentActivityResearchNode([], root);
  const child = { ...root, id: "child", parentNodeId: root.id, prompt: "Follow up", createdAt: 300 };
  items = upsertRecentActivityResearchNode(items, child);
  items = upsertRecentActivityResearchNode(items, { ...child, id: "earlier", createdAt: 200 });
  items = upsertRecentActivityResearchNode(items, { ...child, prompt: "Updated follow up" });
  items = upsertRecentActivityResearchNode(items, { ...child, id: "grandchild", parentNodeId: child.id });
  items = upsertRecentActivityResearchNode(items, { ...root, prompt: "Updated root" });
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.prompt, "Updated root");
  assert.deepEqual(item.children?.map((entry) => entry.nodeId), ["earlier", "child"]);
  assert.equal(item.children?.[1].prompt, "Updated follow up");
  assert.equal(item.createdAt, 100);
  assert.deepEqual(upsertRecentActivityResearchNode([], child), []);
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

test("virtual feed rows omit day dividers and retain feed positions", () => {
  const events = buildRecentActivityFromItems(
    [{ ...query, nodeId: "link", kind: "note", prompt: "https://example.com", createdAt: 300 }, query],
    [tree],
  );
  const rows = buildRecentActivityVirtualRows(events);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.position), [1, 2]);
  assert.deepEqual(rows.map((row) => row.key), events.map((event) => event.id));
});


test("live summary events retain imported report provenance", () => {
  const node: ResearchNode = {
    id: "imported", treeId: "imported-tree", prompt: "Original prompt", adapter: "codex",
    groupId: "workspace", worktreeDir: "/workspace", status: "complete", createdAt: 100,
    kind: "run", origin: "imported", model: null,
  };
  const query = recentResearchQueryFromNode(node)!;
  assert.equal(query.origin, "imported");
  const items = upsertRecentActivityResearchNode([], node);
  const updated = upsertRecentActivityResearchNode(items, {
    ...node, recap: { text: "Summary", responseRevision: "revision" },
  });
  assert.equal(activityEventFromResearchQuery(updated[0]).execution?.origin, "imported");
  assert.equal(updated[0].model, null);
});

const memberReply = (id: string, createdAt: number, inReplyTo?: string): NoteReply => ({
  id,
  author: inReplyTo ? { kind: "author" } : { kind: "member", id: `m-${id}`, displayName: `Member ${id}` },
  body: id,
  inReplyTo,
  createdAt,
});

test("live note updates cut replies to five threads like the backend", () => {
  const replies = [
    ...Array.from({ length: 7 }, (_, index) => memberReply(`r${index}`, index)),
    memberReply("response", 10, "r1"),
    memberReply("late-response", 11, "r6"),
  ];
  const capped = cappedNoteDelivery({ status: "posted", postedAt: 0, replies }, 5);
  assert.deepEqual(capped.replies?.map((reply) => reply.id), ["r0", "r1", "r2", "r3", "r4", "response"]);

  const note: ResearchNode = {
    id: "note", treeId: "note-tree", prompt: "Question", adapter: "claude",
    groupId: "workspace", worktreeDir: "/workspace", status: "complete", createdAt: 100,
    kind: "note", highlights: [], delivery: { status: "posted", postedAt: 100, replies },
  };
  const [item] = upsertRecentActivityResearchNode([], note);
  assert.equal(item.kind, "note");
  assert.equal(item.replyCount, 7);
  assert.equal(item.delivery?.replies?.length, 6);
});

test("follow-ups about a reply resolve its author from the loaded note", () => {
  const note: ResearchNode = {
    id: "note", treeId: "note-tree", prompt: "Question", adapter: "claude",
    groupId: "workspace", worktreeDir: "/workspace", status: "complete", createdAt: 100,
    kind: "note", highlights: [],
    delivery: { status: "posted", postedAt: 100, replies: [memberReply("r0", 110)] },
  };
  let items = upsertRecentActivityResearchNode([], note);
  const child: ResearchNode = {
    ...note, id: "child", parentNodeId: "note", kind: "run", delivery: null,
    replyAnchor: "r0", status: "running", createdAt: 120,
  };
  items = upsertRecentActivityResearchNode(items, child);
  assert.equal(items[0].children?.[0].replyAnchorAuthor, "Member r0");
  // A target outside the loaded replies keeps the name the backend sent.
  const withBackendName = [{
    ...items[0],
    delivery: { status: "posted" as const, postedAt: 100 },
    children: [{ ...items[0].children![0], replyAnchorAuthor: "Ana" }],
  }];
  const refreshed = upsertRecentActivityResearchNode(withBackendName, { ...child, status: "complete" });
  assert.equal(refreshed[0].children?.[0].replyAnchorAuthor, "Ana");
  assert.equal(refreshed[0].children?.[0].status, "complete");
});
