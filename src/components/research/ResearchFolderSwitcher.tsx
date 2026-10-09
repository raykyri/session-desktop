import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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
import {
  ResearchMenu,
  ResearchMenuItem,
  ResearchMenuSeparator,
  type ResearchMenuRect,
} from "./ResearchMenu";
import { ResearchStripButton } from "./ResearchSidebarNav";

const MENU_WIDTH = 264;

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
   * strip, with `footer` (the account control) at its bottom. */
  variant?: "sidebar" | "strip";
  footer?: ReactNode;
}

/** The research workspace switcher. A workspace is a folder on disk that
 * scopes the sidebar and feed. The feed's "folders" file questions inside a
 * workspace, so this menu says "workspace" for the scope and "folder" only
 * for its directory on disk. */
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
  const strip = variant === "strip";
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** The open menu's trigger and what it is placed against: the trigger, or
   * in the strip, the strip's edge level with the icon. Null while closed. */
  const [placement, setPlacement] = useState<{
    trigger: HTMLElement;
    anchor: HTMLElement | ResearchMenuRect;
  } | null>(null);
  const open = placement !== null;
  const openRef = useRef(open);
  openRef.current = open;

  const show = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    if (!strip) {
      setPlacement({ trigger, anchor: trigger });
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const stripRight = trigger.closest(".research-strip")?.getBoundingClientRect().right ?? rect.right;
    setPlacement({
      trigger,
      anchor: { left: rect.left, top: rect.top, right: stripRight, bottom: rect.bottom },
    });
  };
  const close = (restoreFocus: boolean) => {
    setPlacement(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const toggle = () => (openRef.current ? close(false) : show());
  const actionsRef = useRef({ show, close });
  actionsRef.current = { show, close };

  // Handle ⌘O from the app-level shortcut dispatcher to open or close the menu.
  // Closing it returns focus to the trigger if focus was inside the menu.
  useEffect(
    () =>
      listenToResearchFolderMenuToggle(() => {
        if (!openRef.current) {
          actionsRef.current.show();
          return;
        }
        actionsRef.current.close(Boolean(document.activeElement?.closest(".research-menu")));
      }),
    [],
  );

  const scopedFolder = folders.find((folder) => folder.id === scope);
  const folderName = (folder: GroupInfo) => {
    const name = folder.nameOverride || folder.name;
    return name === "Default research" ? "Default workspace" : name;
  };
  const scopedName = scopedFolder ? folderName(scopedFolder) : null;

  function select(next: ResearchFolderScope) {
    close(true);
    onSelectScope(next);
  }

  const menu = placement ? (
    <ResearchMenu
      anchor={placement.anchor}
      align={strip ? "side" : "start"}
      trigger={placement.trigger}
      label="Research workspaces"
      width={MENU_WIDTH}
      footer={strip ? footer : undefined}
      onClose={() => close(false)}
    >
      {folders.map((folder, index) => (
        <ResearchMenuItem
          key={folder.id}
          icon={<Folder size={15} aria-hidden="true" />}
          label={folderName(folder)}
          detail={folder.dir}
          title={folder.dir}
          checked={scope === folder.id}
          trailing={
            <>
              {scope === folder.id ? (
                <Check className="research-menu-check" size={15} aria-hidden="true" />
              ) : null}
              {index > 0 ? (
                <span className="research-menu-count">{treeCounts.get(folder.id) ?? 0}</span>
              ) : null}
            </>
          }
          onSelect={() => select(folder.id)}
        />
      ))}
      <ResearchMenuSeparator />
      <ResearchMenuItem
        icon={<FolderPlus size={15} aria-hidden="true" />}
        label="Add workspace…"
        disabled={folderPickerBusy}
        onSelect={() => {
          close(true);
          void onNewFolder().then((workspace) => {
            if (workspace) {
              onSelectScope(workspace.id);
            }
          });
        }}
      />
      {scopedFolder ? (
        <>
          <ResearchMenuSeparator />
          <ResearchMenuItem
            icon={<Pencil size={15} aria-hidden="true" />}
            label={`Rename “${folderName(scopedFolder)}”…`}
            onSelect={() => {
              close(false);
              onRenameFolder(scopedFolder);
            }}
          />
          <ResearchMenuItem
            icon={<FolderOpen size={15} aria-hidden="true" />}
            label="Open in Finder"
            onSelect={() => {
              close(true);
              void onOpenFolder(scopedFolder);
            }}
          />
          <ResearchMenuItem
            icon={<FolderInput size={15} aria-hidden="true" />}
            label="Move workspace folder…"
            disabled={folderPickerBusy}
            onSelect={() => {
              close(true);
              void onMoveFolder(scopedFolder);
            }}
          />
          <ResearchMenuItem
            icon={<Trash2 size={15} aria-hidden="true" />}
            label="Remove workspace…"
            danger
            onSelect={() => {
              close(false);
              onRemoveFolder(scopedFolder);
            }}
          />
        </>
      ) : null}
    </ResearchMenu>
  ) : null;

  if (strip) {
    return (
      <div className="research-folder-switcher is-strip">
        <ResearchStripButton
          label={scopedName ? `Workspace: ${scopedName}` : "Choose a workspace"}
          description={`${scopedName ?? "Workspaces"} (⌘O)`}
          buttonRef={triggerRef}
          popup
          expanded={open}
          onClick={toggle}
        >
          <Folder size={16} aria-hidden="true" />
        </ResearchStripButton>
        {menu}
      </div>
    );
  }

  return (
    <div className="research-folder-switcher">
      <button
        ref={triggerRef}
        type="button"
        className="control-button research-folder-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={scopedFolder?.dir ?? "No research workspace selected"}
        onClick={toggle}
      >
        <Folder size={13} aria-hidden="true" />
        <span className="research-folder-trigger-copy">
          <span className="research-folder-trigger-name">{scopedName ?? "Choose a workspace"}</span>
          {scopedFolder ? <span className="research-folder-path">{scopedFolder.dir}</span> : null}
        </span>
        <ChevronDown size={13} aria-hidden="true" className={open ? "is-open" : undefined} />
      </button>
      {shortcutHintsShown ? (
        <span className="pane-tab-shortcut-hint research-folder-shortcut-hint" aria-hidden="true">
          ⌘O
        </span>
      ) : null}
      {menu}
    </div>
  );
}
