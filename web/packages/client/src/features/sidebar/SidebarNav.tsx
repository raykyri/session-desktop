// The sidebar's places (the desktop's `ResearchSidebarNav.tsx`): Home,
// Highlights, Shared with me, Notifications and All Users (web only), then the Folders section (Drafts, the workspace's folders,
// Archive, Trash) with New folder. Rows carry no counts. Every row but
// Highlights and Trash takes card drops; a folder row has a … menu with
// Rename and Delete.

import type { ResearchFolder } from "@session/shared";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_TRASH_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchPlaceName,
} from "@session/shared/lib/researchFolders";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Ellipsis,
  Globe,
  Highlighter,
  House,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useReceivedInvites, useUnreadNotificationCount } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { formatChord } from "../../lib/platform.js";
import { useShortcutHintsShown } from "../../lib/shortcutHints.js";
import { AnchoredMenu } from "../../ui/AnchoredMenu.js";
import { IconButton } from "../../ui/Button.js";
import { SHORTCUT_HINT } from "../../ui/surfaces.js";
import { PlaceIcon } from "../home/FeedTray.js";
import { useFolderDialogStore, useRequestFolderDelete } from "../home/FolderDialogsHost.js";
import { IconMenuItem } from "../sidebar/menuRows.js";

import {
  badgeText,
  COUNT_BADGE,
  invitationCountLabel,
  SIDEBAR_ROW,
  SIDEBAR_ROW_SELECTED,
  SIDEBAR_SECTION_HEADING,
  unreadCountLabel,
} from "./rows.js";

interface NavEntry {
  /** The route path the row opens. */
  to:
    | "/"
    | "/highlights"
    | "/shared"
    | "/notifications"
    | "/drafts"
    | "/archive"
    | "/trash"
    | "/f/$folderId";
  folderId?: string;
  label: string;
  icon: ReactNode;
  /** The place a card dropped on the row moves to: Home is Unfiled. */
  drop?: string;
  /** Web only: the All Users feed is `/` with `?feed=all`. */
  feed?: "all";
  key: string;
}

function placeEntries(folders: ResearchFolder[]): NavEntry[] {
  return [
    RESEARCH_DRAFTS_FOLDER_ID,
    ...folders.map((folder) => folder.id),
    RESEARCH_ARCHIVE_FOLDER_ID,
    RESEARCH_TRASH_FOLDER_ID,
  ].map((place): NavEntry => {
    const folder = folders.find((candidate) => candidate.id === place);
    const base = {
      key: place,
      label: folder?.name ?? researchPlaceName(place, folders),
      icon: <PlaceIcon place={place} size={14} />,
      ...(place === RESEARCH_TRASH_FOLDER_ID ? {} : { drop: place }),
    };
    if (place === RESEARCH_DRAFTS_FOLDER_ID) return { ...base, to: "/drafts" };
    if (place === RESEARCH_ARCHIVE_FOLDER_ID) return { ...base, to: "/archive" };
    if (place === RESEARCH_TRASH_FOLDER_ID) return { ...base, to: "/trash" };
    return { ...base, to: "/f/$folderId", folderId: place };
  });
}

/** The place the current route shows, as a row key. */
function currentKey(pathname: string, feed: string | null): string | null {
  if (pathname === "/") return feed === "all" ? "all-users" : "home";
  if (pathname === "/highlights") return "highlights";
  if (pathname === "/shared") return "shared";
  if (pathname === "/notifications") return "notifications";
  if (pathname === "/drafts" || pathname.startsWith("/drafts/")) return RESEARCH_DRAFTS_FOLDER_ID;
  if (pathname === "/archive") return RESEARCH_ARCHIVE_FOLDER_ID;
  if (pathname === "/trash") return RESEARCH_TRASH_FOLDER_ID;
  const folder = /^\/f\/([^/]+)$/.exec(pathname);
  return folder?.[1] ? decodeURIComponent(folder[1]) : null;
}

