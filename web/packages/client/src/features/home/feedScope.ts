import type { RecentActivityScope } from "@session/shared";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { useNavigationStore, type FeedMode } from "../../stores/navigation.js";

export function parseFeedMode(value: unknown): FeedMode | null {
  if (value === "all" || value === "workspaces") return value;
  return typeof value === "string" && value !== "" ? "workspace" : null;
}

export interface FeedScopeControl {
  mode: FeedMode;
  scope: RecentActivityScope;
  setMode: (mode: FeedMode) => void;
}

export function useFeedScope(workspaceId: string, signedIn: boolean): FeedScopeControl {
  const navigate = useNavigate();
  const stored = useNavigationStore((state) => state.feedMode);
  const setStored = useNavigationStore((state) => state.setFeedMode);
  const raw = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>)["feed"];
      return typeof value === "string" ? value : null;
    },
  });
  const fromUrl = parseFeedMode(raw);
  const mode = signedIn ? (fromUrl ?? stored) : "all";

  useEffect(() => {
    if (signedIn && fromUrl !== null && fromUrl !== stored) setStored(fromUrl);
  }, [fromUrl, signedIn, stored, setStored]);

  useEffect(() => {
    if (
      !signedIn ||
      mode !== "workspace" ||
      workspaceId === "" ||
      typeof raw !== "string" ||
      raw === workspaceId
    ) {
      return;
    }
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, feed: workspaceId }),
      replace: true,
    });
  }, [mode, navigate, raw, signedIn, workspaceId]);

  const setMode = useCallback(
    (next: FeedMode) => {
      setStored(next);
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          feed: next === "workspace" ? workspaceId : next,
        }),
        replace: true,
      });
    },
    [navigate, setStored, workspaceId],
  );

  return {
    mode,
    scope: mode === "all" ? "all" : mode === "workspaces" ? "mine" : "workspace",
    setMode,
  };
}
