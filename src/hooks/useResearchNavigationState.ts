import { useCallback, useRef, useState } from "react";
import { EMPTY_RESEARCH_VISITS, type ResearchVisitHistory } from "../lib/researchHistory";
import type { ResearchWorkspaceScope } from "../lib/researchScope";

// The stored key keeps the scope's earlier name, "folder scope".
export const RESEARCH_WORKSPACE_SCOPE_KEY = "session.research-folder-scope.v1";
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
  // Back/forward visits. Empty until the startup restore seeds it with the
  // thread (or Home) it opens.
  const [researchVisits, setResearchVisitsState] = useState<ResearchVisitHistory>(EMPTY_RESEARCH_VISITS);
  const researchVisitsRef = useRef(researchVisits);
  researchVisitsRef.current = researchVisits;
  /** Applies `update` to the latest visits (the ref, so several updates in
   * one event compose) and stores the result when it changed. */
  const updateResearchVisits = useCallback(
    (update: (current: ResearchVisitHistory) => ResearchVisitHistory) => {
      const current = researchVisitsRef.current;
      const next = update(current);
      if (next === current) return;
      researchVisitsRef.current = next;
      setResearchVisitsState(next);
    },
    [],
  );
  // The research workspace the sidebar and feed show. The raw stored
  // value is resolved against live research workspaces wherever it is read.
  const [researchWorkspaceScope, setResearchWorkspaceScope] = useState<ResearchWorkspaceScope>(
    () => localStorage.getItem(RESEARCH_WORKSPACE_SCOPE_KEY),
  );
  const changeResearchWorkspaceScope = useCallback((scope: ResearchWorkspaceScope) => {
    setResearchWorkspaceScope(scope);
    if (scope) {
      localStorage.setItem(RESEARCH_WORKSPACE_SCOPE_KEY, scope);
    } else {
      localStorage.removeItem(RESEARCH_WORKSPACE_SCOPE_KEY);
    }
  }, []);
  return {
    feedOpen,
    feedOpenRef,
    setFeedOpen,
    researchVisits,
    researchVisitsRef,
    updateResearchVisits,
    researchWorkspaceScope,
    changeResearchWorkspaceScope,
  };
}
