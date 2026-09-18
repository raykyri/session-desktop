// An encyclopedia page (`10-home-feed-journal-encyclopedia.md` §6).

import { useParams } from "@tanstack/react-router";

import { EncyclopediaPageView } from "../features/encyclopedia/EncyclopediaPageView.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";

export function EncyclopediaPage() {
  const { slug } = useParams({ from: "/_shell/e/$slug" });
  const { workspaceId } = useWorkspaceScope();
  // Re-keying on slug changes resets view state (such as active confirmations or in-flight edits) when navigating between encyclopedia pages.
  return <EncyclopediaPageView key={slug} workspaceId={workspaceId} slug={slug} />;
}
