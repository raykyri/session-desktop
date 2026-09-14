import type { GroupInfo, PaneInfo, ResearchTreeSummary } from "../types";
import { type ResearchFolderScope, workspaceIsInResearchScope } from "./researchScope";

export const RESEARCH_HOME_TAB_ID = "__research_home__";
export const RESEARCH_BOOKMARKS_TAB_ID = "__research_bookmarks__";
export const RESEARCH_HIGHLIGHTS_TAB_ID = "__research_highlights__";
const RESEARCH_TREE_TAB_PREFIX = "__research_tree__:";

export type ResearchJournalView = "home" | "bookmarks" | "highlights";

/** The journal pages in sidebar order. They lead the Ctrl-Tab cycle, ahead of
 * the research trees, so cycling follows the sidebar top to bottom. */
export const RESEARCH_JOURNAL_TAB_IDS: readonly string[] = [
  RESEARCH_HOME_TAB_ID,
  RESEARCH_BOOKMARKS_TAB_ID,
  RESEARCH_HIGHLIGHTS_TAB_ID,
];

export function researchJournalTabId(view: ResearchJournalView): string {
  switch (view) {
    case "bookmarks":
      return RESEARCH_BOOKMARKS_TAB_ID;
    case "highlights":
      return RESEARCH_HIGHLIGHTS_TAB_ID;
    default:
      return RESEARCH_HOME_TAB_ID;
  }
}

export function researchJournalViewFromTabId(tabId: string): ResearchJournalView | null {
  switch (tabId) {
    case RESEARCH_HOME_TAB_ID:
      return "home";
    case RESEARCH_BOOKMARKS_TAB_ID:
      return "bookmarks";
    case RESEARCH_HIGHLIGHTS_TAB_ID:
      return "highlights";
    default:
      return null;
  }
}

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
    ...RESEARCH_JOURNAL_TAB_IDS,
    ...trees
      .filter((tree) => workspaceIsInResearchScope(tree.workspaceId, scope))
      .map((tree) => researchTreeTabId(tree.id)),
  ];
}
