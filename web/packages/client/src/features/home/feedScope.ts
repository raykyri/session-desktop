// Which feed `/` shows (`10-home-feed-journal.md` §1): the workspace's Home
// for a signed-in account, or the web's All Users feed of public threads —
// for a guest always, for an account when the URL says `?feed=all` (the
// sidebar's All Users place). Older links with `?feed=workspaces` (the
// removed My Workspaces feed) or a workspace id open Home.

import type { RecentActivityScope } from "@session/shared";
import { useRouterState } from "@tanstack/react-router";

import type { FeedMode } from "../../stores/navigation.js";

export function parseFeedMode(value: unknown): FeedMode {
  return value === "all" ? "all" : "workspace";
}

export interface FeedScope {
  mode: FeedMode;
  scope: RecentActivityScope;
}

export function useFeedScope(signedIn: boolean): FeedScope {
  const raw = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>)["feed"];
      return typeof value === "string" ? value : null;
    },
  });
  const mode = signedIn ? parseFeedMode(raw) : "all";
  return { mode, scope: mode === "all" ? "all" : "workspace" };
}
