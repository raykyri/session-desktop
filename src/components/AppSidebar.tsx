import { memo, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Moon, PanelLeft, Settings, Sun } from "lucide-react";
import GithubAccountControl from "./GithubAccountControl";
import ResearchAgentsSwitcher from "./research/ResearchAgentsSwitcher";
import ResearchWorkspaceSwitcher from "./research/ResearchWorkspaceSwitcher";
import {
  ResearchRailButton,
  ResearchSidebarNav,
  ResearchSidebarRail,
} from "./research/ResearchSidebarNav";
import { IS_MAC } from "../lib/appHelpers";
import { RESEARCH_HOME_SHORTCUT_LABEL } from "../lib/appShortcuts";
import type { ResearchWorkspaceScope } from "../lib/researchScope";
import { SIDEBAR_MIN_WIDTH } from "../lib/sidebarLayout";
import type { ResearchFeedPage } from "../lib/sidebarMode";
import type { AgentAdapterMetadata, GroupInfo, ResearchFolder } from "../types";

export const SIDEBAR_TOGGLE_SHORTCUT_LABEL = "⇧⌘G";

interface AppSidebarProps {
  /** Shows the icon rail instead of the full sidebar. */
  rail: boolean;
  /** The rail is shown because the window is narrow. */
  forcedRail: boolean;
  width: number;
  maxWidth: number;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeKey: (event: KeyboardEvent<HTMLDivElement>) => void;
  onCollapse: () => void;
  onExpand: () => void;

  feedPage: ResearchFeedPage;
  folders: ResearchFolder[];
  foldersLoadError: string | null;
  onRetryFoldersLoad: () => void;
  onNavigate: (page: ResearchFeedPage) => void;
  onNewFolder: () => void;
  onRenameFolder: (folderId: string, trigger: HTMLElement) => void;
  onDeleteFolder: (folderId: string) => void;
  shortcutHintsShown: boolean;

  appearance: "light" | "dark";
  settingsOpen: boolean;
  onToggleAppearance: () => void;
  onOpenSettings: () => void;

  workspaces: GroupInfo[];
  workspaceScope: ResearchWorkspaceScope;
  workspaceTreeCounts: Map<string, number>;
  folderPickerBusy: boolean;
  onSelectWorkspace: (scope: ResearchWorkspaceScope) => void;
  onNewWorkspace: () => Promise<GroupInfo | null>;
  onOpenWorkspace: (workspace: GroupInfo) => Promise<void>;
  onRenameWorkspace: (workspace: GroupInfo) => void;
  onMoveWorkspace: (workspace: GroupInfo) => Promise<void>;
  onRemoveWorkspace: (workspace: GroupInfo) => void;

  adapters: readonly AgentAdapterMetadata[] | null;
  adaptersLoading: boolean;
  adaptersError: string | null;
  onOpenAgentSetup: (instanceId: string | null) => void;
  onRefreshAdapters: () => void;
}

/**
 * The left sidebar: the full sidebar with its resize handle, or the icon
 * rail. Both list the feed pages and folders and end with the workspace
 * switcher, the Agents module, the account control, appearance and Settings.
 * Memoized: App re-renders on every research event, and none of these props
 * change with run progress.
 */
