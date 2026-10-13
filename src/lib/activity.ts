import { nodeAdapter, nodeAgent, nodeAttachments, nodeDelivery, nodePrompt, nodeRecap, nodeRun, nodeStatus, passageAnchor, replyAnchorId } from "./researchNodeTypes";
import type {
  PostDelivery,
  PostReply,
  RecentResearchQuery,
  RecentResearchQueryCursor,
  ResearchNode,
} from "../types";

/** One page of Home's feed: research roots (runs and posts), newest first. */
export interface RecentActivityPage {
  items: RecentResearchQuery[];
  nextCursor?: RecentResearchQueryCursor | null;
}

/** Number of top-level replies included per post on Home; mirrors the backend's
 * `RECENT_ACTIVITY_POST_REPLY_LIMIT`. */
const RECENT_ACTIVITY_POST_REPLY_LIMIT = 5;

function topLevelReplyCount(replies: PostReply[] = []): number {
  return replies.filter((reply) => !reply.inReplyTo).length;
}

/** The delivery with only the first `limit` top-level replies and the
 * responses to them, matching the backend's feed payload. */
export function cappedPostDelivery(delivery: PostDelivery, limit: number): PostDelivery {
  const kept = new Set(
    (delivery.replies ?? [])
      .filter((reply) => !reply.inReplyTo)
      .slice(0, limit)
      .map((reply) => reply.id),
  );
  return {
    ...delivery,
    replies: (delivery.replies ?? []).filter(
      (reply) => kept.has(reply.id) || (reply.inReplyTo != null && kept.has(reply.inReplyTo)),
    ),
  };
}

/** Display name of a reply's author, as the backend's `replyAnchorAuthor`
 * names it. */
function postReplyAuthorName(reply: PostReply): string {
  return reply.author.kind === "member" ? reply.author.displayName : "You";
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
  const delivery = nodeDelivery(node);
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
    ...(delivery
      ? {
          delivery: cappedPostDelivery(delivery, RECENT_ACTIVITY_POST_REPLY_LIMIT),
          replyCount: topLevelReplyCount(delivery.replies),
        }
      : {}),
    ...(replyAnchorId(node) ? { replyAnchor: replyAnchorId(node) } : {}),
    status: nodeStatus(node),
    ...(error ? { error } : {}),
    createdAt: node.createdAt,
    recap: nodeRecap(node)?.text.trim() || undefined,
  };
}

/** Resolves a follow-up's reply target against its loaded parent. The
 * parent's delivery may be cut to the first replies; a target outside that
 * window keeps the author name the backend supplied. */
function withReplyAnchorAuthor(
  child: RecentResearchQuery,
  parent: RecentResearchQuery,
  existing?: RecentResearchQuery,
): RecentResearchQuery {
  if (!child.replyAnchor) return child;
  const reply = parent.delivery?.replies?.find((candidate) => candidate.id === child.replyAnchor);
  const author = reply ? postReplyAuthorName(reply) : existing?.replyAnchorAuthor;
  return author ? { ...child, replyAnchorAuthor: author } : child;
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
      const existing = item.children?.find((child) => child.nodeId === query.nodeId);
      const child = withReplyAnchorAuthor(query, item, existing);
      const children = [
        ...(item.children ?? []).filter((candidate) => candidate.nodeId !== query.nodeId),
        child,
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
