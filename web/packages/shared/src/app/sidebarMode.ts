// Tab ids for the sidebar's rows. Journal pages and
// research threads all share one id space so a single cycle (Ctrl-Tab) and a
// single "active row" value cover the whole sidebar.

import { type ResearchFolderScope, workspaceIsInResearchScope } from "../research/scope.js";
import type { ResearchTreeSummary } from "../types/research.js";

export const RESEARCH_HOME_TAB_ID = "__research_home__";
export const RESEARCH_BOOKMARKS_TAB_ID = "__research_bookmarks__";
export const RESEARCH_HIGHLIGHTS_TAB_ID = "__research_highlights__";
const RESEARCH_TREE_TAB_PREFIX = "__research_tree__:";

/** Pages the journal surface can show. */
export type ResearchJournalView = "home" | "bookmarks" | "highlights";

/** Every journal view, for tests that must cover the whole set. */
export const RESEARCH_JOURNAL_VIEWS: readonly ResearchJournalView[] = [
  "home",
  "bookmarks",
  "highlights",
];

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

/** Sidebar order: the journal pages, then the scoped research trees. */
export function researchCycleTabIds(
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
