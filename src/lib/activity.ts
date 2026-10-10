import { nodeType } from "./researchNodeTypes";
import type {
  NoteDelivery,
  NoteReply,
  RecentResearchQuery,
  RecentResearchQueryCursor,
  ResearchNode,
  ResearchNodeStatus,
  ResearchTreeSummary,
} from "../types";

/**
 * Shared activity grammar. Surfaces render these semantic slots rather than
 * hand-building slightly different metadata sentences for each source.
 */
interface ActivityEvent<TSource = unknown> {
  id: string;
  actor: { kind: "user" | "agent" | "system"; label: string };
  action: { kind: "saved" | "asked" | "posted" | "created" | "completed"; label: string };
  object: {
    kind: "link" | "post" | "note" | "research-query" | "artifact" | "task";
    id: string;
    label: string;
  };
  context?: { kind: "research" | "source" | "workspace"; label: string };
  relationship?: { kind: "top-level" | "follow-up"; label: string };
  execution?: { adapter: string; model?: string | null; origin?: string | null };
  state?: { kind: ResearchNodeStatus | "ready"; label: string };
  occurredAt: number;
  source: TSource;
}

type RecentActivitySource = { kind: "research-query"; query: RecentResearchQuery };

export type RecentActivityEvent = ActivityEvent<RecentActivitySource>;

/** One page of Home's feed: research roots (runs and notes), newest first. */
export interface RecentActivityPage {
  items: RecentResearchQuery[];
  nextCursor?: RecentResearchQueryCursor | null;
}

/** Top-level replies Home carries per note; mirrors the backend's
 * `RECENT_ACTIVITY_NOTE_REPLY_LIMIT`. */
const RECENT_ACTIVITY_NOTE_REPLY_LIMIT = 5;

function topLevelReplyCount(replies: NoteReply[] = []): number {
  return replies.filter((reply) => !reply.inReplyTo).length;
}

/** The delivery with only the first `limit` top-level replies and the
 * responses to them, matching the backend's feed payload. */
