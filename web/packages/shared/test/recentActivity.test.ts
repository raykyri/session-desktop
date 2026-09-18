import test from "ava";

import {
  activityEventFromJournalEntry,
  activityEventFromResearchQuery,
  buildRecentActivity,
  buildRecentActivityFromItems,
  mergeRecentActivityItems,
  recentActivityItemFromJournalEntry,
  recentResearchQueryFromNode,
  reconcileRecentActivityHead,
  upsertRecentActivityItem,
  upsertRecentActivityResearchNode,
  upsertRecentResearchQuery,
} from "../src/journal/activity.js";
import type { RecentActivityItem } from "../src/types/activity.js";
import type { JournalEntry } from "../src/types/journal.js";
import type {
  RecentResearchQuery,
  ResearchNode,
  ResearchTreeSummary,
} from "../src/types/research.js";

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
  model: "gpt-luna",
  status: "running",
  createdAt: 200,
};

const node: ResearchNode = {
  id: "root",
  treeId: tree.id,
  workspaceId: "workspace",
  parentNodeId: null,
  prompt: "Question",
  documentIds: [],
  model: "gpt-luna",
  status: "complete",
  attempt: 1,
  createdAt: 100,
  highlights: [],
};

const asItem = (candidate: RecentResearchQuery): RecentActivityItem => ({
  kind: "research-query",
  occurredAt: candidate.createdAt,
  query: candidate,
});

const nodeIds = (items: RecentActivityItem[]) =>
  items.map((item) => (item.kind === "research-query" ? item.query.nodeId : ""));

test("research metadata follows the shared actor/action/object grammar", (t) => {
  const event = activityEventFromResearchQuery(query, tree);
  t.deepEqual(event.actor, { kind: "user", label: "You" });
  t.deepEqual(event.action, { kind: "asked", label: "asked" });
  t.is(event.object.kind, "research-query");
  t.is(event.relationship?.label, "Follow-up");
  t.is(event.context?.label, tree.title);
  t.deepEqual(event.execution, { model: "gpt-luna" });
  t.is(event.state?.label, "Running");
});

test("run states are labeled and a completed answer carries no badge", (t) => {
  const labelOf = (status: RecentResearchQuery["status"]) =>
    activityEventFromResearchQuery({ ...query, status }, tree).state?.label;
  t.is(labelOf("queued"), "Queued");
  t.is(labelOf("failed"), "Failed");
  t.is(labelOf("cancelled"), "Cancelled");
  t.is(labelOf("interrupted"), "Interrupted");
  t.is(labelOf("complete"), undefined);
});

test("a top-level imported query keeps its provenance", (t) => {
  const event = activityEventFromResearchQuery(
    { ...query, parentNodeId: null, origin: "imported" },
    tree,
  );
  t.is(event.relationship?.label, "Top-level");
  t.deepEqual(event.execution, { model: "gpt-luna", origin: "imported" });
});

test("saved metadata resolves type and source context", (t) => {
  const link: JournalEntry = {
    kind: "link",
    id: "saved",
    createdAt: "2026-08-30T12:00:00.000Z",
    url: "https://example.com/paper",
  };
  const event = activityEventFromJournalEntry(link);
  t.is(event.object.label, "Link");
  t.is(event.context?.label, "example.com");
  t.is(event.state, undefined);
  // A URL that is not parseable still names the entry.
  t.is(activityEventFromJournalEntry({ ...link, url: "not a url" }).context?.label, "Saved link");
});

test("mixed activity sorts deterministically and malformed saved dates last", (t) => {
  const entries: JournalEntry[] = [
    { kind: "link", id: "bad", createdAt: "not-a-date", url: "https://example.com/old" },
    {
      kind: "link",
      id: "new",
      createdAt: "1970-01-01T00:00:00.300Z",
      url: "https://example.com/new",
    },
  ];
  t.deepEqual(
    buildRecentActivity(entries, [query], [tree]).map((event) => event.id),
    ["journal:new", "research:child", "journal:bad"],
  );
});

test("Home hides archived research and shows it again when restored", (t) => {
  const items: RecentActivityItem[] = [
    { kind: "research-query", occurredAt: query.createdAt, query },
    {
      kind: "research-query",
      occurredAt: 150,
      query: { ...query, nodeId: "active", treeId: "active-tree", createdAt: 150 },
    },
    recentActivityItemFromJournalEntry({
      kind: "link",
      id: "saved",
      createdAt: "1970-01-01T00:00:00.100Z",
      url: "https://example.com/paper",
    }),
  ];
  const activeTree = { ...tree, id: "active-tree" };
  t.deepEqual(
    buildRecentActivityFromItems(items, [{ ...tree, archivedAt: 300 }, activeTree]).map(
      (event) => event.id,
    ),
    ["research:active", "journal:saved"],
  );
  t.deepEqual(
    buildRecentActivityFromItems(items, [{ ...tree, archivedAt: null }, activeTree]).map(
      (event) => event.id,
    ),
    ["research:child", "research:active", "journal:saved"],
  );
});

