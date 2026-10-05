import type { GroupInfo, ResearchTreeSummary } from "../types";

// Research is scoped to exactly one folder (Research workspace) at a
// time. A null scope is only used when no research folders exist yet.
export type ResearchFolderScope = string | null;

export function resolveResearchScope(
  stored: string | null,
  researchGroups: GroupInfo[],
): ResearchFolderScope {
  return researchGroups.some((group) => group.id === stored)
    ? stored
    : (researchGroups[0]?.id ?? null);
}

export function treesForResearchScope(
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
): ResearchTreeSummary[] {
  return scope ? trees.filter((tree) => tree.workspaceId === scope) : [];
}

export function workspaceIsInResearchScope(
  workspaceId: string,
  scope: ResearchFolderScope,
): boolean {
  return workspaceId === scope;
}

export function treeForResearchScope(
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
  preferredTreeId: string | null,
): ResearchTreeSummary | null {
  const scoped = treesForResearchScope(trees, scope);
  return scoped.find((tree) => tree.id === preferredTreeId) ?? scoped[0] ?? null;
}
