import { nodeAdapter, nodeAgent, nodeAttachments, nodePrompt, nodeRecap, nodeRun, nodeStatus, passageAnchor } from "@session/shared/lib/researchNodeTypes";
import type {
  RecentResearchQuery,
  RecentResearchQueryCursor,
  ResearchNode,
} from "../types";

/** One page of Home's feed: research roots (runs and posts), newest first. */
export interface RecentActivityPage {
  items: RecentResearchQuery[];
  nextCursor?: RecentResearchQueryCursor | null;
}

export function recentActivityCursor(query: RecentResearchQuery): RecentResearchQueryCursor {
  return { createdAt: query.createdAt, nodeId: query.nodeId };
}

export function activityCursorIsBefore(
  candidate: RecentResearchQueryCursor,
  boundary: RecentResearchQueryCursor,
): boolean {
  return (
    candidate.createdAt < boundary.createdAt ||
    (candidate.createdAt === boundary.createdAt && candidate.nodeId < boundary.nodeId)
  );
}

/** Newest first; ties broken by descending node id, as the backend pages. */
function compareRecentActivityItems(
  left: RecentResearchQuery,
  right: RecentResearchQuery,
): number {
  return (
    right.createdAt - left.createdAt ||
    (right.nodeId < left.nodeId ? -1 : right.nodeId > left.nodeId ? 1 : 0)
  );
}

export function recentResearchQueryFromNode(
  node: ResearchNode,
  includeFollowUps = false,
): RecentResearchQuery | null {
  if (!includeFollowUps && node.parentNodeId) {
    return null;
  }
  const error = nodeRun(node)?.error;
  return {
    nodeId: node.id,
    treeId: node.treeId,
    parentNodeId: node.parentNodeId,
    inline: Boolean(node.inline),
    prompt: nodePrompt(node),
    queryTarget: passageAnchor(node)?.exact,
    attachments: nodeAttachments(node),
    title: node.title,
    adapter: nodeAdapter(node),
    model: nodeAgent(node)?.model,
    type: node.type,
    ...(node.type === "document" ? { source: node.source } : {}),
    ...(node.type === "post" ? { format: node.format } : {}),
    status: nodeStatus(node),
    ...(error ? { error } : {}),
    createdAt: node.createdAt,
    recap: nodeRecap(node)?.text.trim() || undefined,
  };
}

/** Live node events update children within their loaded root, without changing feed order. */
export function upsertRecentActivityResearchNode(
  items: RecentResearchQuery[],
  node: ResearchNode,
): RecentResearchQuery[] {
  const query = recentResearchQueryFromNode(node, true);
  if (!query) return items;
  if (query.parentNodeId) {
    return items.map((item) => {
      if (item.nodeId !== query.parentNodeId || item.treeId !== query.treeId) return item;
      const children = [
        ...(item.children ?? []).filter((candidate) => candidate.nodeId !== query.nodeId),
        query,
      ].sort((left, right) =>
        left.createdAt - right.createdAt || left.nodeId.localeCompare(right.nodeId),
      );
      return { ...item, children };
    });
  }
  const existing = items.find((item) => item.nodeId === query.nodeId);
  if (existing) {
    query.children = existing.children;
  }
  return upsertRecentActivityItem(items, query);
}

export function upsertRecentActivityItem(
  items: RecentResearchQuery[],
  item: RecentResearchQuery,
): RecentResearchQuery[] {
  const next = items.filter((candidate) => candidate.nodeId !== item.nodeId);
  let low = 0;
  let high = next.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareRecentActivityItems(next[middle], item) <= 0) low = middle + 1;
    else high = middle;
  }
  next.splice(low, 0, item);
  return next;
}

export function mergeRecentActivityItems(
  current: RecentResearchQuery[],
  incoming: RecentResearchQuery[],
): RecentResearchQuery[] {
  const byId = new Map(current.map((item) => [item.nodeId, item]));
  for (const item of incoming) {
    byId.set(item.nodeId, item);
  }
  return [...byId.values()].sort(compareRecentActivityItems);
}

export function reconcileRecentActivityHead(
  current: RecentResearchQuery[],
  head: RecentResearchQuery[],
  nextCursor: RecentResearchQueryCursor | null,
): RecentResearchQuery[] {
  if (!nextCursor) {
    return [...head].sort(compareRecentActivityItems);
  }
  const olderTail = current.filter((item) =>
    activityCursorIsBefore(recentActivityCursor(item), nextCursor),
  );
  return mergeRecentActivityItems(olderTail, head);
}
