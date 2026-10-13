import { useAppStartup } from "./hooks/useAppStartup";
import { useResearchNavigationState } from "./hooks/useResearchNavigationState";
import { useUserNotifications } from "./hooks/useUserNotifications";
import { useEditableFocusRestore } from "./hooks/useEditableFocusRestore";
import { useAppSettings } from "./hooks/useAppSettings";
import { useAdapterReadiness } from "./hooks/useAdapterReadiness";
import { useAppToast } from "./hooks/useAppToast";
import { researchBrowserOwnerId, useBrowserOverlays } from "./hooks/useBrowserOverlays";
import BrowserOverlayLayer from "./components/BrowserOverlayLayer";
import AgentSetupDialog from "./components/AgentSetupDialog";
import SettingsDialog from "./components/settings/SettingsDialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CSSProperties,
} from "react";
import {
  LoaderCircle,
  X,
} from "lucide-react";
import {
  adapterCanLaunchResearch,
} from "./lib/adapterReadiness";
import CommandPalette, { type PaletteCommand } from "./components/CommandPalette";
import AgentSetupGuide from "./components/AgentSetupGuide";
import ImageLightbox from "./components/ImageLightbox";
import {
  getImageLightbox,
  subscribeImageLightbox,
} from "./lib/imageLightbox";
import DiagramLightbox from "./components/DiagramLightbox";
import {
  getDiagramLightbox,
  subscribeDiagramLightbox,
} from "./lib/diagramLightbox";
import {
  UserNotificationStack,
} from "./components/UserNotificationStack";
import {
  resolveResearchScope,
} from "./lib/researchScope";
import ResearchThreadPage, { type ResearchThreadTreeMenu } from "./components/research/ResearchThreadPage";
import { ResearchInlineWidgetsContext } from "./components/research/ResearchMessage";
import {
  ResearchAgentRepairContext,
  type ResearchAgentRepair,
} from "./components/research/ResearchSignInRepair";
import ResearchDraftView from "./components/research/ResearchDraftView";
import { researchImageBlockReason } from "./lib/researchImages";
import ResearchActivityFeed from "./components/research/ResearchActivityFeed";
import ResearchColumns from "./components/research/ResearchColumns";
import { ResearchEmptyContent } from "./components/research/ResearchColumnChrome";
import ResearchHighlightsFeed from "./components/research/ResearchHighlightsFeed";
import { useActivityFeedState } from "./hooks/useActivityFeedState";
import ResearchQueryComposer, {
  type ComposerFocusRequest,
  type ResearchLaunchChoice,
} from "./components/research/ResearchQueryComposer";
import {
  IS_MAC,
} from "./lib/appHelpers";
import {
  RESEARCH_HOME_SHORTCUT_LABEL,
} from "./lib/appShortcuts";
import { useSessionEvents } from "./hooks/useSessionEvents";
import {
  APP_TEXT_SIZE,
} from "./lib/appearance";
import {
  researchFeedCardNodeId,
} from "./lib/researchNavigation";
import {
  groupsForScope,
  researchAttention,
} from "./lib/workspaceScope";
import {
  type ResearchFeedView,
  type ResearchFeedPage,
} from "./lib/sidebarMode";
import {
  RESEARCH_DRAFTS_FOLDER_ID,
  researchTreePlace,
  treesWithWorkspaceOrder,
  type ResearchDropPosition,
} from "./lib/researchFolders";
import { useResearchToast } from "./hooks/useResearchToast";
import { useResearchData } from "./hooks/useResearchData";
import { useResearchNavigation } from "./hooks/useResearchNavigation";
import { useResearchEvents } from "./hooks/useResearchEvents";
import { useResearchActions } from "./hooks/useResearchActions";
import { useResearchHighlights } from "./hooks/useResearchHighlights";
import { useResearchFolderDialogs } from "./hooks/useResearchFolderDialogs";

import { useAppShortcuts, useEscapeDispatcher, useShortcutHintsVisible } from "./hooks/useAppKeyboard";

import { useResearchWorkspaces } from "./hooks/useResearchWorkspaces";

import { useSidebarLayout } from "./hooks/useSidebarLayout";
import AppSidebar, { SIDEBAR_TOGGLE_SHORTCUT_LABEL } from "./components/AppSidebar";

import { useSessionProcesses } from "./hooks/useSessionProcesses";
import { useQuitFlow } from "./hooks/useQuitFlow";
import QuitDialog from "./components/QuitDialog";
import {
  ResearchWorkspaceRemovalDialog,
  ResearchWorkspaceRenameDialog,
} from "./components/research/ResearchWorkspaceDialogs";

import { useResearchFiling } from "./hooks/useResearchFiling";
import { useResearchDrafts } from "./hooks/useResearchDrafts";
import { useResearchCardDrag } from "./hooks/useResearchCardDrag";
import { useResearchGroupActions } from "./hooks/useResearchGroupActions";
import { researchTreeGroups } from "./lib/researchGroups";
import { researchThreadKind, researchThreadState } from "./lib/researchRowGlyph";
import type { ResearchThreadGroup } from "./components/research/ResearchGroupPanel";
import {
  ResearchFolderNameDialog,
} from "./components/research/ResearchFolderDialogs";
import { ResearchFeedToast } from "./components/research/ResearchFeedChrome";
import {
  ResearchTreeDeleteDialog,
  ResearchTreeDeleteOfferDialog,
} from "./components/research/ResearchTreeMenu";
import { researchTreeContents, type ResearchTreeContents } from "./lib/researchTreeContents";
import { emptyResearchTrash } from "./lib/api";
import { researchTrashEntries, type ResearchTrashEntry } from "./lib/researchTrash";
import { useResearchTrash } from "./hooks/useResearchTrash";
import type {
  AgentAdapterMetadata,
  ResearchDraft,
  ResearchImageAttachment,
  RuntimeConfig,
} from "./types";

const BROWSER_OVERLAY_LEFT_MARGIN = 64;
const NO_ADAPTERS: AgentAdapterMetadata[] = [];

