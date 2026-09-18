// The research sidebar shows exactly one workspace at a time; these helpers
// resolve which one and which trees belong to it. Ported from the desktop
// `src/lib/researchScope.ts`, where the unit was a research-scoped `GroupInfo`.

import type { Workspace } from "../types/account.js";
import type { ResearchTreeSummary } from "../types/research.js";

/** The displayed workspace id. Null is only used before any workspace exists. */
export type ResearchFolderScope = string | null;

export function resolveResearchScope(
  stored: string | null,
  workspaces: Workspace[],
): ResearchFolderScope {
  return workspaces.some((workspace) => workspace.id === stored)
    ? stored
    : (workspaces[0]?.id ?? null);
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

// The tree selection should stay inside the current workspace when the active
// tree is archived or deleted, rather than jumping to another workspace's tree.
export function nextTreeInResearchScope(
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
  excludeTreeId: string,
): ResearchTreeSummary | null {
  return treesForResearchScope(trees, scope).find((tree) => tree.id !== excludeTreeId) ?? null;
}
