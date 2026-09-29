// The workspace scope (`07-client-architecture.md` §3): which workspace the
// sidebar and the feeds are looking at.
//
// The scope is a search param rather than a store, so a reload, a deep link
// and a second tab all agree (ADR-7). `?ws=` absent means the account's
// default workspace, which is what `settings.defaultWorkspaceId` holds; an
// account with no default falls back to the first workspace in sidebar order.
// Fall back to a valid workspace if a bookmarked workspace ID no longer exists.

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";

import { useSettings, useWorkspaces } from "../../api/queries.js";

export interface WorkspaceScope {
  /** The resolved workspace, or `""` before the lists have loaded. Queries
   * that take a workspace are disabled on the empty string. */
  workspaceId: string;
  /** Raw workspace ID from the `?ws=` query parameter before resolution. */
  requested: string | null;
  /** True once the `workspaces.list` query has settled. */
  ready: boolean;
  setScope: (workspaceId: string) => void;
}

/** The raw `?ws=`, read without naming a route: the sidebar renders on every
 * route, including the ones whose search schema has no `ws` at all. */
export function useWorkspaceSearchParam(): string | null {
  return useRouterState({
    select: (state) => {
      const search = state.location.search as Record<string, unknown>;
      const value = search["ws"];
      return typeof value === "string" && value !== "" ? value : null;
    },
  });
}

export function useWorkspaceScope(): WorkspaceScope {
  const navigate = useNavigate();
  const requested = useWorkspaceSearchParam();
  const workspaces = useWorkspaces();
  const settings = useSettings();

  const list = workspaces.data ?? [];
  const known = requested !== null && list.some((workspace) => workspace.id === requested);
  const fallback = settings.data?.defaultWorkspaceId ?? null;
  const fallbackKnown = fallback !== null && list.some((workspace) => workspace.id === fallback);
  const workspaceId = known
    ? requested
    : fallbackKnown
      ? fallback
      : (list[0]?.id ?? (list.length === 0 ? (fallback ?? "") : ""));

  const setScope = useCallback(
    (next: string) => {
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({ ...previous, ws: next }),
        replace: true,
      });
    },
    [navigate],
  );

  return { workspaceId, requested, ready: workspaces.isSuccess, setScope };
}
