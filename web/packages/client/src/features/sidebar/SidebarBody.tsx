// Everything inside the sidebar frame (`10-home-feed-journal-encyclopedia.md`
// §7): the three top-level rows, the workspace switcher, the encyclopedia
// section and the research list.
//
// Split out of `AppShell`'s `Sidebar` so the narrow-layout drawer and the
// resizable column render the same thing rather than two divergent copies.

import { Link, useRouterState } from "@tanstack/react-router";
import { Bookmark, Highlighter, Home } from "lucide-react";

import { cn } from "../../lib/cn.js";
import { EncyclopediaSection } from "../encyclopedia/EncyclopediaSection.js";

import { ResearchSidebarSection, routeParam } from "./ResearchSidebarSection.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { SIDEBAR_ROW, SIDEBAR_ROW_SELECTED } from "./rows.js";
import { useWorkspaceScope } from "./scope.js";

/** The three top-level rows. Their Cmd-digit chords still resolve
 * (`shared/app/shortcuts.ts`); the rows no longer print a badge for them, so
 * the chord table in the command palette is the one place that advertises a
 * chord. */
const NAV_ITEMS = [
  { to: "/", label: "Home", icon: Home },
  { to: "/bookmarks", label: "Bookmarks", icon: Bookmark },
  { to: "/highlights", label: "Highlights", icon: Highlighter },
] as const;

export function SidebarBody() {
  const { workspaceId, setScope } = useWorkspaceScope();
  const activeSlug = useRouterState({
    select: (state) => routeParam(state.matches.at(-1)?.params, "slug"),
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pb-2">
      <nav aria-label="Sections" className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            search={(previous: Record<string, unknown>) => previous}
            className={cn(SIDEBAR_ROW, "no-underline")}
            activeProps={{
              "aria-current": "page",
              className: cn(SIDEBAR_ROW, SIDEBAR_ROW_SELECTED),
            }}
          >
            <item.icon size={14} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </Link>
        ))}
      </nav>

      <WorkspaceSwitcher workspaceId={workspaceId} onSelect={setScope} />
      <EncyclopediaSection workspaceId={workspaceId} activeSlug={activeSlug} />
      <ResearchSidebarSection workspaceId={workspaceId} />
    </div>
  );
}
