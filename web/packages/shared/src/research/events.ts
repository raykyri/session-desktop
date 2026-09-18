// Parsing and reducers for the server's event stream
// (`03-api-and-events.md` §3).
//
// `parseResearchEvent` narrows a loose `SessionEvent` into a closed union
// before it is allowed to mutate live state; the reducers below apply one
// parsed event to a cached collection, preserving object identity wherever
// nothing changed so the client's renderers can keep memoized subtrees.
//
// Ported from the desktop `src/lib/researchEvents.ts`, with the new run events
// (`05-run-lifecycle-and-streaming.md` §4), `models.updated`, and the node
// shape from `02-domain-model-and-database.md` §2 (`workspaceId`, `model`,
// `attempt`, `documentIds`; no `groupId`, `worktreeDir`, `adapter`, `paneId`,
// or `agentId`).

import type { ModelInfo, ModelProvider } from "../types/account.js";
import type { SessionEvent } from "../types/events.js";
import type {
  ResearchHighlight,
  ResearchNode,
  ResearchNodeContent,
  ResearchNodeStatus,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "../types/research.js";
import type { Turn } from "../types/turn.js";
import { isTurn } from "../types/turn.js";

import { isActiveResearchStatus } from "./threads.js";

type TreeCreatedEvent = {
  type: "research.tree.created";
  tree: ResearchTree;
  node: ResearchNode;
  timestamp: number;
};

type DocumentUpdatedEvent = {
  type: "research.document.updated";
  tree: ResearchTree;
  node: ResearchNode;
  responseRevision: string;
  markdownChanged: boolean;
  removedHighlightCount: number;
  timestamp: number;
};

type NodeEvent = {
  type: "research.node.created" | "research.node.updated";
  node: ResearchNode;
  /** Place in the admission queue while the node is `queued`; 0 means it has
   * been claimed (`03-api-and-events.md` §3). Carried on the update event so a
   * waiting reader's position advances without refetching `getNodeContent`,
   * which is the only other place it appears. Absent once the run starts, and
   * on `research.node.created`, which the server emits before admission. */
  queuePosition?: number;
  timestamp: number;
};

type TreeEvent = {
  type: "research.tree.updated" | "research.tree.archived" | "research.tree.restored";
  tree: ResearchTree;
  timestamp: number;
};

type HighlightCreatedEvent = {
  type: "research.highlight.created";
  nodeId: string;
  highlight: ResearchHighlight;
  timestamp: number;
};

type HighlightRemovedEvent = {
  type: "research.highlight.removed";
  nodeId: string;
  highlightId: string;
  timestamp: number;
};

type HighlightsRemovedEvent = {
  type: "research.highlights.removed";
  nodeId: string;
  highlightIds: string[];
  timestamp: number;
};

/** Background summary generation started or settled for a run. Purely a
 * viewer hint: the recap itself arrives as a node update. */
type RecapPendingEvent = {
  type: "research.recap.pending";
  nodeId: string;
  pending: boolean;
  timestamp: number;
};

type TreeRemovedEvent = {
  type: "research.tree.removed";
  treeId: string;
  timestamp: number;
};

type NodeRemovedEvent = {
  type: "research.node.removed";
  treeId: string;
  parentNodeId: string;
  removedNodeIds: string[];
  timestamp: number;
};

/** An attempt opened its provider stream. `attempt` distinguishes a retry or
 * auto-resume from the original run, so a viewer showing a stale attempt's
 * output knows to drop it. */
type RunStartedEvent = {
  type: "research.run.started";
  nodeId: string;
  attempt: number;
  seq: number;
  model: string;
  timestamp: number;
};

/** Reasoning is or is no longer streaming. No reasoning content is sent. */
type RunThinkingEvent = {
  type: "research.run.thinking";
  nodeId: string;
  seq: number;
  active: boolean;
  timestamp: number;
};

/** Text appended to the in-flight turn since the previous delta. */
type TurnDeltaEvent = {
  type: "research.turn.delta";
  nodeId: string;
  seq: number;
  turnId: string;
  text: string;
  timestamp: number;
};

/** A durable turn, replacing any live turn with the same id. */
type TurnCommittedEvent = {
  type: "research.turn.committed";
  nodeId: string;
  seq: number;
  turn: Turn;
  timestamp: number;
};

/** The attempt settled. Precedes the terminal `research.node.updated`, which
 * remains the authoritative carrier of the node row. */
type RunFinishedEvent = {
  type: "research.run.finished";
  nodeId: string;
  attempt: number;
  seq: number;
  status: ResearchNodeStatus;
  error?: string;
  timestamp: number;
};

/** Provider availability changed, so the model picker's entries changed. */
type ModelsUpdatedEvent = {
  type: "models.updated";
  models: ModelInfo[];
  timestamp: number;
};

/** Every event this build knows how to apply. Keeping this a closed union
 * makes a new server event take the explicit recovery path until its client
 * state effects are intentionally implemented. */
export type ParsedResearchEvent =
  | TreeCreatedEvent
  | DocumentUpdatedEvent
  | NodeEvent
  | TreeEvent
  | HighlightCreatedEvent
  | HighlightRemovedEvent
  | HighlightsRemovedEvent
  | RecapPendingEvent
  | TreeRemovedEvent
  | NodeRemovedEvent
  | RunStartedEvent
  | RunThinkingEvent
  | TurnDeltaEvent
  | TurnCommittedEvent
  | RunFinishedEvent
  | ModelsUpdatedEvent;

export type ResearchEventParseResult =
  | { kind: "event"; event: ParsedResearchEvent }
  | { kind: "notResearch" }
  | { kind: "unsupported"; type: string }
  | { kind: "malformed"; type: string };

const RESEARCH_STATUSES = new Set<ResearchNodeStatus>([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

const MODEL_PROVIDERS = new Set<ModelProvider>(["vertex", "openrouter", "anthropic"]);

/** Types this parser owns that are not under the `research.` prefix.
 *
 * `models.updated` is one of them, so the prefix guard is widened by this set
 * rather than split into a second parser. One entry point keeps the caller
 * from having to know which parser owns a type, and keeps the `unsupported`
 * classification meaningful: with two parsers, an event one of them did not
 * recognize would be reported as `notResearch` by the other, and the scoped
 * refetch that `unsupported` exists to trigger would never happen. */
const NON_RESEARCH_PARSED_TYPES = new Set<string>(["models.updated"]);

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
    isOptionalFiniteNumber(value.lastViewedAt) &&
    isOptionalBoolean(value.followed) &&
    isOptionalBoolean(value.bookmarked)
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

function isResearchNode(value: unknown): value is ResearchNode {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.treeId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.prompt === "string" &&
    typeof value.model === "string" &&
    isFiniteNumber(value.attempt) &&
    isStringArray(value.documentIds) &&
    typeof value.status === "string" &&
    RESEARCH_STATUSES.has(value.status as ResearchNodeStatus) &&
    isFiniteNumber(value.createdAt) &&
    isOptionalFiniteNumber(value.startedAt) &&
    isOptionalFiniteNumber(value.completedAt) &&
    isOptionalFiniteNumber(value.responseSnapshotAt) &&
    (value.recap == null ||
      (isRecord(value.recap) &&
        typeof value.recap.text === "string" &&
        typeof value.recap.responseRevision === "string" &&
        isOptionalString(value.recap.id) &&
        isOptionalFiniteNumber(value.recap.generatedAt) &&
        isOptionalString(value.recap.model) &&
        isOptionalString(value.recap.instructions))) &&
    isOptionalString(value.parentNodeId) &&
    isOptionalString(value.title) &&
    isOptionalString(value.responsePreview) &&
    isOptionalString(value.error) &&
    Array.isArray(value.highlights) &&
    value.highlights.every(isResearchHighlight)
  );
}

function isModelInfo(value: unknown): value is ModelInfo {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.provider === "string" &&
    MODEL_PROVIDERS.has(value.provider as ModelProvider) &&
    typeof value.adminOnly === "boolean" &&
    typeof value.available === "boolean" &&
    typeof value.supportsFiles === "boolean" &&
    typeof value.supportsImages === "boolean"
  );
}

/** Parse and minimally validate a server event before it is allowed to mutate
 * live research state. A malformed or newly-added event is distinguishable
 * from an unrelated one so the caller can recover with an authoritative
 * refetch instead of silently ignoring it. */
export function parseResearchEvent(event: SessionEvent): ResearchEventParseResult {
  if (!event.type.startsWith("research.") && !NON_RESEARCH_PARSED_TYPES.has(event.type)) {
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
              // `exactOptionalPropertyTypes`: omit the key rather than set it
              // to undefined when the node is not waiting for admission.
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
    case "research.highlight.removed":
      return typeof payload.nodeId === "string" && typeof payload.highlightId === "string"
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              highlightId: payload.highlightId,
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
    case "research.run.started":
      return typeof payload.nodeId === "string" &&
        isFiniteNumber(payload.attempt) &&
        isFiniteNumber(payload.seq) &&
        typeof payload.model === "string"
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              attempt: payload.attempt,
              seq: payload.seq,
              model: payload.model,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.run.thinking":
      return typeof payload.nodeId === "string" &&
        isFiniteNumber(payload.seq) &&
        typeof payload.active === "boolean"
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              seq: payload.seq,
              active: payload.active,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.turn.delta":
      return typeof payload.nodeId === "string" &&
        isFiniteNumber(payload.seq) &&
        typeof payload.turnId === "string" &&
        typeof payload.text === "string"
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              seq: payload.seq,
              turnId: payload.turnId,
              text: payload.text,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.turn.committed":
      return typeof payload.nodeId === "string" &&
        isFiniteNumber(payload.seq) &&
        isTurn(payload.turn)
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              seq: payload.seq,
              turn: payload.turn,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "research.run.finished":
      return typeof payload.nodeId === "string" &&
        isFiniteNumber(payload.attempt) &&
        isFiniteNumber(payload.seq) &&
        typeof payload.status === "string" &&
        RESEARCH_STATUSES.has(payload.status as ResearchNodeStatus) &&
        isOptionalString(payload.error)
        ? {
            kind: "event",
            event: {
              type: event.type,
              nodeId: payload.nodeId,
              attempt: payload.attempt,
              seq: payload.seq,
              status: payload.status as ResearchNodeStatus,
              // `exactOptionalPropertyTypes`: omit the key rather than set it
              // to undefined when the run finished without an error.
              ...(typeof payload.error === "string" ? { error: payload.error } : {}),
              timestamp: event.timestamp,
            },
          }
        : malformed();
    case "models.updated":
      return Array.isArray(payload.models) && payload.models.every(isModelInfo)
        ? {
            kind: "event",
            event: {
              type: event.type,
              models: payload.models,
              timestamp: event.timestamp,
            },
          }
        : malformed();
    default:
      return { kind: "unsupported", type: event.type };
  }
}

export interface ResearchStatusContribution {
  runningCount: number;
  failedCount: number;
  completedCount: number;
  cancelledCount: number;
}

/** A node's contribution to the four counters a tree summary carries
 * (`02-domain-model-and-database.md` §5.9).
 *
 * `interrupted` contributes to none of them: the summary has no interrupted
 * column, and an interrupted node has neither a live run to count as running
 * nor an outcome to bucket. When the server resumes it the node returns to
 * `running` and lands in `runningCount` again. */
export function researchStatusContribution(status: ResearchNodeStatus): ResearchStatusContribution {
  return {
    runningCount: status === "queued" || status === "running" ? 1 : 0,
    failedCount: status === "failed" ? 1 : 0,
    completedCount: status === "complete" ? 1 : 0,
    cancelledCount: status === "cancelled" ? 1 : 0,
  };
}

export function researchSummaryFromDetail(detail: ResearchTreeDetail): ResearchTreeSummary {
  let runningCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  let cancelledCount = 0;
  let latestSettlement: number | null = null;
  let latestFailure: number | null = null;
  for (const node of detail.nodes) {
    const contribution = researchStatusContribution(node.status);
    runningCount += contribution.runningCount;
    failedCount += contribution.failedCount;
    completedCount += contribution.completedCount;
    cancelledCount += contribution.cancelledCount;
    if (node.completedAt != null) {
      latestSettlement = Math.max(latestSettlement ?? node.completedAt, node.completedAt);
      if (node.status === "failed") {
        latestFailure = Math.max(latestFailure ?? node.completedAt, node.completedAt);
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
    kind: root?.kind ?? "run",
    workspaceId: detail.tree.workspaceId,
    runningCount,
    failedCount,
    completedCount,
    cancelledCount,
    updatedAt: detail.tree.updatedAt,
    archivedAt: detail.tree.archivedAt ?? null,
    followed: detail.tree.followed ?? false,
    bookmarked: detail.tree.bookmarked ?? false,
    hasUnseenUpdate: unseen(latestSettlement),
    hasUnseenFailure: unseen(latestFailure),
  };
}

function compareResearchNodes(left: ResearchNode, right: ResearchNode): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

/** Upsert one full-node event while preserving collection identity for an
 * identical object and the server's (createdAt, id) ordering. */
export function upsertResearchNode(nodes: ResearchNode[], node: ResearchNode): ResearchNode[] {
  const index = nodes.findIndex((candidate) => candidate.id === node.id);
  const existing = index >= 0 ? nodes[index] : undefined;
  if (existing) {
    if (existing === node) {
      return nodes;
    }
    const next = [...nodes];
    next[index] = node;
    if (compareResearchNodes(existing, node) !== 0) {
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

/** Whether a node belongs in the activity list of work the user is waiting on.
 *
 * The active statuses plus `interrupted`. `interrupted` is settled for the
 * purposes of the structural predicates in `threads.ts`, but the server
 * re-queues every resume-pending node at the head of the queue on boot
 * (`02-domain-model-and-database.md` §5.7), so the work is still coming;
 * dropping it here would blink every in-flight node out of the activity list
 * across a deploy and back in a second later. The desktop also kept a node
 * here while a pane stayed bound to it — the web has no panes. */
export function researchNodeIsActivity(node: ResearchNode): boolean {
  return isActiveResearchStatus(node.status) || node.status === "interrupted";
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

/** Apply a node event to the content the viewer is showing for that node.
 *
 * The node row and the queue position travel together on the event and are the
 * two fields of `ResearchNodeContent` a node event is authoritative for; the
 * turns are the streaming protocol's business. `queuePosition` is only ever
 * present while a node waits for admission, so an event without it clears the
 * cached one rather than leaving a stale place in the queue on screen. */
export function patchResearchNodeContent(
  content: ResearchNodeContent | null,
  event: NodeEvent,
): ResearchNodeContent | null {
  if (!content || content.node.id !== event.node.id) {
    return content;
  }
  if (content.node === event.node && content.queuePosition === event.queuePosition) {
    return content;
  }
  const next: ResearchNodeContent = { ...content, node: event.node };
  if (event.queuePosition === undefined) {
    delete next.queuePosition;
  } else {
    next.queuePosition = event.queuePosition;
  }
  return next;
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
  const followed = tree.followed ?? false;
  const bookmarked = tree.bookmarked ?? false;
  if (
    summary.title === tree.title &&
    summary.rootNodeId === tree.rootNodeId &&
    summary.workspaceId === tree.workspaceId &&
    summary.updatedAt === tree.updatedAt &&
    (summary.archivedAt ?? null) === archivedAt &&
    (summary.followed ?? false) === followed &&
    (summary.bookmarked ?? false) === bookmarked
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
    followed,
    bookmarked,
  };
}

/** Whether a status is an outcome the reader should be told about.
 *
 * `interrupted` is excluded even though the server treats it as terminal: it
 * reports that the deployment stopped an attempt, not that the question was
 * answered, and the attention flags exist to surface answers and failures. The
 * resumed attempt's real settlement lights the flag instead. */
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
  const before = researchStatusContribution(previous.status);
  const after = researchStatusContribution(node.status);
  const lifecycleChanged =
    previous.status !== node.status || previous.completedAt !== node.completedAt;
  if (!lifecycleChanged) {
    return summary;
  }
  const newlySettled =
    terminalStatus(node.status) &&
    node.completedAt != null &&
    (previous.completedAt == null || previous.completedAt !== node.completedAt);
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
      node.startedAt ?? 0,
      node.completedAt ?? 0,
    ),
    hasUnseenUpdate: summary.hasUnseenUpdate || newlySettled,
    hasUnseenFailure: summary.hasUnseenFailure || (newlySettled && node.status === "failed"),
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
  const contribution = researchStatusContribution(node.status);
  return {
    ...summary,
    runningCount: summary.runningCount + contribution.runningCount,
    failedCount: summary.failedCount + contribution.failedCount,
    completedCount: summary.completedCount + contribution.completedCount,
    cancelledCount: summary.cancelledCount + contribution.cancelledCount,
    updatedAt: Math.max(summary.updatedAt, eventTimestamp),
  };
}

/** Remove every cached node contribution available for a branch deletion.
 * Attention stays conservative because another node may still own the flag;
 * the debounced tree read resolves counts when some removed nodes were not in
 * the local cache. */
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
      const contribution = researchStatusContribution(node.status);
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