export function cappedNoteDelivery(delivery: NoteDelivery, limit: number): NoteDelivery {
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

/** Display name of a reply's author as follow-ups name it ("@Ana's reply"). */
export function noteReplyAuthorName(reply: NoteReply): string {
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
  const kind = node.kind ?? "run";
  if (!includeFollowUps && node.parentNodeId) {
    return null;
  }
  return {
    nodeId: node.id,
    treeId: node.treeId,
    parentNodeId: node.parentNodeId,
    inline: Boolean(node.inline),
    prompt: node.prompt,
    queryTarget: node.queryAnchor?.exact,
    attachments: node.attachments,
    title: node.title,
    adapter: node.adapter,
    model: node.model,
    ...(node.origin ? { origin: node.origin } : {}),
    kind,
    ...(node.delivery
      ? {
          delivery: cappedNoteDelivery(node.delivery, RECENT_ACTIVITY_NOTE_REPLY_LIMIT),
          replyCount: topLevelReplyCount(node.delivery.replies),
        }
      : {}),
    ...(node.replyAnchor ? { replyAnchor: node.replyAnchor } : {}),
    status: node.status,
    ...(node.error ? { error: node.error } : {}),
    createdAt: node.createdAt,
    recap: node.recap?.text.trim() || undefined,
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
  const author = reply ? noteReplyAuthorName(reply) : existing?.replyAnchorAuthor;
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
    query.promoted = existing.promoted;
  }
  return upsertRecentActivityItem(items, query);
}

/** Keeps a root's starred-children list in step with a node update: a
 * listed node takes the new prompt, title, and status, and an unstarred one
 * drops out. A newly starred node needs its depth and tree position from the
 * backend, so `stale` asks the caller to refetch the feed. */
export function patchRecentActivityPromoted(
  items: RecentResearchQuery[],
  node: ResearchNode & { promotedAt?: number | null },
): { items: RecentResearchQuery[]; stale: boolean } {
  const promotedAt = node.promotedAt ?? null;
  let stale = false;
  let changed = false;
  const next = items.map((item) => {
    if (item.treeId !== node.treeId || item.parentNodeId || item.nodeId === node.id) return item;
    const promoted = item.promoted ?? [];
    const index = promoted.findIndex((entry) => entry.nodeId === node.id);
    if (index < 0) {
      if (promotedAt != null) stale = true;
      return item;
    }
    changed = true;
    if (promotedAt == null) {
      return { ...item, promoted: promoted.filter((entry) => entry.nodeId !== node.id) };
    }
    const entry = promoted[index];
    return {
      ...item,
      promoted: promoted.map((candidate, position) =>
        position === index
          ? { ...entry, prompt: node.prompt, title: node.title, status: node.status, promotedAt }
          : candidate,
      ),
    };
  });
  return { items: changed ? next : items, stale };
}

export function activityEventFromResearchQuery(
  query: RecentResearchQuery,
  tree?: ResearchTreeSummary,
): RecentActivityEvent {
  const followUp = Boolean(query.parentNodeId);
  const note = nodeType(query) === "post";
  const object: RecentActivityEvent["object"] = note
    ? { kind: noteObjectKind(query), id: query.nodeId, label: "Note" }
    : { kind: "research-query", id: query.nodeId, label: "Research" };
  const action: RecentActivityEvent["action"] = !note
    ? { kind: "asked", label: "asked" }
    : query.delivery
      ? { kind: "posted", label: "Posted to network" }
      : { kind: "saved", label: object.kind === "post" ? "Saved post" : "Saved link" };
  const sourceLabel = note && !query.delivery ? savedSourceLabel(query) : null;
  return {
    id: `research:${query.nodeId}`,
    actor: { kind: "user", label: "You" },
    action,
    object,
    context: sourceLabel
      ? { kind: "source", label: sourceLabel }
      : { kind: "research", label: tree?.title ?? "Research" },
    relationship: {
      kind: followUp ? "follow-up" : "top-level",
      label: followUp ? "Follow-up" : "Top-level",
    },
    execution: {
      adapter: query.adapter,
      model: query.model,
      ...(query.origin ? { origin: query.origin } : {}),
    },
    state: visibleResearchState(query.status),
    occurredAt: query.createdAt,
    source: { kind: "research-query", query },
  };
}

/** A note with no delivery is a saved URL: a post when it resolved to a
 * tweet, otherwise a link. */
function noteObjectKind(query: RecentResearchQuery): "note" | "post" | "link" {
  if (query.delivery) return "note";
  return query.attachments?.some((attachment) => attachment.kind === "tweet") ? "post" : "link";
}

function savedSourceLabel(query: RecentResearchQuery): string | null {
  const tweet = query.attachments?.find((attachment) => attachment.kind === "tweet")?.tweet;
  if (tweet?.author.handle) return `@${tweet.author.handle}`;
  try {
    return new URL(query.prompt.trim()).hostname;
  } catch {
    return null;
  }
}

function visibleResearchState(status: ResearchNodeStatus): ActivityEvent["state"] {
  switch (status) {
    case "queued":
      return { kind: status, label: "Queued" };
    case "starting":
      return { kind: status, label: "Starting" };
    case "running":
      return { kind: status, label: "Running" };
    case "failed":
      return { kind: status, label: "Failed" };
    case "cancelled":
      return { kind: status, label: "Cancelled" };
    case "complete":
      return undefined;
  }
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

export function buildRecentActivityFromItems(
  items: RecentResearchQuery[],
  trees: ResearchTreeSummary[],
): RecentActivityEvent[] {
  const treeById = new Map(trees.map((tree) => [tree.id, tree]));
  return items
    .filter((item) => treeById.get(item.treeId)?.archivedAt == null)
    .map((item) => activityEventFromResearchQuery(item, treeById.get(item.treeId)))
    .sort((left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id));
}
