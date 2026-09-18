// The sidebar's visibility filter (`10-home-feed-journal-encyclopedia.md` §7).
//
// `?filter=` is the authority and the `navigation` store is the memory: the URL
// is what a reload, a deep link and a second tab agree on (ADR-7), and the
// store is what supplies the value on a route that was opened without one, so
// the choice survives navigating between pages.

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import type { ResearchVisibilityFilter } from "../../stores/navigation.js";
import { useNavigationStore } from "../../stores/navigation.js";

export type { ResearchVisibilityFilter };

export function parseVisibilityFilter(value: unknown): ResearchVisibilityFilter | null {
  return value === "active" || value === "archived" || value === "all" ? value : null;
}

export interface VisibilityFilterControl {
  filter: ResearchVisibilityFilter;
  setFilter: (filter: ResearchVisibilityFilter) => void;
}

export function useVisibilityFilter(): VisibilityFilterControl {
  const navigate = useNavigate();
  const stored = useNavigationStore((state) => state.visibilityFilter);
  const setStored = useNavigationStore((state) => state.setVisibilityFilter);
  const fromUrl = useRouterState({
    select: (state) =>
      parseVisibilityFilter((state.location.search as Record<string, unknown>)["filter"]),
  });
  const filter = fromUrl ?? stored;

  // A link that names a filter changes the remembered one, so leaving that
  // route and coming back does not silently revert it.
  useEffect(() => {
    if (fromUrl !== null && fromUrl !== stored) setStored(fromUrl);
  }, [fromUrl, stored, setStored]);

  const setFilter = useCallback(
    (next: ResearchVisibilityFilter) => {
      setStored(next);
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({ ...previous, filter: next }),
        replace: true,
      });
    },
    [navigate, setStored],
  );

  return { filter, setFilter };
}
