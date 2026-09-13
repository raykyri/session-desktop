import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activityEventFromJournalEntry,
  activityEventFromResearchQuery,
  buildRecentActivity,
  mergeRecentActivityItems,
  recentActivityItemFromJournalEntry,
  reconcileRecentActivityHead,
  recentResearchQueryFromNode,
  upsertRecentActivityItem,
  upsertRecentResearchQuery,
} from "../src/lib/activity";
import {
  normalizeRecentActivityPage,
  type RecentActivityItem,
} from "../src/lib/journal";
import ActivityMetadataLine, {
  formatActivityMetadataSummary,
  formatResearchAskedSummary,
} from "../src/components/ActivityMetadataLine";
import {
  buildRecentActivityVirtualRows,
  ResearchQueryCard,
  virtualActivityRange,
} from "../src/components/research/ResearchActivityFeed";
import type { JournalEntry } from "../src/lib/journal";
import type { RecentResearchQuery, ResearchNode, ResearchTreeSummary } from "../src/types";

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

test("research metadata names thread prompts and left-aligned Home activity", () => {
  const followUp = activityEventFromResearchQuery(query, tree);
  assert.equal(formatActivityMetadataSummary(followUp), "Replied in “Collective memory”");

  const topLevel = activityEventFromResearchQuery(
    { ...query, parentNodeId: null, adapter: "claude", model: "fable" },
    tree,
  );
  assert.equal(formatActivityMetadataSummary(topLevel), "");
  assert.equal(formatResearchAskedSummary("claude", "fable"), "You asked Claude Fable");
  assert.equal(
    formatResearchAskedSummary("claude", null),
    "You asked Claude",
  );
  assert.equal(
    formatResearchAskedSummary("claude", "claude-opus-4-6"),
    "You asked Claude",
  );

  const html = renderToStaticMarkup(createElement(ActivityMetadataLine, {
    event: { ...topLevel, occurredAt: Date.now() - 2 * 60 * 60 * 1000 },
  }));
  assert.ok(html.includes('class="activity-metadata-summary"'));
  assert.match(html, /activity-metadata-summary"><time/);
  assert.match(html, />2 hr ago<\/time>/);
});

test("saved metadata resolves type and source context", () => {
  const link: JournalEntry = {
    kind: "link",
    id: "saved",
    createdAt: "2026-08-30T12:00:00.000Z",
    url: "https://example.com/paper",
  };
  const event = activityEventFromJournalEntry(link);
  assert.equal(event.object.label, "Link");
  assert.equal(event.context?.label, "example.com");
  assert.equal(event.state, undefined);
  assert.equal(formatActivityMetadataSummary(event), "Saved");
});

test("mixed activity sorts deterministically and malformed saved dates last", () => {
  const entries: JournalEntry[] = [
    { kind: "link", id: "bad", createdAt: "not-a-date", url: "https://example.com/old" },
    { kind: "link", id: "new", createdAt: "1970-01-01T00:00:00.300Z", url: "https://example.com/new" },
  ];
  assert.deepEqual(
    buildRecentActivity(entries, [query], [tree]).map((event) => event.id),
    ["journal:new", "research:child", "journal:bad"],
  );
});

test("only top-level run nodes enter the Home feed", () => {
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
  assert.deepEqual(
    upsertRecentResearchQuery([query], { ...query, status: "failed" }),
    [{ ...query, status: "failed" }],
  );
});

test("mixed activity pages merge by one deterministic source-aware order", () => {
  const link = recentActivityItemFromJournalEntry({
    kind: "link",
    id: "link",
    createdAt: "1970-01-01T00:00:00.200Z",
    url: "https://example.com/same-time",
  });
  const research: RecentActivityItem = {
    kind: "research-query",
    occurredAt: 200,
    query,
  };
  assert.deepEqual(
    mergeRecentActivityItems([link], [research]).map((item) => item.kind),
    ["research-query", "journal"],
  );
});

test("live activity upserts insert into the sorted position without disturbing peers", () => {
  const asItem = (nodeId: string, createdAt: number): RecentActivityItem => ({
    kind: "research-query",
    occurredAt: createdAt,
    query: { ...query, nodeId, createdAt },
  });
  const current = [asItem("newest", 300), asItem("oldest", 100)];
  const next = upsertRecentActivityItem(current, asItem("middle", 200));
  assert.deepEqual(
    next.map((item) => (item.kind === "research-query" ? item.query.nodeId : "")),
    ["newest", "middle", "oldest"],
  );
});

test("head reconciliation preserves a loaded tail without retaining stale head rows", () => {
  const head = { ...query, nodeId: "head", createdAt: 300 };
  const stale = { ...query, nodeId: "stale", createdAt: 250 };
  const tail = { ...query, nodeId: "tail", createdAt: 100 };
  const asItem = (candidate: RecentResearchQuery): RecentActivityItem => ({
    kind: "research-query",
    occurredAt: candidate.createdAt,
    query: candidate,
  });
  const reconciled = reconcileRecentActivityHead(
    [asItem(stale), asItem(tail)],
    [asItem(head)],
    { occurredAt: 200, sourceRank: 1, id: "boundary" },
  );
  assert.deepEqual(
    reconciled.map((item) => (item.kind === "research-query" ? item.query.nodeId : "")),
    ["head", "tail"],
  );
});

test("activity page normalization drops malformed opaque journal records", () => {
  const page = normalizeRecentActivityPage({
    items: [
      {
        kind: "journal",
        occurredAt: 11,
        entry: { kind: "note", id: "legacy", createdAt: "2026-01-01", text: "ignore" } as JournalEntry,
      },
      {
        kind: "journal",
        occurredAt: 10,
        entry: { id: "broken" } as JournalEntry,
      },
      { kind: "research-query", occurredAt: query.createdAt, query },
    ],
    nextCursor: null,
  });
  assert.deepEqual(page.items.map((item) => item.kind), ["research-query"]);
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

test("home-feed research prompts render markdown links", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchQueryCard, {
      query: {
        ...query,
        prompt:
          "what would solving the alignment problem this way look like?\nhttps://x.com/OrionJohnston/status/2097801834224312595",
      },
      onOpen: () => {},
      onContextMenu: () => {},
    }),
  );

  assert.match(html, /turn-markdown/);
  assert.match(
    html,
    /href="https:\/\/x\.com\/OrionJohnston\/status\/2097801834224312595"/,
  );
  assert.doesNotMatch(html, /recent-query-open/);
});

test("home-feed research prompts show a recap below the question", () => {
  const withRecap = renderToStaticMarkup(
    createElement(ResearchQueryCard, {
      query: { ...query, recap: "Read Cusk and Heti." },
      onOpen: () => {},
      onContextMenu: () => {},
    }),
  );
  const withoutRecap = renderToStaticMarkup(
    createElement(ResearchQueryCard, {
      query,
      onOpen: () => {},
      onContextMenu: () => {},
    }),
  );

  assert.ok(withRecap.indexOf("turn-markdown") < withRecap.indexOf("Summary: Read Cusk and Heti."));
  assert.doesNotMatch(withoutRecap, /Summary:/);
});

test("virtual feed rows omit day dividers and retain feed positions", () => {
  const events = buildRecentActivity(
    [{ kind: "link", id: "link", createdAt: "1970-01-01T00:00:00.300Z", url: "https://example.com" }],
    [query],
    [tree],
  );
  const rows = buildRecentActivityVirtualRows(events);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.position), [1, 2]);
  assert.deepEqual(rows.map((row) => row.key), events.map((event) => event.id));
});
