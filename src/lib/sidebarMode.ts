/** Lists the feed column can show. Home lists Unfiled and a tray per folder;
 * a folder, Drafts, or Archive lists only that place. */
export type ResearchFeedView =
  | { kind: "home" }
  | { kind: "bookmarks" }
  | { kind: "drafts" }
  | { kind: "archive" }
  | { kind: "folder"; folderId: string };

/** Pages the journal surface can show: a feed list or Highlights. */
export type ResearchJournalView = ResearchFeedView | { kind: "highlights" };

/** A stable key per view, for selection and scroll resets. */
export function researchJournalViewKey(view: ResearchJournalView): string {
  return view.kind === "folder" ? `folder:${view.folderId}` : view.kind;
}

/** Below this window width the sidebar shows as the icon strip regardless of
 * the saved preference. */
export const RESEARCH_SIDEBAR_AUTO_STRIP_WIDTH = 900;
