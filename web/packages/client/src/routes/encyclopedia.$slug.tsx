// An encyclopedia page (`10-home-feed-journal-encyclopedia.md` §6).

import { useParams } from "@tanstack/react-router";

import { EncyclopediaPageView } from "../features/encyclopedia/EncyclopediaPageView.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";

export function EncyclopediaPage() {
  const { slug } = useParams({ from: "/_shell/e/$slug" });
  const { workspaceId } = useWorkspaceScope();
  // `key` remounts on a slug change: the view holds per-page state (the delete
  // confirmation, the rewrite in flight) that must not survive navigating from
  // one page to the next through a wikilink.
  return <EncyclopediaPageView key={slug} workspaceId={workspaceId} slug={slug} />;
}
