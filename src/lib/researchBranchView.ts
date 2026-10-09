// Placement math for the conversation column, the branch drawer, and pinned
// branch columns. A conversation is an inline chain (see researchThreads); a
// branch is a non-inline child node, rendered as the chain it heads. The root's
// chain is always the conversation column; any other chain shows either in the
// drawer or, once pinned, as its own column.

import { canFollowUpFrom, inlineChainFor, isActiveResearchStatus } from "./researchThreads";
import type { ResearchNode } from "../types";

/** Below this content width one column shows at a time and the drawer covers
 * the whole column area. */
const RESEARCH_SINGLE_COLUMN_BELOW = 620;
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
