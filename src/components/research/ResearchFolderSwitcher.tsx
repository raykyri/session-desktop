import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import type { GroupInfo } from "../../types";
import type { ResearchFolderScope } from "../../lib/researchScope";
import { listenToResearchFolderMenuToggle } from "../../lib/researchShortcuts";
import { ResearchStripButton } from "./ResearchSidebarNav";

interface ResearchFolderSwitcherProps {
  folders: GroupInfo[];
  scope: ResearchFolderScope;
  // Tree counts (active + archived) keyed by workspace id for the menu badges.
  treeCounts: Map<string, number>;
  folderPickerBusy: boolean;
  /** Show the held-⌘ shortcut badge on the trigger. */
  shortcutHintsShown: boolean;
  onSelectScope: (scope: ResearchFolderScope) => void;
  onNewFolder: () => Promise<GroupInfo | null>;
  onOpenFolder: (folder: GroupInfo) => Promise<void>;
  onRenameFolder: (folder: GroupInfo) => void;
  onMoveFolder: (folder: GroupInfo) => Promise<void>;
  onRemoveFolder: (folder: GroupInfo) => void;
  /** "strip": an icon in the collapsed sidebar whose menu opens beside the
   * strip as a popover, with `footer` (the account control) at its bottom. */
  variant?: "sidebar" | "strip";
  footer?: ReactNode;
}

export default function ResearchFolderSwitcher({
  folders,
  scope,
  treeCounts,
  folderPickerBusy,
  shortcutHintsShown,
  onSelectScope,
  onNewFolder,
  onOpenFolder,
  onRenameFolder,
  onMoveFolder,
  onRemoveFolder,
  variant = "sidebar",
  footer,
}: ResearchFolderSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stripTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const strip = variant === "strip";

  // The strip's popover opens beside the strip, its bottom level with the icon.
  useEffect(() => {
    if (!open || !strip) return;
    const place = () => {
      const rect = stripTriggerRef.current?.getBoundingClientRect();
      const stripRect = stripTriggerRef.current
        ?.closest(".research-strip")
        ?.getBoundingClientRect();
      if (!rect) return;
      setPopoverStyle({
        left: (stripRect?.right ?? rect.right) + 6,
        bottom: Math.max(8, window.innerHeight - rect.bottom),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, strip]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Element;
      // A dialog opened from the menu (GitHub sign-in) keeps it open.
      if (target.closest?.('[role="dialog"], [role="alertdialog"]')) return;
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        setOpen(false);
        if (strip) stripTriggerRef.current?.focus();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, strip]);

  // ⌘O routed from the app-level shortcut dispatcher; toggling (rather than
  // only opening) lets the same chord dismiss the menu it summoned.
  useEffect(() => listenToResearchFolderMenuToggle(() => setOpen((current) => !current)), []);

  const scopedFolder = folders.find((folder) => folder.id === scope);
  const folderName = (folder: GroupInfo) => {
    const name = folder.nameOverride || folder.name;
    return name === "Default research" ? "Default workspace" : name;
  };

  function select(next: ResearchFolderScope) {
    setOpen(false);
    onSelectScope(next);
  }

  const scopedName = scopedFolder ? folderName(scopedFolder) : "Research folders";
  const menu = (
    <div
      className={`research-folder-menu${strip ? " is-in-popover" : ""}`}
      role="menu"
      aria-label="Research folders"
    >
      {folders.length > 0
        ? folders.map((folder, index) => (
            <button
              key={folder.id}
              type="button"
              role="menuitemradio"
              aria-checked={scope === folder.id}
              className={`control-button research-folder-item${scope === folder.id ? " is-selected" : ""}`}
              title={folder.dir}
              onClick={() => select(folder.id)}
            >
              <Folder size={13} aria-hidden="true" />
              <span className="research-folder-item-copy">
                <span className="research-folder-item-name">{folderName(folder)}</span>
                <span className="research-folder-path">{folder.dir}</span>
              </span>
              {scope === folder.id ? <Check size={13} aria-hidden="true" /> : null}
              {index > 0 ? (
                <span className="research-folder-count">{treeCounts.get(folder.id) ?? 0}</span>
              ) : null}
            </button>
          ))
        : null}
      <div className="research-folder-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="control-button research-folder-item"
        disabled={folderPickerBusy}
        onClick={() => {
          setOpen(false);
          void onNewFolder().then((workspace) => {
            if (workspace) {
              onSelectScope(workspace.id);
            }
          });
        }}
      >
        <FolderPlus size={13} aria-hidden="true" />
        <span className="research-folder-item-name">Open new folder…</span>
      </button>
      {scopedFolder ? (
        <>
          <div className="research-folder-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="control-button research-folder-item"
            onClick={() => {
              setOpen(false);
              onRenameFolder(scopedFolder);
            }}
          >
            <Pencil size={13} aria-hidden="true" />
            <span className="research-folder-item-name">Rename “{folderName(scopedFolder)}”</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="control-button research-folder-item"
            onClick={() => {
              setOpen(false);
              void onOpenFolder(scopedFolder);
            }}
          >
            <FolderOpen size={13} aria-hidden="true" />
            <span className="research-folder-item-name">Open in Finder</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="control-button research-folder-item"
            disabled={folderPickerBusy}
            onClick={() => {
              setOpen(false);
              void onMoveFolder(scopedFolder);
            }}
          >
            <FolderInput size={13} aria-hidden="true" />
            <span className="research-folder-item-name">Move selected folder…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="control-button research-folder-item is-remove"
            onClick={() => {
              setOpen(false);
              onRemoveFolder(scopedFolder);
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
            <span className="research-folder-item-name">Remove selected folder</span>
          </button>
        </>
      ) : null}
    </div>
  );

  if (strip) {
    return (
      <div className="research-folder-switcher is-strip" ref={rootRef}>
        <ResearchStripButton
          label={`Workspace: ${scopedName}`}
          description={`${scopedName} (⌘O)`}
          buttonRef={stripTriggerRef}
          popup
          expanded={open}
          selected={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Folder size={16} aria-hidden="true" />
        </ResearchStripButton>
        {open ? (
          <div className="research-folder-popover" style={popoverStyle}>
            {menu}
            {footer ? <div className="research-folder-popover-footer">{footer}</div> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="research-folder-switcher" ref={rootRef}>
      <button
        type="button"
        className="control-button research-folder-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={scopedFolder?.dir ?? "No research folder selected"}
        onClick={() => setOpen((current) => !current)}
      >
        <Folder size={13} aria-hidden="true" />
        <span className="research-folder-trigger-copy">
          <span className="research-folder-trigger-name">{scopedName}</span>
          {scopedFolder ? <span className="research-folder-path">{scopedFolder.dir}</span> : null}
        </span>
        <ChevronDown size={13} aria-hidden="true" className={open ? "is-open" : undefined} />
      </button>
      {shortcutHintsShown ? (
        <span className="pane-tab-shortcut-hint research-folder-shortcut-hint" aria-hidden="true">
          ⌘O
        </span>
      ) : null}
      {open ? menu : null}
    </div>
  );
}
