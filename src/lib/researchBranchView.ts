// Placement math for the conversation column, the branch drawer, and pinned
// branch columns. A conversation is an inline chain (see researchThreads); a
// branch is a non-inline child node, rendered as the chain it heads. The root's
// chain is always the conversation column; any other chain shows either in the
// drawer or, once pinned, as its own column.

import { canContinueThread, canFollowUpFrom, inlineChainFor, isActiveResearchStatus } from "./researchThreads";
import type { QueuedResearchFollowup } from "./researchNavigation";
import type { ResearchNode } from "../types";

/** Below this column-area width (feed included) one column shows at a time
 * and the drawer covers the whole column area. */
export const RESEARCH_SINGLE_COLUMN_BELOW = 620;
export const RESEARCH_PINNED_COLUMN_WIDTH = 560;
const DRAWER_SHARE = 0.46;
const DRAWER_MIN_WIDTH = 380;
const DRAWER_MAX_WIDTH = 640;

/** The drawer is 46% of the column area (feed included), 380–640px, never
 * wider than the conversation column it overlays. In single-column mode it
 * covers the whole column. */
export function researchDrawerWidth(areaWidth: number, columnWidth: number): number {
  if (areaWidth < RESEARCH_SINGLE_COLUMN_BELOW) {
    return columnWidth;
  }
  const preferred = Math.round(areaWidth * DRAWER_SHARE);
  return Math.min(columnWidth, Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, preferred)));
}

function byCreation(left: ResearchNode, right: ResearchNode) {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

/** Branches asked from one answer: its non-inline children, oldest first. */
export function researchBranchesOf(nodes: readonly ResearchNode[], nodeId: string): ResearchNode[] {
  return nodes
    .filter((node) => node.parentNodeId === nodeId && !node.inline)
    .sort(byCreation);
}

/** Non-inline children per parent id, for rendering every turn's branch
 * button from one pass over the tree. */
export function researchBranchesByParent(
  nodes: readonly ResearchNode[],
): Map<string, ResearchNode[]> {
  const map = new Map<string, ResearchNode[]>();
  for (const node of nodes) {
    if (!node.parentNodeId || node.inline) {
      continue;
    }
    const list = map.get(node.parentNodeId);
    if (list) {
      list.push(node);
    } else {
      map.set(node.parentNodeId, [node]);
    }
  }
  for (const list of map.values()) {
    list.sort(byCreation);
  }
  return map;
}

/** The head of the chain containing `nodeId`: the branch node a drawer or
 * pinned column is named after. */
export function researchChainHead(nodes: ResearchNode[], nodeId: string): string {
  return inlineChainFor(nodes, nodeId)[0] ?? nodeId;
}

type ResearchNodePlacement =
  | { kind: "main" }
  | { kind: "pinned"; headId: string }
  | { kind: "drawer"; headId: string };

/** Where a node renders: in the conversation column, in a pinned column, or
 * (anything else) in the drawer. */
export function researchNodePlacement(
  nodes: ResearchNode[],
  mainChainIds: readonly string[],
  pinnedHeadIds: readonly string[],
  nodeId: string,
): ResearchNodePlacement {
  if (mainChainIds.includes(nodeId)) {
    return { kind: "main" };
  }
  const headId = researchChainHead(nodes, nodeId);
  return pinnedHeadIds.includes(headId) ? { kind: "pinned", headId } : { kind: "drawer", headId };
}

/** For a branch opened from another branch: the parent branch's head, which
 * the drawer's back button opens. Null when the parent is in the root
 * conversation (or missing). */
export function researchParentBranchHead(
  nodes: ResearchNode[],
  mainChainIds: readonly string[],
  headId: string,
): string | null {
  const head = nodes.find((node) => node.id === headId);
  const parentId = head?.parentNodeId;
  if (!parentId || mainChainIds.includes(parentId)) {
    return null;
  }
  return nodes.some((node) => node.id === parentId) ? researchChainHead(nodes, parentId) : null;
}

/** The root-conversation turn a node descends from: the node itself when it
 * is in the conversation, otherwise the turn its outermost branch was asked
 * from. Falls back to the conversation's head. */
export function researchMainChainAncestor(
  nodes: ResearchNode[],
  mainChainIds: readonly string[],
  nodeId: string,
): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let current = byId.get(nodeId);
  while (current && !seen.has(current.id)) {
    if (mainChainIds.includes(current.id)) {
      return current.id;
    }
    seen.add(current.id);
    current = current.parentNodeId ? byId.get(current.parentNodeId) : undefined;
  }
  return mainChainIds[0] ?? null;
}

