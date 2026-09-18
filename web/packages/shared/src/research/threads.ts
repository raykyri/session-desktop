// Chain math for inline follow-ups: the linear "thread spine" a research
// document renders when follow-ups continue an answer in place instead of
// branching into rail cards. A node has at most one existing inline child
// (enforced by the server's partial unique index,
// `02-domain-model-and-database.md` §5.4); these helpers only read whatever
// node list they are given, so a malformed graph degrades to shorter chains
// rather than throwing.

import type { ResearchNode, ResearchNodeStatus } from "../types/research.js";

/** The statuses of a run that has been admitted but not settled. One list,
 * shared by the branch/thread math and the document view, so a future status
 * cannot fall out of sync between them.
 *
 * `interrupted` is deliberately not here. It is a settled row state — nothing
 * is executing, and the server's monotonicity rule groups it with `failed` and
 * `cancelled` as a status `resetForRetry` may leave
 * (`02-domain-model-and-database.md` §5.3). The callers of this list gate
 * structural actions (branch deletion, thread continuation) on whether a run
 * is in flight, and an interrupted run is not. The predicates that care about
 * "work the user is still waiting on" name `interrupted` explicitly instead —
 * see `researchNodeIsActivity` in `events.ts`. */
export const ACTIVE_RESEARCH_STATUSES: readonly ResearchNodeStatus[] = ["queued", "running"];

export function isActiveResearchStatus(status: ResearchNodeStatus): boolean {
  return ACTIVE_RESEARCH_STATUSES.includes(status);
}

/** Whether a settled node can take any follow-up at all. The desktop also
 * required a native session checkpoint for run nodes, whose follow-ups forked
 * that session; on the web every follow-up is a fresh run that carries its
 * parent's content as context (`02-domain-model-and-database.md` §5.4), so
 * completion is the only condition and every node kind is eligible. */
export function canFollowUpFrom(node: ResearchNode): boolean {
  return node.status === "complete";
}

/** Whether `candidate` should win the inline slot over the current best: the
 * oldest child wins, ties broken by id, so the spine is stable across renders. */
function inlineChildWins(candidate: ResearchNode, current: ResearchNode | null): boolean {
  return (
    !current ||
    candidate.createdAt < current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id < current.id)
  );
}

/** The unique inline child of a node, or null. Duplicate inline children
 * cannot be created, but a corrupted store could hold them; the oldest wins
 * (stable across renders) so the thread never flickers between spines. */
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
 * data from an imported report, bounded by bytes but not by node count — did
 * ~N full scans and could freeze the renderer. */
function inlineChildByParent(nodes: ResearchNode[]): Map<string, ResearchNode> {
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

/** Ordered node ids of the inline chain containing nodeId: walk up parent
 * links while the current node is inline, then down through inline children.
 * Every node is a chain of at least itself. Cycle-guarded with visited sets
 * so a malformed graph cannot hang the renderer. */
export function inlineChainFor(nodes: ResearchNode[], nodeId: string): string[] {
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
    // A stray inline node the spine does not reach — the losing duplicate of
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

/** Whether a settled node can be retried in place (same node id, same launch
 * inputs, relaunched through the ordinary machinery). The desktop also
 * required that no pane from the previous run lingered; the web has no panes,
 * so the condition is exactly the server's `nodes.resetForRetry` precondition:
 * `failed`, `cancelled`, or `interrupted`
 * (`02-domain-model-and-database.md` §5.3). An interrupted node is normally
 * auto-resumed, but after repeated failed resumes it stays interrupted and
 * Retry is the user's way out. Archived-tree gating stays the caller's job,
 * matching canContinueThread. */
export function canRetryResearchNode(node: ResearchNode): boolean {
  return node.status === "failed" || node.status === "cancelled" || node.status === "interrupted";
}

/** Whether the thread composer can continue from this tail node: complete and
 * with its inline slot free. Archived-tree gating stays the caller's job,
 * matching how branch follow-ups are gated today. */
export function canContinueThread(nodes: ResearchNode[], tail: ResearchNode): boolean {
  return canFollowUpFrom(tail) && !inlineChildOf(nodes, tail.id);
}
