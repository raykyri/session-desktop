// Bookmarks (`10-home-feed-journal.md` §3): the same feed with
// `bookmarkedOnly`, no composer and no import. The server filters roots by
// `trees.bookmarked`; the desktop filtered client-side.

import { ActivityFeed } from "../features/home/ActivityFeed.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";

export function BookmarksPage() {
  const { workspaceId } = useWorkspaceScope();
  return <ActivityFeed workspaceId={workspaceId} bookmarkedOnly title="Bookmarks" />;
}
