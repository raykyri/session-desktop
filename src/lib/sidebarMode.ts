import type { GroupInfo, PaneInfo, ResearchTreeSummary } from "../types";
import { type ResearchFolderScope, workspaceIsInResearchScope } from "./researchScope";

export const RESEARCH_HOME_TAB_ID = "__research_home__";
const RESEARCH_TREE_TAB_PREFIX = "__research_tree__:";

export function researchTreeTabId(treeId: string): string {
  return `${RESEARCH_TREE_TAB_PREFIX}${treeId}`;
}

export function researchTreeIdFromTabId(tabId: string): string | null {
  if (!tabId.startsWith(RESEARCH_TREE_TAB_PREFIX)) {
    return null;
  }
  const treeId = tabId.slice(RESEARCH_TREE_TAB_PREFIX.length);
  return treeId || null;
}

export function researchCycleTabIds(
  _panes: PaneInfo[],
  _groups: GroupInfo[],
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
): string[] {
  return [
    RESEARCH_HOME_TAB_ID,
    ...trees
      .filter((tree) => workspaceIsInResearchScope(tree.workspaceId, scope))
      .map((tree) => researchTreeTabId(tree.id)),
  ];
}
