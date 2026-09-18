// The Home feed's activity grammar and the reducers that keep a loaded feed
// in order as live events arrive.
//
// Ported from the desktop `src/lib/activity.ts`. Surfaces render the semantic
// slots below rather than hand-building a slightly different metadata sentence
// per source, so "You saved a Link from example.com" and "You asked a
// follow-up in Collective memory" come out of one vocabulary.
//
// `execution` carries the registry model id (`models/registry.ts`) where the
// desktop carried an adapter name plus an optional model.

import type { RecentActivityItem } from "../types/activity.js";
import type { JournalEntry } from "../types/journal.js";
import type {
  RecentActivityCursor,
  RecentResearchQuery,
  ResearchNode,
  ResearchNodeStatus,
  ResearchTreeSummary,
} from "../types/research.js";

import {
  activityCursorIsBefore,
  compareRecentActivityItems,
  recentActivityItemCursor,
  recentActivityItemId,
} from "./cursor.js";

export interface ActivityEvent<TSource = unknown> {
  id: string;
  actor: { kind: "user" | "agent" | "system"; label: string };
  action: { kind: "saved" | "asked" | "created" | "completed"; label: string };
  object: {
    kind: "link" | "post" | "research-query" | "artifact" | "task";
    id: string;
    label: string;
  };
  context?: { kind: "research" | "source" | "workspace"; label: string };
  relationship?: { kind: "top-level" | "follow-up"; label: string };
  execution?: { model: string; origin?: string | null };
  state?: { kind: ResearchNodeStatus | "ready"; label: string };
  occurredAt: number;
  source: TSource;
}

export type RecentActivitySource =
  { kind: "journal"; entry: JournalEntry } | { kind: "research-query"; query: RecentResearchQuery };

export type RecentActivityEvent = ActivityEvent<RecentActivitySource>;

/** The feed row for a node, or null when the node does not belong in the feed:
 * only run nodes appear, and only roots unless follow-ups were asked for. */
export function recentResearchQueryFromNode(
  node: ResearchNode,
  includeFollowUps = false,
): RecentResearchQuery | null {
  if ((node.kind && node.kind !== "run") || (!includeFollowUps && node.parentNodeId)) return null;
  return {
    nodeId: node.id,
    treeId: node.treeId,
    parentNodeId: node.parentNodeId,
    inline: Boolean(node.inline),
    prompt: node.prompt,
    queryTarget: node.queryAnchor?.exact,
    attachments: node.attachments,
    title: node.title,
    model: node.model,
    ...(node.origin ? { origin: node.origin } : {}),
    status: node.status,
    createdAt: node.createdAt,
    recap: node.recap?.text.trim() || undefined,
  };
}

/** Live node events update children within their loaded root, without changing
 * feed order. */
export function upsertRecentActivityResearchNode(
  items: RecentActivityItem[],
  node: ResearchNode,
): RecentActivityItem[] {
  const query = recentResearchQueryFromNode(node, true);
  if (!query) return items;
  if (query.parentNodeId) {
    return items.map((item) => {
      if (
        item.kind !== "research-query" ||
        item.query.nodeId !== query.parentNodeId ||
        item.query.treeId !== query.treeId
      ) {
        return item;
      }
      const children = [
        ...(item.query.children ?? []).filter((child) => child.nodeId !== query.nodeId),
        query,
      ].sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.nodeId.localeCompare(right.nodeId),
      );
      return { ...item, query: { ...item.query, children } };
    });
  }
  const existing = items.find(
    (item) => item.kind === "research-query" && item.query.nodeId === query.nodeId,
  );
  if (existing?.kind === "research-query") query.children = existing.query.children;
  return upsertRecentActivityItem(items, recentActivityItemFromResearchQuery(query));
}

export function upsertRecentResearchQuery(
  queries: RecentResearchQuery[],
  query: RecentResearchQuery,
): RecentResearchQuery[] {
  return [...queries.filter((candidate) => candidate.nodeId !== query.nodeId), query].sort(
    (left, right) => right.createdAt - left.createdAt || right.nodeId.localeCompare(left.nodeId),
  );
}

