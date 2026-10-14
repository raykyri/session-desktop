import type {
  ParsedResearchEvent,
  ResearchFollowupQueueItem,
  SessionEvent,
  ResearchHighlight,
  ResearchNode,
  ResearchNodeStatus,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "../wire/index.js";

import { nodeRun, nodeStatus } from "./researchNodeTypes.js";

// The event union is part of the wire model (`../wire/events.ts`).
export type { ParsedResearchEvent };

type ResearchEventParseResult =
  | { kind: "event"; event: ParsedResearchEvent }
  | { kind: "notResearch" }
  | { kind: "unsupported"; type: string }
  | { kind: "malformed"; type: string };

// The statuses the desktop backend sends, plus the web's `interrupted` (a
// deploy or crash stopped a run the server resumes). The desktop backend never
// sends `interrupted`.
const RESEARCH_STATUSES = new Set<ResearchNodeStatus>([
  "queued",
  "starting",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || value === null || isFiniteNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isResearchTree(value: unknown): value is ResearchTree {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.rootNodeId === "string" &&
    typeof value.workspaceId === "string" &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isOptionalFiniteNumber(value.archivedAt) &&
    isOptionalFiniteNumber(value.trashedAt) &&
    isOptionalFiniteNumber(value.lastViewedAt)
  );
}

function isResearchHighlight(value: unknown): value is ResearchHighlight {
  if (!isRecord(value) || !isRecord(value.anchor)) {
    return false;
  }
  const anchor = value.anchor;
  return (
    typeof value.id === "string" &&
    isFiniteNumber(value.createdAt) &&
    anchor.version === 1 &&
    anchor.projection === "answer-v1" &&
    typeof anchor.responseRevision === "string" &&
    isFiniteNumber(anchor.start) &&
    isFiniteNumber(anchor.end) &&
    typeof anchor.exact === "string" &&
    typeof anchor.prefix === "string" &&
    typeof anchor.suffix === "string"
  );
}

function isUserMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    (value.attachments === undefined || Array.isArray(value.attachments))
  );
}

function isAgentSpec(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.adapter === "string" &&
    isOptionalString(value.model) &&
    isOptionalString(value.effort)
  );
}

function isOptionalRecap(value: unknown): boolean {
  return (
    value == null ||
    (isRecord(value) &&
      typeof value.text === "string" &&
      typeof value.responseRevision === "string" &&
      isOptionalString(value.id) &&
      isOptionalFiniteNumber(value.generatedAt) &&
      isOptionalString(value.adapter) &&
      isOptionalString(value.model) &&
      isOptionalString(value.instructions))
  );
}

function isRunState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.status === "string" &&
    RESEARCH_STATUSES.has(value.status as ResearchNodeStatus) &&
    isOptionalString(value.error) &&
    isOptionalFiniteNumber(value.startedAt) &&
    isOptionalFiniteNumber(value.completedAt) &&
    isOptionalFiniteNumber(value.responseSnapshotAt) &&
    typeof value.sessionReady === "boolean"
  );
}

/** The envelope every node shares, then the fields its type requires
 * (src/types.ts ResearchNode, the backend's ResearchNodeView). */
function isResearchNode(value: unknown): value is ResearchNode {
  if (!isRecord(value)) {
    return false;
  }
  const envelope =
    typeof value.id === "string" &&
    typeof value.treeId === "string" &&
    typeof value.groupId === "string" &&
    isFiniteNumber(value.createdAt) &&
    isOptionalString(value.parentNodeId) &&
    isOptionalString(value.title) &&
    isOptionalBoolean(value.inline) &&
    (value.anchor == null || isRecord(value.anchor)) &&
    Array.isArray(value.highlights) &&
    value.highlights.every(isResearchHighlight);
  if (!envelope) {
    return false;
  }
  switch (value.type) {
    case "post":
      return (
        isUserMessage(value.message) &&
        (value.format === "text" || value.format === "link") &&
        isAgentSpec(value.followUpAgent) &&
        isOptionalFiniteNumber(value.editedAt)
      );
    case "exchange":
      return (
        isUserMessage(value.message) &&
        isAgentSpec(value.agent) &&
        isRunState(value.run) &&
        isOptionalRecap(value.recap)
      );
    case "document":
      return (
        (value.message == null || isUserMessage(value.message)) &&
        (value.source === "imported" ||
          value.source === "authored" ||
          value.source === "transcript") &&
        (value.followUpAgent == null || isAgentSpec(value.followUpAgent)) &&
        isOptionalFiniteNumber(value.responseSnapshotAt) &&
        isOptionalRecap(value.recap) &&
        isOptionalFiniteNumber(value.editedAt)
      );
    default:
      return false;
  }
}

