import type {
  EncyclopediaPageSummary,
  GroupInfo,
  PaneInfo,
  ResearchTreeSummary,
} from "../types";
import { type ResearchFolderScope, workspaceIsInResearchScope } from "./researchScope";

export const RESEARCH_HOME_TAB_ID = "__research_home__";
export const RESEARCH_BOOKMARKS_TAB_ID = "__research_bookmarks__";
export const RESEARCH_HIGHLIGHTS_TAB_ID = "__research_highlights__";
/** The encyclopedia view without a page; open pages use per-slug ids. */
export const RESEARCH_ENCYCLOPEDIA_TAB_ID = "__research_encyclopedia__";
const RESEARCH_ENCYCLOPEDIA_TAB_PREFIX = "__research_encyclopedia__:";
const RESEARCH_TREE_TAB_PREFIX = "__research_tree__:";

/** Pages the journal surface can show. `encyclopedia` is an open
 * encyclopedia page. */
export type ResearchJournalView = "home" | "bookmarks" | "highlights" | "encyclopedia";

/** Every journal view, for tests that must cover the whole set. */
export const RESEARCH_JOURNAL_VIEWS: readonly ResearchJournalView[] = [
  "home",
  "bookmarks",
  "highlights",
  "encyclopedia",
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
    case "encyclopedia":
      return RESEARCH_ENCYCLOPEDIA_TAB_ID;
    default:
      return RESEARCH_HOME_TAB_ID;
  }
}

export function researchJournalViewFromTabId(tabId: string): ResearchJournalView | null {
  if (tabId.startsWith(RESEARCH_ENCYCLOPEDIA_TAB_PREFIX)) {
    return "encyclopedia";
  }
  switch (tabId) {
    case RESEARCH_HOME_TAB_ID:
      return "home";
    case RESEARCH_BOOKMARKS_TAB_ID:
      return "bookmarks";
    case RESEARCH_HIGHLIGHTS_TAB_ID:
      return "highlights";
    case RESEARCH_ENCYCLOPEDIA_TAB_ID:
      return "encyclopedia";
    default:
      return null;
  }
}

export function researchEncyclopediaTabId(slug: string): string {
  return `${RESEARCH_ENCYCLOPEDIA_TAB_PREFIX}${slug}`;
}

export function researchEncyclopediaSlugFromTabId(tabId: string): string | null {
  if (!tabId.startsWith(RESEARCH_ENCYCLOPEDIA_TAB_PREFIX)) {
    return null;
  }
  const slug = tabId.slice(RESEARCH_ENCYCLOPEDIA_TAB_PREFIX.length);
  return slug || null;
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

/** Sidebar order: the journal pages, then the scoped encyclopedia pages, then
 * the scoped research trees. */
export function researchCycleTabIds(
  _panes: PaneInfo[],
  _groups: GroupInfo[],
  trees: ResearchTreeSummary[],
  scope: ResearchFolderScope,
  pages: readonly EncyclopediaPageSummary[] = [],
): string[] {
  return [
    ...RESEARCH_JOURNAL_TAB_IDS,
    ...pages
      .filter((page) => page.workspaceId === scope)
      .map((page) => researchEncyclopediaTabId(page.slug)),
    ...trees
      .filter((tree) => workspaceIsInResearchScope(tree.workspaceId, scope))
      .map((tree) => researchTreeTabId(tree.id)),
  ];
}
