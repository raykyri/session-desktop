import { useState } from "react";
import type { ReactNode, Ref } from "react";
import {
  Bookmark,
  Ellipsis,
  Highlighter,
  House,
  PanelLeft,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { ResearchFolder } from "../../types";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchFolderMonogram,
} from "../../lib/researchFolders";
import {
  researchJournalViewKey,
  type ResearchJournalView,
} from "../../lib/sidebarMode";
import { ResearchPlaceIcon } from "./ResearchFeedChrome";
import { ResearchMenu, ResearchMenuItem } from "./ResearchMenu";

interface NavEntry {
  view: ResearchJournalView;
  label: string;
  icon: ReactNode;
  /** Monogram shown in the strip instead of the icon (user folders). */
  monogram?: string;
  /** Drop target place: Home is Unfiled. */
  drop?: string;
  folderId?: string;
}

function placeView(place: string): ResearchJournalView {
  if (place === RESEARCH_DRAFTS_FOLDER_ID) return { kind: "drafts" };
  if (place === RESEARCH_ARCHIVE_FOLDER_ID) return { kind: "archive" };
  return { kind: "folder", folderId: place };
}

function primaryEntries(): NavEntry[] {
  return [
    {
      view: { kind: "home" },
      label: "Home",
      icon: <House size={16} aria-hidden="true" />,
      drop: RESEARCH_UNFILED_FOLDER_ID,
    },
    { view: { kind: "bookmarks" }, label: "Bookmarks", icon: <Bookmark size={16} aria-hidden="true" /> },
    {
      view: { kind: "highlights" },
      label: "Highlights",
      icon: <Highlighter size={16} aria-hidden="true" />,
    },
  ];
}

function folderEntries(folders: ResearchFolder[]): NavEntry[] {
  return [
    RESEARCH_DRAFTS_FOLDER_ID,
    ...folders.map((folder) => folder.id),
    RESEARCH_ARCHIVE_FOLDER_ID,
  ].map((place) => {
    const folder = folders.find((candidate) => candidate.id === place);
    return {
      view: placeView(place),
      label: folder?.name ?? (place === RESEARCH_DRAFTS_FOLDER_ID ? "Drafts" : "Archive"),
      icon: <ResearchPlaceIcon place={place} size={16} />,
      monogram: folder ? researchFolderMonogram(folder.name) : undefined,
      drop: place,
      folderId: folder?.id,
    };
  });
}

interface ResearchSidebarNavProps {
  current: ResearchJournalView | null;
  folders: ResearchFolder[];
  onNavigate: (view: ResearchJournalView) => void;
  onNewFolder: () => void;
  /** `trigger` is the row's … button, where focus returns after the dialog. */
  onRenameFolder: (folderId: string, trigger: HTMLElement) => void;
  onDeleteFolder: (folderId: string) => void;
  /** Why the stored folders couldn't be loaded; only the system rows show
   * meanwhile. */
  foldersLoadError?: string | null;
  onRetryFoldersLoad?: () => void;
  /** Shown beside Home while ⌘ is held. */
  homeShortcutHint?: string | null;
}

/** The full sidebar's rows: Home, Bookmarks, Highlights, then the Folders
 * section (Drafts, user folders, Archive). Rows carry no counts. Every row
 * but Bookmarks and Highlights is a drop target; user folders have a …
 * menu with Rename and Delete. */