export function SidebarNav({
  workspaceId,
  folders,
  signedIn,
  foldersLoadError,
  onRetryFoldersLoad,
}: {
  workspaceId: string;
  folders: ResearchFolder[];
  signedIn: boolean;
  foldersLoadError?: string | null;
  onRetryFoldersLoad?: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Shown beside Home while ⌘ is held (`lib/shortcutHints`).
  const hintsShown = useShortcutHintsShown();
  const feed = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>)["feed"];
      return typeof value === "string" ? value : null;
    },
  });
  const selected = currentKey(pathname, feed);
  // Invitations waiting for the reader, counted on Shared with me, where
  // they are accepted.
  const invitations = useReceivedInvites().data?.length ?? 0;
  const unread = useUnreadNotificationCount().data ?? 0;
  const badgeOf = (key: string): { count: number; label: string } | null =>
    key === "shared" && invitations > 0
      ? { count: invitations, label: invitationCountLabel(invitations) }
      : key === "notifications" && unread > 0
        ? { count: unread, label: unreadCountLabel(unread) }
        : null;
  const [menu, setMenu] = useState<{ folderId: string; anchor: HTMLElement } | null>(null);
  const openNew = useFolderDialogStore((state) => state.openNew);
  const openRename = useFolderDialogStore((state) => state.openRename);
  const requestDelete = useRequestFolderDelete();
  const search = (previous: Record<string, unknown>) => ({
    ws: (previous["ws"] as string | undefined) ?? (workspaceId || undefined),
  });

  const primary: NavEntry[] = [
    {
      key: "home",
      to: "/",
      label: "Home",
      icon: <House size={14} aria-hidden="true" />,
      drop: RESEARCH_UNFILED_FOLDER_ID,
    },
    ...(signedIn
      ? [
          {
            key: "highlights",
            to: "/highlights" as const,
            label: "Highlights",
            icon: <Highlighter size={14} aria-hidden="true" />,
          },
          // Web only: the threads other people share with the reader.
          {
            key: "shared",
            to: "/shared" as const,
            label: "Shared with me",
            icon: <Users size={14} aria-hidden="true" />,
          },
          // Web only: the notification inbox.
          {
            key: "notifications",
            to: "/notifications" as const,
            label: "Notifications",
            icon: <Bell size={14} aria-hidden="true" />,
          },
          // Web only: every account's public threads (a guest's `/`).
          {
            key: "all-users",
            to: "/" as const,
            feed: "all" as const,
            label: "All Users",
            icon: <Globe size={14} aria-hidden="true" />,
          },
        ]
      : []),
  ];

  const renderRow = (entry: NavEntry) => {
    const isSelected = entry.key === selected;
    const badge = badgeOf(entry.key);
    const menuOpen = menu !== null && menu.folderId === entry.folderId;
    return (
      <div
        key={entry.key}
        className={cn(
          "group/row relative rounded-md border border-transparent",
          "[&.is-drop-target]:border-border-drop [&.is-drop-target]:bg-surface-drop",
        )}
        data-research-drop={signedIn ? entry.drop : undefined}
      >
        <Link
          to={entry.to}
          params={entry.folderId ? { folderId: entry.folderId } : {}}
          search={
            entry.feed
              ? (previous: Record<string, unknown>) => ({ ...search(previous), feed: entry.feed })
              : search
          }
          aria-current={isSelected ? "page" : undefined}
          aria-label={badge ? `${entry.label}, ${badge.label}` : undefined}
          className={cn(SIDEBAR_ROW, isSelected && SIDEBAR_ROW_SELECTED, entry.folderId && "pr-8")}
        >
          <span className="text-fg-muted inline-flex shrink-0">{entry.icon}</span>
          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          {badge ? (
            <span
              className={COUNT_BADGE}
              aria-hidden="true"
              {...(entry.key === "shared"
                ? { "data-invite-count": badge.count }
                : { "data-unread-count": badge.count })}
            >
              {badgeText(badge.count)}
            </span>
          ) : null}
          {entry.key === "home" && hintsShown ? (
            <span className={SHORTCUT_HINT} aria-hidden="true">
              {formatChord("mod+shift+h")}
            </span>
          ) : null}
        </Link>
        {entry.folderId ? (
          <IconButton
            label={`Actions for ${entry.label}`}
            tooltip={false}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={cn(
              "absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100",
              menuOpen && "opacity-100",
            )}
            onClick={(event) => {
              const anchor = event.currentTarget;
              const folderId = entry.folderId ?? "";
              setMenu((open) => (open?.folderId === folderId ? null : { folderId, anchor }));
            }}
          >
            <Ellipsis size={15} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
    );
  };

  const menuFolder = menu ? folders.find((folder) => folder.id === menu.folderId) : undefined;
  return (
    <>
      <nav aria-label="Research" className="flex flex-col gap-px px-2">
        {primary.map(renderRow)}
      </nav>
      {signedIn ? (
        <>
          <div className={cn(SIDEBAR_SECTION_HEADING, "mt-3 pr-1")}>
            <span>Folders</span>
            <IconButton
              label="New folder"
              disabled={workspaceId === ""}
              onClick={(event) => openNew(null, event.currentTarget)}
            >
              <Plus size={15} aria-hidden="true" />
            </IconButton>
          </div>
          {foldersLoadError ? (
            <div
              className="text-fg-muted px-2.5 py-1 text-xs"
              role="status"
              title={foldersLoadError}
            >
              Folders couldn't be loaded.{" "}
              {onRetryFoldersLoad ? (
                <button
                  type="button"
                  className="text-fg-secondary cursor-pointer border-0 bg-transparent p-0 text-xs underline"
                  onClick={onRetryFoldersLoad}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          <nav aria-label="Folders" className="flex flex-col gap-px px-2">
            {placeEntries(folders).map(renderRow)}
          </nav>
        </>
      ) : null}
      {menu && menuFolder ? (
        <AnchoredMenu
          anchor={menu.anchor}
          label={`Actions for ${menuFolder.name}`}
          onClose={() => setMenu(null)}
        >
          <IconMenuItem
            icon={<Pencil size={15} aria-hidden="true" />}
            onClick={() => openRename(menuFolder.id, menuFolder.name, menu.anchor)}
          >
            Rename…
          </IconMenuItem>
          <IconMenuItem
            icon={<Trash2 size={15} aria-hidden="true" />}
            onClick={() => requestDelete(menuFolder.id)}
          >
            Delete…
          </IconMenuItem>
        </AnchoredMenu>
      ) : null}
    </>
  );
}
