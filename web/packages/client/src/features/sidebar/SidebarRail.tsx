// The collapsed sidebar (the desktop's `ResearchSidebarRail` in
// `ResearchSidebarNav.tsx`): a 52px column of icons. Expand sidebar, then
// Home and Highlights (and the web's Shared with me and All Users), then one
// icon per place — Drafts, each folder as its first letter (named in the
// tooltip), Archive, Trash — then New folder, and at the foot the Light/Dark
// toggle and Settings. Home and every place but Trash take card drops, as in
// the full sidebar.

import type { ResearchFolder } from "@session/shared";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_TRASH_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchFolderMonogram,
  researchPlaceName,
} from "@session/shared/lib/researchFolders";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Globe,
  Highlighter,
  House,
  Moon,
  PanelLeft,
  Plus,
  Settings,
  Sun,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

import { useResolvedAppearance } from "../../lib/appearance.js";
import { cn } from "../../lib/cn.js";
import { formatChord } from "../../lib/platform.js";
import { selectAppearance, useSettingsStore } from "../../stores/settings.js";
import { Tooltip } from "../../ui/Tooltip.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { PlaceIcon } from "../home/FeedTray.js";
import { useFolderDialogStore } from "../home/FolderDialogsHost.js";

/** The rail is this wide (the desktop's 52px). */
export const SIDEBAR_RAIL_WIDTH = 52;

const RAIL_ICON = cn(
  "relative grid h-[34px] w-9 shrink-0 cursor-pointer place-items-center rounded-lg border border-transparent bg-transparent p-0",
  "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-primary",
  "aria-[current=page]:bg-surface-fill-medium aria-[current=page]:text-fg-heading",
  "[&.is-drop-target]:border-border-drop [&.is-drop-target]:bg-surface-drop",
  "disabled:cursor-default disabled:opacity-50",
  FOCUS_RING,
);

type RailPath =
  | "/"
  | "/highlights"
  | "/shared"
  | "/settings"
  | "/drafts"
  | "/archive"
  | "/trash"
  | "/f/$folderId";

interface RailEntry {
  key: string;
  to: RailPath;
  folderId?: string;
  feed?: "all";
  label: string;
  /** The tooltip, when it says more than the label (a shortcut). */
  tooltip?: string;
  icon: ReactNode;
  drop?: string;
}

function placeEntries(folders: readonly ResearchFolder[]): RailEntry[] {
  return [
    RESEARCH_DRAFTS_FOLDER_ID,
    ...folders.map((folder) => folder.id),
    RESEARCH_ARCHIVE_FOLDER_ID,
    RESEARCH_TRASH_FOLDER_ID,
  ].map((place): RailEntry => {
    const folder = folders.find((candidate) => candidate.id === place);
    const base = {
      key: place,
      label: folder?.name ?? researchPlaceName(place, [...folders]),
      icon: folder ? (
        <span className="text-[13px] leading-none font-semibold" aria-hidden="true">
          {researchFolderMonogram(folder.name)}
        </span>
      ) : (
        <PlaceIcon place={place} size={16} />
      ),
      ...(place === RESEARCH_TRASH_FOLDER_ID ? {} : { drop: place }),
    };
    if (place === RESEARCH_DRAFTS_FOLDER_ID) return { ...base, to: "/drafts" };
    if (place === RESEARCH_ARCHIVE_FOLDER_ID) return { ...base, to: "/archive" };
    if (place === RESEARCH_TRASH_FOLDER_ID) return { ...base, to: "/trash" };
    return { ...base, to: "/f/$folderId", folderId: place };
  });
}

function currentKey(pathname: string, feed: string | null): string | null {
  if (pathname === "/") return feed === "all" ? "all-users" : "home";
  if (pathname === "/highlights") return "highlights";
  if (pathname === "/shared") return "shared";
  if (pathname === "/settings") return "settings";
  if (pathname === "/drafts" || pathname.startsWith("/drafts/")) return RESEARCH_DRAFTS_FOLDER_ID;
  if (pathname === "/archive") return RESEARCH_ARCHIVE_FOLDER_ID;
  if (pathname === "/trash") return RESEARCH_TRASH_FOLDER_ID;
  const folder = /^\/f\/([^/]+)$/.exec(pathname);
  return folder?.[1] ? decodeURIComponent(folder[1]) : null;
}