test("only top-level run nodes enter the Home feed", (t) => {
  t.is(recentResearchQueryFromNode(node)?.nodeId, "root");
  t.is(recentResearchQueryFromNode({ ...node, parentNodeId: "root" }), null);
  t.is(recentResearchQueryFromNode({ ...node, kind: "document" }), null);
  t.deepEqual(upsertRecentResearchQuery([query], { ...query, status: "failed" }), [
    { ...query, status: "failed" },
  ]);
});

test("a node's feed row carries its model, origin, and recap", (t) => {
  const imported = recentResearchQueryFromNode({
    ...node,
    origin: "imported",
    recap: { text: "  Summary  ", responseRevision: "revision" },
  });
  t.is(imported?.origin, "imported");
  t.is(imported?.model, "gpt-luna");
  t.is(imported?.recap, "Summary");
  t.is(recentResearchQueryFromNode(node)?.recap, undefined);
});

test("live follow-ups stay under their root and survive root updates", (t) => {
  let items = upsertRecentActivityResearchNode([], node);
  const child = {
    ...node,
    id: "child",
    parentNodeId: node.id,
    prompt: "Follow up",
    createdAt: 300,
  };
  items = upsertRecentActivityResearchNode(items, child);
  items = upsertRecentActivityResearchNode(items, { ...child, id: "earlier", createdAt: 200 });
  items = upsertRecentActivityResearchNode(items, { ...child, prompt: "Updated follow up" });
  items = upsertRecentActivityResearchNode(items, {
    ...child,
    id: "grandchild",
    parentNodeId: child.id,
  });
  items = upsertRecentActivityResearchNode(items, { ...node, prompt: "Updated root" });
  t.is(items.length, 1);
  const item = items[0];
  t.is(item?.kind, "research-query");
  if (item?.kind !== "research-query") return;
  t.is(item.query.prompt, "Updated root");
  t.deepEqual(
    item.query.children?.map((entry) => entry.nodeId),
    ["earlier", "child"],
  );
  t.is(item.query.children?.[1]?.prompt, "Updated follow up");
  t.is(item.occurredAt, 100);
  // A follow-up whose root is not loaded has nowhere to go.
  t.deepEqual(upsertRecentActivityResearchNode([], child), []);
});

test("mixed activity pages merge by one deterministic source-aware order", (t) => {
  const link = recentActivityItemFromJournalEntry({
    kind: "link",
    id: "link",
    createdAt: "1970-01-01T00:00:00.200Z",
    url: "https://example.com/same-time",
  });
  const research: RecentActivityItem = { kind: "research-query", occurredAt: 200, query };
  t.deepEqual(
    mergeRecentActivityItems([link], [research]).map((item) => item.kind),
    ["research-query", "journal"],
  );
});

test("live upserts insert into the sorted position without disturbing peers", (t) => {
  const current = [
    asItem({ ...query, nodeId: "newest", createdAt: 300 }),
    asItem({ ...query, nodeId: "oldest", createdAt: 100 }),
  ];
  const next = upsertRecentActivityItem(
    current,
    asItem({ ...query, nodeId: "middle", createdAt: 200 }),
  );
  t.deepEqual(nodeIds(next), ["newest", "middle", "oldest"]);
});

test("head reconciliation preserves a loaded tail without retaining stale head rows", (t) => {
  const reconciled = reconcileRecentActivityHead(
    [
      asItem({ ...query, nodeId: "stale", createdAt: 250 }),
      asItem({ ...query, nodeId: "tail", createdAt: 100 }),
    ],
    [asItem({ ...query, nodeId: "head", createdAt: 300 })],
    { occurredAt: 200, sourceRank: 1, id: "boundary" },
  );
  t.deepEqual(nodeIds(reconciled), ["head", "tail"]);
});

test("restoring a tree archived before load drops the tail so the next page refetches it", (t) => {
  const head = asItem({ ...query, nodeId: "head", createdAt: 300 });
  const tail = asItem({ ...query, nodeId: "tail", createdAt: 100 });
  // Archived trees are omitted from activity pages, so the loaded tail did not
  // include this item.
  const restored = asItem({
    ...query,
    nodeId: "restored",
    treeId: "restored-tree",
    createdAt: 200,
  });
  const headCursor = { occurredAt: 250, sourceRank: 1, id: "boundary" };

  t.deepEqual(nodeIds(reconcileRecentActivityHead([head, tail], [head], headCursor)), [
    "head",
    "tail",
  ]);
  const reset = reconcileRecentActivityHead([head, tail], [head], null);
  t.deepEqual(nodeIds(reset), ["head"]);
  t.deepEqual(nodeIds(mergeRecentActivityItems(reset, [restored, tail])), [
    "head",
    "restored",
    "tail",
  ]);
});
