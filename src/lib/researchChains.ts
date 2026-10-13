// Chain math for inline follow-ups: the linear chain of messages that one
// level of a research thread shows when follow-ups continue the conversation
// instead of opening a branch. A node has at most one existing inline child
// (enforced by the backend under its model lock); these helpers only read
// whatever node list they are given, so a malformed graph degrades to
// shorter chains rather than throwing.

import { documentSource, followUpLaunch, nodeRun, nodeStatus, nodeType } from "./researchNodeTypes";
import type { ResearchNode, ResearchNodeStatus } from "../types";

/** The statuses of a run that has been admitted but not settled. One list,
 * shared by the branch and chain math and the thread page, so a future status
 * cannot fall out of sync between them. Mirrors the backend's
 * ResearchNodeStatus::is_active (src-tauri/src/research.rs). */
const ACTIVE_RESEARCH_STATUSES: readonly ResearchNodeStatus[] = [
  "queued",
  "starting",
  "running",
];

export function isActiveResearchStatus(status: ResearchNodeStatus): boolean {
  return ACTIVE_RESEARCH_STATUSES.includes(status);
}

/** A cancelled pane run can still need process cleanup (`holdsProcess`). SDK
 * cancellation interrupts the session without a pane binding, so it needs no
 * retry here. */
export function canStopResearchNode(node: ResearchNode): boolean {
  return (
    isActiveResearchStatus(nodeStatus(node)) ||
    (nodeStatus(node) === "cancelled" && Boolean(nodeRun(node)?.holdsProcess))
  );
}

/** The header acts on the visible inline chain, even when an earlier answer
 * is selected. Callers pass only that chain, never the tree's other branches. */
export function researchChainStopTarget(chain: readonly ResearchNode[]): ResearchNode | null {
  return [...chain].reverse().find(canStopResearchNode) ?? null;
}

/** Whether a settled node can take any follow-up at all: it finished, and —
 * for exchanges, whose follow-ups fork the native session — its checkpoint
 * was recorded. Posts and documents launch fresh runs with their content as
 * context, so they need no checkpoint. */
export function canFollowUpFrom(node: ResearchNode): boolean {
  if (nodeStatus(node) !== "complete") {
    return false;
  }
  return followUpLaunch(node) === "context" || Boolean(nodeRun(node)?.sessionReady);
}

/** Selects the oldest inline child, breaking ties by id so the chain
 * remains stable across renders. */
function inlineChildWins(candidate: ResearchNode, current: ResearchNode | null): boolean {
  return (
    !current ||
    candidate.createdAt < current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id < current.id)
  );
}

/** Returns a node's inline child, or null. If a corrupted store contains
 * duplicates, selects the oldest child consistently across renders. */
export function inlineChildOf(nodes: ResearchNode[], nodeId: string): ResearchNode | null {
  let child: ResearchNode | null = null;
  for (const node of nodes) {
    if (node.parentNodeId === nodeId && node.inline && inlineChildWins(node, child)) {
      child = node;
    }
  }
  return child;
}

/** Index of every node's oldest inline child, built in one pass so walking a
 * chain is O(N) rather than O(N²): the previous code rescanned the whole node
 * array at every downward step, so an N-node inline chain — attacker-controlled
 * data from an imported archive, bounded by bytes but not by node count — did
 * ~N full scans and could freeze the renderer. */
function inlineChildByParent(nodes: readonly ResearchNode[]): Map<string, ResearchNode> {
  const byParent = new Map<string, ResearchNode>();
  for (const node of nodes) {
    if (!node.inline || !node.parentNodeId) {
      continue;
    }
    if (inlineChildWins(node, byParent.get(node.parentNodeId) ?? null)) {
      byParent.set(node.parentNodeId, node);
    }
  }
  return byParent;
}

/** The chains headed by many branch heads, from one index of the inline
 * children: the returned function lists a head and the inline follow-ups
 * after it, oldest first. A branch head is not inline, so its chain starts
 * at it; the walk is cycle-guarded like inlineChainFor. */
export function inlineChainsFromHeads(nodes: readonly ResearchNode[]): (headId: string) => string[] {
  const childByParent = inlineChildByParent(nodes);
  return (headId) => {
    const chain = [headId];
    const seen = new Set(chain);
    for (let next = childByParent.get(headId); next && !seen.has(next.id); next = childByParent.get(next.id)) {
      seen.add(next.id);
      chain.push(next.id);
    }
    return chain;
  };
}

/** Ordered node ids of the inline chain containing nodeId: walk up parent
 * links while the current node is inline, then down through inline children.
 * Every node is a chain of at least itself. Cycle-guarded with visited sets
 * so a malformed graph cannot hang the renderer. */
export function inlineChainFor(nodes: readonly ResearchNode[], nodeId: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Both maps are built in a single linear pass, so the walks below are O(1)
  // per step and the whole traversal is O(N).
  const childByParent = inlineChildByParent(nodes);
  let head = byId.get(nodeId);
  if (!head) {
    return [nodeId];
  }
  const visited = new Set<string>([head.id]);
  while (head.inline && head.parentNodeId) {
    const parent = byId.get(head.parentNodeId);
    if (!parent || visited.has(parent.id)) {
      break;
    }
    visited.add(parent.id);
    head = parent;
  }
  const chain = [head.id];
  const seen = new Set<string>([head.id]);
  let current = head;
  for (;;) {
    const next = childByParent.get(current.id);
    if (!next || seen.has(next.id)) {
      break;
    }
    seen.add(next.id);
    chain.push(next.id);
    current = next;
  }
  if (!chain.includes(nodeId)) {
    // A stray inline node the chain does not reach — the losing duplicate of
    // an occupied slot on a corrupted store. It must still be viewable, so it
    // heads its own chain (like a branch child) instead of resolving to a
    // page that never renders it.
    const strayChain = [nodeId];
    const straySeen = new Set<string>([nodeId]);
    let strayCurrent = byId.get(nodeId);
    while (strayCurrent) {
      const next = childByParent.get(strayCurrent.id);
      if (!next || straySeen.has(next.id)) {
        break;
      }
      straySeen.add(next.id);
      strayChain.push(next.id);
      strayCurrent = next;
    }
    return strayChain;
  }
  return chain;
}

