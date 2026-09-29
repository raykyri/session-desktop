// Wire-shaped fixtures for the Home, sidebar, and highlights
// tests. Kept beside `fixtures.ts` rather than inside it because those are the
// research shapes the cache tests share; these are the feed and workspace
// shapes only Phase 6's views read.

import type {
  JournalEntry,
  RecentActivityItem,
  RecentActivityPage,
  RecentResearchQuery,
  ResearchHighlightFeedItem,
  Workspace,
} from "@session/shared";
import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { QueryClient } from "@tanstack/react-query";

import { queryClientDefaults } from "../src/api/queries.js";

/**
 * The app's defaults plus infinite `gcTime` on both caches. `helpers.tsx` does
 * this for queries; a mutation needs it too, because a settled mutation
 * schedules its own five-minute collection and AVA waits for that timer before
 * the worker can exit.
 */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
      mutations: { gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

export const WORKSPACE_ID = "w1";

export function workspace(overrides: Partial<Workspace & { treeCount: number }> = {}) {
  return {
    id: WORKSPACE_ID,
    name: "Collective memory",
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    treeCount: 1,
    ...overrides,
  };
}

export function serverSettings(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_USER_SETTINGS,
    researchLaunchInstruction: null,
    defaultWorkspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

export function researchQuery(overrides: Partial<RecentResearchQuery> = {}): RecentResearchQuery {
  return {
    nodeId: "n1",
    treeId: "t1",
    parentNodeId: null,
    inline: false,
    prompt: "What is collective memory?",
    model: "gemini-flash",
    status: "complete",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function linkEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "j1",
    kind: "link",
    url: "https://example.com/a",
    createdAt: new Date(1_700_000_000_000).toISOString(),
    ...overrides,
  } as JournalEntry;
}

export function activityPage(
  items: RecentActivityItem[],
  nextCursor: RecentActivityPage["nextCursor"] = null,
): RecentActivityPage {
  return { items, nextCursor };
}

export function queryItem(query: RecentResearchQuery): RecentActivityItem {
  return { kind: "research-query", occurredAt: query.createdAt, query };
}

export function journalItem(entry: JournalEntry): RecentActivityItem {
  return { kind: "journal", occurredAt: Date.parse(entry.createdAt), entry };
}

export function highlightItem(
  overrides: Partial<ResearchHighlightFeedItem> = {},
): ResearchHighlightFeedItem {
  return {
    highlightId: "h1",
    nodeId: "n1",
    treeId: "t1",
    treeTitle: "Collective memory",
    nodeLabel: "Collective memory",
    exact: "a shared store of meaning",
    prefix: "Memory is ",
    suffix: " across a group.",
    createdAt: Date.now(),
    ...overrides,
  };
}
