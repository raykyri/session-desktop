/** Lists the feed column can show. Home lists Unfiled and a tray per folder;
 * a folder, Drafts, or Archive lists only that place. */
export type ResearchFeedView =
  | { kind: "home" }
  | { kind: "drafts" }
  | { kind: "archive" }
  | { kind: "folder"; folderId: string };

/** Pages the feed column can show: a feed list or Highlights. */
export type ResearchFeedPage = ResearchFeedView | { kind: "highlights" };

/** A stable key per view, for selection and scroll resets. */
export function researchFeedPageKey(view: ResearchFeedPage): string {
  return view.kind === "folder" ? `folder:${view.folderId}` : view.kind;
}

/** Below this window width the sidebar shows as the icon rail regardless of
 * the saved preference. */
export const RESEARCH_SIDEBAR_AUTO_RAIL_WIDTH = 900;