/** The order a messages column lists its chain in (`chainIds`, oldest first,
 * as `inlineChainFor` returns it): the chain head's stored `chainOrder`, then
 * the chain nodes it does not list, oldest first. Those were added after the
 * order was stored, so a new follow-up lists last. Ids no longer in the
 * chain are dropped. Without a stored order, oldest first. The order is
 * display only: a follow-up continues the chain's last node in `chainIds`,
 * wherever that node lists. */
export function chainDisplayOrder(
  chainIds: readonly string[],
  stored: readonly string[] | undefined,
): string[] {
  const members = new Set(chainIds);
  const listed: string[] = [];
  const seen = new Set<string>();
  for (const id of stored ?? []) {
    if (members.has(id) && !seen.has(id)) {
      seen.add(id);
      listed.push(id);
    }
  }
  const unlisted = chainIds.filter((id) => !seen.has(id));
  return [...listed, ...unlisted];
}

/** Whether a settled node can be retried in place (same node id, same launch
 * inputs, relaunched through the ordinary machinery): it failed or was
 * cancelled, and no pane from the previous run lingers — an unfinished cancel
 * keeps its own Retry-cancel controls until the pane is reclaimed.
 * Archived-tree gating stays the caller's job, matching canContinueChain. */
export function canRetryResearchNode(node: ResearchNode): boolean {
  return (
    (nodeStatus(node) === "failed" || nodeStatus(node) === "cancelled") && !nodeRun(node)?.holdsProcess
  );
}

/** Whether a settled exchange can be rerun in place: as canRetryResearchNode,
 * and a complete answer too (the rerun replaces it). */
export function canRerunResearchNode(node: ResearchNode): boolean {
  return (
    nodeType(node) === "exchange" &&
    !isActiveResearchStatus(nodeStatus(node)) &&
    !nodeRun(node)?.holdsProcess
  );
}

/** Whether a node's answer menu shows Rerun. Only exchanges have runs to
 * relaunch. The caller checks whether the tree is archived, matching
 * canRetryResearchNode. */
export function researchRerunOffered(node: ResearchNode): boolean {
  return nodeType(node) === "exchange";
}

/** Whether Rerun asks for confirmation before it relaunches. Only a complete
 * answer is replaced; a failed or cancelled run is retried at once, as the
 * answer pane's Retry button does. */
export function researchRerunConfirms(node: ResearchNode): boolean {
  return nodeStatus(node) === "complete";
}

/** The node the Rerun confirmation dialog is open for: none in an archived
 * thread, where the menu offers no Rerun. */
export function researchRerunDialogNode<T extends ResearchNode>(
  node: T | null | undefined,
  archived: boolean,
): T | null {
  return node && !archived ? node : null;
}

/** Why the Rerun dialog's Continue button is disabled while another retry or
 * rerun request is in flight. */
export const RESEARCH_RERUN_PENDING_REASON = "Another retry or rerun is starting";

/** Why Rerun is disabled for an exchange, or null when it can run: the run
 * must have settled (complete, failed or cancelled) with no pane from it
 * still open, and the answer it follows (its fork point) must be complete.
 * An inline follow-up whose previous answer is still running is not blocked:
 * the rerun waits behind it, as a Retry does. */
export function researchRerunBlocker(node: ResearchNode, parent: ResearchNode | null): string | null {
  if (isActiveResearchStatus(nodeStatus(node))) {
    return "Wait for the answer to finish";
  }
  if (nodeRun(node)?.holdsProcess) {
    return "The previous run's terminal is still open";
  }
  if (parent && nodeStatus(parent) !== "complete") {
    if (!node.inline || !isActiveResearchStatus(nodeStatus(parent))) {
      return isActiveResearchStatus(nodeStatus(parent))
        ? "Wait for the answer this follows to finish"
        : "The answer this follows did not complete";
    }
  }
  return null;
}

/** Whether a level's ask box can continue the chain from this tail node: complete,
 * inline slot free, and — for exchanges, whose follow-ups fork the native
 * session — the session checkpoint recorded. Posts and documents
 * launch fresh runs that carry their content as context, so they need no
 * checkpoint. Archived-tree gating stays the caller's job, matching how
 * branch follow-ups are gated today. */
export function canContinueChain(nodes: ResearchNode[], tail: ResearchNode): boolean {
  return canFollowUpFrom(tail) && !inlineChildOf(nodes, tail.id);
}

/** The ask box placeholder of a level whose chain starts at `head`.
 * A document with no follow-up yet asks about the document (or, for a
 * transcript, the conversation), whether or not it carries a message: an
 * imported report's question is shown as its message row, but a follow-up
 * starts a fresh run with the report as context rather than continuing the
 * run that wrote it. */
export function chainComposerPlaceholder(
  head: ResearchNode,
  chainLength: number,
  waiting: boolean,
): string {
  const source = documentSource(head);
  if (source !== null && chainLength === 1) {
    return source === "transcript" ? "Ask about this conversation" : "Ask about this document";
  }
  return waiting ? "Queue a follow-up" : "Ask a follow-up";
}
