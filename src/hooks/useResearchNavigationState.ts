import { useCallback, useRef, useState } from "react";
import { initResearchWorkspaceHistory } from "../lib/researchHistory";
import type { ResearchFolderScope } from "../lib/researchScope";

export const RESEARCH_FOLDER_SCOPE_KEY = "session.research-folder-scope.v1";
const FEED_OPEN_KEY = "session.feed-open.v1";

/** Owns persisted research navigation preferences and the in-session back/forward history. */
export function useResearchNavigationState() {
  const [feedOpen, setFeedOpenState] = useState(
    () => localStorage.getItem(FEED_OPEN_KEY) === "true",
  );
  const feedOpenRef = useRef(feedOpen);
  feedOpenRef.current = feedOpen;
  const setFeedOpen = useCallback((open: boolean) => {
    feedOpenRef.current = open;
    setFeedOpenState(open);
    localStorage.setItem(FEED_OPEN_KEY, open ? "true" : "false");
  }, []);
  const [researchWorkspaceHistory, setResearchWorkspaceHistory] = useState(() =>
    initResearchWorkspaceHistory(
      localStorage.getItem(FEED_OPEN_KEY) === "true" ? { kind: "feed" } : null,
    ),
  );
  const researchWorkspaceHistoryRef = useRef(researchWorkspaceHistory);
  researchWorkspaceHistoryRef.current = researchWorkspaceHistory;
  // Which single folder research is scoped to. The raw stored
  // value is resolved against live research workspaces wherever it is read.
  const [researchFolderScope, setResearchFolderScope] = useState<ResearchFolderScope>(
    () => localStorage.getItem(RESEARCH_FOLDER_SCOPE_KEY),
  );
  const changeResearchFolderScope = useCallback((scope: ResearchFolderScope) => {
    setResearchFolderScope(scope);
    if (scope) {
      localStorage.setItem(RESEARCH_FOLDER_SCOPE_KEY, scope);
    } else {
      localStorage.removeItem(RESEARCH_FOLDER_SCOPE_KEY);
    }
  }, []);
  return {
    feedOpen,
    feedOpenRef,
    setFeedOpen,
    researchWorkspaceHistory,
    researchWorkspaceHistoryRef,
    setResearchWorkspaceHistory,
    researchFolderScope,
    changeResearchFolderScope,
  };
}