export function SidebarRail({
  workspaceId,
  folders,
  signedIn,
  onExpand,
  inert = false,
}: {
  workspaceId: string;
  folders: readonly ResearchFolder[];
  signedIn: boolean;
  onExpand: () => void;
  /** Behind the narrow layout's open drawer, which holds the same places. */
  inert?: boolean | undefined;
}) {
  const appearance = useResolvedAppearance(useSettingsStore(selectAppearance));
  const toggleAppearance = useSettingsStore((state) => state.toggleAppearance);
  const light = appearance === "light";
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const feed = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>)["feed"];
      return typeof value === "string" ? value : null;
    },
  });
  const selected = currentKey(pathname, feed);
  const openNew = useFolderDialogStore((state) => state.openNew);
  const search = (previous: Record<string, unknown>) => ({
    ws: (previous["ws"] as string | undefined) ?? (workspaceId || undefined),
  });

  const primary: RailEntry[] = [
    {
      key: "home",
      to: "/",
      label: "Home",
      icon: <House size={16} aria-hidden="true" />,
      drop: RESEARCH_UNFILED_FOLDER_ID,
    },
    ...(signedIn
      ? [
          {
            key: "highlights",
            to: "/highlights" as const,
            label: "Highlights",
            icon: <Highlighter size={16} aria-hidden="true" />,
          },
          {
            key: "shared",
            to: "/shared" as const,
            label: "Shared with me",
            icon: <Users size={16} aria-hidden="true" />,
          },
          {
            key: "all-users",
            to: "/" as const,
            feed: "all" as const,
            label: "All Users",
            icon: <Globe size={16} aria-hidden="true" />,
          },
        ]
      : []),
  ];

  const entryLink = (entry: RailEntry) => (
    <Tooltip key={entry.key} content={entry.tooltip ?? entry.label} side="right">
      <Link
        to={entry.to}
        params={entry.folderId ? { folderId: entry.folderId } : {}}
        search={
          entry.feed
            ? (previous: Record<string, unknown>) => ({ ...search(previous), feed: entry.feed })
            : search
        }
        aria-label={entry.label}
        aria-current={entry.key === selected ? "page" : undefined}
        data-research-drop={signedIn ? entry.drop : undefined}
        className={RAIL_ICON}
      >
        {entry.icon}
      </Link>
    </Tooltip>
  );

  return (
    <aside
      aria-label="Sidebar"
      inert={inert}
      className="border-border-divider bg-surface-sidebar flex h-full shrink-0 flex-col items-center gap-0.5 border-r pb-2.5 select-none"
      style={{ width: SIDEBAR_RAIL_WIDTH }}
    >
      <div className="border-border-divider mb-1 grid h-11 w-full shrink-0 place-items-center border-b">
        <Tooltip content={`Expand sidebar (${formatChord("mod+shift+g")})`} side="right">
          <button
            type="button"
            aria-label="Expand sidebar"
            className={RAIL_ICON}
            onClick={onExpand}
          >
            <PanelLeft size={15} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <nav aria-label="Research" className="flex flex-col items-center gap-0.5">
        {primary.map(entryLink)}
      </nav>
      {signedIn ? (
        <>
          <div className="bg-border-divider my-1.5 h-px w-6 shrink-0" />
          <nav
            aria-label="Folders"
            className="flex min-h-0 flex-col items-center gap-0.5 overflow-y-auto"
          >
            {placeEntries(folders).map(entryLink)}
            <Tooltip content="New folder" side="right">
              <button
                type="button"
                aria-label="New folder"
                className={RAIL_ICON}
                disabled={workspaceId === ""}
                onClick={(event) => openNew(null, event.currentTarget)}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </Tooltip>
          </nav>
        </>
      ) : null}
      <span className="flex-1" />
      <Tooltip content={light ? "Dark mode" : "Light mode"} side="right">
        <button
          type="button"
          aria-label={light ? "Dark mode" : "Light mode"}
          className={RAIL_ICON}
          onClick={toggleAppearance}
        >
          {light ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
        </button>
      </Tooltip>
      {entryLink({
        key: "settings",
        to: "/settings",
        label: "Settings",
        tooltip: `Settings (${formatChord("mod+,")})`,
        icon: <Settings size={16} aria-hidden="true" />,
      })}
    </aside>
  );
}