/** Parse and minimally validate a backend event before it is allowed to
 * mutate live research state. A malformed or newly-added research event is
 * distinguishable from an unrelated event so the caller can recover with an
 * authoritative refetch instead of silently ignoring it. */
/** A web follow-up queue item (`research.queue.changed`). */
function isFollowupQueueItem(value: unknown): value is ResearchFollowupQueueItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.treeId === "string" &&
    typeof value.headNodeId === "string" &&
    typeof value.authorId === "string" &&
    isUserMessage(value.message) &&
    isAgentSpec(value.agent) &&
    isFiniteNumber(value.position) &&
    isFiniteNumber(value.createdAt) &&
    isOptionalString(value.failedReason)
  );
}

export function parseResearchEvent(event: SessionEvent): ResearchEventParseResult {
  if (!event.type.startsWith("research.")) {
    return { kind: "notResearch" };
  }
  const malformed = (): ResearchEventParseResult => ({
    kind: "malformed",
    type: event.type,
  });
  if (!isFiniteNumber(event.timestamp) || !isRecord(event.payload)) {
    return malformed();
  }
  const payload = event.payload;
  switch (event.type) {
    case "research.tree.created":
      return isResearchTree(payload.tree) && isResearchNode(payload.node)
        ? {
            kind: "event",
            event: {
              type: event.type,
              tree: payload.tree,
              node: payload.node,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.document.updated":
      return isResearchTree(payload.tree) &&
        isResearchNode(payload.node) &&
        typeof payload.responseRevision === "string" &&
        typeof payload.markdownChanged === "boolean" &&
        isFiniteNumber(payload.removedHighlightCount)
        ? {
            kind: "event",
            event: {
              type: event.type,
              tree: payload.tree,
              node: payload.node,
              responseRevision: payload.responseRevision,
              markdownChanged: payload.markdownChanged,
              removedHighlightCount: payload.removedHighlightCount,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.node.created":
    case "research.node.updated":
      return isResearchNode(payload.node) && isOptionalFiniteNumber(payload.queuePosition)
        ? {
            kind: "event",
            event: {
              type: event.type,
              node: payload.node,
              // Web only; the desktop backend never sends it.
              ...(isFiniteNumber(payload.queuePosition)
                ? { queuePosition: payload.queuePosition }
                : {}),
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.tree.updated":
    case "research.tree.archived":
    case "research.tree.restored":
      return isResearchTree(payload.tree)
        ? {
            kind: "event",
            event: { type: event.type, tree: payload.tree, timestamp: event.timestamp },
          }
        : malformed();
    case "research.highlight.created":
      return typeof payload.nodeId === "string" && isResearchHighlight(payload.highlight)
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              highlight: payload.highlight,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.highlights.removed":
      return typeof payload.nodeId === "string" && isStringArray(payload.highlightIds)
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              highlightIds: payload.highlightIds,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.recap.pending":
      return typeof payload.nodeId === "string" && typeof payload.pending === "boolean"
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              pending: payload.pending,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.tree.removed":
      return typeof payload.treeId === "string"
        ? {
            kind: "event",
            event: { type: event.type, treeId: payload.treeId, timestamp: event.timestamp },
          }
        : malformed();
    case "research.node.removed":
      return typeof payload.treeId === "string" &&
        typeof payload.parentNodeId === "string" &&
        isStringArray(payload.removedNodeIds)
        ? {
            kind: "event",
            event: {
              type: event.type,
              treeId: payload.treeId,
              parentNodeId: payload.parentNodeId,
              removedNodeIds: payload.removedNodeIds,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.drafts.changed":
      return typeof payload.workspaceId === "string"
        ? {
            kind: "event",
            event: {
              type: event.type,
              workspaceId: payload.workspaceId,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.folders.changed":
    case "research.trash.changed":
      // The web server names the workspace; the desktop sends an empty payload.
      if (payload.workspaceId !== undefined && typeof payload.workspaceId !== "string") {
        return malformed();
      }
      return {
        kind: "event",
        event: {
          type: event.type,
          ...(typeof payload.workspaceId === "string" ? { workspaceId: payload.workspaceId } : {}),
          timestamp: event.timestamp,
        },
      };
    // Web only; the desktop backend never sends it.
    case "research.queue.changed":
      return typeof payload.treeId === "string" &&
        typeof payload.headNodeId === "string" &&
        Array.isArray(payload.items) &&
        payload.items.every(isFollowupQueueItem)
        ? {
            kind: "event",
            event: {
              type: event.type,
              treeId: payload.treeId,
              headNodeId: payload.headNodeId,
              items: payload.items,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    default:
      return { kind: "unsupported", type: event.type };
  }
}

interface ResearchStatusContribution {
  runningCount: number;
  failedCount: number;
  completedCount: number;
  cancelledCount: number;
}

export function researchStatusContribution(status: ResearchNodeStatus): ResearchStatusContribution {
  return {
    runningCount: status === "queued" || status === "starting" || status === "running" ? 1 : 0,
    failedCount: status === "failed" ? 1 : 0,
    completedCount: status === "complete" ? 1 : 0,
    cancelledCount: status === "cancelled" ? 1 : 0,
  };
}

/** A node's share of its tree's run counts: posts and documents have no run
 * and count for nothing, as in the backend's summaries. */
function nodeRunContribution(node: ResearchNode): ResearchStatusContribution {
  const run = nodeRun(node);
  return run
    ? researchStatusContribution(run.status)
    : { runningCount: 0, failedCount: 0, completedCount: 0, cancelledCount: 0 };
}

export function researchSummaryFromDetail(detail: ResearchTreeDetail): ResearchTreeSummary {
  let runningCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  let cancelledCount = 0;
  let latestSettlement: number | null = null;
  let latestFailure: number | null = null;
  // Runs only, as the backend counts: posts and documents have no run.
  for (const run of detail.nodes.map(nodeRun)) {
    if (!run) continue;
    const contribution = researchStatusContribution(run.status);
    runningCount += contribution.runningCount;
    failedCount += contribution.failedCount;
    completedCount += contribution.completedCount;
    cancelledCount += contribution.cancelledCount;
    const completedAt = run.completedAt;
    if (completedAt != null) {
      latestSettlement = Math.max(latestSettlement ?? completedAt, completedAt);
      if (run.status === "failed") {
        latestFailure = Math.max(latestFailure ?? completedAt, completedAt);
      }
    }
  }
  const lastViewedAt = detail.tree.lastViewedAt ?? null;
  const unseen = (settledAt: number | null) =>
    settledAt !== null && (lastViewedAt === null || settledAt > lastViewedAt);
  const root = detail.nodes.find((node) => node.id === detail.tree.rootNodeId);
  return {
    id: detail.tree.id,
    title: detail.tree.title,
    rootNodeId: detail.tree.rootNodeId,
    type: root?.type ?? "exchange",
    workspaceId: detail.tree.workspaceId,
    runningCount,
    failedCount,
    completedCount,
    cancelledCount,
    updatedAt: detail.tree.updatedAt,
    archivedAt: detail.tree.archivedAt ?? null,
    hasUnseenUpdate: unseen(latestSettlement),
    hasUnseenFailure: unseen(latestFailure),
  };
}

function compareResearchNodes(left: ResearchNode, right: ResearchNode): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

/** Upsert one full-node event while preserving collection identity for an
 * identical object and the backend's (createdAt, id) ordering. */
export function upsertResearchNode(nodes: ResearchNode[], node: ResearchNode): ResearchNode[] {
  const index = nodes.findIndex((candidate) => candidate.id === node.id);
  if (index >= 0) {
    if (nodes[index] === node) {
      return nodes;
    }
    const next = [...nodes];
    next[index] = node;
    if (compareResearchNodes(nodes[index]!, node) !== 0) {
      next.sort(compareResearchNodes);
    }
    return next;
  }
  const next = [...nodes, node];
  next.sort(compareResearchNodes);
  return next;
}

export function removeResearchNodes(
  nodes: ResearchNode[],
  removedIds: Iterable<string>,
): ResearchNode[] {
  const removed = removedIds instanceof Set ? removedIds : new Set(removedIds);
  const next = nodes.filter((node) => !removed.has(node.id));
  return next.length === nodes.length ? nodes : next;
}

export function researchNodeIsActivity(node: ResearchNode): boolean {
  return (
    nodeStatus(node) === "queued" ||
    nodeStatus(node) === "starting" ||
    nodeStatus(node) === "running" ||
    // The web's status for a run the server resumes after a restart.
    nodeStatus(node) === "interrupted"
  );
}

export function upsertResearchActivity(
  activity: ResearchNode[],
  node: ResearchNode,
): ResearchNode[] {
  return researchNodeIsActivity(node)
    ? upsertResearchNode(activity, node)
    : removeResearchNodes(activity, [node.id]);
}

export function patchResearchDetailNode(
  detail: ResearchTreeDetail | null,
  node: ResearchNode,
): ResearchTreeDetail | null {
  if (!detail || detail.tree.id !== node.treeId) {
    return detail;
  }
  const nodes = upsertResearchNode(detail.nodes, node);
  return nodes === detail.nodes ? detail : { ...detail, nodes };
}

export function patchResearchDetailTree(
  detail: ResearchTreeDetail | null,
  tree: ResearchTree,
): ResearchTreeDetail | null {
  if (!detail || detail.tree.id !== tree.id || detail.tree === tree) {
    return detail;
  }
  return { ...detail, tree };
}

export function removeResearchDetailNodes(
  detail: ResearchTreeDetail | null,
  treeId: string,
  removedIds: Iterable<string>,
): ResearchTreeDetail | null {
  if (!detail || detail.tree.id !== treeId) {
    return detail;
  }
  const nodes = removeResearchNodes(detail.nodes, removedIds);
  return nodes === detail.nodes ? detail : { ...detail, nodes };
}

export function addResearchNodeHighlight(
  node: ResearchNode,
  highlight: ResearchHighlight,
): ResearchNode {
  if (node.highlights.some((candidate) => candidate.id === highlight.id)) {
    return node;
  }
  return { ...node, highlights: [...node.highlights, highlight] };
}

export function removeResearchNodeHighlights(
  node: ResearchNode,
  highlightIds: Iterable<string>,
): ResearchNode {
  const removed = highlightIds instanceof Set ? highlightIds : new Set(highlightIds);
  const highlights = node.highlights.filter((highlight) => !removed.has(highlight.id));
  return highlights.length === node.highlights.length ? node : { ...node, highlights };
}

export function patchResearchDetailHighlightCreated(
  detail: ResearchTreeDetail | null,
  nodeId: string,
  highlight: ResearchHighlight,
): ResearchTreeDetail | null {
  if (!detail) {
    return detail;
  }
  const node = detail.nodes.find((candidate) => candidate.id === nodeId);
  return node ? patchResearchDetailNode(detail, addResearchNodeHighlight(node, highlight)) : detail;
}

export function patchResearchDetailHighlightsRemoved(
  detail: ResearchTreeDetail | null,
  nodeId: string,
  highlightIds: Iterable<string>,
): ResearchTreeDetail | null {
  if (!detail) {
    return detail;
  }
  const node = detail.nodes.find((candidate) => candidate.id === nodeId);
  return node
    ? patchResearchDetailNode(detail, removeResearchNodeHighlights(node, highlightIds))
    : detail;
}

/** Patch the summary fields carried authoritatively by a tree event without
 * disturbing node-derived counts or attention flags. */
export function patchResearchSummaryTree(
  summary: ResearchTreeSummary,
  tree: ResearchTree,
): ResearchTreeSummary {
  if (summary.id !== tree.id) {
    return summary;
  }
  const archivedAt = tree.archivedAt ?? null;
  if (
    summary.title === tree.title &&
    summary.rootNodeId === tree.rootNodeId &&
    summary.workspaceId === tree.workspaceId &&
    summary.updatedAt === tree.updatedAt &&
    (summary.archivedAt ?? null) === archivedAt
  ) {
    return summary;
  }
  return {
    ...summary,
    title: tree.title,
    rootNodeId: tree.rootNodeId,
    workspaceId: tree.workspaceId,
    updatedAt: tree.updatedAt,
    archivedAt,
  };
}

function terminalStatus(status: ResearchNodeStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

/** Apply the node-derived portion of a summary update. The caller must supply
 * the previously observed full node; without it, count deltas are ambiguous
 * and the safe path is a targeted authoritative tree refresh. */
export function patchResearchSummaryForNode(
  summary: ResearchTreeSummary,
  previous: ResearchNode,
  node: ResearchNode,
  eventTimestamp: number,
): ResearchTreeSummary {
  if (summary.id !== node.treeId || previous.id !== node.id || previous.treeId !== node.treeId) {
    return summary;
  }
  const before = nodeRunContribution(previous);
  const after = nodeRunContribution(node);
  const previousRun = nodeRun(previous);
  const run = nodeRun(node);
  const lifecycleChanged =
    previousRun?.status !== run?.status || previousRun?.completedAt !== run?.completedAt;
  if (!lifecycleChanged) {
    return summary;
  }
  const newlySettled =
    run != null &&
    terminalStatus(run.status) &&
    run.completedAt != null &&
    previousRun?.completedAt !== run.completedAt;
  return {
    ...summary,
    runningCount: Math.max(0, summary.runningCount - before.runningCount + after.runningCount),
    failedCount: Math.max(0, summary.failedCount - before.failedCount + after.failedCount),
    completedCount: Math.max(
      0,
      summary.completedCount - before.completedCount + after.completedCount,
    ),
    cancelledCount: Math.max(
      0,
      summary.cancelledCount - before.cancelledCount + after.cancelledCount,
    ),
    updatedAt: Math.max(
      summary.updatedAt,
      eventTimestamp,
      run?.startedAt ?? 0,
      run?.completedAt ?? 0,
    ),
    hasUnseenUpdate: summary.hasUnseenUpdate || newlySettled,
    hasUnseenFailure: summary.hasUnseenFailure || (newlySettled && run?.status === "failed"),
  };
}

/** Add the status contribution of a newly-created node. Node-created events
 * do not include the tree, but they do carry everything needed for the live
 * count badges while the trailing authoritative tree read is debounced. */
export function patchResearchSummaryForCreatedNode(
  summary: ResearchTreeSummary,
  node: ResearchNode,
  eventTimestamp: number,
): ResearchTreeSummary {
  if (summary.id !== node.treeId) {
    return summary;
  }
  const contribution = nodeRunContribution(node);
  return {
    ...summary,
    runningCount: summary.runningCount + contribution.runningCount,
    failedCount: summary.failedCount + contribution.failedCount,
    completedCount: summary.completedCount + contribution.completedCount,
    cancelledCount: summary.cancelledCount + contribution.cancelledCount,
    updatedAt: Math.max(summary.updatedAt, eventTimestamp),
  };
}

/** Removes cached node contributions for a branch deletion. Attention flags
 * remain set because another node may require them. The debounced tree read
 * resolves counts when the local cache did not contain every removed node. */
export function patchResearchSummaryForRemovedNodes(
  summary: ResearchTreeSummary,
  treeId: string,
  removedNodes: ResearchNode[],
  eventTimestamp: number,
): ResearchTreeSummary {
  if (summary.id !== treeId || removedNodes.length === 0) {
    return summary;
  }
  const removed = removedNodes.reduce(
    (total, node) => {
      const contribution = nodeRunContribution(node);
      total.runningCount += contribution.runningCount;
      total.failedCount += contribution.failedCount;
      total.completedCount += contribution.completedCount;
      total.cancelledCount += contribution.cancelledCount;
      return total;
    },
    { runningCount: 0, failedCount: 0, completedCount: 0, cancelledCount: 0 },
  );
  return {
    ...summary,
    runningCount: Math.max(0, summary.runningCount - removed.runningCount),
    failedCount: Math.max(0, summary.failedCount - removed.failedCount),
    completedCount: Math.max(0, summary.completedCount - removed.completedCount),
    cancelledCount: Math.max(0, summary.cancelledCount - removed.cancelledCount),
    updatedAt: Math.max(summary.updatedAt, eventTimestamp),
  };
}
