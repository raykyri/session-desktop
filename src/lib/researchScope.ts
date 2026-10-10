import type { GroupInfo, ResearchTreeSummary } from "../types";

// Research is scoped to exactly one research workspace (a GroupInfo) at a
// time. A null scope is only used when no research workspaces exist yet.
export type ResearchWorkspaceScope = string | null;

export function resolveResearchScope(
  stored: string | null,
  researchGroups: GroupInfo[],
): ResearchWorkspaceScope {
  return researchGroups.some((group) => group.id === stored)
    ? stored
    : (researchGroups[0]?.id ?? null);
}

export function treesForResearchScope(
  trees: ResearchTreeSummary[],
  scope: ResearchWorkspaceScope,
): ResearchTreeSummary[] {
  return scope ? trees.filter((tree) => tree.workspaceId === scope) : [];
}

export function workspaceIsInResearchScope(
  workspaceId: string,
  scope: ResearchWorkspaceScope,
): boolean {
  return workspaceId === scope;
}

export function treeForResearchScope(
  trees: ResearchTreeSummary[],
  scope: ResearchWorkspaceScope,
  preferredTreeId: string | null,
): ResearchTreeSummary | null {
  const scoped = treesForResearchScope(trees, scope);
  return scoped.find((tree) => tree.id === preferredTreeId) ?? scoped[0] ?? null;
}
