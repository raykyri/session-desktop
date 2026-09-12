import { useCallback, useRef, useState } from "react";
import type { ResearchVisibilityFilter } from "../components/research/ResearchSidebarSection";
import { initResearchWorkspaceHistory } from "../lib/researchHistory";
import type { ResearchFolderScope } from "../lib/researchScope";

const RESEARCH_VISIBILITY_FILTER_KEY = "session.research-visibility-filter.v1";
const LEGACY_SHOW_ARCHIVED_RESEARCH_KEY = "session.show-archived-research.v1";
export const RESEARCH_FOLDER_SCOPE_KEY = "session.research-folder-scope.v1";
const JOURNAL_OPEN_KEY = "session.journal-open.v1";

/** Owns persisted research navigation preferences and the in-session back/forward history. */
export function useResearchNavigationState() {
  const [journalOpen, setJournalOpenState] = useState(
    () => localStorage.getItem(JOURNAL_OPEN_KEY) === "true",
  );
  const journalOpenRef = useRef(journalOpen);
  journalOpenRef.current = journalOpen;
  const setJournalOpen = useCallback((open: boolean) => {
    journalOpenRef.current = open;
    setJournalOpenState(open);
    localStorage.setItem(JOURNAL_OPEN_KEY, open ? "true" : "false");
  }, []);
  const [researchWorkspaceHistory, setResearchWorkspaceHistory] = useState(() =>
    initResearchWorkspaceHistory(
      localStorage.getItem(JOURNAL_OPEN_KEY) === "true" ? { kind: "journal" } : null,
    ),
  );
  const researchWorkspaceHistoryRef = useRef(researchWorkspaceHistory);
  researchWorkspaceHistoryRef.current = researchWorkspaceHistory;
  const [researchVisibilityFilter, setResearchVisibilityFilter] =
    useState<ResearchVisibilityFilter>(() => {
      const stored = localStorage.getItem(RESEARCH_VISIBILITY_FILTER_KEY);
      if (stored === "active" || stored === "archived" || stored === "all") {
        return stored;
      }
      return localStorage.getItem(LEGACY_SHOW_ARCHIVED_RESEARCH_KEY) === "true"
        ? "all"
        : "active";
    });
  const changeResearchVisibilityFilter = useCallback((filter: ResearchVisibilityFilter) => {
    setResearchVisibilityFilter(filter);
    localStorage.setItem(RESEARCH_VISIBILITY_FILTER_KEY, filter);
  }, []);
  // Which single folder the Research sidebar is scoped to. The raw stored
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
    journalOpen,
    journalOpenRef,
    setJournalOpen,
    researchWorkspaceHistory,
    researchWorkspaceHistoryRef,
    setResearchWorkspaceHistory,
    researchVisibilityFilter,
    changeResearchVisibilityFilter,
    researchFolderScope,
    changeResearchFolderScope,
  };
}
