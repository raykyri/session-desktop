// Highlights (`10-home-feed-journal-encyclopedia.md` §4).

import { HighlightsFeed } from "../features/highlights/HighlightsFeed.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";

export function HighlightsPage() {
  const { workspaceId } = useWorkspaceScope();
  return <HighlightsFeed workspaceId={workspaceId} />;
}