function AppSidebar(props: AppSidebarProps) {
  const {
    rail,
    forcedRail,
    width,
    maxWidth,
    onResizeStart,
    onResizeKey,
    onCollapse,
    onExpand,
    feedPage,
    folders,
    foldersLoadError,
    onRetryFoldersLoad,
    onNavigate,
    onNewFolder,
    onRenameFolder,
    onDeleteFolder,
    shortcutHintsShown,
    appearance,
    settingsOpen,
    onToggleAppearance,
    onOpenSettings,
  } = props;
  // The workspace switcher, the Agents module and the account control sit at
  // the bottom of the full sidebar, in that order. In the rail the workspace
  // switcher is an icon whose menu opens as a popover with the account control
  // inside, so both (and ⌘O) stay reachable below 900px; the Agents icon
  // follows it.
  const workspaceSwitcher = (variant: "sidebar" | "rail", footer?: ReactNode) => (
    <ResearchWorkspaceSwitcher
      variant={variant}
      footer={footer}
      folders={props.workspaces}
      scope={props.workspaceScope}
      treeCounts={props.workspaceTreeCounts}
      folderPickerBusy={props.folderPickerBusy}
      shortcutHintsShown={shortcutHintsShown}
      onSelectScope={props.onSelectWorkspace}
      onNewFolder={props.onNewWorkspace}
      onOpenFolder={props.onOpenWorkspace}
      onRenameFolder={props.onRenameWorkspace}
      onMoveFolder={props.onMoveWorkspace}
      onRemoveFolder={props.onRemoveWorkspace}
    />
  );
  const agentsSwitcher = (variant: "sidebar" | "rail") => (
    <ResearchAgentsSwitcher
      variant={variant}
      adapters={props.adapters}
      loading={props.adaptersLoading}
      error={props.adaptersError}
      onOpenSetup={props.onOpenAgentSetup}
      onRefresh={props.onRefreshAdapters}
    />
  );

  if (rail) {
    return (
      <ResearchSidebarRail
        current={feedPage}
        folders={folders}
        forced={forcedRail}
        reserveTitlebar={IS_MAC}
        expandShortcut={SIDEBAR_TOGGLE_SHORTCUT_LABEL}
        onExpand={onExpand}
        onNavigate={onNavigate}
        onNewFolder={onNewFolder}
        footer={
          <>
            {workspaceSwitcher("rail", <GithubAccountControl />)}
            {agentsSwitcher("rail")}
            <ResearchRailButton
              label={appearance === "light" ? "Dark mode" : "Light mode"}
              onClick={onToggleAppearance}
            >
              {appearance === "light" ? (
                <Moon size={16} aria-hidden="true" />
              ) : (
                <Sun size={16} aria-hidden="true" />
              )}
            </ResearchRailButton>
            <ResearchRailButton label="Settings (⌘,)" selected={settingsOpen} onClick={onOpenSettings}>
              <Settings size={16} aria-hidden="true" />
            </ResearchRailButton>
          </>
        }
      />
    );
  }

  return (
    <>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
      />
      <aside className="sidebar is-research-mode">
        <div className="titlebar-drag" data-tauri-drag-region aria-hidden="true" />
        {/* Keep the collapse and expand buttons at the same position beside
            the traffic lights. */}
        <button
          type="button"
          className="icon-button sidebar-header-button sidebar-collapse-toggle"
          title={`Collapse sidebar to icons (${SIDEBAR_TOGGLE_SHORTCUT_LABEL})`}
          aria-label="Collapse sidebar"
          onClick={onCollapse}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>
        <div className="sidebar-header-controls">
          <button
            type="button"
            className={`icon-button sidebar-header-button${settingsOpen ? " is-active" : ""}`}
            aria-label="Settings"
            title="Settings (⌘,)"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onOpenSettings}
          >
            <Settings size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button sidebar-header-button"
            aria-label={appearance === "light" ? "Switch to dark mode" : "Switch to light mode"}
            aria-pressed={appearance === "light"}
            title={appearance === "light" ? "Dark mode" : "Light mode"}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onToggleAppearance}
          >
            {appearance === "light" ? (
              <Moon size={15} aria-hidden="true" />
            ) : (
              <Sun size={15} aria-hidden="true" />
            )}
          </button>
        </div>
        <div className="research-sidebar-body">
          <ResearchSidebarNav
            current={feedPage}
            folders={folders}
            onNavigate={onNavigate}
            onNewFolder={onNewFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            foldersLoadError={foldersLoadError}
            onRetryFoldersLoad={onRetryFoldersLoad}
            homeShortcutHint={shortcutHintsShown ? RESEARCH_HOME_SHORTCUT_LABEL : null}
          />
        </div>
        {workspaceSwitcher("sidebar")}
        {agentsSwitcher("sidebar")}
        <GithubAccountControl />
      </aside>
    </>
  );
}

export default memo(AppSidebar);
