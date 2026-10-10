// Level math for the column pairs. A conversation is an inline chain (see
// researchThreads); a branch is a non-inline child node, shown as the chain it
// heads. Level 0 is the root's chain; each later level is a branch asked from
// the previous level's selected message.

import { canContinueThread, canFollowUpFrom, inlineChainFor, isActiveResearchStatus } from "./researchThreads";
import type { QueuedResearchFollowup } from "./researchNavigation";
import type { ResearchNode } from "../types";

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

/** The selected message of each open level, root conversation first. The
 * deepest level's selection determines the whole path: each level's chain
 * head was asked from the previous level's selected message. */
export function researchLevelPath(nodes: ResearchNode[], nodeId: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = nodeId;
  while (current && byId.has(current) && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    const head = byId.get(inlineChainFor(nodes, current)[0] ?? current);
    current = head?.parentNodeId ?? undefined;
  }
  return path;
}

/** The nearest node on `nodeId`'s ancestry (itself included) that still
 * exists, from the parents recorded before a removal: the message a removed
 * branch was asked from, or null when nothing on the way survives. */
export function researchSurvivingAncestor(
  parentById: ReadonlyMap<string, string | null>,
  nodeId: string,
  validNodeIds: ReadonlySet<string>,
): string | null {
  const seen = new Set<string>();
  let current: string | null | undefined = nodeId;
  while (current && !seen.has(current)) {
    if (validNodeIds.has(current)) {
      return current;
    }
    seen.add(current);
    current = parentById.get(current);
  }
  return null;
}

/** Branches of one answer in reading order: by where their passage starts
 * (`passageStart`, for anchors that resolve in the rendered answer), then
 * whole-answer and unresolved branches, each group oldest first. */
export function researchBranchesInReadingOrder(
  branches: readonly ResearchNode[],
  passageStart: (branchId: string) => number | null,
): ResearchNode[] {
  const start = new Map(branches.map((branch) => [branch.id, passageStart(branch.id)]));
  return [...branches].sort((left, right) => {
    const a = start.get(left.id) ?? null;
    const b = start.get(right.id) ?? null;
    if (a !== null && b !== null && a !== b) {
      return a - b;
    }
    if ((a === null) !== (b === null)) {
      return a === null ? 1 : -1;
    }
    return byCreation(left, right);
  });
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

/** A pair's accessible label from a question: whitespace collapsed, and cut
 * at the last word boundary within `max` characters, with an ellipsis. A
 * single word longer than `max` is cut at `max`. */
export function researchPairLabel(text: string, max = 80): string {
  const flat = text.split(/\s+/).join(" ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