function journalTimestamp(entry: JournalEntry): number {
  const timestamp = Date.parse(entry.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function journalObject(entry: JournalEntry): ActivityEvent["object"] {
  if (entry.kind === "link") {
    return { kind: "link", id: entry.id, label: "Link" };
  }
  return { kind: "post", id: entry.id, label: "Post" };
}

export function activityEventFromJournalEntry(entry: JournalEntry): RecentActivityEvent {
  const sourceLabel =
    entry.kind === "tweet"
      ? entry.tweet?.author.handle
        ? `@${entry.tweet.author.handle}`
        : "X"
      : (URL.parse(entry.url)?.hostname ?? "Saved link");
  return {
    id: `journal:${entry.id}`,
    actor: { kind: "user", label: "You" },
    action: { kind: "saved", label: "saved" },
    object: journalObject(entry),
    ...(sourceLabel ? { context: { kind: "source" as const, label: sourceLabel } } : {}),
    occurredAt: journalTimestamp(entry),
    source: { kind: "journal", entry },
  };
}

/** The states worth naming in a feed row. A completed answer says so by
 * showing its recap, so it carries no badge. */
function visibleResearchState(status: ResearchNodeStatus): ActivityEvent["state"] {
  switch (status) {
    case "queued":
      return { kind: status, label: "Queued" };
    case "running":
      return { kind: status, label: "Running" };
    case "failed":
      return { kind: status, label: "Failed" };
    case "cancelled":
      return { kind: status, label: "Cancelled" };
    case "interrupted":
      return { kind: status, label: "Interrupted" };
    case "complete":
      return undefined;
  }
}

export function activityEventFromResearchQuery(
  query: RecentResearchQuery,
  tree?: ResearchTreeSummary,
): RecentActivityEvent {
  const followUp = Boolean(query.parentNodeId);
  const state = visibleResearchState(query.status);
  return {
    id: `research:${query.nodeId}`,
    actor: { kind: "user", label: "You" },
    action: { kind: "asked", label: "asked" },
    object: { kind: "research-query", id: query.nodeId, label: "Research" },
    context: { kind: "research", label: tree?.title ?? "Research" },
    relationship: {
      kind: followUp ? "follow-up" : "top-level",
      label: followUp ? "Follow-up" : "Top-level",
    },
    execution: {
      model: query.model,
      ...(query.origin ? { origin: query.origin } : {}),
    },
    ...(state ? { state } : {}),
    occurredAt: query.createdAt,
    source: { kind: "research-query", query },
  };
}

export function buildRecentActivity(
  entries: JournalEntry[],
  queries: RecentResearchQuery[],
  trees: ResearchTreeSummary[],
): RecentActivityEvent[] {
  const treeById = new Map(trees.map((tree) => [tree.id, tree]));
  return [
    ...entries.map(activityEventFromJournalEntry),
    ...queries.map((query) => activityEventFromResearchQuery(query, treeById.get(query.treeId))),
  ].sort((left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id));
}

export function recentActivityItemFromJournalEntry(entry: JournalEntry): RecentActivityItem {
  const occurredAt = Date.parse(entry.createdAt);
  return {
    kind: "journal",
    occurredAt: Number.isFinite(occurredAt) ? occurredAt : 0,
    entry,
  };
}

export function recentActivityItemFromResearchQuery(
  query: RecentResearchQuery,
): RecentActivityItem {
  return { kind: "research-query", occurredAt: query.createdAt, query };
}

/** Insert or replace one item, keeping the feed's order without re-sorting it. */
export function upsertRecentActivityItem(
  items: RecentActivityItem[],
  item: RecentActivityItem,
): RecentActivityItem[] {
  const id = recentActivityItemId(item);
  const next = items.filter((candidate) => recentActivityItemId(candidate) !== id);
  let low = 0;
  let high = next.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = next[middle];
    if (candidate && compareRecentActivityItems(candidate, item) <= 0) low = middle + 1;
    else high = middle;
  }
  next.splice(low, 0, item);
  return next;
}

export function mergeRecentActivityItems(
  current: RecentActivityItem[],
  incoming: RecentActivityItem[],
): RecentActivityItem[] {
  const byId = new Map(current.map((item) => [recentActivityItemId(item), item]));
  for (const item of incoming) {
    byId.set(recentActivityItemId(item), item);
  }
  return [...byId.values()].sort(compareRecentActivityItems);
}

/** Replace the head of a loaded feed with a freshly fetched first page. The
 * tail is kept only when the new page ends in a cursor to continue from;
 * without one the head is the whole feed. */
export function reconcileRecentActivityHead(
  current: RecentActivityItem[],
  head: RecentActivityItem[],
  nextCursor: RecentActivityCursor | null,
): RecentActivityItem[] {
  if (!nextCursor) {
    return [...head].sort(compareRecentActivityItems);
  }
  const olderTail = current.filter((item) =>
    activityCursorIsBefore(recentActivityItemCursor(item), nextCursor),
  );
  return mergeRecentActivityItems(olderTail, head);
}

export function buildRecentActivityFromItems(
  items: RecentActivityItem[],
  trees: ResearchTreeSummary[],
): RecentActivityEvent[] {
  const treeById = new Map(trees.map((tree) => [tree.id, tree]));
  return items
    .filter(
      (item) => item.kind === "journal" || treeById.get(item.query.treeId)?.archivedAt == null,
    )
    .map((item) =>
      item.kind === "journal"
        ? activityEventFromJournalEntry(item.entry)
        : activityEventFromResearchQuery(item.query, treeById.get(item.query.treeId)),
    )
    .sort((left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id));
}