/** What a chain's client-side follow-up queue does next, given the chain's
 * tail: send the first queued question, keep waiting (for a run, or for a
 * finished run's session checkpoint), or stall on a tail that stopped without
 * an answer to continue from. */
export function researchQueueStep(tail: ResearchNode | null): "send" | "wait" | "stalled" {
  if (!tail || isActiveResearchStatus(tail.status)) {
    return "wait";
  }
  if (tail.status !== "complete") {
    return "stalled";
  }
  return canFollowUpFrom(tail) ? "send" : "wait";
}

/** What a chain's client-side queue does on a pass over the current tree:
 * drop it (its head is gone), wait, or send its first question as an inline
 * follow-up of `tailId`.
 *
 * `inFlight` is the queue's last send: `true` while the fork request runs,
 * then the new child's id until that child is in `nodes`. The request
 * resolves before the tree detail includes the child, so until then the
 * chain's tail in `nodes` is stale: sending against it would ask the
 * backend for a second inline follow-up of the same node. */
export function researchQueueAction(
  nodes: ResearchNode[],
  headId: string,
  queue: readonly QueuedResearchFollowup[],
  inFlight: string | true | undefined,
): { kind: "clear" } | { kind: "wait" } | { kind: "send"; item: QueuedResearchFollowup; tailId: string } {
  if (queue.length === 0) {
    return { kind: "wait" };
  }
  if (!nodes.some((node) => node.id === headId)) {
    return { kind: "clear" };
  }
  if (inFlight === true || (inFlight !== undefined && !nodes.some((node) => node.id === inFlight))) {
    return { kind: "wait" };
  }
  // A question the backend refused waits for Retry or Remove.
  if (queue[0].failed) {
    return { kind: "wait" };
  }
  const chain = inlineChainFor(nodes, headId);
  const tailId = chain[chain.length - 1];
  const tail = nodes.find((node) => node.id === tailId) ?? null;
  if (!tail || researchQueueStep(tail) !== "send" || !canContinueThread(nodes, tail)) {
    return { kind: "wait" };
  }
  return { kind: "send", item: queue[0], tailId: tail.id };
}

/** Whether the conversation document renders its column (and with it the
 * scroller that carries swipe navigation) rather than the loading
 * placeholder. A document mounted for a new tree first renders the
 * placeholder, so listeners on the scroller attach when this turns true. */
export function researchDocumentHasColumn(
  detail: unknown,
  rootNodeId: string | null | undefined,
  selectedNodeId: string | null | undefined,
): boolean {
  return Boolean(detail && rootNodeId && selectedNodeId);
}

/** The fork that sends an edited question in place of a failed (or stopped)
 * one: same parent, passage, reply and inline slot, naming the failed node as
 * the one it replaces. The backend admits the new node before it removes the
 * failed one, so a send that fails leaves the failed turn and its partial
 * answer in place. */
export function researchEditedQuestionFork(failed: ResearchNode, prompt: string) {
  if (!failed.parentNodeId) {
    return null;
  }
  return {
    parentNodeId: failed.parentNodeId,
    prompt,
    queryAnchor: failed.queryAnchor ?? null,
    inline: Boolean(failed.inline),
    replyAnchor: failed.replyAnchor ?? null,
    replacesNodeId: failed.id,
  };
}
