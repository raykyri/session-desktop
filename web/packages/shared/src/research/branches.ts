// Branch math for the research tree: which nodes a deletion would take with
// it, and whether any of them is still running.

import type { ResearchNode } from "../types/research.js";

import { isActiveResearchStatus } from "./threads.js";

export interface ResearchBranchInfo {
  nodeIds: string[];
  descendantCount: number;
  hasActiveRuns: boolean;
}

export function researchBranchInfo(
  nodes: ResearchNode[],
  rootNodeId: string,
): ResearchBranchInfo | null {
  if (!nodes.some((node) => node.id === rootNodeId)) {
    return null;
  }
  const nodeIds = new Set([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!nodeIds.has(node.id) && node.parentNodeId && nodeIds.has(node.parentNodeId)) {
        nodeIds.add(node.id);
        changed = true;
      }
    }
  }
  const branchNodes = nodes.filter((node) => nodeIds.has(node.id));
  return {
    nodeIds: branchNodes.map((node) => node.id),
    descendantCount: Math.max(0, branchNodes.length - 1),
    // The desktop also treated a node still bound to a pane as active. The web
    // has no panes, so an admitted-but-unsettled status is the whole test.
    hasActiveRuns: branchNodes.some((node) => isActiveResearchStatus(node.status)),
  };
}