function MainApp() {
  const appRef = useRef<HTMLDivElement | null>(null);

  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const {
    loading: adapterProbeLoading,
    error: adapterProbeError,
    setError: setAdapterProbeError,
    refresh: refreshAdapterReadiness,
    forceRefresh: forceRefreshAdapterReadiness,
  } = useAdapterReadiness(config, setConfig);

  const researchData = useResearchData();
  const {
    researchTrees,
    setResearchTrees,
    researchTreesRef,
    archivedResearchTrees,
    archivedResearchTreesRef,
    researchActivity,
    recentActivityItems,
    recapPendingNodeIds,
    activeResearchTreeId,
    activeResearchTreeIdRef,
    activeResearchDetail,
    activeResearchDetailRef,
    activeResearchDetailError,
  } = researchData;
  // After "Ask as a question": the offer to delete the edited thread, then
  // the delete confirmation for it.
  const [researchDeleteOffer, setResearchDeleteOffer] = useState<{
    treeId: string;
    newTreeId: string;
    contents: ResearchTreeContents;
  } | null>(null);
  const [researchOfferDeletingTreeId, setResearchOfferDeletingTreeId] = useState<string | null>(null);
  const activityFeedState = useActivityFeedState();
  const researchNavigationState = useResearchNavigationState();
  const {
    researchWorkspaceScope,
    changeResearchWorkspaceScope,
  } = researchNavigationState;
  const sidebar = useSidebarLayout(appRef);
  const { toggle: toggleSidebar } = sidebar;
  const [error, setError] = useState<string | null>(null);
  const {
    settings,
    setSettings,
    availableBodyFonts,
    bodyFontFamily,
    toggleAppearance,
    applyStoredPreferences,
  } = useAppSettings(setError);
  const {
    groups,
    setGroups,
    groupsRef,
    setAgents,
    hydrateAgents,
  } = useSessionProcesses(settings.preventSleep);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSettings = useCallback(() => {
    setAgentsOpen(false);
    setSettingsOpen(true);
  }, []);
  const [agentsOpen, setAgentsOpen] = useState(false);
  // The agent instance the Agent Setup dialog opens on; null selects the first
  // agent whose setup is incomplete.
  const [agentSetupInstanceId, setAgentSetupInstanceId] = useState<string | null>(null);
  // Where Agent Setup was opened: from the research composer (whose question
  // stays in place under the dialog) or from elsewhere (sidebar, palette).
  const agentSetupOriginRef = useRef<"composer" | "other">("other");
  // A request for the feed's research composer to select an agent (when
  // `adapterId` is set) and take focus. The composer clears it once applied;
  // `seq` distinguishes repeated requests for the same agent.
  const [composerFocusRequest, setComposerFocusRequest] = useState<ComposerFocusRequest | null>(
    null,
  );
  const requestComposerFocus = useCallback((adapterId: string | null) => {
    setComposerFocusRequest((current) => ({ seq: (current?.seq ?? 0) + 1, adapterId }));
  }, []);
  const clearComposerFocusRequest = useCallback((seq: number) => {
    setComposerFocusRequest((current) => (current?.seq === seq ? null : current));
  }, []);
  const openAgentSetup = useCallback(
    (instanceId: string | null = null, origin: "composer" | "other" = "other") => {
      setSettingsOpen(false);
      agentSetupOriginRef.current = origin;
      setAgentSetupInstanceId(instanceId);
      setAgentsOpen(true);
    },
    [],
  );
  const openAgentSetupFromComposer = useCallback(
    (instanceId: string | null) => openAgentSetup(instanceId, "composer"),
    [openAgentSetup],
  );
  // Closing setup opened from the composer returns focus to its question.
  const closeAgentSetup = useCallback(() => {
    setAgentsOpen(false);
    if (agentSetupOriginRef.current === "composer") requestComposerFocus(null);
  }, [requestComposerFocus]);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const errorDismissRef = useRef<HTMLButtonElement | null>(null);
  // If an error appears after its triggering control was removed (for
  // example, a toast's Undo button), focus the error banner's Dismiss button.
  useEffect(() => {
    if (!error) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        errorDismissRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [error]);
  const { appToast, showAppToast } = useAppToast();
  const { userNotifications, handleUserNotificationRequested, dismissUserNotification } =
    useUserNotifications({ settings });
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const researchGroups = useMemo(() => groupsForScope(groups, "research"), [groups]);
  const researchScope = useMemo(
    () => resolveResearchScope(researchWorkspaceScope, researchGroups),
    [researchWorkspaceScope, researchGroups],
  );
  const researchScopeRef = useRef(researchScope);
  researchScopeRef.current = researchScope;
  const navigation = useResearchNavigation(researchData, researchNavigationState, researchScope);
  const {
    researchStageView,
    refreshResearchNavigation,
    navigateToResearchThread,
    openResearchNode,
    openRecentResearchQuery,
    openResearchHighlight,
    handleResearchRecapApplied,
    loadActivityForTrees,
    retryActiveResearchDetail,
    focusResearchHome,
    goResearchBack,
    goResearchForward,
    reportResearchNavigation,
    pruneResearchNodeVisits,
    researchHistoryNav,
    hydrateResearch,
  } = navigation;
  const workspaces = useResearchWorkspaces(researchData, navigation, {
    groups,
    setGroups,
    groupsRef,
    config,
    researchScope,
    changeResearchWorkspaceScope,
    setError,
  });
  const {
    folderPickerStatus,
    renameRequest,
    removal: researchFolderRemoval,
    removing: removingResearchFolder,
    closeRemoval: closeResearchFolderRemoval,
  } = workspaces;
  const renameGroupId = renameRequest?.groupId ?? null;
  // Menu badges and the folder-replace dialog count every tree that references
  // a folder, including archived trees that prevent removal.
  const researchFolderTreeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tree of [...researchTrees, ...archivedResearchTrees]) {
      counts.set(tree.workspaceId, (counts.get(tree.workspaceId) ?? 0) + 1);
    }
    return counts;
  }, [archivedResearchTrees, researchTrees]);
  const researchAttentionState = useMemo(() => researchAttention(researchTrees), [researchTrees]);
  const runningResearchCount = researchAttentionState.runningCount;
  const {
    exitDialog,
    quitting,
    exitPreflightRequest,
    setExitPreflightRequest,
    confirmExit,
    cancelExit,
  } = useQuitFlow({ runningResearchCount, researchActivity, onError: setError });
  // A research thread's relative local links resolve against its workspace
  // folder, as the backend resolves them.
  const researchOwnerWorkingDir = useCallback(
    (ownerId: string) => {
      const tree = [...researchTrees, ...archivedResearchTrees].find(
        (candidate) => researchBrowserOwnerId(candidate.id) === ownerId,
      );
      return tree ? (groupById.get(tree.workspaceId)?.dir ?? null) : null;
    },
    [archivedResearchTrees, groupById, researchTrees],
  );
  const browser = useBrowserOverlays({
    researchTrees,
    archivedResearchTrees,
    activeOwnerId: activeResearchTreeId ? researchBrowserOwnerId(activeResearchTreeId) : null,
    ownerWorkingDir: researchOwnerWorkingDir,
    fileServerPort: config?.fileServerPort ?? null,
    onError: setError,
  });
  const { toggleSourceBrowser } = browser;
  const imageLightbox = useSyncExternalStore(
    subscribeImageLightbox,
    getImageLightbox,
    getImageLightbox,
  );
  // Subscribe to the diagram lightbox's module store so the native input
  // policy below includes its open state, as it does for the image lightbox.
  const diagramLightbox = useSyncExternalStore(
    subscribeDiagramLightbox,
    getDiagramLightbox,
    getDiagramLightbox,
  );
  // Hide the native browser view while an app-level dialog or menu is open;
  // native views render above the webview.
  const nativeModalOccluded = Boolean(
    settingsOpen ||
      agentsOpen ||
      imageLightbox !== null ||
      diagramLightbox !== null ||
      commandPaletteOpen ||
      researchFolderRemoval ||
      exitDialog ||
      exitPreflightRequest ||
      renameGroupId ||
      browser.linkMenu,
  );
  const nativeBrowserOccluded = Boolean(
    nativeModalOccluded || appToast || userNotifications.length > 0 || folderPickerStatus,
  );

  // Preserve the existing bounded research/transcript text zoom.
  const turnFontDelta = Math.min(1, Math.max(0, (settings.textSize - APP_TEXT_SIZE) * 0.25));

  const appStyle = {
    "--font-ui": bodyFontFamily,
    "--sidebar-width": `${sidebar.effectiveWidth}px`,
    "--browser-overlay-left": `${BROWSER_OVERLAY_LEFT_MARGIN}px`,
    "--turn-font-delta": `${turnFontDelta}px`,
  } as CSSProperties;

  useAppStartup({
    applySecondary: applyStoredPreferences,
    applyInitial: async ({ runtimeConfig, existingGroups,
      existingAgents, existingResearchTrees, existingResearchActivity,
      existingRecentActivity }, isCancelled) => {
      setConfig(runtimeConfig);
      setGroups(existingGroups);
      hydrateAgents(existingAgents);
      const restoreResearchSelection = hydrateResearch({
        trees: existingResearchTrees,
        activity: existingResearchActivity,
        recentActivity: existingRecentActivity,
        groups: existingGroups,
      });
      if (!isCancelled()) {
        await restoreResearchSelection(isCancelled);
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  // Which list the feed column shows: Home, Highlights, Drafts,
  // Archive, or a user folder. Switching lists keeps the open thread.
  const [feedPage, setFeedPage] = useState<ResearchFeedPage>({ kind: "home" });
  const openFeedPage = useCallback((view: ResearchFeedPage) => {
    setFeedPage(view);
  }, []);
  // Folders, drafts, and moving questions between them. Toasts confirm moves
  // with Undo; drags run on pointer events shared by feed, sidebar, and rail.
  const {
    toast: researchToast,
    showToast: showResearchToast,
    dismissToast: dismissResearchToast,
    undoToast: undoResearchToast,
    pauseToast: pauseResearchToast,
    resumeToast: resumeResearchToast,
  } = useResearchToast();
  const applyResearchTreeOrder = useCallback((workspaceId: string, treeIds: string[]) => {
    setResearchTrees((current) => treesWithWorkspaceOrder(current, workspaceId, treeIds));
  }, []);
  const refreshResearchTreesAfterFiling = useCallback(() => {
    void refreshResearchNavigation().catch(() => undefined);
  }, [refreshResearchNavigation]);
  const researchFiling = useResearchFiling({
    workspaceId: researchScope,
    activeTreesRef: researchTreesRef,
    archivedTreesRef: archivedResearchTreesRef,
    applyTreeOrder: applyResearchTreeOrder,
    refreshTrees: refreshResearchTreesAfterFiling,
    onError: setError,
    showToast: showResearchToast,
  });
  const {
    folderState: researchFolderState,
    folders: researchFolders,
    setTrayCollapsed: setResearchTrayCollapsed,
    fileNewTree: fileNewResearchTree,
    refreshFolders: refreshResearchFolders,
    foldersLoadError: researchFoldersLoadError,
    retryFoldersLoad: retryResearchFoldersLoad,
    setFolderTrashed: setResearchFolderTrashed,
    deleteFolders: deleteResearchFolders,
    moveOutOfGroup: moveResearchTreeOutOfGroup,
    setGroupsCollapsed: setResearchGroupsCollapsed,
  } = researchFiling;
  const {
    drafts: researchDrafts,
    refreshDrafts: refreshResearchDrafts,
    saveDraft: saveResearchDraftText,
    removeDraft: removeResearchDraft,
    deleteDraft: deleteResearchDraftEntry,
    moveDraft: moveResearchDraft,
  } = useResearchDrafts(researchScope, setError);
  const researchFolderStateRef = useRef(researchFolderState);
  researchFolderStateRef.current = researchFolderState;
  const toggleResearchTray = useCallback(
    (place: string) =>
      setResearchTrayCollapsed(place, !researchFolderStateRef.current.collapsed.includes(place)),
    [setResearchTrayCollapsed],
  );
  const {
    nameRequest: researchFolderNameRequest,
    openNew: openNewResearchFolderDialog,
    openRename: openRenameResearchFolderDialog,
    closeName: closeResearchFolderNameDialog,
    submitName: submitResearchFolderName,
    pendingDelete: pendingResearchFolderDelete,
    requestDelete: requestResearchFolderDelete,
    confirmDelete: confirmResearchFolderDelete,
    deleteNow: deleteResearchFolderNow,
    cancelDelete: cancelResearchFolderDelete,
  } = useResearchFolderDialogs({
    filing: researchFiling,
    showToast: showResearchToast,
    openFeedPage,
    researchTreesRef,
    archivedResearchTreesRef,
  });
  const researchHighlights = useResearchHighlights(feedPage.kind === "highlights", setError);
  const invalidateResearchHighlights = researchHighlights.invalidate;
  const researchTrash = useResearchTrash(setError);
  const handleResearchEvent = useResearchEvents(researchData, navigation, {
    refreshResearchDrafts,
    refreshResearchFolders,
    refreshResearchTrash: researchTrash.refresh,
    invalidateResearchHighlights,
  });
  const {
    submitNewResearch,
    submitNewPost,
    importReport,
    editResearchDocument,
    editResearchPost,
    cancelResearchRun,
    renameResearchTreeTitle,
    removeResearchTreeAndSelectFallback,
    trashResearchTreeAndSelectFallback,
    createResearchFollowup,
    retryResearchRun,
    rerunResearchRun,
    postActions,
    removeResearchBranchFromThread,
  } = useResearchActions(researchData, navigation, {
    groups,
    setGroups,
    config,
    researchScope,
    refreshAdapterReadiness,
    setError,
  });

  // The thread page's toasts use the research toast: its live region is
  // mounted before any text arrives, and it pauses under the pointer or focus.
  const handleResearchThreadToast = useCallback(
    (message: string, tone?: "normal" | "warning") =>
      showResearchToast(message, tone === "warning" ? { tone: "warning" } : {}),
    [showResearchToast],
  );

  // A parent's children go with it when it is archived, moved to the Trash,
  // deleted or restored (see useResearchGroupActions).
  const researchGroupActions = useResearchGroupActions({
    filing: researchFiling,
    activeTreesRef: researchTreesRef,
    archivedTreesRef: archivedResearchTreesRef,
    trashedTrees: researchTrash.trees,
    trashTree: trashResearchTreeAndSelectFallback,
    removeTree: removeResearchTreeAndSelectFallback,
    onError: setError,
    showToast: showResearchToast,
  });
  const {
    groupChildren: researchGroupChildren,
    moveTree: moveResearchTreeOrGroup,
    nestTree: nestResearchTree,
    trashGroup: trashResearchTreeWithUndo,
    removeGroup: removeResearchGroup,
    unarchiveGroup: unarchiveResearchGroup,
    restoreGroupFromTrash: restoreResearchGroupFromTrash,
  } = researchGroupActions;
  // Delete now from a feed menu or the delete offer: the thread and its
  // children. A failure is shown and keeps the dialog open.
  const removeResearchGroupFromMenu = useCallback(
    async (treeId: string) => {
      setError(null);
      try {
        await removeResearchGroup(treeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [removeResearchGroup],
  );
  const startResearchCardDrag = useResearchCardDrag({
    onMoveTree: (treeId, place, position) => moveResearchTreeOrGroup(treeId, place, position),
    onNestTree: (treeId, parentId, beforeId) => nestResearchTree(treeId, parentId, beforeId),
    onMoveDraft: (draftId, beforeId) => void moveResearchDraft(draftId, beforeId),
    onSpringOpen: (place) => setResearchTrayCollapsed(place, false),
    onSpringOpenGroup: (parentId) => setResearchGroupsCollapsed([parentId], false),
  });
  // The scoped workspace's Trash: its trees and its folders.
  const researchTrashItems = useMemo(
    () => researchTrashEntries(researchTrash.trees, researchFolderState.folders, researchScope),
    [researchFolderState.folders, researchScope, researchTrash.trees],
  );
  const restoreResearchTrashEntry = useCallback(
    (entry: ResearchTrashEntry) => {
      const restore =
        entry.kind === "tree"
          ? restoreResearchGroupFromTrash(entry.id)
          : setResearchFolderTrashed(entry.id, false);
      void restore.then(
        () => showResearchToast("Restored."),
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      );
    },
    [restoreResearchGroupFromTrash, setResearchFolderTrashed, showResearchToast],
  );
  // Permanent deletion from the Trash, with the children in the Trash of a
  // parent. Rejections keep the dialog open.
  const deleteResearchTrashEntry = useCallback(
    async (entry: ResearchTrashEntry) => {
      if (entry.kind === "tree") await removeResearchGroup(entry.id);
      else await deleteResearchFolders([entry.id]);
    },
    [deleteResearchFolders, removeResearchGroup],
  );
  const emptyResearchTrashNow = useCallback(async () => {
    if (!researchScope) return;
    const folderIds = researchTrashItems
      .filter((entry) => entry.kind === "folder")
      .map((entry) => entry.id);
    await emptyResearchTrash(researchScope);
    if (folderIds.length > 0) await deleteResearchFolders(folderIds);
  }, [deleteResearchFolders, researchScope, researchTrashItems]);

  // The ⌘K palette's command list, rebuilt on each open from live state:
  // research threads and app actions.
  function buildPaletteCommands(): PaletteCommand[] {
    const commands: PaletteCommand[] = researchTrees.map((tree) => ({
      id: `research:${tree.id}`,
      section: "Research",
      title: tree.title,
      hint: tree.runningCount > 0 ? `${tree.runningCount} running` : undefined,
      action: () => navigateToResearchThread(tree.id),
    }));
    commands.push(
      {
        id: "action:home",
        section: "Actions",
        title: "Home",
        hint: RESEARCH_HOME_SHORTCUT_LABEL,
        action: focusResearchHome,
      },
      {
        id: "action:toggle-left-sidebar",
        section: "Actions",
        title: "Toggle sidebar",
        hint: SIDEBAR_TOGGLE_SHORTCUT_LABEL,
        action: toggleSidebar,
      },
      {
        id: "action:settings",
        section: "Actions",
        title: "Open Settings",
        hint: "⌘,",
        action: openSettings,
      },
      {
        id: "action:agents",
        section: "Actions",
        title: "Open Agents",
        action: () => openAgentSetup(),
      },
    );
    return commands;
  }

  const openNewResearchFolderFromSidebar = useCallback(
    () => openNewResearchFolderDialog(),
    [openNewResearchFolderDialog],
  );

  useEditableFocusRestore();
  const dismissError = useCallback(() => setError(null), []);
  const dispatchBrowserEscape = useEscapeDispatcher(
    {
      researchFolderRemoval,
      exitDialog,
      renameGroupId,
      removingResearchFolder,
      settingsOpen,
      agentsOpen,
      error,
    },
    {
      closeBrowserOnEscape: browser.closeOnEscape,
      closeResearchFolderRemoval,
      cancelExit,
      closeSettings,
      closeAgentSetup,
      dismissError,
    },
  );
  const shortcutHintsVisible = useShortcutHintsVisible();
  const shortcutHintsShown = settings.showShortcutHints && shortcutHintsVisible;
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const handleNativeAppShortcut = useAppShortcuts({
    focusResearchHome,
    toggleSidebar,
    openSettings,
    openCommandPalette,
    toggleSourceBrowser,
  });

  useSessionEvents({
    setExitPreflightRequest,
    setAgents,
    setGroups,
    openBrowserOverlay: browser.openBrowserOverlay,
    onAppShortcut: handleNativeAppShortcut,
    onBrowserEscapeRequested: () => {
      dispatchBrowserEscape();
    },
    onResearchChanged: handleResearchEvent,
    onUserNotificationRequested: handleUserNotificationRequested,
  });

  // A note double-clicked in the feed. The double-click's first click opened
  // its thread at the note; the thread page edits it once it has the tree's
  // detail, and clears the request. A request for a tree that is no longer
  // open is dropped.
  const [researchNoteEditRequest, setResearchNoteEditRequest] = useState<{
    treeId: string;
    nodeId: string;
  } | null>(null);
  const editResearchNoteFromFeed = useCallback(
    (treeId: string, nodeId: string) => setResearchNoteEditRequest({ treeId, nodeId }),
    [],
  );
  const shownResearchNoteEditRequest =
    researchStageView === "thread" && researchNoteEditRequest?.treeId === activeResearchTreeId
      ? researchNoteEditRequest
      : null;
  useEffect(() => {
    setResearchNoteEditRequest((current) =>
      current && current.treeId !== activeResearchTreeId ? null : current,
    );
  }, [activeResearchTreeId]);

  // Opening a card whose root isn't in the loaded feed (Archive, or a folder
  // member paged out of it) keeps the list in the feed column beside the thread.
  // Opening a card (click or Enter) selects its question in the column that
  // lists it and clears any selection after it, including when the thread is
  // already open and for archived threads. A thread already showing that
  // selection is left unchanged.
  const openFeedResearchTree = useCallback(
    (treeId: string) => {
      const rootNodeId = researchFeedCardNodeId([...researchTrees, ...archivedResearchTrees], treeId);
      if (rootNodeId) openResearchNode(treeId, rootNodeId);
      else navigateToResearchThread(treeId);
    },
    [archivedResearchTrees, navigateToResearchThread, openResearchNode, researchTrees],
  );
  const openFeedView = useCallback(
    (view: ResearchFeedView) => {
      cancelResearchFolderDelete();
      openFeedPage(view);
    },
    [cancelResearchFolderDelete, openFeedPage],
  );
  const moveResearchTreeFromFeed = useCallback(
    (treeId: string, place: string) => moveResearchTreeOrGroup(treeId, place),
    [moveResearchTreeOrGroup],
  );
  const reorderResearchTreeFromFeed = useCallback(
    (treeId: string, place: string, position: ResearchDropPosition) =>
      moveResearchTreeOrGroup(treeId, place, position),
    [moveResearchTreeOrGroup],
  );
  const moveResearchDraftFromFeed = useCallback(
    (draftId: string, beforeId: string | null) => void moveResearchDraft(draftId, beforeId),
    [moveResearchDraft],
  );
  // The open question's Move to, listed in its root answer menus with the
  // same state as its feed row's menu.
  const activeResearchTreeSummary = useMemo(
    () =>
      activeResearchTreeId
        ? (researchTrees.find((tree) => tree.id === activeResearchTreeId) ??
          archivedResearchTrees.find((tree) => tree.id === activeResearchTreeId) ??
          null)
        : null,
    [activeResearchTreeId, researchTrees, archivedResearchTrees],
  );
  const activeResearchTreeState =
    activeResearchTreeSummary ??
    (activeResearchDetail?.tree.id === activeResearchTreeId ? activeResearchDetail?.tree : null) ??
    null;
  const activeResearchTreeMenu = useMemo<ResearchThreadTreeMenu | undefined>(() => {
    const tree = activeResearchTreeState;
    if (!tree) return undefined;
    return {
      currentPlace: researchTreePlace(tree, researchFolderState),
      folders: researchFolders,
      onMove: (place) => moveResearchTreeFromFeed(tree.id, place),
      onNewFolder: (trigger) => openNewResearchFolderDialog(tree.id, trigger),
    };
  }, [
    activeResearchTreeState,
    researchFolderState,
    researchFolders,
    moveResearchTreeFromFeed,
    openNewResearchFolderDialog,
  ]);
  // The open thread's Home group, for "In this group" above its messages:
  // kept as the same object while its contents are unchanged, so the
  // memoized thread page does not re-render for unrelated tree updates.
  const activeResearchGroupRef = useRef<ResearchThreadGroup | null>(null);
  const activeResearchGroup = useMemo(() => {
    const tree = researchTrees.find((candidate) => candidate.id === activeResearchTreeId);
    let next: ResearchThreadGroup | null = null;
    if (tree && tree.archivedAt == null) {
      const place = researchTreePlace(tree, researchFolderState);
      const listed = researchTrees.filter(
        (candidate) =>
          candidate.workspaceId === tree.workspaceId &&
          candidate.archivedAt == null &&
          researchTreePlace(candidate, researchFolderState) === place,
      );
      const group = researchTreeGroups(listed, researchFolderState.parents).find(
        (candidate) =>
          candidate.tree.id === tree.id || candidate.children.some((child) => child.id === tree.id),
      );
      if (group && group.children.length > 0) {
        next =
          group.tree.id === tree.id
            ? {
                parent: null,
                children: group.children.map((child) => ({
                  id: child.id,
                  title: child.title,
                  kind: researchThreadKind(child, undefined),
                  state: researchThreadState(child, undefined),
                  unread: child.hasUnseenUpdate,
                })),
              }
            : { parent: { id: group.tree.id, title: group.tree.title }, children: [] };
      }
    }
    const previous = activeResearchGroupRef.current;
    if (previous && next && JSON.stringify(previous) === JSON.stringify(next)) return previous;
    activeResearchGroupRef.current = next;
    return next;
  }, [activeResearchTreeId, researchFolderState, researchTrees]);
  // Opening a thread from "In this group" expands its group in Home.
  const openResearchGroupTree = useCallback(
    (treeId: string) => {
      const parentId = researchFolderStateRef.current.parents[treeId];
      if (parentId) setResearchGroupsCollapsed([parentId], false);
      openFeedResearchTree(treeId);
    },
    [openFeedResearchTree, setResearchGroupsCollapsed],
  );
  // Open a draft beside the current feed view. Opening a thread closes it.
  const [openResearchDraftId, setOpenResearchDraftId] = useState<string | null>(null);
  const openResearchDraft =
    researchDrafts.find((draft) => draft.id === openResearchDraftId) ?? null;
  useEffect(() => {
    if (activeResearchTreeId) setOpenResearchDraftId(null);
  }, [activeResearchTreeId]);
  const openResearchDraftInColumn = useCallback(
    (draft: ResearchDraft) => {
      if (activeResearchTreeIdRef.current) focusResearchHome();
      setOpenResearchDraftId(draft.id);
    },
    [focusResearchHome],
  );
  const saveOpenResearchDraft = useCallback(
    async (draft: ResearchDraft, prompt: string, images?: ResearchImageAttachment[]) => {
      await saveResearchDraftText(draft.id, prompt, draft.workspaceId, images);
    },
    [saveResearchDraftText],
  );
  const deleteResearchDraftFromFeed = useCallback(
    (draft: ResearchDraft) => {
      setOpenResearchDraftId((current) => (current === draft.id ? null : current));
      void removeResearchDraft(draft.id).then((deleted) => {
        if (deleted) showResearchToast("Draft deleted.");
      });
    },
    [removeResearchDraft, showResearchToast],
  );

  const renamingGroup = renameGroupId ? groupById.get(renameGroupId) : undefined;
  const renamingResearchFolder =
    renamingGroup?.scope === "research" ? renamingGroup : undefined;

  // Keep Home mounted beside open threads. Stable props prevent streamed
  // thread updates from rerendering the memoized feed.
  const feedResearchTrees = useMemo(
    () => [...researchTrees, ...archivedResearchTrees],
    [researchTrees, archivedResearchTrees],
  );
  // A question submitted from a user folder's view is filed in that folder; from
  // any other list it goes to Unfiled.
  const composerFolderId = feedPage.kind === "folder" ? feedPage.folderId : null;
  const composerFolderName = composerFolderId
    ? researchFolders.find((folder) => folder.id === composerFolderId)?.name
    : undefined;
  const submitFeedResearch = useCallback(
    async (input: Parameters<typeof submitNewResearch>[0]) => {
      const treeId = await submitNewResearch(input);
      if (composerFolderId) fileNewResearchTree(treeId, composerFolderId);
    },
    [composerFolderId, fileNewResearchTree, submitNewResearch],
  );
  const submitFeedPost = useCallback(
    async (input: Parameters<typeof submitNewPost>[0]) => {
      const treeId = await submitNewPost(input);
      if (composerFolderId) fileNewResearchTree(treeId, composerFolderId);
    },
    [composerFolderId, fileNewResearchTree, submitNewPost],
  );
  const saveComposerDraft = useCallback(
    async (prompt: string, images: ResearchImageAttachment[]) => {
      await saveResearchDraftText(null, prompt, undefined, images);
      setResearchTrayCollapsed(RESEARCH_DRAFTS_FOLDER_ID, false);
      showResearchToast(
        <span>
          Saved to <b>Drafts</b>.
        </span>,
      );
    },
    [saveResearchDraftText, setResearchTrayCollapsed, showResearchToast],
  );
  // Send the draft with the composer's current agent and model, then delete
  // it. The new question is filed in Unfiled. If deletion fails after sending,
  // report that error without rejecting the successful send.
  const composerLaunchChoiceRef = useRef<(() => ResearchLaunchChoice | null) | null>(null);
  const sendResearchDraft = useCallback(
    async (draft: ResearchDraft, prompt: string, images: ResearchImageAttachment[]) => {
      const choice = composerLaunchChoiceRef.current?.();
      if (!choice) {
        throw new Error("No research agent is ready. Review agents in Settings.");
      }
      const imageBlock = researchImageBlockReason(
        choice.adapter,
        config?.adapters.find((adapter) => adapter.id === choice.adapter)?.label,
        images,
      );
      if (imageBlock) throw new Error(imageBlock);
      await submitNewResearch({ prompt, ...choice, workspaceId: draft.workspaceId, images });
      setOpenResearchDraftId((current) => (current === draft.id ? null : current));
      try {
        await deleteResearchDraftEntry(draft.id);
      } catch (err) {
        setError(
          `The question was sent, but its draft couldn't be deleted. ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      showResearchToast(
        <span>
          Sent. Moved from Drafts to <b>Unfiled</b>.
        </span>,
      );
    },
    [config?.adapters, deleteResearchDraftEntry, showResearchToast, submitNewResearch],
  );
  // "Ask as a question" in the editor column: a new thread with the edited
  // text, asked with the agent, model and effort chosen in the editor's
  // footer (which starts from the Home ask box's selection), in the edited
  // thread's folder. It opens selected.
  // Once the new thread exists, a dialog offers to delete the edited thread
  // (see ResearchTreeDeleteOfferDialog), counted from its nodes as they were
  // when the question was asked.
  const askResearchEditorQuestion = useCallback(
    async (prompt: string, choice: ResearchLaunchChoice) => {
      const origin = activeResearchDetailRef.current;
      const workspaceId = origin?.tree.workspaceId ?? researchScopeRef.current;
      const newTreeId = await submitNewResearch({ prompt, ...choice, workspaceId });
      const contents = origin ? researchTreeContents(origin.nodes, origin.tree.rootNodeId) : null;
      if (origin && contents) {
        setResearchDeleteOffer({ treeId: origin.tree.id, newTreeId, contents });
      }
    },
    [submitNewResearch],
  );
  // The offer and the delete confirmation it opens apply only while the
  // original thread is listed and not archived; otherwise they are skipped.
  const researchDeleteOfferTree = researchDeleteOffer
    ? researchTrees.find((tree) => tree.id === researchDeleteOffer.treeId)
    : undefined;
  const researchOfferDeletingTree = researchOfferDeletingTreeId
    ? researchTrees.find((tree) => tree.id === researchOfferDeletingTreeId)
    : undefined;
  useEffect(() => {
    if (researchDeleteOffer && !researchDeleteOfferTree) setResearchDeleteOffer(null);
  }, [researchDeleteOffer, researchDeleteOfferTree]);
  useEffect(() => {
    if (researchOfferDeletingTreeId && !researchOfferDeletingTree) setResearchOfferDeletingTreeId(null);
  }, [researchOfferDeletingTree, researchOfferDeletingTreeId]);
  // Focus after either dialog closes: the new thread's root message row.
  const researchOfferNewTreeIdRef = useRef<string | null>(null);
  const askedResearchRow = useCallback(() => {
    const newTreeId = researchOfferNewTreeIdRef.current;
    const rootNodeId = researchTreesRef.current.find((tree) => tree.id === newTreeId)?.rootNodeId;
    return rootNodeId
      ? document.querySelector<HTMLElement>(`[data-research-row][data-node-id="${CSS.escape(rootNodeId)}"]`)
      : null;
  }, []);
  if (researchDeleteOffer) researchOfferNewTreeIdRef.current = researchDeleteOffer.newTreeId;
  const readResearchQuestionChoice = useCallback(() => composerLaunchChoiceRef.current?.() ?? null, []);
  const configAdapters = config?.adapters;
  const feedComposer = useMemo(
    () =>
      configAdapters ? (
        <ResearchQueryComposer
          adapters={configAdapters}
          requireCmdEnterToSend={settings.requireCmdEnterToSend}
          workspaceId={researchScope}
          placeholder={
            composerFolderName ? `Ask a question in ${composerFolderName}` : "Ask a question"
          }
          launchChoiceRef={composerLaunchChoiceRef}
          onOpenAgentSettings={openAgentSetupFromComposer}
          focusRequest={composerFocusRequest}
          onFocusRequestHandled={clearComposerFocusRequest}
          onCreate={submitFeedResearch}
          onPost={submitFeedPost}
          onSaveDraft={saveComposerDraft}
        />
      ) : null,
    [
      configAdapters,
      composerFolderName,
      composerFocusRequest,
      clearComposerFocusRequest,
      openAgentSetupFromComposer,
      settings.requireCmdEnterToSend,
      researchScope,
      saveComposerDraft,
      submitFeedResearch,
      submitFeedPost,
    ],
  );
  // "Start research with …" selects the agent and focuses the feed composer.
  // Preserve the existing text, workspace, and options without submitting.
  // If setup opened elsewhere, show Home first.
  const startResearchFromSetup = useCallback(
    (adapter: AgentAdapterMetadata, origin: "composer" | "home" | "other") => {
      setAgentsOpen(false);
      setHomeSetupPinned(false);
      if (origin === "other") {
        openFeedPage({ kind: "home" });
        focusResearchHome();
      }
      requestComposerFocus(adapter.id);
    },
    [focusResearchHome, openFeedPage, requestComposerFocus],
  );
  const startResearchFromSetupDialog = useCallback(
    (adapter: AgentAdapterMetadata) => startResearchFromSetup(adapter, agentSetupOriginRef.current),
    [startResearchFromSetup],
  );
  const startResearchFromHomeSetup = useCallback(
    (adapter: AgentAdapterMetadata) => startResearchFromSetup(adapter, "home"),
    [startResearchFromSetup],
  );
  // Show the setup guide when no agent can run research. Keep it visible after
  // an agent becomes ready so the user can choose "Start research".
  const noResearchAgent = Boolean(configAdapters) && !configAdapters?.some(adapterCanLaunchResearch);
  const [homeSetupPinned, setHomeSetupPinned] = useState(false);
  useEffect(() => {
    if (noResearchAgent) setHomeSetupPinned(true);
  }, [noResearchAgent]);
  const feedSetupGuide = useMemo(
    () =>
      !configAdapters || !(noResearchAgent || homeSetupPinned) ? undefined : (
        <AgentSetupGuide
          adapters={configAdapters}
          loading={adapterProbeLoading}
          error={adapterProbeError}
          onRefresh={forceRefreshAdapterReadiness}
          onCopied={showAppToast}
          onError={setAdapterProbeError}
          onStartResearch={startResearchFromHomeSetup}
        />
      ),
    [
      configAdapters,
      noResearchAgent,
      homeSetupPinned,
      adapterProbeLoading,
      adapterProbeError,
      forceRefreshAdapterReadiness,
      setAdapterProbeError,
      showAppToast,
      startResearchFromHomeSetup,
    ],
  );
  const refreshFeed = useCallback(() => void refreshResearchNavigation(), [refreshResearchNavigation]);
  // The sign-in repair under a failed run: the probed agents, and an explicit
  // forced probe as its Verify action.
  const verifyAgentReadiness = useCallback(
    () => refreshAdapterReadiness({ force: true }),
    [refreshAdapterReadiness],
  );
  const researchAgentRepair = useMemo<ResearchAgentRepair>(
    () => ({
      adapters: configAdapters ?? [],
      verify: verifyAgentReadiness,
      onCopied: showAppToast,
      onError: setError,
    }),
    [configAdapters, showAppToast, verifyAgentReadiness],
  );
  // The shell is a plain container: its sidebar (an aside) and the
  // workspace (the main landmark) sit side by side, not nested.
  return (
    <div
      ref={appRef}
      className={`app-shell${sidebar.rail && IS_MAC ? " has-titlebar-rail" : ""}${
        settings.reduceMotion ? " reduce-motion" : ""
      }`}
      style={appStyle}
    >
      <AppSidebar
        rail={sidebar.rail}
        forcedRail={sidebar.forcedRail}
        width={sidebar.width}
        maxWidth={sidebar.maxWidth()}
        onResizeStart={sidebar.startResize}
        onResizeKey={sidebar.resizeWithKeyboard}
        onCollapse={sidebar.collapse}
        onExpand={sidebar.expand}
        feedPage={feedPage}
        folders={researchFolders}
        foldersLoadError={researchFoldersLoadError}
        onRetryFoldersLoad={retryResearchFoldersLoad}
        onNavigate={openFeedPage}
        onNewFolder={openNewResearchFolderFromSidebar}
        onRenameFolder={openRenameResearchFolderDialog}
        onDeleteFolder={requestResearchFolderDelete}
        shortcutHintsShown={shortcutHintsShown}
        appearance={settings.appearance}
        settingsOpen={settingsOpen}
        onToggleAppearance={toggleAppearance}
        onOpenSettings={openSettings}
        workspaces={researchGroups}
        workspaceScope={researchScope}
        workspaceTreeCounts={researchFolderTreeCounts}
        folderPickerBusy={folderPickerStatus !== null}
        onSelectWorkspace={workspaces.selectWorkspace}
        onNewWorkspace={workspaces.chooseWorkspaceFolder}
        onOpenWorkspace={workspaces.openWorkspaceFolder}
        onRenameWorkspace={workspaces.openRename}
        onMoveWorkspace={workspaces.moveWorkspaceFolder}
        onRemoveWorkspace={workspaces.requestRemoval}
        adapters={config?.adapters ?? null}
        adaptersLoading={adapterProbeLoading}
        adaptersError={adapterProbeError}
        onOpenAgentSetup={openAgentSetup}
        onRefreshAdapters={forceRefreshAdapterReadiness}
      />
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commandPaletteOpen ? buildPaletteCommands() : []}
      />

      {agentsOpen ? (
        <AgentSetupDialog
          adapters={config?.adapters ?? []}
          initialInstanceId={agentSetupInstanceId}
          loading={adapterProbeLoading}
          error={adapterProbeError}
          onProbe={refreshAdapterReadiness}
          onRefresh={forceRefreshAdapterReadiness}
          onCopied={showAppToast}
          onError={setAdapterProbeError}
          onStartResearch={startResearchFromSetupDialog}
          onClose={closeAgentSetup}
        />
      ) : null}

      <SettingsDialog
        open={settingsOpen}
        onClose={closeSettings}
        settings={settings}
        setSettings={setSettings}
        availableBodyFonts={availableBodyFonts}
      />

      {researchFolderRemoval ? (
        <ResearchWorkspaceRemovalDialog
          workspace={researchFolderRemoval}
          name={workspaces.workspaceName(researchFolderRemoval)}
          error={workspaces.removalError}
          removing={removingResearchFolder}
          onCancel={closeResearchFolderRemoval}
          onConfirm={() => void workspaces.confirmRemoval()}
        />
      ) : null}
      {exitDialog ? (
        <QuitDialog
          dialog={exitDialog}
          quitting={quitting}
          onCancel={cancelExit}
          onConfirm={() => void confirmExit()}
        />
      ) : null}

      {renameRequest ? (
        <ResearchWorkspaceRenameDialog
          initialName={renameRequest.name}
          researchFolder={renamingResearchFolder}
          onSubmit={(name) => void workspaces.submitRename(renameRequest.groupId, name)}
          onClose={workspaces.closeRename}
        />
      ) : null}
      <main className="workspace">
        {error ? (
          <div
            className="error-banner"
            role="alert"
            aria-live="assertive"
          >
            <span className="error-banner-message">{error}</span>
            <button
              ref={errorDismissRef}
              type="button"
              className="control-button error-banner-dismiss"
              title="Dismiss (Esc)"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div className="main-stage is-research">
          {/* Keep the selected feed view mounted beside the thread, draft, or
              placeholder so its scroll position survives content changes. */}
          <ResearchColumns
            hasThread={researchStageView === "thread" || openResearchDraft !== null}
            feed={
              config ? (
                feedPage.kind === "highlights" ? (
                  <ResearchHighlightsFeed
                    items={researchHighlights.items}
                    loading={researchHighlights.loading}
                    error={researchHighlights.error}
                    onOpen={openResearchHighlight}
                    onRemove={researchHighlights.remove}
                    onRefresh={() => void researchHighlights.refresh()}
                  />
                ) : (
                  <ResearchActivityFeed
                    {...activityFeedState}
                    view={feedPage}
                    selectedTreeId={researchStageView === "thread" ? activeResearchTreeId : null}
                    selectedDraftId={openResearchDraft?.id ?? null}
                    onImportReport={importReport}
                    composer={feedComposer}
                    setupGuide={feedSetupGuide}
                    items={recentActivityItems}
                    researchTrees={feedResearchTrees}
                    folders={researchFolders}
                    folderState={researchFolderState}
                    drafts={researchDrafts}
                    onLoadTrees={loadActivityForTrees}
                    onOpenResearchQuery={openRecentResearchQuery}
                    onOpenDraft={openResearchDraftInColumn}
                    onOpenTree={openFeedResearchTree}
                    onEditNote={editResearchNoteFromFeed}
                    onOpenView={openFeedView}
                    onResearchRecapApplied={handleResearchRecapApplied}
                    onError={setError}
                    onRenameResearch={renameResearchTreeTitle}
                    onRestoreResearch={unarchiveResearchGroup}
                    onTrashResearch={trashResearchTreeWithUndo}
                    onRemoveResearch={removeResearchGroupFromMenu}
                    groupChildren={researchGroupChildren}
                    onNestTree={nestResearchTree}
                    onMoveOutOfGroup={moveResearchTreeOutOfGroup}
                    onSetGroupsCollapsed={setResearchGroupsCollapsed}
                    trashEntries={researchTrashItems}
                    onRestoreTrashEntry={restoreResearchTrashEntry}
                    onDeleteTrashEntry={deleteResearchTrashEntry}
                    onEmptyTrash={emptyResearchTrashNow}
                    onMoveTree={moveResearchTreeFromFeed}
                    onReorderTree={reorderResearchTreeFromFeed}
                    onReorderDraft={moveResearchDraftFromFeed}
                    onNewFolder={openNewResearchFolderDialog}
                    onRenameFolder={openRenameResearchFolderDialog}
                    onRequestDeleteFolder={requestResearchFolderDelete}
                    pendingDeleteFolderId={pendingResearchFolderDelete}
                    onConfirmDeleteFolder={confirmResearchFolderDelete}
                    onDeleteFolderNow={deleteResearchFolderNow}
                    onCancelDeleteFolder={cancelResearchFolderDelete}
                    onToggleTray={toggleResearchTray}
                    onDeleteDraft={deleteResearchDraftFromFeed}
                    onDragStart={startResearchCardDrag}
                    onRefresh={refreshFeed}
                    // Mouse buttons, swipes, and thread controls share one history.
                    onBack={goResearchBack}
                    onForward={goResearchForward}
                  />
                )
              ) : null
            }
          >
            {researchStageView === "thread" && activeResearchTreeId ? (
              // Remount on tree changes to reset selection, fetched content,
              // and the follow-up draft before rendering the new tree. An
              // effect would briefly show and refetch the previous tree's node.
              <ResearchInlineWidgetsContext.Provider value={settings.researchInlineWidgets}>
                <ResearchAgentRepairContext.Provider value={researchAgentRepair}>
                  <ResearchThreadPage
                    key={activeResearchTreeId}
                    detail={activeResearchDetail}
                    treeTitle={
                      activeResearchDetail?.tree.title ??
                      researchTrees.find((tree) => tree.id === activeResearchTreeId)?.title ??
                      archivedResearchTrees.find((tree) => tree.id === activeResearchTreeId)?.title
                    }
                    treeType={
                      (
                        researchTrees.find((tree) => tree.id === activeResearchTreeId) ??
                        archivedResearchTrees.find((tree) => tree.id === activeResearchTreeId)
                      )?.type
                    }
                    archived={Boolean(activeResearchDetail?.tree.archivedAt)}
                    recapPendingNodeIds={recapPendingNodeIds}
                    detailError={activeResearchDetailError}
                    onRetryDetail={retryActiveResearchDetail}
                    onFork={createResearchFollowup}
                    postActions={postActions}
                    onRemoveBranch={removeResearchBranchFromThread}
                    onRemoveTree={removeResearchGroup}
                    onTrashTree={trashResearchTreeWithUndo}
                    groupChildCount={researchGroupChildren(activeResearchTreeId).length}
                    group={activeResearchGroup}
                    onOpenGroupTree={openResearchGroupTree}
                    onRenameTree={renameResearchTreeTitle}
                    onUpdateDocument={editResearchDocument}
                    onUpdatePost={editResearchPost}
                    onAskAsQuestion={askResearchEditorQuestion}
                    readQuestionChoice={readResearchQuestionChoice}
                    questionAdapters={configAdapters ?? NO_ADAPTERS}
                    onCancel={cancelResearchRun}
                    onRetryNode={retryResearchRun}
                    onRerunNode={rerunResearchRun}
                    linkActions={browser.linkActionsFor(researchBrowserOwnerId(activeResearchTreeId))}
                    onError={setError}
                    onToast={handleResearchThreadToast}
                    shortcutHintsShown={shortcutHintsShown}
                    requireCmdEnterToSend={settings.requireCmdEnterToSend}
                    treeMenu={activeResearchTreeMenu}
                    canGoBack={researchHistoryNav.canGoBack}
                    canGoForward={researchHistoryNav.canGoForward}
                    onBack={goResearchBack}
                    onForward={goResearchForward}
                    onNavigate={reportResearchNavigation}
                    onPruneVisits={pruneResearchNodeVisits}
                    noteEditRequest={shownResearchNoteEditRequest}
                    onNoteEditRequestHandled={() => setResearchNoteEditRequest(null)}
                  />
                </ResearchAgentRepairContext.Provider>
              </ResearchInlineWidgetsContext.Provider>
            ) : openResearchDraft ? (
              <ResearchDraftView
                key={openResearchDraft.id}
                draft={openResearchDraft}
                requireCmdEnterToSend={settings.requireCmdEnterToSend}
                onSave={(prompt, images) => saveOpenResearchDraft(openResearchDraft, prompt, images)}
                onToast={showResearchToast}
                onSend={(prompt, images) => sendResearchDraft(openResearchDraft, prompt, images)}
              />
            ) : (
              <ResearchEmptyContent history={researchHistoryNav}>
                <p>Select a question to open its conversation.</p>
              </ResearchEmptyContent>
            )}
          </ResearchColumns>
        </div>
      </main>

      <BrowserOverlayLayer
        browser={browser}
        bodyFontId={settings.bodyFontId}
        occluded={nativeBrowserOccluded}
        fileServerPort={config?.fileServerPort ?? null}
        onError={setError}
      />

      <UserNotificationStack
        notifications={userNotifications}
        onDismiss={dismissUserNotification}
      />

      {appToast ? (
        <div
          className={`composer-toast app-toast${appToast.tone === "warning" ? " is-warning" : ""}`}
          role="status"
          aria-live="polite"
        >
          {appToast.message}
        </div>
      ) : null}
      <ResearchFeedToast
        toast={researchToast}
        onUndo={undoResearchToast}
        onDismiss={dismissResearchToast}
        onPause={pauseResearchToast}
        onResume={resumeResearchToast}
      />
      {researchDeleteOffer && researchDeleteOfferTree ? (
        <ResearchTreeDeleteOfferDialog
          tree={researchDeleteOfferTree}
          contents={researchDeleteOffer.contents}
          fallbackFocus={askedResearchRow}
          onKeep={() => setResearchDeleteOffer(null)}
          onDelete={() => {
            setResearchDeleteOffer(null);
            setResearchOfferDeletingTreeId(researchDeleteOfferTree.id);
          }}
        />
      ) : null}
      {researchOfferDeletingTree ? (
        <ResearchTreeDeleteDialog
          tree={researchOfferDeletingTree}
          groupChildren={researchGroupChildren(researchOfferDeletingTree.id)}
          fallbackFocus={askedResearchRow}
          onClose={() => setResearchOfferDeletingTreeId(null)}
          onTrash={trashResearchTreeWithUndo}
          onRemove={removeResearchGroupFromMenu}
        />
      ) : null}
      {researchGroupActions.dialog}
      {researchFolderNameRequest ? (
        <ResearchFolderNameDialog
          request={researchFolderNameRequest}
          folders={researchFolders}
          onSubmit={submitResearchFolderName}
          onClose={closeResearchFolderNameDialog}
        />
      ) : null}
      {folderPickerStatus ? (
        <div className="folder-picker-status" role="status" aria-live="polite">
          <LoaderCircle size={14} aria-hidden="true" />
          <span>{folderPickerStatus}</span>
        </div>
      ) : null}
      <ImageLightbox />
      <DiagramLightbox />
    </div>
  );
}

export default function App() {
  return <MainApp />;
}