export function ResearchSidebarNav({
  current,
  folders,
  onNavigate,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
  foldersLoadError = null,
  onRetryFoldersLoad,
  homeShortcutHint = null,
}: ResearchSidebarNavProps) {
  const currentKey = current ? researchJournalViewKey(current) : null;
  const [menu, setMenu] = useState<{ folderId: string; anchor: HTMLElement } | null>(null);
  const renderRow = (entry: NavEntry) => {
    const key = researchJournalViewKey(entry.view);
    const selected = key === currentKey;
    return (
      <div
        key={key}
        className={`research-nav-row${selected ? " is-selected" : ""}${
          menu && menu.folderId === entry.folderId ? " has-open-menu" : ""
        }`}
        data-research-drop={entry.drop}
      >
        <button
          type="button"
          className="research-nav-select"
          aria-current={selected ? "page" : undefined}
          onClick={() => onNavigate(entry.view)}
        >
          {entry.icon}
          <span className="research-nav-label">{entry.label}</span>
          {entry.view.kind === "home" && homeShortcutHint ? (
            <span className="pane-tab-shortcut-hint" aria-hidden="true">
              {homeShortcutHint}
            </span>
          ) : null}
        </button>
        {entry.folderId ? (
          <button
            type="button"
            className="research-feed-icon-button research-nav-menu"
            aria-label={`Actions for ${entry.label}`}
            aria-haspopup="menu"
            onClick={(event) => {
              const anchor = event.currentTarget;
              const folderId = entry.folderId as string;
              setMenu((open) => (open?.folderId === folderId ? null : { folderId, anchor }));
            }}
          >
            <Ellipsis size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  };
  return (
    <>
      <nav className="research-nav" aria-label="Research">
        {primaryEntries().map(renderRow)}
      </nav>
      <div className="research-nav-section">
        <span>Folders</span>
        <button
          type="button"
          className="research-feed-icon-button"
          title="New folder"
          aria-label="New folder"
          onClick={onNewFolder}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      {foldersLoadError ? (
        <div className="research-nav-note" role="status" title={foldersLoadError}>
          Folders couldn't be loaded.{" "}
          {onRetryFoldersLoad ? (
            <button type="button" className="research-nav-note-action" onClick={onRetryFoldersLoad}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <nav className="research-nav is-folders" aria-label="Folders">
        {folderEntries(folders).map(renderRow)}
      </nav>
      {menu ? (
        <ResearchMenu
          anchor={menu.anchor}
          label={`Actions for ${folders.find((folder) => folder.id === menu.folderId)?.name ?? "folder"}`}
          align="start"
          width={180}
          onClose={() => setMenu(null)}
        >
          <ResearchMenuItem
            icon={<Pencil size={15} aria-hidden="true" />}
            label="Rename…"
            onSelect={() => {
              setMenu(null);
              onRenameFolder(menu.folderId, menu.anchor);
            }}
          />
          <ResearchMenuItem
            icon={<Trash2 size={15} aria-hidden="true" />}
            label="Delete…"
            onSelect={() => {
              setMenu(null);
              onDeleteFolder(menu.folderId);
            }}
          />
        </ResearchMenu>
      ) : null}
    </>
  );
}

interface ResearchSidebarStripProps {
  current: ResearchJournalView | null;
  folders: ResearchFolder[];
  /** The window is too narrow for the full sidebar, so it can't expand. */
  forced: boolean;
  /** macOS keeps its window buttons over the strip's top cell, so the expand
   * button sits beside them, where the full sidebar's collapse button is. */
  reserveTitlebar: boolean;
  expandShortcut: string;
  onExpand: () => void;
  onNavigate: (view: ResearchJournalView) => void;
  onNewFolder: () => void;
  /** Settings and other controls at the bottom of the strip. */
  footer: ReactNode;
}

/** A tooltip for strip icons, fixed beside the icon so the scrolling folder
 * group can't clip it. Shown on hover, focus, and while a drag hovers it. */
function placeStripTip(icon: HTMLElement) {
  const tip = icon.querySelector<HTMLElement>(".research-strip-tip");
  if (!tip) return;
  const rect = icon.getBoundingClientRect();
  tip.style.left = `${rect.right + 8}px`;
  tip.style.top = `${rect.top + rect.height / 2}px`;
}

export function ResearchStripButton({
  label,
  description,
  selected = false,
  disabled = false,
  drop,
  className = "",
  buttonRef,
  popup,
  expanded,
  onClick,
  children,
}: {
  label: string;
  /** Shown in the tooltip instead of the label, and announced as a description. */
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  drop?: string;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  /** The button opens a menu. */
  popup?: boolean;
  expanded?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`research-strip-icon${selected ? " is-selected" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-description={description}
      aria-current={selected ? "page" : undefined}
      aria-disabled={disabled ? "true" : undefined}
      aria-haspopup={popup ? "menu" : undefined}
      aria-expanded={popup ? expanded : undefined}
      data-research-drop={drop}
      onMouseEnter={(event) => placeStripTip(event.currentTarget)}
      onFocus={(event) => placeStripTip(event.currentTarget)}
      onPointerMove={(event) => placeStripTip(event.currentTarget)}
      onClick={disabled ? undefined : onClick}
    >
      {children}
      {expanded ? null : (
        <span className="research-strip-tip" aria-hidden="true">
          {description ?? label}
        </span>
      )}
    </button>
  );
}

/** The collapsed sidebar: a 52px column of icons. Home, Bookmarks, and
 * Highlights, then one icon per folder (user folders as their first letter,
 * named in the tooltip), then New folder. Folder icons and Home accept drops. */
export function ResearchSidebarStrip({
  current,
  folders,
  forced,
  reserveTitlebar,
  expandShortcut,
  onExpand,
  onNavigate,
  onNewFolder,
  footer,
}: ResearchSidebarStripProps) {
  const currentKey = current ? researchJournalViewKey(current) : null;
  const entryButton = (entry: NavEntry) => {
    const key = researchJournalViewKey(entry.view);
    return (
      <ResearchStripButton
        key={key}
        label={entry.label}
        selected={key === currentKey}
        drop={entry.drop}
        onClick={() => onNavigate(entry.view)}
      >
        {entry.monogram ? (
          <span className="research-strip-monogram" aria-hidden="true">
            {entry.monogram}
          </span>
        ) : (
          entry.icon
        )}
      </ResearchStripButton>
    );
  };
  const expand = (
    <ResearchStripButton
      label="Expand sidebar"
      description={
        forced ? "The window is too narrow for the full sidebar" : `Expand sidebar (${expandShortcut})`
      }
      disabled={forced}
      className={reserveTitlebar ? "is-expand is-beside-titlebar" : "is-expand"}
      onClick={onExpand}
    >
      <PanelLeft size={15} aria-hidden="true" />
    </ResearchStripButton>
  );
  return (
    <aside className="research-strip" aria-label="Sidebar">
      <div className="research-strip-top" data-tauri-drag-region>
        {expand}
      </div>
      {primaryEntries().map(entryButton)}
      <div className="research-strip-divider" />
      <div className="research-strip-folders">
        {folderEntries(folders).map(entryButton)}
        <ResearchStripButton label="New folder" onClick={onNewFolder}>
          <Plus size={16} aria-hidden="true" />
        </ResearchStripButton>
      </div>
      <span className="research-strip-spacer" />
      {footer}
    </aside>
  );
}
