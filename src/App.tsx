import { useAppStartup } from "./hooks/useAppStartup";
import { RESEARCH_FOLDER_SCOPE_KEY, useResearchNavigationState } from "./hooks/useResearchNavigationState";
import { useUserNotifications } from "./hooks/useUserNotifications";
import { recordRemoteStartup, reconcileRemoteReservation } from "./lib/remoteStartup";
import {
  shouldCloseRemotePaneOnControlD,
} from "./lib/remoteConnection";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SetStateAction,
} from "react";
import {
  Check,
  ChevronDown,
  Bot,
  Eye,
  EyeOff,
  Globe,
  LoaderCircle,
  MessageSquareText,
  Minus,
  Moon,
  PanelLeft,
  Plus,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAgentUiAdapter } from "./adapters";
import { CODEX_ADAPTER_ID } from "./adapters/codex";
import {
  adapterCanLaunchResearch,
  adapterReadinessLabel,
  adapterReadinessMessage,
} from "./lib/adapterReadiness";
import CommandPalette, { type PaletteCommand } from "./components/CommandPalette";
import AgentSetupGuide from "./components/AgentSetupGuide";
import BrowserOverlay from "./components/BrowserOverlay";
import ImageLightbox from "./components/ImageLightbox";
import {
  closeImageLightbox,
  getImageLightbox,
  subscribeImageLightbox,
} from "./lib/imageLightbox";
import DiagramLightbox from "./components/DiagramLightbox";
import {
  closeDiagramLightbox,
  getDiagramLightbox,
  subscribeDiagramLightbox,
} from "./lib/diagramLightbox";
import ConfirmDialogActionButton from "./components/ConfirmDialogActionButton";
import {
  mergeRailPastTurns,
  railPastTurnSummaries,
} from "./lib/homeRails";
import {
  ThreadGraphRequestTracker,
  uniqueResolvedThreadIds,
} from "./lib/threadGraphRefresh";
import type {
  HomeRailPastTurn,
} from "./lib/homeRailTypes";
import LinkContextMenu from "./components/LinkContextMenu";
import {
  UserNotificationStack,
} from "./components/UserNotificationStack";
import { formatTurnsTranscript } from "./lib/transcriptFormat";
import type { TranscriptScrollPosition } from "./lib/transcriptScroll";
import type { LinkActions } from "./components/TranscriptMarkdown";
import ResearchFolderSwitcher from "./components/research/ResearchFolderSwitcher";
import GithubAccountControl from "./components/GithubAccountControl";
import {
  resolveResearchScope,
  treeForResearchScope,
  treesForResearchScope,
  workspaceIsInResearchScope,
} from "./lib/researchScope";
import ResearchDocument, { type ResearchDocumentTreeMenu } from "./components/research/ResearchDocument";
import ResearchDraftView from "./components/research/ResearchDraftView";
import ResearchActivityFeed from "./components/research/ResearchActivityFeed";
import ResearchColumns from "./components/research/ResearchColumns";
import ResearchHighlightsFeed from "./components/research/ResearchHighlightsFeed";
import { useActivityFeedState } from "./hooks/useActivityFeedState";
import ResearchQueryComposer, {
  type ResearchLaunchChoice,
} from "./components/research/ResearchQueryComposer";
import type { NoteActions } from "./components/research/ResearchNote";
import {
  clearResearchTreeAttention,
  reconcileResearchActivity,
  reconcileResearchTreeDetail,
  reconcileResearchTreeSummaries,
} from "./lib/researchSnapshots";
import {
  addResearchNodeHighlight,
  parseResearchEvent,
  patchResearchDetailHighlightCreated,
  patchResearchDetailHighlightsRemoved,
  patchResearchDetailNode,
  patchResearchDetailTree,
  patchResearchSummaryForCreatedNode,
  patchResearchSummaryForNode,
  patchResearchSummaryForRemovedNodes,
  patchResearchSummaryTree,
  removeResearchDetailNodes,
  removeResearchNodeHighlights,
  removeResearchNodes,
  researchNodeIsActivity,
  researchSummaryFromDetail,
  upsertResearchActivity,
  type ParsedResearchEvent,
} from "./lib/researchEvents";
import {
  agentStatusKeepsMachineAwake,
  desiredPreventSleepState,
  clamp,
  defaultPaneTitle,
  firstUserTurnText,
  isEditableTarget,
  IS_MAC,
  isTerminalTarget,

  repositoryWorktreeName,
  selectPaneAfterClose,
  upsertThreadGraphs,
} from "./lib/appHelpers";
import { sanitizeTerminalTitle } from "./lib/terminalTitle";
import {
  availableRemoteId,
  remoteDraftFromSshAlias,
  remoteIdFromLabel,
  unconfiguredSshAliases,
  type RemoteSettingsDraft,
} from "./lib/remoteSettings";
import {
  windowFocusKeyboardOwner,
} from "./lib/windowFocus";
import {
  applicableSpeculativeAcknowledgements,
  terminalAttentionProbeIsDue,
  terminalPaneHasUserAttention,
  terminalPaneWasIntentionallyActivated,
} from "./lib/terminalAttention";
import {
  RESEARCH_HOME_SHORTCUT_LABEL,
  resolveAppShortcut,
  showHideShortcutConflict,
  type AppShortcutCommand,
} from "./lib/appShortcuts";
import { nativeHumanBrowserOwnerIds } from "./lib/humanBrowserState";
import {
  anyBrowserOverlayOpen,
  browserOverlayShowsLink,
  closeAllBrowserOverlaysState,
  closeBrowserOverlayState,
} from "./lib/browserOverlay";
import { createTranscriptScrollCaptureSlot } from "./lib/transcriptScroll";
import { TranscriptOptionsRequestTracker } from "./lib/transcriptSessions";
import {
  buildSingleAgentThreadGraph,
  focusedBranchTurns,
  pendingGraphOverlayTurns,
  overlayLiveTurnState,
  threadIdForAgent,
} from "./lib/threadGraph";
import {
  formatPlainTextTranscript,
} from "./lib/turnTimeline";
import {
  requestResearchFollowupsFocus,
  requestResearchFolderMenuToggle,
  requestResearchNodeOpen,
} from "./lib/researchShortcuts";
import { useSessionEvents } from "./hooks/useSessionEvents";
import type {
  BrowserOverlayMode,
  BrowserOverlaySize,
  BrowserOverlayState,
  CloseDialogState,
  ExitDialogState,
  ExitPreflightRequest,
} from "./appTypes";
import {
  canSplitPaneInTree,
  canToggleTurnSidebar,
  joinPaneSplit,
  normalizePaneSplitsForPanes,
  paneSplitAxis,
  paneSplitFlagIsEnabled,
  paneSplitForPane,
  paneSplitIsNested,
  paneSplitsEqual,
  paneSnapshotForPersistedPaneSplits,
  reservedTerminalStageWidth,
  setPaneSplitFlagEnabled,
  splitAxisForPane,
  splitBranchChildCountForPane,
  splitFractions,
} from "./lib/paneSplits";
import {
  APP_TEXT_SIZE,
} from "./lib/appearance";
import {
  canPreviewLocalFilePath,
  canRenderInInternalBrowser,
  isFileServerUrl,
  pathFromSessionFileHref,
  resolveLocalLinkPath,

} from "./lib/links";
import {
  canGoWorkspaceBack,
  canGoWorkspaceForward,
  pruneResearchWorkspaceHistory,
  pushResearchWorkspaceHistory,
  researchWorkspaceHistoryBack,
  researchWorkspaceHistoryForward,
  type ResearchWorkspaceVisit,
} from "./lib/researchHistory";
import {
  isResearchTreeSelectionChange,
  pruneResearchNavigation,
  pruneResearchNavigationNodes,
  researchNavigationStore,
  saveResearchNavigation,
} from "./lib/researchNavigation";
import {
  activityCursorIsBefore,
  mergeRecentActivityItems,
  reconcileRecentActivityHead,
  recentActivityCursor as recentActivityItemCursor,
  patchRecentActivityPromoted,
  upsertRecentActivityResearchNode,
} from "./lib/activity";
import { isActiveResearchStatus } from "./lib/researchThreads";
import {
  groupsForScope,
  panesForScope,
  researchAttention,
} from "./lib/workspaceScope";
import {
  RESEARCH_SIDEBAR_AUTO_STRIP_WIDTH,
  type ResearchFeedView,
  type ResearchJournalView,
} from "./lib/sidebarMode";
import {
  RESEARCH_DRAFTS_FOLDER_ID,
  researchTreePlace,
  treesWithWorkspaceOrder,
  type ResearchFeedChild,
} from "./lib/researchFolders";
import { useResearchToast } from "./hooks/useResearchToast";
import { useResearchFiling } from "./hooks/useResearchFiling";
import { useResearchDrafts } from "./hooks/useResearchDrafts";
import { useResearchCardDrag } from "./hooks/useResearchCardDrag";
import {
  ResearchFolderNameDialog,
  type ResearchFolderNameRequest,
} from "./components/research/ResearchFolderDialogs";
import { ResearchFeedToast } from "./components/research/ResearchFeedChrome";
import {
  ResearchSidebarNav,
  ResearchSidebarStrip,
  ResearchStripButton,
} from "./components/research/ResearchSidebarNav";
import { stripTaggedUserInstructionBlocks } from "./lib/taggedInstructions";
import {
  clearSessionDraft,
  loadSessionDraftJson,
  readSessionDraftJson,
  saveSessionDraftJson,
  SESSION_DRAFT_KEYS,
} from "./lib/sessionDrafts";
import {
  APPEARANCE_OPTIONS,
  bodyFontStackFor,
  clampResearchLaunchInstruction,
  COLOR_THEME_OPTIONS,
  DEFAULT_RESEARCH_LAUNCH_INSTRUCTION,
  DEFAULT_BODY_FONT_ID,
  detectAvailableBodyFonts,
  loadSettings,
  saveSettings,
  SYSTEM_BODY_FONT_ID,
  TAB_TITLE_PROVIDER_OPTIONS,
  type AppSettings,
  type BodyFontOption,
} from "./lib/settings";
import {
  acknowledgeAgent,
  attachPane,
  browserOpenLocalPathExternal,

  browserOpenPreviewExternal,
  browserRevealLocalPath,
  closeWorktreePane,
  confirmAppExit,
  deleteRemote,
  createResearchWorkspaceWithFolder,
  renameResearchWorkspace,
  moveResearchWorkspaceWithFolder,
  removeResearchWorkspace,
  revealResearchWorkspace,
  ensureDefaultResearchWorkspace,
  cancelResearchNode,
  createResearchTree,
  importResearchReport,
  updateResearchDocument,
  forkResearchNode,
  markResearchTreeViewed,
  renameResearchNode,
  listResearchHighlights,
  removeResearchHighlights,
  renameResearchTree,
  setResearchNodePromoted,
  setResearchTreeBookmarked,
  setResearchTreeFollowed,
  removeResearchTree,
  removeResearchBranch,
  restoreResearchTree,
  retryResearchNode,
  forkAgent,
  setOpenRouterKey,
  openRouterChatCompletion,
  getThreadGraph,
  getShowHideShortcut,
  activatePane,
  probeRemote,
  probeAgentAdapters,
  generateResearchAgentTitle,
  killPane,
  listGroups,
  listAgents,
  listSshConfigAliases,
  listAgentTranscripts,
  listAgentTurnQueue,
  listHomeTurnHistory,
  destroyHumanBrowser,
  hideAllHumanBrowsers,
  reloadHumanBrowser,
  listTurns,
  listPanes,
  listResearchActivity,
  listRecentActivity,
  listResearchTrees,
  getResearchTree,
  createResearchNote,
  createResearchNoteFollowUp,
  respondToResearchNoteReply,
  removeResearchNoteReply,
  openExternalUrl,
  browserOpenCodexInlineVisualization,
  browserOpenCodexVisualizationReference,
  browserOpenLocalPath,
  paneActivity,
  placePaneAfter,
  renameGroup,
  renamePane,
  setActiveTab,
  setNativeBrowserBackground,
  setNativeBrowserOverlayOpen,
  setPaneSplits as persistPaneSplits,
  setAgentDraft as persistAgentDraft,
  setAgentTyping,
  setShowHideShortcut,
  setShowHideShortcutCaptureActive,
  setPreventSleep,
  setUseLoginShell,
  setResearchLaunchInstruction,
  setWorktreeLocation,
  spawnShell,
  openPaneWorktree,
  openRepositoryBranch,
  openRepositoryWorktree,
  upsertRemote,
  worktreeStatus,
} from "./lib/api";
import type {
  AgentInfo,
  ConversationHistoryRef,
  ConversationHistorySnapshot,
  GroupInfo,
  InitialPaneSize,
  MessageAnchor,
  PaneInfo,
  PaneSplitAxis,
  PaneSplitInfo,
  SessionEvent,
  QueuedTurn,
  RecentResearchQuery,
  RecentResearchQueryCursor,
  ResearchHighlightAnchor,
  ResearchDraft,
  ResearchHighlightFeedItem,
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
  RuntimeConfig,
  RemoteChoice,
  RemoteProbeResult,
  RepositoryBranch,
  RepositoryInventory,
  SavedRemote,
  ThreadGraph,
  TranscriptHookEvent,
  TranscriptOption,
  Turn,
  WaitTarget,
} from "./types";
import type { ShowHideShortcutSetting } from "./lib/api";


interface ConversationHistorySegment {
  snapshotId: string;
  turns: Turn[];
}

interface OrphanedQueueGroup {
  agent: AgentInfo;
  queuedTurns: QueuedTurn[];
}

type WorktreeCreateAction =
  | { kind: "open" }
  | { kind: "fork"; prompt?: string; anchor?: MessageAnchor };

type WorktreeCreateDialogState = {
  pane: PaneInfo;
  action: WorktreeCreateAction;
  name: string;
  suggestedName: string;
  creating: boolean;
  error: string | null;
  inventory: RepositoryInventory | null;
  inventoryLoading: boolean;
  inventoryError: string | null;
  startRef: string | null;
  requestId: number;
};

type RepositoryBrowserState = {
  pane: PaneInfo;
  inventory: RepositoryInventory | null;
  error: string | null;
  opening: string | null;
  names: Record<string, string>;
};

function remoteSettingsDraft(remote: RemoteChoice): RemoteSettingsDraft {
  return {
    id: remote.id,
    label: remote.label,
    host: remote.host,
    workspaceRoot: remote.workspaceRoot ?? "",
    sessionCli: remote.sessionCli ?? "",
    multiplexer: remote.multiplexer,
  };
}

function savedRemoteFromSettingsDraft(draft: RemoteSettingsDraft): SavedRemote {
  return {
    host: draft.host.trim(),
    label: draft.label.trim() || null,
    multiplexer: draft.multiplexer,
    sessionCli: draft.sessionCli.trim() || null,
    workspaceRoot: draft.workspaceRoot.trim() || null,
  };
}
const LEFT_SIDEBAR_MIN_WIDTH = 208;
const LEFT_SIDEBAR_DEFAULT_WIDTH = LEFT_SIDEBAR_MIN_WIDTH;
const LEFT_SIDEBAR_MAX_WIDTH = 420;
// Below this width, compact the research sidebar around its content.
const RESEARCH_SIDEBAR_STRIP_WIDTH = 52;
type ResearchViewedAckOptions = {
  /** A real exposure edge (selection, focus, composer close) should check the
   * backend even when the current sidebar snapshot carries no attention bit. */
  force?: boolean;
  /** The accepted navigation snapshot already proved this tree has attention. */
  knownUnseen?: boolean;
  /** Native terminal activation is authoritative even when DOM focus belongs
   * to the sibling native view rather than the webview document. */
  exposureConfirmed?: boolean;
};
// Legacy sentinel once used as the selected tab for the Home page. Kept so a
// persisted last-tab id from an older build is ignored instead of restored.
const HOME_TAB_ID = "__home__";
const ACTIVE_RESEARCH_TREE_KEY = "session.active-research-tree.v1";
const ACTIVE_RESEARCH_PANE_KEY = "session.active-research-pane.v1";
// Whether Home is forward on the research surface. Selection-level UI state,
// like the active tree id; the feed contents live backend-side.

// Browser-overlay / link-action owner for a research tree's document. Keyed
// per tree so an overlay opened from one tree's links doesn't follow the user
// into another tree (each tree keeps its own overlay, like panes do).
const RESEARCH_BROWSER_OWNER_PREFIX = "__research_document__:";
function researchBrowserOwnerId(treeId: string) {
  return `${RESEARCH_BROWSER_OWNER_PREFIX}${treeId}`;
}
// How long after the user's last keystroke we keep holding the queue before letting a
// finished turn auto-send the next queued message.
const INPUT_DEQUEUE_HOLD_MS = 1500;
// Full graphs are cosmetic relative to the bounded live timeline. Collapse a
// streaming burst into one per-thread read after activity goes quiet.
const THREAD_GRAPH_REFRESH_DEBOUNCE_MS = 300;

function partitionResearchTrees(trees: ResearchTreeSummary[]) {
  return {
    active: trees.filter((tree) => !tree.archivedAt),
    archived: trees.filter((tree) => Boolean(tree.archivedAt)),
  };
}

function upsertResearchTreeSummary(
  trees: ResearchTreeSummary[],
  summary: ResearchTreeSummary,
  prepend = false,
): ResearchTreeSummary[] {
  const index = trees.findIndex((tree) => tree.id === summary.id);
  if (index === -1) {
    return prepend ? [summary, ...trees] : [...trees, summary];
  }
  if (trees[index] === summary) {
    return trees;
  }
  const next = [...trees];
  next[index] = summary;
  return next;
}

function removeResearchTreeSummary(
  trees: ResearchTreeSummary[],
  treeId: string,
): ResearchTreeSummary[] {
  return trees.some((tree) => tree.id === treeId)
    ? trees.filter((tree) => tree.id !== treeId)
    : trees;
}

function patchResearchTreeSummaries(
  trees: ResearchTreeSummary[],
  patch: (tree: ResearchTreeSummary) => ResearchTreeSummary,
): ResearchTreeSummary[] {
  let changed = false;
  const next = trees.map((tree) => {
    const patched = patch(tree);
    changed ||= patched !== tree;
    return patched;
  });
  return changed ? next : trees;
}

function replaceResearchActivityForTree(
  activity: ResearchNode[],
  detail: ResearchTreeDetail,
): ResearchNode[] {
  const otherTrees = activity.filter((node) => node.treeId !== detail.tree.id);
  const treeActivity = detail.nodes.filter(researchNodeIsActivity);
  const next = [...otherTrees, ...treeActivity].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  return reconcileResearchActivity(activity, next);
}

function researchDocumentIsVisible(
  treeId: string,
  activeSurface: "pane" | "research",
  activeTreeId: string | null,
): boolean {
  return (
    activeSurface === "research" &&
    activeTreeId === treeId &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

function claimResizePointer(event: ReactPointerEvent<HTMLDivElement>): () => void {
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  handle.setPointerCapture(pointerId);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
  };
}

// Bounded retry for releasing a pane's output backlog (attachPane). A failure would
// otherwise leave the terminal blank forever, so retry with backoff to ride out a
// transient race (e.g. the pane not yet visible to the backend) before giving up.
const ATTACH_MAX_RETRIES = 4;
const ATTACH_INITIAL_RETRY_MS = 150;
const ATTACH_MAX_RETRY_MS = 2000;
const BROWSER_OVERLAY_LEFT_MARGIN = 64;
const EXPAND_TOGGLE_SHORTCUT_LABEL = "⌘⇧E / Ctrl+Shift+E";
const LEFT_SIDEBAR_TOGGLE_SHORTCUT_LABEL = "⇧⌘G";
const TERMINAL_MIN_WIDTH = 380;
const TURN_PANE_MIN_WIDTH = 300;
const TURN_PANE_DEFAULT_WIDTH = 420;
const TURN_PANE_MAX_WIDTH = 720;

const TERMINAL_SPLIT_MIN_HEIGHT = 140;
const TERMINAL_SPLIT_MIN_WIDTH = 200;
const TERMINAL_SPLIT_GUTTER_PX = 8;
const DEFAULT_INITIAL_COLS = 100;
const DEFAULT_INITIAL_ROWS = 24;
const MIN_INITIAL_COLS = 20;
const MIN_INITIAL_ROWS = 5;

const MAX_FIRST_MESSAGE_TITLE_CHARS = 80;
const MAX_OPENROUTER_TITLE_SOURCE_CHARS = 4000;
const OPENROUTER_TITLE_MAX_COMPLETION_TOKENS = 1000;
const FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT = 5;
// The OpenRouter chat-completion request is proxied through the Rust backend
// (openRouterChatCompletion) so the API key is attached server-side; the renderer
// never sends it and the request timeout is enforced in the backend.
const APP_TOAST_TIMEOUT_MS = 5000;
const TITLE_GENERATION_TEST_MESSAGE =
  "Review the launch plan, identify the highest-risk blockers, and suggest next steps.";
// Upper bound on the per-agent hook-event history. This feed accumulates for an
// agent's whole lifetime (it backs the "copy transcript as JSON" export), so
// without a cap a long-running, tool-heavy agent grows the array without limit.
// N is generous enough that the copy export stays complete for any realistic
// session.
const MAX_HOOK_EVENTS_PER_AGENT = 2000;

function waitForPaintedFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

interface PendingFirstMessageTitle {
  paneId: string;
  checkedMessages: number;
  seenTurnIds: Set<string>;
  skillCommand: string | null;
}

interface AgentTurnInfo {
  turns: Turn[];
  assistantLabel: string;
  // Formats transcript strings on first call and caches them. Only the copy
  // actions consume these, so eagerly formatting every agent's transcript on
  // every turn/status event was pure waste; use hasTranscript for emptiness.
  getTranscript: () => string;
  getPlainTextTranscript: () => string;
  hasTranscript: boolean;
  conversationHistory: ConversationHistoryRef | null;
}

interface ConversationHistoryState {
  /** Immediate parent first; rendering reverses this into chronological order. */
  snapshots: ConversationHistorySnapshot[];
  loading: boolean;
  error: string | null;
}

interface TurnPaneSurface {
  pane: PaneInfo;
  agent: AgentInfo | undefined;
  turns: Turn[];
  assistantLabel: string;
  getTranscript: () => string;
  getPlainTextTranscript: () => string;
  hasTranscript: boolean;
  conversationHistory: ConversationHistorySegment[];
  hasPreviousConversation: boolean;
  previousConversationSnapshotId: string | null;
  previousConversationLoading: boolean;
  previousConversationError: string | null;
  transcriptNotice: string | null;
  transcriptOptions: TranscriptOption[];
  queuedTurns: QueuedTurn[];
  waitTargets: WaitTarget[];
  draft: string;
  orphanedQueues: OrphanedQueueGroup[];
  queueSplit: boolean;
  queueSplitHeight: number | undefined;
  browserOverlay: BrowserOverlayState | undefined;
  topFraction: number;
  heightFraction: number;
  hasTurnSidebar: boolean;
}

interface OpenRouterTitleConfig {
  // The API key is no longer carried here: the request is proxied through the backend
  // (see openRouterChatCompletion), which reads the key from the preferences file.
  model: string;
}

type OpenRouterTitleReasoningEffort = "none" | "minimal";

type TitleGenerationTestState =
  | { status: "running"; providerLabel: string }
  | { status: "success"; providerLabel: string; title: string }
  | { status: "error"; providerLabel: string; message: string };

function normalizedMessagePreview(rawMessage: string): string | null {
  const normalized = rawMessage
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function stripSkillCommandPrefix(rawMessage: string, skillCommand: string | null): string {
  const command = skillCommand?.trim();
  if (!command) {
    return rawMessage;
  }

  const leadingMatch = rawMessage.match(/^\s*/);
  const leading = leadingMatch?.[0] ?? "";
  const message = rawMessage.slice(leading.length);
  if (!message.startsWith(command)) {
    return rawMessage;
  }

  const next = message[command.length];
  if (next !== undefined && next.trim() !== "") {
    return rawMessage;
  }

  return `${leading}${message.slice(command.length)}`;
}

function firstMessageTitleSource(rawMessage: string, skillCommand: string | null = null): string | null {
  const withoutSkillCommand = stripSkillCommandPrefix(rawMessage, skillCommand);
  return normalizedMessagePreview(stripTaggedUserInstructionBlocks(withoutSkillCommand));
}

function sanitizeGeneratedTitle(rawTitle: string): string | null {
  const normalized = sanitizeTerminalTitle(rawTitle);
  if (!normalized) {
    return null;
  }
  const withoutLabel = normalized.replace(/^title:\s*/i, "").trim();
  const unquoted = withoutLabel.replace(/^["'`]+|["'`.]+$/g, "").trim();
  if (!unquoted) {
    return null;
  }
  const chars = Array.from(unquoted);
  if (chars.length <= MAX_FIRST_MESSAGE_TITLE_CHARS) {
    return unquoted;
  }

  return `${chars.slice(0, MAX_FIRST_MESSAGE_TITLE_CHARS - 1).join("").trimEnd()}…`;
}

function firstMessageTitleConfig(
  settings: AppSettings,
): OpenRouterTitleConfig | null {
  if (settings.tabTitleProvider !== "openRouter") {
    return null;
  }
  // OpenRouter sends first-message text to a third-party service, so selecting the
  // provider is the consent boundary; a configured key and model are still required
  // to make a call. The key stays out of the returned config — the backend proxy
  // attaches it — but its presence still gates whether a request is attempted.
  const hasKey = settings.openRouterKey.trim().length > 0;
  const model = settings.openRouterModel.trim();
  return hasKey && model ? { model } : null;
}

function tabTitleProviderLabel(provider: AppSettings["tabTitleProvider"]): string {
  return (
    TAB_TITLE_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? "Tab titles"
  );
}

/** Catalog colors are bare RRGGBB hex; CSS needs the leading '#'. */

function focusConfirmDialogButton(button: HTMLButtonElement | null, force = false) {
  if (!button) {
    return;
  }
  const dialog = button.closest(".confirm-dialog");
  const activeElement = document.activeElement;
  if (force || !dialog?.contains(activeElement)) {
    button.focus();
  }
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function unknownErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isShowHideShortcutCaptureTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("[data-shortcut-capture='show-hide']") !== null
  );
}

function shortcutKeyLabel(event: KeyboardEvent | ReactKeyboardEvent): string | null {
  if (
    event.key === "Shift" ||
    event.key === "Control" ||
    event.key === "Alt" ||
    event.key === "Meta"
  ) {
    return null;
  }

  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code;
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return code;
  }

  switch (code) {
    case "Space":
    case "Enter":
    case "Tab":
    case "Backspace":
    case "Delete":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
    case "Insert":
    case "CapsLock":
      return code;
    case "Escape":
      return "Escape";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "NumpadAdd":
    case "NumpadDecimal":
    case "NumpadDivide":
    case "NumpadEnter":
    case "NumpadEqual":
    case "NumpadMultiply":
    case "NumpadSubtract":
      return code;
    case "AudioVolumeDown":
      return "VolumeDown";
    case "AudioVolumeUp":
      return "VolumeUp";
    case "AudioVolumeMute":
      return "VolumeMute";
    case "MediaPlayPause":
    case "MediaStop":
    case "MediaTrackNext":
    case "MediaTrackPrevious":
      return code;
    default:
      return null;
  }
}

function shortcutFromKeyboardEvent(
  event: KeyboardEvent | ReactKeyboardEvent,
): { accelerator: string | null; error: string | null } {
  const key = shortcutKeyLabel(event);
  if (!key) {
    return { accelerator: null, error: null };
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("Control");
  }
  if (event.altKey) {
    modifiers.push("Option");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if (event.metaKey) {
    modifiers.push("Command");
  }
  if (modifiers.length === 0) {
    return {
      accelerator: null,
      error: "Use at least one modifier, such as Option or Command.",
    };
  }

  return { accelerator: [...modifiers, key].join("+"), error: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function openRouterPayloadErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload.trim() || null;
  }
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  const error = record.error;
  if (typeof error === "string") {
    return error;
  }
  const errorRecord = asRecord(error);
  return typeof errorRecord?.message === "string" ? errorRecord.message : null;
}

function openRouterContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const partRecord = asRecord(part);
      const text = partRecord?.text;
      if (typeof text === "string") {
        return text;
      }
      const nestedContent = partRecord?.content;
      return typeof nestedContent === "string" ? nestedContent : "";
    })
    .join("");
  return text.trim() ? text : null;
}

function openRouterFirstChoice(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  return asRecord(choices[0]);
}

function openRouterTitleFromPayload(payload: unknown): string | null {
  const firstChoice = openRouterFirstChoice(payload);
  const message = asRecord(firstChoice?.message);
  const content = message?.content ?? firstChoice?.text;
  const text = openRouterContentText(content);
  return text ? sanitizeGeneratedTitle(text) : null;
}

function openRouterChoiceErrorMessage(choice: Record<string, unknown> | null): string | null {
  const error = asRecord(choice?.error);
  if (!error) {
    return null;
  }
  const message = typeof error.message === "string" ? error.message : "Unknown provider error";
  const code =
    typeof error.code === "string" || typeof error.code === "number" ? ` ${error.code}` : "";
  return `choice error${code}: ${message}`;
}

function openRouterPayloadUsageSummary(payload: unknown): string | null {
  const record = asRecord(payload);
  const usage = asRecord(record?.usage);
  if (!usage) {
    return null;
  }
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  const completionDetails = asRecord(usage.completion_tokens_details);
  const reasoningTokens =
    typeof completionDetails?.reasoning_tokens === "number"
      ? completionDetails.reasoning_tokens
      : null;
  const parts: string[] = [];
  if (completionTokens !== null) {
    parts.push(`completion_tokens=${completionTokens}`);
  }
  if (reasoningTokens !== null) {
    parts.push(`reasoning_tokens=${reasoningTokens}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function openRouterEmptyTitleMessage(payload: unknown): string {
  const firstChoice = openRouterFirstChoice(payload);
  const choiceError = openRouterChoiceErrorMessage(firstChoice);
  if (choiceError) {
    return `OpenRouter generation failed: ${choiceError}`;
  }

  const finishReason =
    typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null;
  const nativeFinishReason =
    typeof firstChoice?.native_finish_reason === "string"
      ? firstChoice.native_finish_reason
      : null;
  const usage = openRouterPayloadUsageSummary(payload);
  const details: string[] = [];
  if (finishReason) {
    details.push(`finish_reason=${finishReason}`);
  }
  if (nativeFinishReason && nativeFinishReason !== finishReason) {
    details.push(`native_finish_reason=${nativeFinishReason}`);
  }
  if (usage) {
    details.push(usage);
  }

  return details.length > 0
    ? `OpenRouter returned no title (${details.join(", ")}).`
    : "OpenRouter returned no title.";
}

function isOpenRouterReasoningConfigError(status: number, message: string | null): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  return /\b(reasoning|effort|thinking)\b/i.test(message ?? "");
}

function openRouterTitlePayload(
  sourceMessage: string,
  titleConfig: OpenRouterTitleConfig,
  reasoningEffort: OpenRouterTitleReasoningEffort | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: titleConfig.model,
    messages: [
      {
        role: "system",
        content:
          "Create a concise terminal tab title for the user's first message. Return only the title, without quotes. Use 2-6 words. Use sentence case, not title case.",
      },
      {
        role: "user",
        content: Array.from(sourceMessage).slice(0, MAX_OPENROUTER_TITLE_SOURCE_CHARS).join(""),
      },
    ],
    temperature: 0.2,
    max_completion_tokens: OPENROUTER_TITLE_MAX_COMPLETION_TOKENS,
    stream: false,
  };
  if (reasoningEffort) {
    payload.reasoning = {
      effort: reasoningEffort,
      exclude: true,
    };
  }
  return payload;
}

function parseOpenRouterBody(raw: string, ok: boolean): unknown {
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (ok) {
      throw new Error("OpenRouter returned invalid JSON.");
    }
    return raw;
  }
}

async function summarizeFirstMessageTitle(
  sourceMessage: string,
  titleConfig: OpenRouterTitleConfig,
): Promise<string | null> {
  const attempts: (OpenRouterTitleReasoningEffort | null)[] = ["none", "minimal", null];
  for (let index = 0; index < attempts.length; index += 1) {
    const reasoningEffort = attempts[index];
    const payload = openRouterTitlePayload(sourceMessage, titleConfig, reasoningEffort);
    // Routed through the Rust backend so the API key is attached server-side and
    // never enters the renderer on the request path. The backend enforces the
    // request timeout and returns the upstream status + raw body.
    const { status, body } = await openRouterChatCompletion(payload);
    const ok = status >= 200 && status < 300;
    const responsePayload = parseOpenRouterBody(body, ok);
    if (!ok) {
      const message = openRouterPayloadErrorMessage(responsePayload) ?? `HTTP ${status}`;
      if (index < attempts.length - 1 && isOpenRouterReasoningConfigError(status, message)) {
        continue;
      }
      throw new Error(`OpenRouter request failed (${status}): ${message}`);
    }

    const payloadError = openRouterPayloadErrorMessage(responsePayload);
    if (payloadError) {
      throw new Error(`OpenRouter returned an error: ${payloadError}`);
    }
    const title = openRouterTitleFromPayload(responsePayload);
    if (!title) {
      throw new Error(openRouterEmptyTitleMessage(responsePayload));
    }
    return title;
  }
  return null;
}

function createPendingFirstMessageTitle(
  paneId: string,
  skillCommand: string | null = null,
): PendingFirstMessageTitle {
  return {
    paneId,
    checkedMessages: 0,
    seenTurnIds: new Set(),
    skillCommand,
  };
}

function latestUserTurnId(turns: Turn[]): string | null {
  let latest: string | null = null;
  for (const turn of turns) {
    if (firstUserTurnText(turn)) {
      latest = turn.id;
    }
  }
  return latest;
}

function agentHistoryRequestKey(agent: AgentInfo) {
  return [
    threadIdForAgent(agent),
    agent.branchId ?? "",
    agent.sessionId ?? "",
    agent.transcriptPath ?? "",
  ].join("\0");
}

interface HomeTurnHistoryState {
  requestKey: string;
  pastTurns: HomeRailPastTurn[];
  nextBefore: string | null;
  loading: boolean;
}

function MainApp() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const mainStageRef = useRef<HTMLDivElement | null>(null);

  // Opening/closing either side pane resizes native terminal surfaces. Keep the
  // final focus handoff after that layout commit scoped to the active pane,
  // especially in a split where a sibling surface is also visible.
  const paneChromeFocusFrameRef = useRef<number | null>(null);
  // Becomes true once the single backend event subscription is live. Until then,
  // panes that want to attach are parked here so their pre-attach backlog is only
  // released after the listener can actually deliver it.
  const eventsReadyRef = useRef(false);
  const pendingAttachRef = useRef<Set<string>>(new Set());
  const panesRef = useRef<PaneInfo[]>([]);
  const agentsRef = useRef<AgentInfo[]>([]);
  const queuedTurnsByAgentRef = useRef<Record<string, QueuedTurn[]>>({});
  // Composer drafts live here keyed by agent so they survive tab switches; the
  // ref mirrors the state for synchronous reads from the debounced disk flush.
  const draftsByAgentRef = useRef<Record<string, string>>({});
  const draftFlushTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Per-agent queue scroll positions, so switching tabs (even through a shell pane,
  // which unmounts the composer) restores where each queue was left. Ephemeral: a ref
  // so scroll updates never re-render, and the whole thing is dropped on app restart.
  const queueScrollByAgentRef = useRef<Record<string, number>>({});
  // Per-agent transcript scroll positions, so switching tabs — or away to Home /
  // Research (which unmounts the docked right pane) and back — restores where each
  // transcript was left instead of snapping to the latest turn. Same ephemeral
  // shape as the queue scroll above; true-tail snapshots follow growth while
  // hidden, while near-tail snapshots retain their exact offset.
  const transcriptScrollByAgentRef = useRef<Record<string, TranscriptScrollPosition>>({});
  // The active TurnOverlay registers a DOM-backed snapshot here. Pane selection
  // invokes it before scheduling a tab change, preserving expanded geometry.
  const activeTranscriptScrollCaptureSlotRef = useRef(
    createTranscriptScrollCaptureSlot(),
  );
  // Keep active-tab actions reachable from the global keydown listener without
  // re-registering it on every state change.
  const activePaneRef = useRef<PaneInfo | undefined>(undefined);
  const requestClosePaneRef = useRef<(pane: PaneInfo, options?: { confirmAlways?: boolean }) => void>(() => {});
  const closeUnavailableRemotePaneRef = useRef<(pane: PaneInfo) => void>(() => {});
  const splitPaneBelowRef = useRef<(pane: PaneInfo) => void | Promise<void>>(() => {});
  const splitPaneRightRef = useRef<(pane: PaneInfo) => void | Promise<void>>(() => {});
  const canToggleActiveTranscriptExpandedRef = useRef(false);
  const toggleActiveTranscriptExpandedRef = useRef<() => void>(() => {});
  const browserOverlayByPaneRef = useRef<Record<string, BrowserOverlayState>>({});
  const nativeHumanBrowserOwnerIdsRef = useRef<Set<string>>(new Set());
  const activeBrowserOwnerIdRef = useRef<string | null>(null);
  const toggleActiveBrowserOverlayRef = useRef<() => void>(() => {});
  const closeActiveBrowserOverlayRef = useRef<() => void>(() => {});
  const browserEscapeDispatcherRef = useRef<() => "exclusive" | null>(
    () => null,
  );
  // Debounced "user is typing" hold per agent: while active the backend won't
  // auto-drain that agent's queue. Holds the agent id + the pending release timer.
  const agentTypingRef = useRef<{ agentId: string; timer: number } | null>(null);
  const pendingFirstTitleByAgentRef = useRef<Map<string, PendingFirstMessageTitle>>(new Map());
  const titleRegenerationSeqByPaneRef = useRef<Record<string, number>>({});
  // Per-agent write generation for the queued-turns list. Bumped on every write (a
  // refresh starting, or a direct/event-driven update) so an in-flight refresh whose
  // generation was superseded drops its stale response instead of clobbering newer
  // state. Mirrors the pane/group reorder seq guards.
  const agentTurnQueueSeqRef = useRef<Record<string, number>>({});
  // Set once the OpenRouter key has been loaded from the backend, so the
  // persist-on-change effect doesn't push the pre-hydration in-memory value back.
  const openRouterKeyHydratedRef = useRef(false);
  // The backend preference is the startup/recovery source of truth. Do not let the
  // localStorage mirror write its default back before that durable value is loaded.
  const useLoginShellHydratedRef = useRef(false);
  const worktreeLocationHydratedRef = useRef(false);
  const researchLaunchInstructionHydratedRef = useRef(false);
  const paneSplitsRef = useRef<PaneSplitInfo[]>([]);
  const titleGenerationTestSeqRef = useRef(0);
  const activeTabPersistenceReadyRef = useRef(false);
  const appToastTimerRef = useRef<number | null>(null);
  const dismissedRecoveredPaneIdsRef = useRef<Set<string>>(new Set());
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [adapterProbeLoading, setAdapterProbeLoading] = useState(false);
  const [adapterProbeError, setAdapterProbeError] = useState<string | null>(null);
  const adapterProbeRequestRef = useRef(0);
  const adapterProbeCompletedAtRef = useRef(0);
  const refreshAdapterReadiness = useCallback(async (options?: { force?: boolean }) => {
    const request = adapterProbeRequestRef.current + 1;
    adapterProbeRequestRef.current = request;
    setAdapterProbeLoading(true);
    setAdapterProbeError(null);
    try {
      const adapters = await probeAgentAdapters({
        force: options?.force,
      });
      if (adapterProbeRequestRef.current === request) {
        adapterProbeCompletedAtRef.current = Date.now();
        setConfig((current) => (current ? { ...current, adapters } : current));
      }
      return adapters;
    } catch (err) {
      if (adapterProbeRequestRef.current === request) {
        setAdapterProbeError(unknownErrorMessage(err));
      }
      throw err;
    } finally {
      if (adapterProbeRequestRef.current === request) {
        setAdapterProbeLoading(false);
      }
    }
  }, []);
  const configRef = useRef<RuntimeConfig | null>(null);
  configRef.current = config;
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [lastActiveGroupId, setLastActiveGroupId] = useState<string | null>(null);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const applyRecoveredDismissals = useCallback((paneList: PaneInfo[]) => {
    const dismissed = dismissedRecoveredPaneIdsRef.current;
    if (dismissed.size === 0) {
      return paneList;
    }
    let changed = false;
    const next = paneList.map((pane) => {
      if (pane.recovered && dismissed.has(pane.id)) {
        changed = true;
        return { ...pane, recovered: false };
      }
      return pane;
    });
    return changed ? next : paneList;
  }, []);
  const setPanesPreservingRecoveredDismissals = useCallback(
    (update: SetStateAction<PaneInfo[]>) => {
      setPanes((current) => {
        const next =
          typeof update === "function"
            ? (update as (current: PaneInfo[]) => PaneInfo[])(current)
            : update;
        return applyRecoveredDismissals(next.map(reconcileRemoteReservation));
      });
    },
    [applyRecoveredDismissals],
  );
  // Live OSC events override the recovery snapshot, including with explicit
  // null when a title sanitizes empty. Missing keys fall back to the pane's
  // persisted lastOscTitle.
  const [terminalTitleByPane, setTerminalTitleByPane] = useState<
    Record<string, string | null>
  >({});
  const [manuallyTitledPaneIds, setManuallyTitledPaneIds] = useState<Set<string>>(
    () => new Set(),
  );
  const manuallyTitledPaneIdsRef = useRef(manuallyTitledPaneIds);
  manuallyTitledPaneIdsRef.current = manuallyTitledPaneIds;
  const [regeneratingTitlePaneIds, setRegeneratingTitlePaneIds] = useState<Set<string>>(
    () => new Set(),
  );
  const regeneratingTitlePaneIdsRef = useRef(regeneratingTitlePaneIds);
  regeneratingTitlePaneIdsRef.current = regeneratingTitlePaneIds;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  // False while a fresh/reloaded WebContent document still holds the empty
  // placeholder above. Until listAgents() succeeds, it is not safe to infer
  // that the backend has no active agents and release its existing wake lock.
  const [agentsHydrated, setAgentsHydrated] = useState(false);
  // Agents we believe are actively working *right now*, used to show the
  // "Working…" indicator at the bottom of the transcript. This is driven by live
  // status transitions (see useSessionEvents), not the raw status field: an agent
  // restored into a working status — or loaded that way from the boot snapshot —
  // must not light up, since it isn't genuinely doing work. Membership is added
  // only on a live event that moves the agent into a working status (and on the
  // user's own send), and cleared on any non-working event.
  const [thinkingAgentIds, setThinkingAgentIds] = useState<Set<string>>(() => new Set());
  const [processingNewMessageByAgent, setProcessingNewMessageByAgent] = useState<
    Record<string, string | null>
  >({});
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const [threadGraphs, setThreadGraphs] = useState<ThreadGraph[]>([]);
  const [conversationHistoryByThread, setConversationHistoryByThread] = useState<
    Record<string, ConversationHistoryState>
  >({});
  const [homeTurnHistoryByAgent, setHomeTurnHistoryByAgent] = useState<
    Record<string, HomeTurnHistoryState>
  >({});
  const homeTurnHistoryByAgentRef = useRef(homeTurnHistoryByAgent);
  homeTurnHistoryByAgentRef.current = homeTurnHistoryByAgent;
  const homeHistoryRequestKeyByAgentRef = useRef(new Map<string, string>());
  const homeHistoryRequestSequenceByAgentRef = useRef(new Map<string, number>());
  /** One auto-retry budget per agent+requestKey after an initial history load fails. */
  const homeHistoryRetryBudgetByAgentRef = useRef(new Map<string, string>());
  const [queuedTurnsByAgent, setQueuedTurnsByAgentState] = useState<Record<string, QueuedTurn[]>>({});
  // Per-agent hook-event history. It backs only the "copy transcript as JSON"
  // export — nothing renders it — so it lives outside React state: hooks fire on
  // every tool call of a busy agent, and putting each one through setState was a
  // full-app re-render per event. Mutated in place; capped so a long-running,
  // tool-heavy agent bounds both memory and export size.
  const hookEventsByAgentRef = useRef<Record<string, TranscriptHookEvent[]>>({});
  const appendHookEvent = useCallback((event: TranscriptHookEvent) => {
    const store = hookEventsByAgentRef.current;
    const existing = store[event.agentId];
    if (!existing) {
      store[event.agentId] = [event];
      return;
    }
    existing.push(event);
    if (existing.length > MAX_HOOK_EVENTS_PER_AGENT) {
      existing.splice(0, existing.length - MAX_HOOK_EVENTS_PER_AGENT);
    }
  }, []);
  // Latest unexpected-state message per agent (stalled/unreadable transcript,
  // adapter failure). Shown under the right pane's "No activity yet" placeholder;
  // null clears it once the transcript tail recovers.
  const [transcriptNoticeByAgent, setTranscriptNoticeByAgent] = useState<
    Record<string, string | null>
  >({});
  // Sessions available per agent for the right pane's transcript picker. Fetched
  // lazily when an agent is viewed and refreshed when its transcript rotates.
  const [transcriptOptionsByAgent, setTranscriptOptionsByAgent] = useState<
    Record<string, TranscriptOption[]>
  >({});
  const transcriptOptionsRequestTrackerRef = useRef(new TranscriptOptionsRequestTracker());
  const loadingConversationThreadIdsRef = useRef(new Set<string>());
  const conversationHistoryRequestSequenceRef = useRef(new Map<string, number>());
  const [draftsByAgent, setDraftsByAgentState] = useState<Record<string, string>>({});
  const [activePaneId, setActivePaneIdState] = useState<string | null>(null);
  const activePaneIdRef = useRef(activePaneId);
  activePaneIdRef.current = activePaneId;
  const [activeResearchTreeId, setActiveResearchTreeId] = useState<string | null>(null);
  const activeResearchTreeIdRef = useRef(activeResearchTreeId);
  const researchDetailRequestSeqRef = useRef(0);
  const researchNavRefreshSeqRef = useRef(0);
  const researchNavRefreshInFlightRef = useRef(0);
  const recentActivityPageRequestSeqRef = useRef(0);
  const recentActivityHeadRequestSeqRef = useRef(0);
  const researchViewAckInFlightRef = useRef(new Set<string>());
  const researchViewAckPendingRef = useRef(new Set<string>());
  const markVisibleResearchTreeViewedRef = useRef<
    (treeId: string, options?: ResearchViewedAckOptions) => Promise<void>
  >(async () => undefined);
  activeResearchTreeIdRef.current = activeResearchTreeId;
  const [activeResearchPaneId, setActiveResearchPaneId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_RESEARCH_PANE_KEY),
  );
  const activeResearchPaneIdRef = useRef(activeResearchPaneId);
  activeResearchPaneIdRef.current = activeResearchPaneId;
  const [researchTrees, setResearchTrees] = useState<ResearchTreeSummary[]>([]);
  const [archivedResearchTrees, setArchivedResearchTrees] = useState<ResearchTreeSummary[]>([]);
  const activityFeedState = useActivityFeedState();
  const [recentActivityItems, setRecentActivityItems] = useState<RecentResearchQuery[]>([]);
  const recentActivityItemsRef = useRef(recentActivityItems);
  recentActivityItemsRef.current = recentActivityItems;
  const [recentActivityCursor, setRecentActivityCursor] =
    useState<RecentResearchQueryCursor | null>(null);
  const [loadingOlderActivity, setLoadingOlderActivity] = useState(false);
  const loadingOlderActivityRef = useRef(false);
  const [olderActivityError, setOlderActivityError] = useState<string | null>(null);
  const {
    journalOpen,
    setJournalOpen,
    researchWorkspaceHistory,
    researchWorkspaceHistoryRef,
    setResearchWorkspaceHistory,
    researchFolderScope,
    changeResearchFolderScope,
  } = useResearchNavigationState();
  // Read by mark-viewed acknowledgment (a stable callback) to decide whether
  // any attention badge was actually lit without threading the lists through
  // its dependencies.
  const researchTreesRef = useRef(researchTrees);
  const archivedResearchTreesRef = useRef(archivedResearchTrees);
  researchTreesRef.current = researchTrees;
  archivedResearchTreesRef.current = archivedResearchTrees;
  const [researchActivity, setResearchActivity] = useState<ResearchNode[]>([]);
  // Runs whose background summary job is in flight. Held only for the session:
  // the jobs die with the process, so a restart correctly shows no spinner.
  const [recapPendingNodeIds, setRecapPendingNodeIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [activeResearchDetail, setActiveResearchDetail] = useState<ResearchTreeDetail | null>(null);
  const activeResearchDetailRef = useRef(activeResearchDetail);
  activeResearchDetailRef.current = activeResearchDetail;
  // Full-node events are authoritative and arrive more often than React
  // commits. Keep a synchronous cache so several events in one 16 ms batch
  // can compute lifecycle deltas in arrival order rather than all reading the
  // same pre-batch state snapshot.
  const researchNodeEventCacheRef = useRef(new Map<string, ResearchNode>());
  for (const node of researchActivity) {
    researchNodeEventCacheRef.current.set(node.id, node);
  }
  for (const node of activeResearchDetail?.nodes ?? []) {
    researchNodeEventCacheRef.current.set(node.id, node);
  }
  // Why activeResearchDetail is null after a failed tree fetch. Without it the
  // document shows an unexplained spinner forever: the content effect can't
  // run (no detail-derived node id), so no in-document retry can recover.
  const [activeResearchDetailError, setActiveResearchDetailError] = useState<string | null>(null);
  const [activeSurface, setActiveSurfaceState] = useState<"pane" | "research">("research");
  const activeSurfaceRef = useRef(activeSurface);
  activeSurfaceRef.current = activeSurface;
  const showResearchSurface = useCallback(() => {
    activeSurfaceRef.current = "research";
    setActiveSurfaceState("research");
  }, []);
  // Half-typed home-rail composer text, keyed by rail id. App-owned so a tab
  // away can unmount Home without losing it; the transient backend mirror also
  // restores it after a WebKit reload without carrying it across app restarts.
  const [initialHomeComposerDrafts] = useState(() =>
    readSessionDraftJson<Record<string, string>>(SESSION_DRAFT_KEYS.homeComposers),
  );
  const [homeComposerDrafts, setHomeComposerDrafts] = useState<Record<string, string>>(
    initialHomeComposerDrafts ?? {},
  );
  const [homeComposerDraftsReady, setHomeComposerDraftsReady] = useState(
    initialHomeComposerDrafts !== null,
  );
  useEffect(() => {
    if (initialHomeComposerDrafts !== null) {
      return;
    }
    let disposed = false;
    void loadSessionDraftJson<Record<string, string>>(SESSION_DRAFT_KEYS.homeComposers)
      .then((restored) => {
        if (!disposed && restored) {
          setHomeComposerDrafts((current) => ({ ...restored, ...current }));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) {
          setHomeComposerDraftsReady(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [initialHomeComposerDrafts]);
  useEffect(() => {
    if (!homeComposerDraftsReady) {
      return;
    }
    if (Object.values(homeComposerDrafts).some(Boolean)) {
      saveSessionDraftJson(SESSION_DRAFT_KEYS.homeComposers, homeComposerDrafts);
    } else {
      clearSessionDraft(SESSION_DRAFT_KEYS.homeComposers);
    }
  }, [homeComposerDrafts, homeComposerDraftsReady]);
  const setActivePaneId = useCallback(
    (next: SetStateAction<string | null>) => {
      if (typeof next === "function") {
        setActivePaneIdState((current) => {
          const resolved = next(current);
          if (resolved !== current) {
            activeTranscriptScrollCaptureSlotRef.current.capture();
          }
          activePaneIdRef.current = resolved;
          activePaneRef.current =
            resolved && resolved !== HOME_TAB_ID
              ? panesRef.current.find((candidate) => candidate.id === resolved)
              : undefined;
          return resolved;
        });
        return;
      }
      if (next !== activePaneIdRef.current) {
        activeTranscriptScrollCaptureSlotRef.current.capture();
      }
      showResearchSurface();
      activePaneIdRef.current = next;
      activePaneRef.current =
        next && next !== HOME_TAB_ID
          ? panesRef.current.find((candidate) => candidate.id === next)
          : undefined;
      setActivePaneIdState(next);
      if (!next) {
        return;
      }
      const pane = panesRef.current.find((candidate) => candidate.id === next);
      const scope =
        next === HOME_TAB_ID
          ? "terminal"
          : (groupsRef.current.find((group) => group.id === pane?.groupId)?.scope ?? "terminal");
      if (scope === "research" && pane) {
        activeResearchPaneIdRef.current = pane.id;
        setActiveResearchPaneId(pane.id);
        localStorage.setItem(ACTIVE_RESEARCH_PANE_KEY, pane.id);
      }
    },
    [],
  );
  const [shortcutHintsVisible, setShortcutHintsVisible] = useState(false);
  const [turnPaneWidth, setTurnPaneWidth] = useState(TURN_PANE_DEFAULT_WIDTH);
  const [sidebarWidth, setSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const leftSidebarCollapsedRef = useRef(leftSidebarCollapsed);
  leftSidebarCollapsedRef.current = leftSidebarCollapsed;
  // Below 900px of window width the sidebar shows as the icon strip without
  // changing the saved preference; collapsing also shows the strip.
  const [windowNarrowForSidebar, setWindowNarrowForSidebar] = useState(
    () => window.innerWidth < RESEARCH_SIDEBAR_AUTO_STRIP_WIDTH,
  );
  useEffect(() => {
    const onResize = () =>
      setWindowNarrowForSidebar(window.innerWidth < RESEARCH_SIDEBAR_AUTO_STRIP_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const researchSidebarStrip = leftSidebarCollapsed || windowNarrowForSidebar;
  const effectiveSidebarWidth = researchSidebarStrip ? RESEARCH_SIDEBAR_STRIP_WIDTH : sidebarWidth;
  // Application-level settings, loaded from localStorage once on mount and
  // persisted on every change. Shared by every pane. Font size is also adjustable
  // in-session with Cmd-=/Cmd--.
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...loadSettings(),
    codeMode: false,
  }));
  const [availableBodyFonts, setAvailableBodyFonts] = useState<BodyFontOption[] | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [terminalMapOpen, setTerminalMapOpen] = useState(false);
  const terminalMapOpenRef = useRef(terminalMapOpen);
  terminalMapOpenRef.current = terminalMapOpen;
  const terminalMapDialogRef = useRef<HTMLDivElement | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // True while a web editable (composer, rename input, search field…) holds DOM
  // focus. Native terminal panes must never claim first responder then, or they
  // would steal the keyboard mid-typing.
  const [webEditableFocused, setWebEditableFocused] = useState(false);
  const webEditableFocusedRef = useRef(webEditableFocused);
  webEditableFocusedRef.current = webEditableFocused;
  // The DOM node that owned keyboard input when the native app window last
  // deactivated. WebKit can temporarily replace activeElement with <body>
  // during that handoff, so the node itself is needed to restore the composer
  // rather than misclassifying the return as terminal first-responder churn.
  const lastFocusedWebEditableRef = useRef<HTMLElement | null>(null);
  const appBlurWebEditableRef = useRef<HTMLElement | null>(null);
  const nativeWindowFocusedRef = useRef(true);
  const focusOrderSeqRef = useRef(0);
  // Pointer, wheel, and input events can arrive in dense bursts. One backend
  // Done probe per pane per short attention window closes event-order races
  // without turning every key repeat or trackpad tick into IPC.
  const terminalAttentionProbeAtRef = useRef(new Map<string, number>());
  const lastUserInputSeqRef = useRef(0);
  const lastWindowFocusSeqRef = useRef(0);
  const userInputSinceWindowFocus = useCallback(
    () => lastUserInputSeqRef.current > lastWindowFocusSeqRef.current,
    [],
  );
  const [settingsTab, setSettingsTab] = useState<"basic" | "remotes">("basic");
  const [expandedSettingsRemoteId, setExpandedSettingsRemoteId] = useState<string | null>(null);
  const [remoteAddMenuOpen, setRemoteAddMenuOpen] = useState(false);
  const remoteAddMenuRef = useRef<HTMLDivElement | null>(null);
  const remoteAddMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [remoteSettingsDraftState, setRemoteSettingsDraftState] =
    useState<RemoteSettingsDraft | null>(null);
  const [remoteSettingsDraftIsNew, setRemoteSettingsDraftIsNew] = useState(false);
  const [remoteSettingsIdManuallyEdited, setRemoteSettingsIdManuallyEdited] = useState(false);
  const [remoteSettingsSaving, setRemoteSettingsSaving] = useState(false);
  const [remoteSettingsError, setRemoteSettingsError] = useState<string | null>(null);
  const [remoteDeleteConfirm, setRemoteDeleteConfirm] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const remoteDeleteConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const [remoteProbeResults, setRemoteProbeResults] = useState<
    Record<string, RemoteProbeResult>
  >({});
  const [remoteProbeLoadingId, setRemoteProbeLoadingId] = useState<string | null>(null);
  const remoteProbeRequestRef = useRef(0);
  const remoteProbeGenerationByKeyRef = useRef<Record<string, number>>({});
  const [sshConfigAliases, setSshConfigAliases] = useState<string[]>([]);
  const [sshConfigAliasesLoading, setSshConfigAliasesLoading] = useState(false);
  const [sshConfigAliasesError, setSshConfigAliasesError] = useState<string | null>(null);
  const sshConfigAliasesRequestRef = useRef(0);
  const availableSshConfigAliases = useMemo(
    () => unconfiguredSshAliases(sshConfigAliases, config?.remotes ?? []),
    [config?.remotes, sshConfigAliases],
  );
  const refreshSshConfigAliases = useCallback(async () => {
    const request = sshConfigAliasesRequestRef.current + 1;
    sshConfigAliasesRequestRef.current = request;
    setSshConfigAliasesLoading(true);
    setSshConfigAliasesError(null);
    try {
      const aliases = await listSshConfigAliases();
      if (sshConfigAliasesRequestRef.current === request) {
        setSshConfigAliases(aliases);
      }
    } catch (err) {
      if (sshConfigAliasesRequestRef.current === request) {
        setSshConfigAliasesError(unknownErrorMessage(err));
      }
    } finally {
      if (sshConfigAliasesRequestRef.current === request) {
        setSshConfigAliasesLoading(false);
      }
    }
  }, []);
  const [openRouterKeyVisible, setOpenRouterKeyVisible] = useState(false);
  const [showHideShortcutSetting, setShowHideShortcutSetting] =
    useState<ShowHideShortcutSetting>({
      accelerator: null,
      registered: false,
      error: null,
      captureActive: false,
    });
  const [showHideShortcutSaving, setShowHideShortcutSaving] = useState(false);
  const showHideShortcutRequestRef = useRef(0);
  const showHideShortcutValue = showHideShortcutSetting.accelerator ?? "";
  const showHideShortcutMessage =
    showHideShortcutSetting.error ??
    (showHideShortcutValue &&
    !showHideShortcutSetting.registered &&
    !showHideShortcutSetting.captureActive
      ? "Shortcut is saved but not active."
      : null);
  // A system-wide hotkey consumes its chord before the app sees any key event,
  // so a registration that collides with an in-app shortcut silently disables
  // that command everywhere. Warn, don't block: the collision may be wanted.
  const showHideShortcutConflictLabel = showHideShortcutConflict(
    showHideShortcutValue || null,
  );
  const bodyFontFamily = bodyFontStackFor(settings.bodyFontId);
  // Apply the app accent before paint so switching (and restoring) color themes
  // does not flash the default green palette.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.colorTheme = settings.colorTheme;
    return () => {
      delete root.dataset.colorTheme;
    };
  }, [settings.colorTheme]);

  // Light/dark is independent of the system appearance. The root attribute
  // drives every token override; the window theme keeps the native pieces the
  // CSS cannot reach in step (sidebar vibrancy material, prefers-color-scheme
  // inside sandboxed preview iframes, native form controls and scrollbars).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.appearance = settings.appearance;
    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWindow().setTheme(settings.appearance).catch(() => undefined);
    }
    return () => {
      delete root.dataset.appearance;
    };
  }, [settings.appearance]);
  const toggleAppearance = useCallback(() => {
    setSettings((current) => ({
      ...current,
      appearance: current.appearance === "light" ? "dark" : "light",
    }));
  }, []);

  // The selected body font must live at the document root, not only on
  // .app-shell: menus and dialogs are portaled to document.body to escape pane
  // clipping, and CSS inheritance follows their DOM parent rather than their
  // React owner. Keeping the root variable current makes those surfaces follow
  // the same font selection as the rest of the application. data-body-font
  // drives optical text offsets for fonts that sit high in control boxes.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-ui", bodyFontFamily);
    root.dataset.bodyFont = settings.bodyFontId;
    return () => {
      root.style.removeProperty("--font-ui");
      delete root.dataset.bodyFont;
    };
  }, [bodyFontFamily, settings.bodyFontId]);

  useEffect(() => {
    let disposed = false;
    void detectAvailableBodyFonts().then((availableFonts) => {
      if (disposed) {
        return;
      }

      setAvailableBodyFonts(availableFonts);
      setSettings((current) => {
        if (availableFonts.some((option) => option.id === current.bodyFontId)) {
          return current;
        }
        const fallbackBodyFontId =
          availableFonts.find((option) => option.id === DEFAULT_BODY_FONT_ID)?.id ??
          availableFonts.find((option) => option.id === SYSTEM_BODY_FONT_ID)?.id ??
          DEFAULT_BODY_FONT_ID;
        return { ...current, bodyFontId: fallbackBodyFontId };
      });
    });

    return () => {
      disposed = true;
    };
  }, []);

  // Match the native loading canvas to the app's document surface.
  useLayoutEffect(() => {
    if (!IS_MAC) return;
    const value = getComputedStyle(document.documentElement).getPropertyValue("--terminal-pane-bg").trim();
    const color = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
    if (color) {
      void setNativeBrowserBackground(...[0, 2, 4].map((offset) =>
        parseInt(color.slice(offset, offset + 2), 16) / 255,
      ) as [number, number, number]).catch(() => undefined);
    }
  }, [settings.colorTheme, settings.appearance]);
  const shortcutHintsShown = settings.showShortcutHints && shortcutHintsVisible;
  const [error, setError] = useState<string | null>(null);
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
  const [appToast, setAppToast] = useState<{
    message: string;
    tone: "normal" | "warning";
  } | null>(null);
  const {
    userNotifications,
    handleUserNotificationRequested,
    handleNotificationOpenPane,
    dismissUserNotification,
  } = useUserNotifications({
    settings,
    onOpenPane: (paneId) => {
      if (panesRef.current.some((pane) => pane.id === paneId)) {
        focusPaneTab(paneId);
      }
    },
  });
  const [folderPickerStatus, setFolderPickerStatus] = useState<string | null>(null);
  const [worktreeCreateDialog, setWorktreeCreateDialog] =
    useState<WorktreeCreateDialogState | null>(null);
  const [repositoryBrowser, setRepositoryBrowser] = useState<RepositoryBrowserState | null>(null);
  const worktreeDialogResolveRef = useRef<((created: boolean) => void) | null>(null);
  const worktreeNameInputRef = useRef<HTMLInputElement | null>(null);
  const [closeDialog, setCloseDialog] = useState<CloseDialogState | null>(null);
  const [researchFolderRemovalError, setResearchFolderRemovalError] = useState<string | null>(null);
  // Monotonic id for worktree-dialog git-status probes (see closeDialogForPane).
  const worktreeProbeNonceRef = useRef(0);
  const closeConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // Which destructive close-dialog action is mid-flight, so the dialog stays
  // open (and its buttons disabled) until the operation actually finishes.
  const [resolvingClose, setResolvingClose] = useState<
    "keep" | "delete" | "removeResearchFolder" | null
  >(null);
  const [exitDialog, setExitDialog] = useState<ExitDialogState | null>(null);
  const [quitting, setQuitting] = useState(false);
  const quittingRef = useRef(false);
  const exitConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const [exitPreflightRequest, setExitPreflightRequest] =
    useState<ExitPreflightRequest | null>(null);
  const [renamePaneId, setRenamePaneId] = useState<string | null>(null);
  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [titleGenerationTest, setTitleGenerationTest] =
    useState<TitleGenerationTestState | null>(null);
  const [paneSplits, setPaneSplitsState] = useState<PaneSplitInfo[]>([]);
  paneSplitsRef.current = paneSplits;
  // Per-pane browser overlay state, so each tab keeps its own page and open/closed.
  const [browserOverlayByPane, setBrowserOverlayByPane] = useState<
    Record<string, BrowserOverlayState>
  >({});
  browserOverlayByPaneRef.current = browserOverlayByPane;
  const [transcriptExpandedByPane, setTranscriptExpandedByPane] = useState<
    Record<string, boolean>
  >({});
  const [splitTranscriptExpandedByPane, setSplitTranscriptExpandedByPane] = useState<
    Record<string, boolean>
  >({});
  const [focusedAssistantTurn, setFocusedAssistantTurn] = useState<{
    paneId: string;
    itemKey: string;
    restoreDockedOnClose: boolean;
    splitMode: boolean;
  } | null>(null);

  // Tabs in a group share their right-pane visibility; switching groups restores
  // that group's choice. Groups without a choice start with the pane open.
  const [rightBarCollapsedByGroup, setRightBarCollapsedByGroup] = useState<
    Record<string, boolean>
  >({});
  const [queueSplitByAgent] = useState<Record<string, boolean>>({});
  const [queueSplitHeightByAgent] = useState<Record<string, number>>(
    {},
  );
  // Right-click chooser for a link: web URLs choose internal vs external;
  // local paths choose protected preview, reveal, or an explicit OS open.
  const [linkMenu, setLinkMenu] = useState<{
    url: string;
    x: number;
    y: number;
    paneId: string | null;
  } | null>(null);
  // Pane and research-document selection are independent. Switching modes restores
  // the previous selection instead of erasing the other mode's navigation context.
  const researchSurfaceActive = activeSurface === "research";
  const researchActive = researchSurfaceActive && activeResearchTreeId !== null;
  const researchHomeActive = researchSurfaceActive && activeResearchTreeId === null;
  const selectedPane = panes.find((pane) => pane.id === activePaneId);
  const activePane = useMemo(
    () =>
      researchActive || activeSurface !== "pane" ? undefined : selectedPane,
    [activeSurface, researchActive, selectedPane],
  );
  const rightBarCollapsed = activePane
    ? rightBarCollapsedByGroup[activePane.groupId] === true
    : false;
  const rightBarCollapsedRef = useRef(rightBarCollapsed);
  rightBarCollapsedRef.current = rightBarCollapsed;
  const paneById = useMemo(
    () => new Map(panes.map((pane) => [pane.id, pane])),
    [panes],
  );
  const agentByPaneId = useMemo(() => {
    const result = new Map<string, AgentInfo>();
    for (const agent of agents) {
      if (agent.paneId) {
        result.set(agent.paneId, agent);
      }
    }
    return result;
  }, [agents]);
  // Per-agent cache behind agentTurnInfoById. Rebuilding an agent's thread graph
  // and (worse) handing out a fresh `turns` array identity invalidates the
  // transcript timeline's memoization and re-parses all of its markdown — so an
  // event about agent A must not churn agent B's entry, and a status-only change
  // to A must not churn A's own turns. Entries are reused when the inputs that
  // actually feed the computation are unchanged: the per-agent turn list
  // (element-wise — turn objects are immutable once appended), the stored graph
  // object, and the agent fields the graph builders read.
  const turnInfoCacheRef = useRef(
    new Map<
      string,
      {
        agentKey: string;
        agentTurns: Turn[];
        storedGraph: ThreadGraph | undefined;
        // focusedBranchTurns(storedGraph) materializes a Turn object per node
        // and sorts the whole branch — O(full history). Cached per stored-graph
        // identity so a streaming append (which only changes agentTurns)
        // reuses the branch prefix and pays only for the pending suffix.
        // Undefined when the agent had no stored graph.
        storedBranchTurns: Turn[] | undefined;
        info: AgentTurnInfo;
      }
    >(),
  );
  const agentTurnInfoById = useMemo(() => {
    // The fields consulted by buildSingleAgentThreadGraph / focusedBranchTurns /
    // pendingGraphOverlayTurns / participantForTurn. Status flips and other
    // activity metadata deliberately don't invalidate.
    const agentCacheKey = (agent: AgentInfo) =>
      [
        agent.id,
        agent.adapter,
        agent.threadId ?? "",
        agent.branchId ?? "",
        agent.sessionId ?? "",
        agent.transcriptPath ?? "",
        agent.createdAt,
      ].join("\0");
    const sameTurnList = (a: Turn[], b: Turn[]) =>
      a.length === b.length && a.every((turn, index) => turn === b[index]);

    const threadGraphById = new Map(threadGraphs.map((graph) => [graph.threadId, graph]));
    const turnsByAgent = new Map<string, Turn[]>();
    for (const turn of turns) {
      const agentTurns = turnsByAgent.get(turn.agentId);
      if (agentTurns) {
        agentTurns.push(turn);
      } else {
        turnsByAgent.set(turn.agentId, [turn]);
      }
    }
    const cache = turnInfoCacheRef.current;
    const liveAgentIds = new Set<string>();
    const result = new Map<string, AgentTurnInfo>();
    for (const agent of agents) {
      liveAgentIds.add(agent.id);
      const agentTurns = turnsByAgent.get(agent.id) ?? [];
      const agentKey = agentCacheKey(agent);
      // Same fallback the backend keys graph records by, so agents that never
      // got an explicit thread id still find their stored graph.
      const storedGraph = threadGraphById.get(threadIdForAgent(agent));
      const cached = cache.get(agent.id);
      if (
        cached &&
        cached.agentKey === agentKey &&
        cached.storedGraph === storedGraph &&
        sameTurnList(cached.agentTurns, agentTurns)
      ) {
        result.set(agent.id, cached.info);
        continue;
      }
      const adapter = getAgentUiAdapter(agent.adapter);
      const normalizedTurns = adapter.normalizeTurns?.(agentTurns) ?? agentTurns;
      // Prefer the stored graph whenever it can represent this history, even if
      // the newest turns haven't reached it yet (its refresh is debounced behind
      // the live stream): render the graph and overlay the pending suffix.
      // Falling back to the 200-capped turn list whenever the graph missed one
      // turn used to swap the whole visible history (full → capped → full) on
      // every append of a long transcript.
      let storedBranchTurns: Turn[] | undefined;
      let pendingTurns: Turn[] | null = null;
      if (storedGraph) {
        storedBranchTurns =
          cached && cached.agentKey === agentKey && cached.storedGraph === storedGraph
            ? cached.storedBranchTurns
            : undefined;
        storedBranchTurns ??= focusedBranchTurns(storedGraph, agent);
        pendingTurns = pendingGraphOverlayTurns(
          storedGraph,
          agent,
          storedBranchTurns,
          normalizedTurns,
        );
      }
      const usesStoredGraph = Boolean(storedGraph && pendingTurns !== null);
      const branchTurnsBase =
        usesStoredGraph && storedBranchTurns
          ? storedBranchTurns
          : focusedBranchTurns(buildSingleAgentThreadGraph(agent, normalizedTurns), agent);
      const branchTurns = usesStoredGraph
        ? overlayLiveTurnState(branchTurnsBase, normalizedTurns)
        : branchTurnsBase;
      const graphTurns =
        pendingTurns && pendingTurns.length > 0 ? [...branchTurns, ...pendingTurns] : branchTurns;
      // Stored graphs can predate an adapter's presentation normalization and
      // therefore still contain native metadata turns (Claude queue operations in
      // particular). Normalize once more at the final UI boundary so the timeline
      // and copied transcript agree regardless of which graph source won above.
      const visibleTurns = adapter.normalizeTurns?.(graphTurns) ?? graphTurns;
      const assistantLabel = adapter.label;
      // Every turn formats at least its role label, so emptiness is just "no
      // turns" — the full string is only ever built for the copy actions.
      let transcript: string | null = null;
      let plainTextTranscript: string | null = null;
      const info: AgentTurnInfo = {
        turns: visibleTurns,
        assistantLabel,
        getTranscript: () =>
          (transcript ??= formatTurnsTranscript(visibleTurns, assistantLabel)),
        getPlainTextTranscript: () =>
          (plainTextTranscript ??= formatPlainTextTranscript(visibleTurns, assistantLabel)),
        hasTranscript: visibleTurns.length > 0,
        conversationHistory: storedGraph?.conversationHistory ?? null,
      };
      cache.set(agent.id, { agentKey, agentTurns, storedGraph, storedBranchTurns, info });
      result.set(agent.id, info);
    }
    for (const agentId of cache.keys()) {
      if (!liveAgentIds.has(agentId)) {
        cache.delete(agentId);
      }
    }
    return result;
  }, [agents, threadGraphs, turns]);
  const activePaneSplitMembership = useMemo(
    () => paneSplitForPane(paneSplits, activePane?.id),
    [activePane?.id, paneSplits],
  );
  const activePaneSplit = useMemo(() => {
    if (!activePaneSplitMembership || activePaneSplitMembership.paneIds.length < 2) {
      return null;
    }
    return activePaneSplitMembership;
  }, [activePaneSplitMembership]);
  const splitLayoutActive = Boolean(activePaneSplit && activePaneSplit.paneIds.length > 1);
  const activeSplitAxis = paneSplitAxis(activePaneSplit);
  const activeSplitNested = paneSplitIsNested(activePaneSplit);
  // The inline transcript strip only exists for a plain top/bottom stack: it
  // reserves one full-height column on the right and slices it by each pane's
  // vertical fraction, which has no meaning once panes sit side by side. A
  // nested layout therefore takes the same path column splits already do —
  // transcripts move to the expanded overlay and the artifact tray hosts on the
  // stage — leaving that geometry untouched.
  const splitRightPaneMode =
    splitLayoutActive && activeSplitAxis === "vertical" && !activeSplitNested;
  // A split whose transcripts cannot dock as inline cells, so they live in the
  // stage-covering expanded overlay instead. Column splits have always been in
  // this mode; nested layouts join them.
  const splitOverlayTranscriptMode = splitLayoutActive && !splitRightPaneMode;
  const activeSplitFractions = useMemo(
    () => (activePaneSplit ? splitFractions(activePaneSplit) : []),
    [activePaneSplit],
  );
  // Width the stage must keep for the current layout. Memoized as a number so
  // the sidebar clamp re-runs exactly when the floor moves: a nested tree can
  // change its column count without changing the pane count or the root axis
  // (dragging a pane out of a stack), and it must not change on every frame of
  // a divider drag either.
  const reservedTerminalStageMinWidth = useMemo(
    () =>
      reservedTerminalStageWidth({
        axis: paneSplitAxis(activePaneSplit),
        paneCount: activePaneSplit?.paneIds.length ?? 1,
        minWidth: TERMINAL_MIN_WIDTH,
        splitMinWidth: TERMINAL_SPLIT_MIN_WIDTH,
        gutter: TERMINAL_SPLIT_GUTTER_PX,
        // A nested layout's floor is not "one column per pane": stacked panes
        // share a column, so only the widest row of the tree counts.
        root: activePaneSplit?.root ?? null,
      }),
    [activePaneSplit],
  );
  const visibleTerminalPaneIds = useMemo(
    () =>
      activePaneSplitMembership
        ? activePaneSplitMembership.paneIds
        : activePane
          ? [activePane.id]
          : [],
    [activePane?.id, activePaneSplitMembership],
  );
  const visibleTerminalPanes = useMemo(
    () =>
      visibleTerminalPaneIds
        .map((paneId) => paneById.get(paneId))
        .filter((pane): pane is PaneInfo => Boolean(pane)),
    [paneById, visibleTerminalPaneIds],
  );

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const researchGroups = useMemo(() => groupsForScope(groups, "research"), [groups]);
  const researchScope = useMemo(
    () => resolveResearchScope(researchFolderScope, researchGroups),
    [researchFolderScope, researchGroups],
  );
  const researchScopeRef = useRef(researchScope);
  researchScopeRef.current = researchScope;
  // The single source of truth for what the research surface shows. Every
  // stage branch keys off this one value, so precedence (composer page over
  // document over home) lives here instead of being re-derived — and kept
  // consistent — inside each render condition. The
  // composer additionally renders while this is null (another surface is
  // forward) as a hidden keep-alive for its draft.
  const researchStageView = !researchSurfaceActive
    ? null
    : journalOpen || !activeResearchTreeId
      ? ("journal" as const)
      : ("document" as const);
  const researchStageViewRef = useRef(researchStageView);
  researchStageViewRef.current = researchStageView;
  // Menu badges and the folder-replace dialog both count every tree that keeps
  // a folder alive, so archived trees are included (removal is blocked on them).
  const researchFolderTreeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tree of [...researchTrees, ...archivedResearchTrees]) {
      counts.set(tree.workspaceId, (counts.get(tree.workspaceId) ?? 0) + 1);
    }
    return counts;
  }, [archivedResearchTrees, researchTrees]);
  useEffect(() => {
    // Boot-gated like the active-tab effect below: this runs on mount with the
    // pane list still empty, and ungated it would wipe the saved research-pane
    // key before the boot restore ever reads it.
    if (!activeTabPersistenceReadyRef.current) {
      return;
    }
    const visibleResearchPane =
      activeSurface === "pane" &&
      activePane &&
      groupById.get(activePane.groupId)?.scope === "research"
        ? activePane
        : null;
    if (visibleResearchPane && activeResearchPaneId !== visibleResearchPane.id) {
      activeResearchPaneIdRef.current = visibleResearchPane.id;
      setActiveResearchPaneId(visibleResearchPane.id);
      localStorage.setItem(ACTIVE_RESEARCH_PANE_KEY, visibleResearchPane.id);
    } else if (
      activeResearchPaneId &&
      !panes.some((pane) => pane.id === activeResearchPaneId)
    ) {
      activeResearchPaneIdRef.current = null;
      setActiveResearchPaneId(null);
      localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    }
  }, [activePane, activeResearchPaneId, activeSurface, groupById, panes]);
  useEffect(() => {
    if (activeSurface !== "pane" || selectedPane) {
      return;
    }
    // Pane-backed research runs are short-lived. Return to the durable
    // research surface as soon as one retires.
    showResearchSurface();
  }, [
    activePaneId,
    activeResearchTreeId,
    activeSurface,
    groups,
    panes,
    selectedPane,
  ]);
  // Kept current so callbacks captured once (e.g. the events hook's first-render
  // capture) can still read the latest group collapse state through the ref.
  const groupByIdRef = useRef(groupById);
  groupByIdRef.current = groupById;
  // Picks the next active pane after one closes, honoring split membership and skipping
  // collapsed groups — the same rules forgetClosedPane uses. Stable + ref-backed so the
  // pane.removed handler (captured once by useSessionEvents) selects consistently with the
  // user-initiated close path.
  const selectPaneAfterCloseWithContext = useCallback(
    (panesForSelection: PaneInfo[], closedPaneId: string) => {
      const closedPane = panesForSelection.find((pane) => pane.id === closedPaneId);
      const closedScope = closedPane
        ? (groupByIdRef.current.get(closedPane.groupId)?.scope ?? "terminal")
        : "terminal";
      // A research pane is not a tab among tabs: it is the transient terminal
      // view of one tree's run. Handing focus to the "nearest" research pane
      // would land on an unrelated tree's hidden terminal while the sidebar
      // still highlights the tree the user was watching. Return no successor;
      // the surface fallback then restores the durable research document.
      if (closedScope === "research") {
        return null;
      }
      const scopedPanes = panesForSelection.filter(
        (pane) =>
          (groupByIdRef.current.get(pane.groupId)?.scope ?? "terminal") === closedScope,
      );
      return selectPaneAfterClose(scopedPanes, closedPaneId, paneSplitsRef.current, {
        isPaneInCollapsedGroup: (pane) =>
          groupByIdRef.current.get(pane.groupId)?.collapsed === true,
      });
    },
    [],
  );
  const sidebarPanes = useMemo(
    () => panesForScope(panes, groups, "terminal"),
    [groups, panes],
  );
  // Conversation history is deliberately surface-owned. A workspace can retain
  // hundreds of parked agents whose full thread graphs contain years of tool
  // output; hydrating every one copied that history through Rust, IPC, JSON, and
  // React. Terminal views retain full graphs for their visible split only. Home
  // retains the backend's bounded turn windows for its live workstream summaries,
  // but never full graphs. Leaving either surface evicts what it owned.
  const turnHistoryRequestKeyByAgentRef = useRef(new Map<string, string>());
  const graphHistoryRequestKeyByAgentRef = useRef(new Map<string, string>());
  const retainedTurnHistoryAgentIdsRef = useRef(new Set<string>());
  const retainedGraphHistoryAgentIdsRef = useRef(new Set<string>());
  const retainedGraphHistoryThreadIdsRef = useRef(new Set<string>());
  const threadGraphRequestTrackerRef = useRef(new ThreadGraphRequestTracker());
  const dirtyThreadGraphAgentIdsRef = useRef(new Set<string>());
  const threadGraphRefreshTimerRef = useRef<number | null>(null);
  const fetchRetainedThreadGraph = useCallback(
    async (
      threadId: string,
      initialRequest?: { agentId: string; requestKey: string },
    ): Promise<void> => {
      const sequence = threadGraphRequestTrackerRef.current.begin(threadId);
      try {
        const graph = await getThreadGraph(threadId);
        if (
          !threadGraphRequestTrackerRef.current.isLatest(threadId, sequence) ||
          !retainedGraphHistoryThreadIdsRef.current.has(threadId) ||
          (initialRequest &&
            graphHistoryRequestKeyByAgentRef.current.get(initialRequest.agentId) !==
              initialRequest.requestKey)
        ) {
          return;
        }
        if (graph) {
          setThreadGraphs((current) =>
            current.includes(graph) ? current : upsertThreadGraphs(current, [graph]),
          );
        }
      } catch (err) {
        // Only the newest request owns retry state. An older hydration failure
        // must not clear the marker installed by a newer transcript generation.
        if (threadGraphRequestTrackerRef.current.isLatest(threadId, sequence)) {
          if (
            initialRequest &&
            graphHistoryRequestKeyByAgentRef.current.get(initialRequest.agentId) ===
              initialRequest.requestKey
          ) {
            graphHistoryRequestKeyByAgentRef.current.delete(initialRequest.agentId);
          }
          for (const agentId of retainedGraphHistoryAgentIdsRef.current) {
            const currentAgent = agentsRef.current.find((agent) => agent.id === agentId);
            if (currentAgent && threadIdForAgent(currentAgent) === threadId) {
              graphHistoryRequestKeyByAgentRef.current.delete(agentId);
            }
          }
          if (initialRequest) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      }
    },
    [],
  );
  const hydrateAgentHistory = useCallback(async (agent: AgentInfo, includeGraph: boolean) => {
    const threadId = threadIdForAgent(agent);
    const requestKey = agentHistoryRequestKey(agent);
    const needsTurns = turnHistoryRequestKeyByAgentRef.current.get(agent.id) !== requestKey;
    const needsGraph =
      includeGraph && graphHistoryRequestKeyByAgentRef.current.get(agent.id) !== requestKey;
    if (!needsTurns && !needsGraph) {
      return;
    }
    if (needsTurns) {
      turnHistoryRequestKeyByAgentRef.current.set(agent.id, requestKey);
    }
    if (needsGraph) {
      graphHistoryRequestKeyByAgentRef.current.set(agent.id, requestKey);
    }
    const requests: Promise<void>[] = [];
    if (needsTurns) {
      const turnsAtRequestStart = new Map(
        turnsRef.current
          .filter((turn) => turn.agentId === agent.id)
          .map((turn) => [turn.id, turn]),
      );
      requests.push(
        listTurns(agent.id)
          .then((existingTurns) => {
            if (
              !retainedTurnHistoryAgentIdsRef.current.has(agent.id) ||
              turnHistoryRequestKeyByAgentRef.current.get(agent.id) !== requestKey
            ) {
              return;
            }
            // Do not let the snapshot overwrite turns delivered by the live event
            // stream while the request was in flight. Same-id live objects win;
            // genuinely new live turns are appended after the snapshot.
            setTurns((current) => {
              const liveById = new Map(
                current
                  .filter((turn) => turn.agentId === agent.id)
                  .map((turn) => [turn.id, turn]),
              );
              const merged = existingTurns.map((turn) => {
                const live = liveById.get(turn.id);
                // Prefer only turns that arrived or changed after this request
                // began. Previously hydrated same-id turns may belong to an old
                // transcript generation and must be replaced by this snapshot.
                return live && live !== turnsAtRequestStart.get(turn.id) ? live : turn;
              });
              const snapshotIds = new Set(existingTurns.map((turn) => turn.id));
              for (const turn of liveById.values()) {
                if (!snapshotIds.has(turn.id)) {
                  merged.push(turn);
                }
              }
              const next = [
                ...current.filter((turn) => turn.agentId !== agent.id),
                ...merged,
              ];
              return next.length === current.length &&
                next.every((turn, index) => turn === current[index])
                ? current
                : next;
            });
          })
          .catch((err) => {
            if (turnHistoryRequestKeyByAgentRef.current.get(agent.id) === requestKey) {
              turnHistoryRequestKeyByAgentRef.current.delete(agent.id);
              setError(err instanceof Error ? err.message : String(err));
            }
          }),
      );
    }
    if (needsGraph) {
      requests.push(fetchRetainedThreadGraph(threadId, { agentId: agent.id, requestKey }));
    }
    await Promise.all(requests);
  }, [fetchRetainedThreadGraph]);
  const fetchHomeTurnHistoryPage = useCallback(
    async (agent: AgentInfo, before: string | null) => {
      const requestKey = agentHistoryRequestKey(agent);
      const sequence = (homeHistoryRequestSequenceByAgentRef.current.get(agent.id) ?? 0) + 1;
      homeHistoryRequestSequenceByAgentRef.current.set(agent.id, sequence);
      setHomeTurnHistoryByAgent((current) => {
        const existing = current[agent.id];
        const next: HomeTurnHistoryState =
          before !== null && existing?.requestKey === requestKey
            ? { ...existing, loading: true }
            : { requestKey, pastTurns: [], nextBefore: null, loading: true };
        return { ...current, [agent.id]: next };
      });
      try {
        const page = await listHomeTurnHistory(agent.id, before);
        if (
          homeHistoryRequestSequenceByAgentRef.current.get(agent.id) !== sequence ||
          homeHistoryRequestKeyByAgentRef.current.get(agent.id) !== requestKey
        ) {
          return;
        }
        const pageTurns = railPastTurnSummaries(page.turns);
        setHomeTurnHistoryByAgent((current) => {
          const existing = current[agent.id];
          if (!existing || existing.requestKey !== requestKey) {
            return current;
          }
          return {
            ...current,
            [agent.id]: {
              requestKey,
              pastTurns:
                before === null
                  ? pageTurns
                  : mergeRailPastTurns(pageTurns, existing.pastTurns),
              nextBefore: page.nextBefore,
              loading: false,
            },
          };
        });
      } catch (err) {
        if (
          homeHistoryRequestSequenceByAgentRef.current.get(agent.id) === sequence &&
          homeHistoryRequestKeyByAgentRef.current.get(agent.id) === requestKey
        ) {
          // Initial loads stamp the request key before the IPC call. On failure
          // drop it so leaving/returning home or a soft retry can re-issue the
          // same key instead of treating the blank history as a permanent load.
          // "Load earlier" keeps the key so the button can retry the same page.
          if (before === null) {
            homeHistoryRequestKeyByAgentRef.current.delete(agent.id);
          }
          setHomeTurnHistoryByAgent((current) => {
            const existing = current[agent.id];
            return existing?.requestKey === requestKey
              ? { ...current, [agent.id]: { ...existing, loading: false } }
              : current;
          });
          setError(err instanceof Error ? err.message : String(err));
          if (
            before === null &&
            homeHistoryRetryBudgetByAgentRef.current.get(agent.id) !== requestKey
          ) {
            homeHistoryRetryBudgetByAgentRef.current.set(agent.id, requestKey);
            window.setTimeout(() => {
              if (homeHistoryRequestKeyByAgentRef.current.has(agent.id)) {
                return;
              }
              const live = agentsRef.current.find((candidate) => candidate.id === agent.id);
              if (!live || agentHistoryRequestKey(live) !== requestKey) {
                return;
              }
              homeHistoryRequestKeyByAgentRef.current.set(agent.id, requestKey);
              void fetchHomeTurnHistoryPage(live, null);
            }, 1_500);
          }
        }
      }
    },
    [],
  );
  const historyTargetAgents = useMemo(
    () =>
      (terminalMapOpen ? sidebarPanes : visibleTerminalPanes).flatMap((pane) => {
        const agent = agentByPaneId.get(pane.id);
        return agent ? [agent] : [];
      }),
    [agentByPaneId, sidebarPanes, terminalMapOpen, visibleTerminalPanes],
  );
  const retainedTurnHistoryAgentIds = useMemo(
    () => new Set(historyTargetAgents.map((agent) => agent.id)),
    [historyTargetAgents],
  );
  const retainedGraphHistoryAgentIds = useMemo(
    () => new Set(historyTargetAgents.map((agent) => agent.id)),
    [historyTargetAgents],
  );
  const retainedGraphHistoryThreadIds = useMemo(
    () =>
      new Set(historyTargetAgents.map((agent) => threadIdForAgent(agent))),
    [historyTargetAgents],
  );
  retainedTurnHistoryAgentIdsRef.current = retainedTurnHistoryAgentIds;
  retainedGraphHistoryAgentIdsRef.current = retainedGraphHistoryAgentIds;
  retainedGraphHistoryThreadIdsRef.current = retainedGraphHistoryThreadIds;
  useEffect(() => {
    setConversationHistoryByThread((history) => {
      const retained = Object.entries(history).filter(([threadId]) =>
        retainedGraphHistoryThreadIds.has(threadId),
      );
      return retained.length === Object.keys(history).length
        ? history
        : Object.fromEntries(retained);
    });
    for (const threadId of conversationHistoryRequestSequenceRef.current.keys()) {
      if (!retainedGraphHistoryThreadIds.has(threadId)) {
        conversationHistoryRequestSequenceRef.current.delete(threadId);
        loadingConversationThreadIdsRef.current.delete(threadId);
      }
    }
  }, [retainedGraphHistoryThreadIds]);
  useEffect(() => {
    if (!terminalMapOpen) {
      for (const agentId of homeHistoryRequestSequenceByAgentRef.current.keys()) {
        homeHistoryRequestSequenceByAgentRef.current.set(
          agentId,
          (homeHistoryRequestSequenceByAgentRef.current.get(agentId) ?? 0) + 1,
        );
      }
      homeHistoryRequestKeyByAgentRef.current.clear();
      homeHistoryRetryBudgetByAgentRef.current.clear();
      setHomeTurnHistoryByAgent((current) =>
        Object.keys(current).length > 0 ? {} : current,
      );
      return;
    }
    const liveAgentIds = new Set(historyTargetAgents.map((agent) => agent.id));
    setHomeTurnHistoryByAgent((current) => {
      const entries = Object.entries(current).filter(([agentId]) => liveAgentIds.has(agentId));
      return entries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(entries);
    });
    for (const agentId of homeHistoryRequestKeyByAgentRef.current.keys()) {
      if (!liveAgentIds.has(agentId)) {
        homeHistoryRequestKeyByAgentRef.current.delete(agentId);
        homeHistoryRetryBudgetByAgentRef.current.delete(agentId);
      }
    }
    for (const agent of historyTargetAgents) {
      const requestKey = agentHistoryRequestKey(agent);
      if (homeHistoryRequestKeyByAgentRef.current.get(agent.id) === requestKey) {
        continue;
      }
      // New session identity gets a fresh retry budget.
      if (homeHistoryRetryBudgetByAgentRef.current.get(agent.id) !== requestKey) {
        homeHistoryRetryBudgetByAgentRef.current.delete(agent.id);
      }
      homeHistoryRequestKeyByAgentRef.current.set(agent.id, requestKey);
      void fetchHomeTurnHistoryPage(agent, null);
    }
  }, [fetchHomeTurnHistoryPage, historyTargetAgents, terminalMapOpen]);
  const flushDirtyThreadGraphs = useCallback(() => {
    threadGraphRefreshTimerRef.current = null;
    const dirtyAgentIds = [...dirtyThreadGraphAgentIdsRef.current];
    dirtyThreadGraphAgentIdsRef.current.clear();
    const threadIds = uniqueResolvedThreadIds(dirtyAgentIds, (agentId) => {
      if (!retainedGraphHistoryAgentIdsRef.current.has(agentId)) {
        return null;
      }
      const agent = agentsRef.current.find((candidate) => candidate.id === agentId);
      return agent ? threadIdForAgent(agent) : null;
    });
    for (const threadId of threadIds) {
      void fetchRetainedThreadGraph(threadId);
    }
  }, [fetchRetainedThreadGraph]);
  const scheduleAgentThreadGraphRefresh = useCallback(
    (agentId: string) => {
      if (!retainedGraphHistoryAgentIdsRef.current.has(agentId)) {
        return;
      }
      dirtyThreadGraphAgentIdsRef.current.add(agentId);
      if (threadGraphRefreshTimerRef.current === null) {
        threadGraphRefreshTimerRef.current = window.setTimeout(
          flushDirtyThreadGraphs,
          THREAD_GRAPH_REFRESH_DEBOUNCE_MS,
        );
      }
    },
    [flushDirtyThreadGraphs],
  );
  useEffect(
    () => () => {
      if (threadGraphRefreshTimerRef.current !== null) {
        window.clearTimeout(threadGraphRefreshTimerRef.current);
        threadGraphRefreshTimerRef.current = null;
      }
    },
    [],
  );
  useEffect(() => {
    setTurns((current) => {
      const retained = current.filter((turn) => retainedTurnHistoryAgentIds.has(turn.agentId));
      return retained.length === current.length ? current : retained;
    });
    setThreadGraphs((current) => {
      const retained = current.filter((graph) =>
        retainedGraphHistoryThreadIds.has(graph.threadId),
      );
      return retained.length === current.length ? current : retained;
    });
    for (const agentId of turnHistoryRequestKeyByAgentRef.current.keys()) {
      if (!retainedTurnHistoryAgentIds.has(agentId)) {
        turnHistoryRequestKeyByAgentRef.current.delete(agentId);
      }
    }
    for (const agentId of graphHistoryRequestKeyByAgentRef.current.keys()) {
      if (!retainedGraphHistoryAgentIds.has(agentId)) {
        graphHistoryRequestKeyByAgentRef.current.delete(agentId);
      }
    }
    for (const agentId of dirtyThreadGraphAgentIdsRef.current) {
      if (!retainedGraphHistoryAgentIds.has(agentId)) {
        dirtyThreadGraphAgentIdsRef.current.delete(agentId);
      }
    }
    for (const agent of historyTargetAgents) {
      void hydrateAgentHistory(agent, true);
    }
  }, [
    historyTargetAgents,
    hydrateAgentHistory,
    retainedGraphHistoryAgentIds,
    retainedGraphHistoryThreadIds,
    retainedTurnHistoryAgentIds,
  ]);
  const researchNodeByPaneId = useMemo(
    () =>
      new Map(
        researchActivity.flatMap((node) => (node.paneId ? [[node.paneId, node] as const] : [])),
      ),
    [researchActivity],
  );
  // Ref for callbacks captured once (the viewed-marking path runs from event
  // handlers and window listeners).
  const researchNodeByPaneIdRef = useRef(researchNodeByPaneId);
  researchNodeByPaneIdRef.current = researchNodeByPaneId;
  // Every agent id ever bound to a research run. Grow-only on purpose: the
  // event hook consults it to suppress thread-graph refreshes (research runs
  // have no graphs). A settled run's trailing turn events arrive after the
  // agent and its node bindings are gone, so pruning the set would schedule
  // pointless graph reads. Bounded by the number of research launches in one
  // app session.
  const researchAgentIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const node of researchActivity) {
      if (node.agentId) {
        researchAgentIdsRef.current.add(node.agentId);
      }
    }
  }, [researchActivity]);
  useEffect(() => {
    for (const node of activeResearchDetail?.nodes ?? []) {
      if (node.agentId) {
        researchAgentIdsRef.current.add(node.agentId);
      }
    }
  }, [activeResearchDetail]);
  const researchAttentionState = useMemo(() => researchAttention(researchTrees), [researchTrees]);
  const runningResearchCount = researchAttentionState.runningCount;
  const activeBrowserOwnerId = researchSurfaceActive
    ? activeResearchTreeId
      ? researchBrowserOwnerId(activeResearchTreeId)
      : null
    : (activePane?.id ?? null);
  const activeBrowserOverlay = activeBrowserOwnerId
    ? browserOverlayByPane[activeBrowserOwnerId]
    : undefined;
  useEffect(() => {
    if (
      activePane?.groupId &&
      groupById.get(activePane.groupId)?.scope === "terminal"
    ) {
      setLastActiveGroupId(activePane.groupId);
    }
  }, [activePane?.groupId, groupById]);
  useEffect(() => {
    if (!activeTabPersistenceReadyRef.current) {
      return;
    }
    const activePaneIsTerminal =
      activePane && groupById.get(activePane.groupId)?.scope === "terminal";
    const nextActiveTabId = activePaneIsTerminal ? activePane.id : null;
    if (!nextActiveTabId) {
      return;
    }
    void setActiveTab(nextActiveTabId).catch(() => undefined);
  }, [activePane, groupById]);
  // Committed per pane on a trailing debounce rather than per event: programs
  // that stream progress into the terminal title (OSC 0/2 spinners, build
  // percentages) emit a distinct title many times a second, and committing each
  // one re-rendered the whole app — a busy terminal made typing lag everywhere
  // else. A tab label lagging its
  // terminal by a couple hundred milliseconds is imperceptible.

  function paneUsesDefaultTitle(pane: PaneInfo, agent: AgentInfo | undefined): boolean {
    if (manuallyTitledPaneIdsRef.current.has(pane.id)) {
      return false;
    }
    const defaultTitle = defaultPaneTitle(pane, agent, configRef.current);
    return defaultTitle !== null && pane.title === defaultTitle;
  }

  function paneHasUserSetTitle(pane: PaneInfo, agent: AgentInfo | undefined): boolean {
    if (manuallyTitledPaneIdsRef.current.has(pane.id)) {
      return true;
    }
    const defaultTitle = defaultPaneTitle(pane, agent, configRef.current);
    return defaultTitle !== null && pane.title !== defaultTitle;
  }

  function paneStillBelongsToAgent(
    pane: PaneInfo,
    agent: AgentInfo | undefined,
    expectedAgentId: string | undefined,
  ): boolean {
    return !expectedAgentId || agent?.id === expectedAgentId || pane.agentId === expectedAgentId;
  }

  function displayPaneTitle(pane: PaneInfo, agent: AgentInfo | undefined): string {
    const terminalTitle = Object.prototype.hasOwnProperty.call(terminalTitleByPane, pane.id)
      ? terminalTitleByPane[pane.id]
      : pane.lastOscTitle;
    const normalizedTerminalTitle = terminalTitle
      ? sanitizeTerminalTitle(terminalTitle)
      : null;
    return normalizedTerminalTitle && paneUsesDefaultTitle(pane, agent)
      ? normalizedTerminalTitle
      : pane.title;
  }

  function showAppToast(message: string, tone: "normal" | "warning" = "normal") {
    setAppToast({ message, tone });
    if (appToastTimerRef.current !== null) {
      window.clearTimeout(appToastTimerRef.current);
    }
    appToastTimerRef.current = window.setTimeout(() => {
      setAppToast(null);
      appToastTimerRef.current = null;
    }, APP_TOAST_TIMEOUT_MS);
  }

  function remoteProbeKey(id: string | null | undefined) {
    const trimmed = id?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : "__new__";
  }

  function resetRemoteProbe(id: string) {
    const key = remoteProbeKey(id);
    remoteProbeGenerationByKeyRef.current[key] = ++remoteProbeRequestRef.current;
    setRemoteProbeResults((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    setRemoteProbeLoadingId((current) => (current === key ? null : current));
  }

  function changeRemoteSettingsDraft(
    update: (current: RemoteSettingsDraft) => RemoteSettingsDraft,
  ) {
    if (remoteSettingsDraftState) {
      resetRemoteProbe(remoteSettingsDraftState.id);
    }
    setRemoteSettingsError(null);
    setRemoteSettingsDraftState((current) => (current ? update(current) : current));
  }

  function beginAddingRemote() {
    const id = availableRemoteId("remote", config?.remotes ?? []);
    setExpandedSettingsRemoteId("__new__");
    setRemoteSettingsDraftState({
      id,
      label: "",
      host: "",
      workspaceRoot: "",
      sessionCli: "",
      multiplexer: "tmux",
    });
    setRemoteSettingsDraftIsNew(true);
    setRemoteSettingsIdManuallyEdited(false);
    setRemoteSettingsError(null);
    setRemoteDeleteConfirm(null);
  }

  function beginAddingRemoteFromSshAlias(alias: string) {
    setExpandedSettingsRemoteId("__new__");
    setRemoteSettingsDraftState(remoteDraftFromSshAlias(alias, config?.remotes ?? []));
    setRemoteSettingsDraftIsNew(true);
    setRemoteSettingsIdManuallyEdited(false);
    setRemoteSettingsError(null);
    setRemoteDeleteConfirm(null);
  }

  function beginCopyingRemote(remote: RemoteChoice) {
    const id = availableRemoteId(`${remote.id}-copy`, config?.remotes ?? []);
    setExpandedSettingsRemoteId("__new__");
    setRemoteSettingsDraftState({
      ...remoteSettingsDraft(remote),
      id,
      label: `${remote.label} copy`,
      // The UI only creates driveable remotes. A config entry may retain the
      // documented future-facing `herdr` value, but its editable copy should
      // be immediately usable by session.
      multiplexer: "tmux",
    });
    setRemoteSettingsDraftIsNew(true);
    setRemoteSettingsIdManuallyEdited(false);
    setRemoteSettingsError(null);
    setRemoteDeleteConfirm(null);
  }

  function toggleRemoteSettings(remote: RemoteChoice) {
    if (expandedSettingsRemoteId === remote.id) {
      setExpandedSettingsRemoteId(null);
      setRemoteSettingsDraftState(null);
      setRemoteSettingsError(null);
      setRemoteDeleteConfirm(null);
      return;
    }
    setExpandedSettingsRemoteId(remote.id);
    setRemoteSettingsDraftState(remoteSettingsDraft(remote));
    setRemoteSettingsDraftIsNew(false);
    setRemoteSettingsIdManuallyEdited(true);
    setRemoteSettingsError(null);
    setRemoteDeleteConfirm(null);
  }

  async function saveRemoteSettings() {
    const draft = remoteSettingsDraftState;
    if (!draft || remoteSettingsSaving) {
      return;
    }
    const id = draft.id.trim();
    const label = draft.label.trim();
    const host = draft.host.trim();
    if (!id || !label || !host) {
      setRemoteSettingsError("Name, ID, and SSH host are required.");
      return;
    }
    if (remoteSettingsDraftIsNew && (config?.remotes ?? []).some((remote) => remote.id === id)) {
      setRemoteSettingsError(`A remote with the ID “${id}” already exists.`);
      return;
    }
    const remote = savedRemoteFromSettingsDraft({ ...draft, label, host });
    setRemoteSettingsSaving(true);
    setRemoteSettingsError(null);
    try {
      const remotes = await upsertRemote(id, remote);
      setConfig((current) => (current ? { ...current, remotes } : current));
      setExpandedSettingsRemoteId(id);
      setRemoteSettingsDraftState({ ...draft, id, label, host });
      setRemoteSettingsDraftIsNew(false);
      showAppToast(remoteSettingsDraftIsNew ? "Remote added" : "Remote updated");
    } catch (err) {
      setRemoteSettingsError(unknownErrorMessage(err));
    } finally {
      setRemoteSettingsSaving(false);
    }
  }

  async function testRemoteSettings(draft: RemoteSettingsDraft) {
    if (!draft.host.trim()) {
      setRemoteSettingsError("Enter an SSH host before testing.");
      return;
    }
    const key = remoteProbeKey(draft.id);
    const generation = ++remoteProbeRequestRef.current;
    remoteProbeGenerationByKeyRef.current[key] = generation;
    setRemoteProbeLoadingId(key);
    setRemoteProbeResults((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    setRemoteSettingsError(null);
    try {
      const result = await probeRemote(savedRemoteFromSettingsDraft(draft));
      if (remoteProbeGenerationByKeyRef.current[key] !== generation) {
        return;
      }
      setRemoteProbeResults((current) => ({ ...current, [key]: result }));
    } catch (err) {
      if (remoteProbeGenerationByKeyRef.current[key] !== generation) {
        return;
      }
      setRemoteSettingsError(unknownErrorMessage(err));
    } finally {
      if (remoteProbeGenerationByKeyRef.current[key] === generation) {
        setRemoteProbeLoadingId((current) => (current === key ? null : current));
      }
    }
  }

  async function removeRemoteSettings(id: string) {
    if (remoteSettingsSaving) {
      return;
    }
    setRemoteSettingsSaving(true);
    setRemoteSettingsError(null);
    try {
      const remotes = await deleteRemote(id);
      setConfig((current) => (current ? { ...current, remotes } : current));
      setExpandedSettingsRemoteId(null);
      setRemoteSettingsDraftState(null);
      setRemoteDeleteConfirm(null);
      resetRemoteProbe(id);
      showAppToast("Remote removed");
    } catch (err) {
      setRemoteSettingsError(unknownErrorMessage(err));
    } finally {
      setRemoteSettingsSaving(false);
    }
  }

  function renderRemoteProbeStatus(probeKey: string) {
    const probeLoading = remoteProbeLoadingId === probeKey;
    const probeResult = remoteProbeResults[probeKey];
    if (probeLoading) {
      return (
        <div className="settings-remote-probe-loading" role="status">
          <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
          Checking SSH, tmux, session-cli, and agent providers…
        </div>
      );
    }
    if (!probeResult) {
      return null;
    }
    const remoteAdapters = probeResult.adapters.filter((adapter) => adapter.supportsRemote);
    return (
      <div className="settings-remote-probe-result" aria-live="polite">
        <div className="settings-remote-checks">
          {probeResult.checks.map((check) => (
            <div className={`settings-remote-check is-${check.status}`} key={check.id}>
              {check.status === "passed" ? (
                <Check size={13} aria-hidden="true" />
              ) : check.status === "failed" ? (
                <X size={13} aria-hidden="true" />
              ) : (
                <Minus size={13} aria-hidden="true" />
              )}
              <span>
                <strong>{check.label}</strong>
                <small>{check.message}</small>
              </span>
            </div>
          ))}
        </div>
        {remoteAdapters.length > 0 ? (
          <div className="settings-remote-provider-results">
            <span>Remote agent providers</span>
            {remoteAdapters.map((adapter) => (
              <div key={adapter.instanceId}>
                <strong>{adapter.label}</strong>
                <span className={`settings-agent-status is-${adapter.readiness}`}>
                  {adapterReadinessLabel(adapter)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderRemoteSettingsForm() {
    const draft = remoteSettingsDraftState;
    if (!draft) {
      return null;
    }
    const fieldPrefix = `settings-remote-${encodeURIComponent(draft.id || "new")}`;
    const probeKey = remoteProbeKey(draft.id);
    const probeLoading = remoteProbeLoadingId === probeKey;
    return (
      <div className="settings-remote-detail">
        <div className="settings-remote-fields settings-remote-fields-id">
          <label htmlFor={`${fieldPrefix}-id`}>
            <span>ID</span>
            <input
              id={`${fieldPrefix}-id`}
              className="form-field"
              type="text"
              value={draft.id}
              disabled={!remoteSettingsDraftIsNew}
              spellCheck={false}
              onChange={(event) => {
                const id = remoteIdFromLabel(event.currentTarget.value);
                setRemoteSettingsIdManuallyEdited(true);
                changeRemoteSettingsDraft((current) => ({ ...current, id }));
              }}
            />
          </label>
        </div>
        <div className="settings-remote-fields">
          <label htmlFor={`${fieldPrefix}-label`}>
            <span>Name</span>
            <input
              id={`${fieldPrefix}-label`}
              className="form-field"
              type="text"
              autoFocus={remoteSettingsDraftIsNew}
              value={draft.label}
              placeholder="Build server"
              onChange={(event) => {
                const label = event.currentTarget.value;
                changeRemoteSettingsDraft((current) => {
                  const nextSlug = remoteIdFromLabel(label);
                  const id =
                    remoteSettingsDraftIsNew && !remoteSettingsIdManuallyEdited && nextSlug
                      ? availableRemoteId(nextSlug, config?.remotes ?? [])
                      : current.id;
                  return { ...current, label, id };
                });
              }}
            />
          </label>
          <label htmlFor={`${fieldPrefix}-host`}>
            <span>SSH host</span>
            <input
              id={`${fieldPrefix}-host`}
              className="form-field"
              type="text"
              value={draft.host}
              placeholder="devbox or user@host"
              list={sshConfigAliases.length > 0 ? "settings-ssh-host-aliases" : undefined}
              spellCheck={false}
              onChange={(event) => {
                const host = event.currentTarget.value;
                changeRemoteSettingsDraft((current) => ({ ...current, host }));
              }}
            />
            {sshConfigAliases.length > 0 ? (
              <small>{sshConfigAliases.length} aliases available from ~/.ssh/config</small>
            ) : null}
          </label>
          <label htmlFor={`${fieldPrefix}-root`}>
            <span>Workspace root <small>optional</small></span>
            <input
              id={`${fieldPrefix}-root`}
              className="form-field"
              type="text"
              value={draft.workspaceRoot}
              placeholder="~/.session/workspaces"
              spellCheck={false}
              onChange={(event) => {
                const workspaceRoot = event.currentTarget.value;
                changeRemoteSettingsDraft((current) => ({ ...current, workspaceRoot }));
              }}
            />
          </label>
          <label htmlFor={`${fieldPrefix}-cli`}>
            <span>Session CLI <small>optional</small></span>
            <input
              id={`${fieldPrefix}-cli`}
              className="form-field"
              type="text"
              value={draft.sessionCli}
              placeholder="session-cli"
              spellCheck={false}
              onChange={(event) => {
                const sessionCli = event.currentTarget.value;
                changeRemoteSettingsDraft((current) => ({ ...current, sessionCli }));
              }}
            />
          </label>
          <datalist id="settings-ssh-host-aliases">
            {sshConfigAliases.map((alias) => (
              <option value={alias} key={alias} />
            ))}
          </datalist>
        </div>
        {remoteSettingsError ? (
          <p className="settings-agent-error" role="alert">{remoteSettingsError}</p>
        ) : null}
        {renderRemoteProbeStatus(probeKey)}
        <div className="settings-remote-actions">
          <button
            type="button"
            className="control-button settings-remote-test"
            disabled={remoteSettingsSaving || probeLoading}
            onClick={() => void testRemoteSettings(draft)}
          >
            {probeLoading ? "Testing…" : "Test connection"}
          </button>
          {!remoteSettingsDraftIsNew ? (
            <button
              type="button"
              className="control-button settings-remote-remove"
              disabled={remoteSettingsSaving}
              onClick={() => {
                setRemoteSettingsError(null);
                setRemoteDeleteConfirm({
                  id: draft.id,
                  label: draft.label.trim() || draft.id,
                });
              }}
            >
              Remove
            </button>
          ) : (
            <button
              type="button"
              className="control-button settings-remote-remove"
              disabled={remoteSettingsSaving}
              onClick={() => {
                setExpandedSettingsRemoteId(null);
                setRemoteSettingsDraftState(null);
                setRemoteSettingsDraftIsNew(false);
                setRemoteSettingsError(null);
                resetRemoteProbe(draft.id);
              }}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            className="control-button settings-remote-save"
            disabled={remoteSettingsSaving}
            onClick={() => void saveRemoteSettings()}
          >
            {remoteSettingsSaving ? "Saving…" : remoteSettingsDraftIsNew ? "Add remote" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  async function testFirstMessageTitleGeneration() {
    const settingsSnapshot = settingsRef.current;
    const titleConfig = firstMessageTitleConfig(settingsSnapshot);
    const providerLabel = titleConfig
      ? "OpenRouter"
      : tabTitleProviderLabel(settingsSnapshot.tabTitleProvider);
    const requestSeq = titleGenerationTestSeqRef.current + 1;
    titleGenerationTestSeqRef.current = requestSeq;

    if (!titleConfig) {
      const message =
        settingsSnapshot.tabTitleProvider === "openRouter"
          ? "Add an OpenRouter key and model before testing."
          : "Choose a title generation provider before testing.";
      setTitleGenerationTest({ status: "error", providerLabel, message });
      return;
    }

    const sourceMessage = firstMessageTitleSource(TITLE_GENERATION_TEST_MESSAGE);
    if (!sourceMessage) {
      setTitleGenerationTest({
        status: "error",
        providerLabel,
        message: "Test message could not be prepared.",
      });
      return;
    }

    setTitleGenerationTest({ status: "running", providerLabel });
    try {
      const title = await summarizeFirstMessageTitle(sourceMessage, titleConfig);
      if (!title) {
        throw new Error(`${providerLabel} returned no title.`);
      }
      if (titleGenerationTestSeqRef.current !== requestSeq) {
        return;
      }
      setTitleGenerationTest({ status: "success", providerLabel, title });
      showAppToast(`${providerLabel} title test: ${title}`);
    } catch (err) {
      if (titleGenerationTestSeqRef.current !== requestSeq) {
        return;
      }
      const message = unknownErrorMessage(err);
      setTitleGenerationTest({
        status: "error",
        providerLabel,
        message,
      });
      showAppToast(
        `${providerLabel} title test failed: ${message}`,
        "warning",
      );
    }
  }

  async function applyFirstMessageTitle(
    paneId: string,
    sourceMessage: string,
    titleConfig: OpenRouterTitleConfig,
    fallbackPane?: PaneInfo,
    expectedAgentId?: string,
  ) {
    if (!sourceMessage) {
      return;
    }

    const pane =
      panesRef.current.find((candidate) => candidate.id === paneId) ?? fallbackPane;
    const paneAgent = pane
      ? agentsRef.current.find((agent) => agent.paneId === pane.id)
      : undefined;
    if (pane && !paneStillBelongsToAgent(pane, paneAgent, expectedAgentId)) {
      return;
    }
    if (pane && paneHasUserSetTitle(pane, paneAgent)) {
      return;
    }

    let title: string | null;
    try {
      title = await summarizeFirstMessageTitle(sourceMessage, titleConfig);
    } catch (err) {
      const message = unknownErrorMessage(err);
      showAppToast(
        `OpenRouter title error: ${message}`,
        "warning",
      );
      return;
    }
    if (!title) {
      return;
    }

    const currentPane =
      panesRef.current.find((candidate) => candidate.id === paneId) ?? fallbackPane;
    const currentPaneAgent = currentPane
      ? agentsRef.current.find((agent) => agent.paneId === currentPane.id)
      : undefined;
    if (
      currentPane &&
      !paneStillBelongsToAgent(currentPane, currentPaneAgent, expectedAgentId)
    ) {
      return;
    }
    if (!currentPane || paneHasUserSetTitle(currentPane, currentPaneAgent)) {
      return;
    }

    try {
      const updated = await renamePane(paneId, title);
      setManuallyTitledPaneIds((current) => {
        const next = new Set(current);
        next.add(paneId);
        return next;
      });
      setPanesPreservingRecoveredDismissals((current) =>
        current.map((pane) => (pane.id === paneId ? { ...pane, title: updated.title } : pane)),
      );
    } catch (err) {
      showAppToast(
        `Couldn't set terminal title: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
    }
  }

  function applyPendingFirstMessageTitle(
    agentId: string,
    rawMessage: string,
    source: { turnId?: string } = {},
  ) {
    const pending = pendingFirstTitleByAgentRef.current.get(agentId);
    if (!pending) {
      return;
    }
    if (source.turnId) {
      if (pending.seenTurnIds.has(source.turnId)) {
        return;
      }
      pending.seenTurnIds.add(source.turnId);
    }

    const messagePreview = normalizedMessagePreview(rawMessage);
    if (!messagePreview) {
      return;
    }
    pending.checkedMessages += 1;
    const sourceMessage = firstMessageTitleSource(rawMessage, pending.skillCommand);
    if (!sourceMessage) {
      if (pending.checkedMessages >= FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT) {
        pendingFirstTitleByAgentRef.current.delete(agentId);
      }
      return;
    }
    const titleConfig = firstMessageTitleConfig(settingsRef.current);
    if (titleConfig) {
      pendingFirstTitleByAgentRef.current.delete(agentId);
      void applyFirstMessageTitle(pending.paneId, sourceMessage, titleConfig, undefined, agentId);
      return;
    }
    pendingFirstTitleByAgentRef.current.delete(agentId);
  }

  function registerShellCodexFirstMessageTitle(
    agent: AgentInfo,
    paneId: string | null,
    source: string | null,
  ) {
    if (source !== "shell" || agent.adapter !== CODEX_ADAPTER_ID) {
      return;
    }
    const resolvedPaneId = paneId ?? agent.paneId ?? null;
    if (!resolvedPaneId || pendingFirstTitleByAgentRef.current.has(agent.id)) {
      return;
    }

    const pane = panesRef.current.find((candidate) => candidate.id === resolvedPaneId);
    if (pane && paneHasUserSetTitle(pane, agent)) {
      return;
    }

    pendingFirstTitleByAgentRef.current.set(
      agent.id,
      createPendingFirstMessageTitle(resolvedPaneId),
    );
  }

  function handleAgentSpawned(agent: AgentInfo, paneId: string | null, source: string | null) {
    // Recorded synchronously in the event batch, so the run's first turn
    // events — flushed in the same coalesce window as agent.spawned — already
    // see the id when deciding whether to skip thread-graph refreshes.
    if (source === "research") {
      researchAgentIdsRef.current.add(agent.id);
    }
    registerShellCodexFirstMessageTitle(agent, paneId, source);
  }

  function handleAgentPromptSubmitted(agentId: string, prompt: string) {
    applyPendingFirstMessageTitle(agentId, prompt);
  }

  // Drop browser/UI state only when its real owner disappears. Browser owners
  // include research trees as well as terminal panes; unrelated pane metadata
  // updates must not retire a research document's preserved browser.
  useEffect(() => {
    panesRef.current = panes;
    const ids = new Set(panes.map((pane) => pane.id));
    const browserOwnerIds = new Set(ids);
    for (const tree of [...researchTrees, ...archivedResearchTrees]) {
      browserOwnerIds.add(researchBrowserOwnerId(tree.id));
    }
    setTerminalTitleByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([paneId]) => ids.has(paneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setManuallyTitledPaneIds((current) => {
      const next = new Set([...current].filter((paneId) => ids.has(paneId)));
      return next.size === current.size ? current : next;
    });
    setRegeneratingTitlePaneIds((current) => {
      const next = new Set([...current].filter((paneId) => ids.has(paneId)));
      if (next.size === current.size) {
        return current;
      }
      regeneratingTitlePaneIdsRef.current = next;
      return next;
    });
    setBrowserOverlayByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([ownerId]) => browserOwnerIds.has(ownerId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setTranscriptExpandedByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([paneId]) => ids.has(paneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setSplitTranscriptExpandedByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([paneId]) => ids.has(paneId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    for (const [agentId, pending] of pendingFirstTitleByAgentRef.current) {
      if (!ids.has(pending.paneId)) {
        pendingFirstTitleByAgentRef.current.delete(agentId);
      }
    }
    for (const paneId of Object.keys(titleRegenerationSeqByPaneRef.current)) {
      if (!ids.has(paneId)) {
        delete titleRegenerationSeqByPaneRef.current[paneId];
      }
    }
  }, [archivedResearchTrees, panes, researchTrees]);

  // A child stays alive while its overlay remains open, including inactive-tab
  // round trips. Closing the overlay, switching to Agent mode, moving to a
  // sandboxed preview, or deleting its owner retires it after the child effect
  // has published its final hidden revision.
  useEffect(() => {
    const nextOwnerIds = nativeHumanBrowserOwnerIds(browserOverlayByPane);
    const retired = [...nativeHumanBrowserOwnerIdsRef.current].filter(
      (ownerId) => !nextOwnerIds.has(ownerId),
    );
    nativeHumanBrowserOwnerIdsRef.current = nextOwnerIds;
    if (retired.length === 0) {
      return;
    }
    // No remaining React-owned child should be on screen. Sweep first so a
    // dropped per-owner destroy cannot leave the last WKWebView painted.
    if (nextOwnerIds.size === 0) {
      void hideEveryHumanBrowser();
    }
    for (const ownerId of retired) {
      void destroyHumanBrowser(ownerId).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }
  }, [browserOverlayByPane]);

  // Drop per-agent UI state for agents that no longer exist, so these maps and refs
  // don't grow unbounded across a long session of spawning and closing agents.
  useEffect(() => {
    const ids = new Set(agents.map((agent) => agent.id));
    transcriptOptionsRequestTrackerRef.current.retain(ids);
    const pruneRecord = <T,>(current: Record<string, T>): Record<string, T> => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    };
    setTranscriptNoticeByAgent(pruneRecord);
    setTranscriptOptionsByAgent(pruneRecord);
    setProcessingNewMessageByAgent(pruneRecord);
    setThinkingAgentIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
    for (const id of Object.keys(queuedTurnsByAgentRef.current)) {
      if (!ids.has(id)) delete queuedTurnsByAgentRef.current[id];
    }
    for (const id of Object.keys(draftsByAgentRef.current)) {
      if (!ids.has(id)) delete draftsByAgentRef.current[id];
    }
    for (const id of Object.keys(hookEventsByAgentRef.current)) {
      if (!ids.has(id)) delete hookEventsByAgentRef.current[id];
    }
    for (const id of Object.keys(queueScrollByAgentRef.current)) {
      if (!ids.has(id)) delete queueScrollByAgentRef.current[id];
    }
    for (const id of Object.keys(transcriptScrollByAgentRef.current)) {
      if (!ids.has(id)) delete transcriptScrollByAgentRef.current[id];
    }
    for (const agentId of pendingFirstTitleByAgentRef.current.keys()) {
      if (!ids.has(agentId)) {
        pendingFirstTitleByAgentRef.current.delete(agentId);
      }
    }
  }, [agents]);

  useEffect(() => {
    setProcessingNewMessageByAgent((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([agentId]) => thinkingAgentIds.has(agentId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [thinkingAgentIds]);

  useEffect(() => {
    setProcessingNewMessageByAgent((current) => {
      const entries = Object.entries(current);
      if (entries.length === 0) {
        return current;
      }

      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      let next: Record<string, string | null> | null = null;
      const mutableNext = () => {
        next ??= { ...current };
        return next;
      };

      for (const [agentId, baselineUserTurnId] of entries) {
        const agent = agentsById.get(agentId);
        if (!agent) {
          delete mutableNext()[agentId];
          continue;
        }

        const agentTurns = turns.filter((turn) => turn.agentId === agentId);
        const adapter = getAgentUiAdapter(agent.adapter);
        const normalizedTurns = adapter.normalizeTurns?.(agentTurns) ?? agentTurns;
        const latestTurnId = latestUserTurnId(normalizedTurns);
        if (latestTurnId && latestTurnId !== baselineUserTurnId) {
          delete mutableNext()[agentId];
        }
      }

      return next ?? current;
    });
  }, [agents, processingNewMessageByAgent, turns]);

  useEffect(() => {
    const pendingAgentIds = Array.from(pendingFirstTitleByAgentRef.current.keys());
    if (pendingAgentIds.length === 0) {
      return;
    }

    for (const agentId of pendingAgentIds) {
      for (const turn of turns) {
        if (!pendingFirstTitleByAgentRef.current.has(agentId)) {
          break;
        }
        if (turn.agentId !== agentId) {
          continue;
        }
        const text = firstUserTurnText(turn);
        if (text) {
          applyPendingFirstMessageTitle(agentId, text, { turnId: turn.id });
        }
      }
    }
  }, [turns]);

  // Called on each keystroke in an agent's composer or terminal. Sets a backend
  // "typing" hold (so a finishing turn won't auto-drain into what the user is typing)
  // and schedules its release INPUT_DEQUEUE_HOLD_MS after the last keystroke; the
  // release drains a held turn if the agent is idle.
  function noteUserInput(agentId: string) {
    const current = agentTypingRef.current;
    if (current && current.agentId !== agentId) {
      // The user moved to a different agent; release the previous hold immediately.
      window.clearTimeout(current.timer);
      void setAgentTyping(current.agentId, false).catch(() => undefined);
      agentTypingRef.current = null;
    }
    if (agentTypingRef.current) {
      window.clearTimeout(agentTypingRef.current.timer);
    } else {
      void setAgentTyping(agentId, true).catch(() => undefined);
    }
    const timer = window.setTimeout(() => {
      agentTypingRef.current = null;
      void setAgentTyping(agentId, false).catch(() => undefined);
    }, INPUT_DEQUEUE_HOLD_MS);
    agentTypingRef.current = { agentId, timer };
  }

  // Opens (or replaces) a pane's browser overlay with a URL, bumping the reload nonce
  // so even re-opening the same URL reloads. Driven by the browser.open event.
  // `sandbox` is set for token-bearing file-server URLs so the iframe loads them in an
  // opaque origin (see BrowserOverlay); plain http(s) URLs are not sandboxed.
  const openBrowserOverlay = useCallback(
    (paneId: string, url: string, sandbox = false, artifactId: string | null = null) => {
      // Force the sandbox on for any token-bearing file-server URL regardless of the
      // caller's flag: only the backend browser.open event passes sandbox=true, so typed
      // navigation and link opens would otherwise load a file-server URL as a trusted
      // same-origin document and defeat the token protection. Dev-server URLs are excluded
      // by isFileServerUrl and keep their real same-origin context.
      const effectiveSandbox =
        sandbox || isFileServerUrl(url, configRef.current?.fileServerPort ?? null);
      setBrowserOverlayByPane((current) => ({
        ...current,
        [paneId]: {
          url,
          open: true,
          artifactId,
          reloadNonce: (current[paneId]?.reloadNonce ?? 0) + 1,
          sandbox: effectiveSandbox,
          mode: effectiveSandbox ? "webkit" : (current[paneId]?.mode ?? "webkit"),
          size: current[paneId]?.size ?? null,
          fullWidth: current[paneId]?.fullWidth ?? false,
        },
      }));
    },
    [],
  );

  const openLinkForPane = useCallback(
    (paneId: string | null | undefined, url: string) => {
      const localPath = pathFromSessionFileHref(url);
      const fileServerPort = configRef.current?.fileServerPort ?? null;
      if (localPath) {
        if (!paneId) {
          setError(`Cannot open local file without an active pane: ${localPath}`);
          return;
        }
        const paneCwd = panesRef.current.find((pane) => pane.id === paneId)?.cwd;
        const resolvedPath = resolveLocalLinkPath(localPath, paneCwd);
        if (
          browserOverlayShowsLink(
            browserOverlayByPaneRef.current[paneId],
            { path: resolvedPath },
            fileServerPort,
          )
        ) {
          setBrowserOverlayByPane((current) => closeBrowserOverlayState(current, paneId));
          return;
        }
        // Absolute filesystem paths from transcript markdown (e.g. an agent
        // linking `/Users/…/report.html`). Mint a token-scoped file-server URL
        // and load it sandboxed — never as a fake https:// host or human-browser
        // navigation, which both mishandle path-shaped hrefs.
        void browserOpenLocalPath(paneId, localPath).catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        });
        return;
      }
      if (paneId && canRenderInInternalBrowser(url)) {
        if (
          browserOverlayShowsLink(
            browserOverlayByPaneRef.current[paneId],
            { url },
            fileServerPort,
          )
        ) {
          setBrowserOverlayByPane((current) => closeBrowserOverlayState(current, paneId));
          return;
        }
        openBrowserOverlay(paneId, url);
      } else {
        void openExternalUrl(url);
      }
    },
    [openBrowserOverlay],
  );

  function toggleBrowserOverlay(paneId: string) {
    setBrowserOverlayByPane((current) => {
      const prev = current[paneId];
      return {
        ...current,
        [paneId]: {
          url: prev?.url ?? null,
          open: !(prev?.open ?? false),
          artifactId: prev?.artifactId ?? null,
          reloadNonce: prev?.reloadNonce ?? 0,
          sandbox: prev?.sandbox ?? false,
          mode: prev?.mode ?? "webkit",
          size: prev?.size ?? null,
          fullWidth: prev?.fullWidth ?? false,
        },
      };
    });
  }

  function reportHumanBrowserError(error: unknown) {
    setError(error instanceof Error ? error.message : String(error));
  }

  // Collapse every native child. A dropped AppKit hide can leave a white
  // WKWebView square over the terminal after React state already marks the
  // overlay as closed; this is the recovery path for that leftover.
  function hideEveryHumanBrowser() {
    return hideAllHumanBrowsers().catch((error) => {
      reportHumanBrowserError(error);
      return 0;
    });
  }

  function closeAllBrowserOverlays() {
    setBrowserOverlayByPane((current) => closeAllBrowserOverlaysState(current));
    void hideEveryHumanBrowser();
  }

  function toggleActiveBrowserOverlay() {
    if (anyBrowserOverlayOpen(browserOverlayByPaneRef.current)) {
      closeAllBrowserOverlays();
      return;
    }
    void hideEveryHumanBrowser().then((hidden) => {
      if (hidden > 0) {
        return;
      }
      const ownerId = activeBrowserOwnerIdRef.current;
      if (ownerId) {
        toggleBrowserOverlay(ownerId);
      }
    });
  }

  function closeActiveBrowserOverlay() {
    if (anyBrowserOverlayOpen(browserOverlayByPaneRef.current)) {
      closeAllBrowserOverlays();
      return;
    }
    void hideEveryHumanBrowser();
  }

  function setBrowserOverlaySize(paneId: string, size: BrowserOverlaySize) {
    setBrowserOverlayByPane((current) => {
      const prev = current[paneId];
      if (!prev) {
        return current;
      }
      return { ...current, [paneId]: { ...prev, size } };
    });
  }

  function setBrowserOverlayFullWidth(paneId: string, fullWidth: boolean) {
    setBrowserOverlayByPane((current) => {
      const prev = current[paneId];
      if (!prev) {
        return current;
      }
      return { ...current, [paneId]: { ...prev, fullWidth } };
    });
  }

  function setBrowserOverlayMode(
    paneId: string,
    mode: BrowserOverlayMode,
    currentUrl?: string | null,
  ) {
    setBrowserOverlayByPane((current) => {
      const prev = current[paneId];
      if (!prev || (prev.sandbox && mode === "agent")) {
        return current;
      }
      const transferableUrl = (() => {
        if (!currentUrl) {
          return null;
        }
        try {
          const parsed = new URL(currentUrl);
          return parsed.protocol === "http:" || parsed.protocol === "https:"
            ? parsed.href
            : null;
        } catch {
          return null;
        }
      })();
      const nextUrl = mode === "webkit" && transferableUrl ? transferableUrl : prev.url;
      return {
        ...current,
        [paneId]: {
          ...prev,
          mode,
          url: nextUrl,
          artifactId: nextUrl === prev.url ? prev.artifactId : null,
          reloadNonce:
            mode === "webkit" && nextUrl !== prev.url
              ? prev.reloadNonce + 1
              : prev.reloadNonce,
        },
      };
    });
  }

  function setHumanBrowserLocation(paneId: string, nextUrl: string) {
    let normalized: string;
    try {
      const parsed = new URL(nextUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return;
      }
      normalized = parsed.href;
    } catch {
      return;
    }
    setBrowserOverlayByPane((current) => {
      const previous = current[paneId];
      if (
        !previous?.open ||
        previous.mode !== "webkit" ||
        previous.sandbox ||
        previous.url === normalized
      ) {
        return current;
      }
      return {
        ...current,
        [paneId]: { ...previous, url: normalized, artifactId: null },
      };
    });
  }

  function toggledPaneRecord(current: Record<string, boolean>, paneId: string) {
    const next = { ...current };
    if (next[paneId]) {
      delete next[paneId];
    } else {
      next[paneId] = true;
    }
    return next;
  }

  function paneRecordWithFlag(
    current: Record<string, boolean>,
    paneId: string,
    expanded: boolean,
  ) {
    if (expanded) {
      return current[paneId] ? current : { ...current, [paneId]: true };
    }
    if (!current[paneId]) {
      return current;
    }
    const next = { ...current };
    delete next[paneId];
    return next;
  }

  function setTranscriptExpandedForPane(
    paneId: string,
    expanded: boolean,
    splitMode = splitLayoutActive,
  ) {
    if (!expanded) {
      setFocusedAssistantTurn(null);
    }
    if (splitMode) {
      const paneIds = paneSplitForPane(paneSplitsRef.current, paneId)?.paneIds ?? [paneId];
      setSplitTranscriptExpandedByPane((current) =>
        setPaneSplitFlagEnabled(current, paneIds, expanded),
      );
      return;
    }
    setTranscriptExpandedByPane((current) => paneRecordWithFlag(current, paneId, expanded));
  }

  function focusTerminalPaneAfterChromeChange(paneId: string | null | undefined) {
    if (!paneId) {
      return;
    }
    if (paneChromeFocusFrameRef.current !== null) {
      cancelAnimationFrame(paneChromeFocusFrameRef.current);
    }
    paneChromeFocusFrameRef.current = requestAnimationFrame(() => {
      paneChromeFocusFrameRef.current = null;
      if (activePaneIdRef.current === paneId) {

      }
    });
  }

  function setRightBarCollapsedForPane(collapsed: boolean, paneId: string | null | undefined) {
    const groupId = panesRef.current.find((pane) => pane.id === paneId)?.groupId;
    if (!groupId) {
      return;
    }
    setRightBarCollapsedByGroup((current) =>
      current[groupId] === collapsed ? current : { ...current, [groupId]: collapsed },
    );
    focusTerminalPaneAfterChromeChange(paneId);
  }

  function setLeftSidebarCollapsedForActivePane(collapsed: boolean) {
    setLeftSidebarCollapsed(collapsed);
    if (collapsed) {
    }
    focusTerminalPaneAfterChromeChange(
      activeSurfaceRef.current === "pane" ? activePaneIdRef.current : null,
    );
  }

  function toggleTranscriptExpandedForPane(paneId: string, splitMode = splitLayoutActive) {
    if (splitMode) {
      const paneIds = paneSplitForPane(paneSplitsRef.current, paneId)?.paneIds ?? [paneId];
      setSplitTranscriptExpandedByPane((current) =>
        setPaneSplitFlagEnabled(current, paneIds, !paneSplitFlagIsEnabled(current, paneIds)),
      );
      return;
    }
    setTranscriptExpandedByPane((current) => toggledPaneRecord(current, paneId));
  }

  function toggleActiveTranscriptExpanded() {
    const paneId = activePane?.id;
    const canExpandStageSplit =
      splitOverlayTranscriptMode && splitOverlayTurnPaneSurfaces.length > 0;
    if (!paneId || (!activePaneCanToggleTurnSidebar && !canExpandStageSplit)) {
      return;
    }

    if (rightBarCollapsed && activePaneCanToggleTurnSidebar) {
      setRightBarCollapsedForPane(false, paneId);
      return;
    }

    if (activeTranscriptExpanded) {
      setFocusedAssistantTurn(null);
    }
    toggleTranscriptExpandedForPane(paneId);
  }

  function expandNewAgentTranscriptByDefault(pane: PaneInfo) {
    if (settingsRef.current.codeMode || pane.kind !== "agent") {
      return;
    }
    setTranscriptExpandedByPane((current) =>
      current[pane.id] ? current : { ...current, [pane.id]: true },
    );
  }

  function refreshActiveBrowserOverlay() {
    if (!activeBrowserOwnerId) {
      return;
    }
    const overlay = browserOverlayByPaneRef.current[activeBrowserOwnerId];
    if (overlay?.open && overlay.mode === "webkit" && !overlay.sandbox) {
      void reloadHumanBrowser(activeBrowserOwnerId).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    setBrowserOverlayByPane((current) => {
      const prev = current[activeBrowserOwnerId];
      if (!prev) {
        return current;
      }
      return {
        ...current,
        [activeBrowserOwnerId]: { ...prev, reloadNonce: prev.reloadNonce + 1 },
      };
    });
  }

  // Navigate the overlay's selected browser. A bare host (no scheme) gets http://
  // so `localhost:5173` works; file paths still go through `session open`.
  function navigateActiveBrowserOverlay(rawInput: string) {
    const trimmed = rawInput.trim();
    if (!activeBrowserOwnerId || !trimmed) {
      return;
    }
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      openBrowserOverlay(activeBrowserOwnerId, parsed.href);
    } else if (parsed.protocol === "mailto:") {
      void openExternalUrl(parsed.href);
    }
  }

  // One stable LinkActions object per transcript owner. TurnOverlay and the
  // research document feed this into the shared provider. Context changes bypass
  // memoization — a fresh object per App render re-rendered every markdown link in the
  // transcript on every unrelated state change. Actions read the opener through
  // a ref so the cached closures never go stale.
  const openLinkForPaneRef = useRef(openLinkForPane);
  openLinkForPaneRef.current = openLinkForPane;
  const linkActionsByPaneRef = useRef(new Map<string, LinkActions>());
  // Closed panes never render again, so drop their cached actions.
  useEffect(() => {
    const livePaneIds = new Set(panes.map((pane) => pane.id));
    for (const paneId of linkActionsByPaneRef.current.keys()) {
      // Research owners are exempt from pane-based eviction (they aren't
      // panes); the cached closures are tiny and a session's tree count is
      // small, so they're simply retained.
      if (!paneId.startsWith(RESEARCH_BROWSER_OWNER_PREFIX) && !livePaneIds.has(paneId)) {
        linkActionsByPaneRef.current.delete(paneId);
      }
    }
  }, [panes]);
  function linkActionsForPane(paneId: string): LinkActions {
    const cache = linkActionsByPaneRef.current;
    let actions = cache.get(paneId);
    if (!actions) {
      actions = {
        openLink: (url) => {
          openLinkForPaneRef.current(paneId, url);
        },
        openLinkMenu: (url, x, y) => setLinkMenu({ url, x, y, paneId }),
        openCodexInlineVisualization: (file) => {
          void browserOpenCodexInlineVisualization(paneId, file).catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
          });
        },
        openCodexVisualizationReference: async (reference) => {
          setError(null);
          try {
            await browserOpenCodexVisualizationReference(paneId, reference.path);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            throw err;
          }
        },
      };
      cache.set(paneId, actions);
    }
    return actions;
  }

  function turnInfoForAgent(agent: AgentInfo | undefined): AgentTurnInfo {
    if (!agent) {
      return {
        turns: [],
        assistantLabel: "Claude",
        getTranscript: () => "",
        getPlainTextTranscript: () => "",
        hasTranscript: false,
        conversationHistory: null,
      };
    }
    return (
      agentTurnInfoById.get(agent.id) ?? {
        turns: [],
        assistantLabel: getAgentUiAdapter(agent.adapter).label,
        getTranscript: () => "",
        getPlainTextTranscript: () => "",
        hasTranscript: false,
        conversationHistory: null,
      }
    );
  }

  function waitTargetsForAgent(activeWaitAgent: AgentInfo | undefined): WaitTarget[] {
    if (!activeWaitAgent) {
      return [];
    }
    return sidebarPanes
      .flatMap((pane) => {
        const agent = agentByPaneId.get(pane.id);
        if (!agent) {
          return [];
        }
        if (agent.id === activeWaitAgent.id || agent.status === "failed") {
          return [];
        }
        const queuedTurns = queuedTurnsByAgent[agent.id] ?? [];
        const hasActiveWork =
          agent.status === "starting" ||
          agent.status === "running" ||
          agent.status === "awaitingInput" ||
          agent.status === "awaitingPermission";
        if (!hasActiveWork && queuedTurns.length === 0) {
          return [];
        }
        return [
          {
            agentId: agent.id,
            paneId: pane.id,
            label: displayPaneTitle(pane, agent),
            status: agent.status,
            queueCount: queuedTurns.length,
            queueBlocked: Boolean(queuedTurns[0]?.waitFor),
          },
        ];
      });
  }

  function orphanedQueuesForPane(pane: PaneInfo | undefined): OrphanedQueueGroup[] {
    if (!pane) {
      return [];
    }
    return agents
      .filter((agent) => agent.orphanedQueuePaneId === pane.id)
      .map((agent) => ({
        agent,
        queuedTurns: queuedTurnsByAgent[agent.id] ?? [],
      }))
      .filter((queue) => queue.queuedTurns.length > 0);
  }

  function turnPaneSurfaceForPane(pane: PaneInfo, splitIndex = -1): TurnPaneSurface {
    const agent = agentByPaneId.get(pane.id);
    const turnInfo = turnInfoForAgent(agent);
    const threadId = agent ? threadIdForAgent(agent) : null;
    const conversationHistoryState = threadId
      ? conversationHistoryByThread[threadId]
      : undefined;
    const conversationHistory = (conversationHistoryState?.snapshots ?? [])
      .slice()
      .reverse()
      .map((snapshot) => ({
        snapshotId: snapshot.id,
        turns:
          getAgentUiAdapter(snapshot.adapter).normalizeTurns?.(snapshot.turns) ?? snapshot.turns,
      }));
    const loadedSnapshots = conversationHistoryState?.snapshots ?? [];
    const oldestLoadedSnapshot = loadedSnapshots[loadedSnapshots.length - 1];
    const previousConversationSnapshotId = oldestLoadedSnapshot
      ? (oldestLoadedSnapshot.previousSnapshotId ?? null)
      : (turnInfo.conversationHistory?.snapshotId ?? null);
    const orphanedQueues = orphanedQueuesForPane(pane);
    const topFraction =
      splitRightPaneMode && splitIndex > 0
        ? activeSplitFractions.slice(0, splitIndex).reduce((sum, value) => sum + value, 0)
        : 0;
    const heightFraction =
      splitRightPaneMode && splitIndex >= 0 ? (activeSplitFractions[splitIndex] ?? 0) : 1;

    return {
      pane,
      agent,
      turns: turnInfo.turns,
      assistantLabel: turnInfo.assistantLabel,
      getTranscript: turnInfo.getTranscript,
      getPlainTextTranscript: turnInfo.getPlainTextTranscript,
      hasTranscript: turnInfo.hasTranscript,
      conversationHistory,
      hasPreviousConversation: Boolean(previousConversationSnapshotId),
      previousConversationSnapshotId,
      previousConversationLoading: conversationHistoryState?.loading ?? false,
      previousConversationError: conversationHistoryState?.error ?? null,
      transcriptNotice: agent ? (transcriptNoticeByAgent[agent.id] ?? null) : null,
      transcriptOptions: agent ? (transcriptOptionsByAgent[agent.id] ?? []) : [],
      queuedTurns: agent ? (queuedTurnsByAgent[agent.id] ?? []) : [],
      waitTargets: waitTargetsForAgent(agent),
      draft: agent ? (draftsByAgent[agent.id] ?? "") : "",
      orphanedQueues,
      queueSplit: agent ? (queueSplitByAgent[agent.id] ?? false) : false,
      queueSplitHeight: agent ? queueSplitHeightByAgent[agent.id] : undefined,
      browserOverlay: browserOverlayByPane[pane.id],
      topFraction,
      heightFraction,
      hasTurnSidebar: Boolean(agent) || orphanedQueues.length > 0,
    };
  }

  const activeTurnPaneSurface = activePane
    ? turnPaneSurfaceForPane(
        activePane,
        activePaneSplit ? activePaneSplit.paneIds.indexOf(activePane.id) : -1,
      )
    : null;
  const splitTurnPaneSurfaces = splitRightPaneMode
    ? visibleTerminalPanes
        .map((pane, index) => turnPaneSurfaceForPane(pane, index))
        .filter((surface) => surface.hasTurnSidebar)
    : [];
  const splitOverlayTurnPaneSurfaces = splitLayoutActive
    ? visibleTerminalPanes
        .map((pane, index) => turnPaneSurfaceForPane(pane, index))
        .filter((surface) => surface.hasTurnSidebar)
    : [];
  const visibleTurnPaneSurfaces = splitRightPaneMode
    ? splitTurnPaneSurfaces
    : splitOverlayTranscriptMode
      ? []
      : activeTurnPaneSurface?.hasTurnSidebar
        ? [activeTurnPaneSurface]
        : [];
  const activePaneHasTurnSidebar = Boolean(activeTurnPaneSurface?.hasTurnSidebar);
  const activePaneCanToggleTurnSidebar =
    !splitOverlayTranscriptMode &&
    canToggleTurnSidebar(
      activePaneHasTurnSidebar,
      splitRightPaneMode,
      splitTurnPaneSurfaces.length,
    );
  const visibleRightBarSurfaces = rightBarCollapsed ? [] : visibleTurnPaneSurfaces;
  const hasVisibleRightBar = visibleRightBarSurfaces.length > 0;
  const hasGlobalTurnSidebar = hasVisibleRightBar && !splitRightPaneMode;
  const splitTranscriptExpanded = Boolean(
    activePaneSplit &&
      paneSplitFlagIsEnabled(splitTranscriptExpandedByPane, activePaneSplit.paneIds),
  );
  const activeTranscriptExpanded = splitLayoutActive
    ? splitTranscriptExpanded && splitOverlayTurnPaneSurfaces.length > 0
    : Boolean(activePane && activePaneHasTurnSidebar && transcriptExpandedByPane[activePane.id]);
  const activeTranscriptVisibleExpanded =
    activeTranscriptExpanded && (splitOverlayTranscriptMode || !rightBarCollapsed);
  const overlayTurnPaneSurfaces = splitLayoutActive
    ? splitOverlayTurnPaneSurfaces
    : visibleRightBarSurfaces;
  const focusedAssistantTurnSurface = focusedAssistantTurn
    ? overlayTurnPaneSurfaces.find(
        (surface) => surface.pane.id === focusedAssistantTurn.paneId,
      )
    : undefined;
  useEffect(() => {
    if (
      focusedAssistantTurn &&
      (!activeTranscriptVisibleExpanded || !focusedAssistantTurnSurface)
    ) {
      if (focusedAssistantTurn.restoreDockedOnClose) {
        setTranscriptExpandedForPane(
          focusedAssistantTurn.paneId,
          false,
          focusedAssistantTurn.splitMode,
        );
      }
      setFocusedAssistantTurn(null);
    }
  }, [
    activeTranscriptVisibleExpanded,
    focusedAssistantTurn,
    focusedAssistantTurnSurface,
  ]);
  const activePaneHasTurnPaneHeader = Boolean(
    hasGlobalTurnSidebar && activePaneHasTurnSidebar,
  );
  const activePaneReservesTurnPaneWidth = Boolean(
    hasGlobalTurnSidebar ||
      (splitRightPaneMode &&
        !rightBarCollapsed &&
        activePaneHasTurnSidebar &&
        !activeTranscriptVisibleExpanded),
  );
  const visibleTurnPaneAgentIds = visibleRightBarSurfaces
    .map((surface) => surface.agent?.id)
    .filter((agentId): agentId is string => Boolean(agentId));
  const visibleTurnPaneAgentIdsKey = visibleTurnPaneAgentIds.join("\0");
  const visibleTurnPaneAgentIdsRef = useRef(visibleTurnPaneAgentIds);
  visibleTurnPaneAgentIdsRef.current = visibleTurnPaneAgentIds;

  const imageLightbox = useSyncExternalStore(
    subscribeImageLightbox,
    getImageLightbox,
    getImageLightbox,
  );
  // Same story as the image lightbox: the diagram lightbox lives in a module
  // store, and subscribing here is what makes an open lightbox participate in
  // the native input policy below.
  const diagramLightbox = useSyncExternalStore(
    subscribeDiagramLightbox,
    getDiagramLightbox,
    getDiagramLightbox,
  );
  // This is the shared hard-input policy for every visible native surface and
  // for the logical owner calculation below. Keeping it single-sourced avoids
  // a modal disabling pointer claims while the owner coordinator still grants
  // keyboard input (or vice versa).
  // Only a search/confirm overlay on a *visible* pane should revoke native
  // keyboard ownership. A pane keeps its overlay-open state while hidden (a
  // find bar left open when the user switched tabs), and its unchanged
  // searchOpen never re-fires the publish effect — so gating on the raw set
  // would let an off-screen pane keyboard-deaden the terminal actually on
  // screen. Intersecting with the visible set matches how the expanded
  // transcript and browser overlays are already visibility-derived.
  const nativeModalOccluded = Boolean(
    settingsOpen ||
      agentsOpen ||
      imageLightbox !== null ||
      diagramLightbox !== null ||
      terminalMapOpen ||
      commandPaletteOpen ||
      repositoryBrowser ||
      worktreeCreateDialog ||
      closeDialog ||
      exitDialog ||
      exitPreflightRequest ||
      renamePaneId ||
      renameGroupId ||
      linkMenu,
  );
  const nativeBrowserOccluded = Boolean(
    nativeModalOccluded || appToast || userNotifications.length > 0 || folderPickerStatus,
  );
  const nativeBrowserGeometryRevision = activeTranscriptVisibleExpanded
    ? -1
    : activePaneReservesTurnPaneWidth
      ? turnPaneWidth
      : 0;
  useLayoutEffect(() => {
    if (!IS_MAC) {
      return;
    }
    void setNativeBrowserOverlayOpen(activeBrowserOverlay?.open === true).catch(
      () => undefined,
    );
  }, [activeBrowserOverlay?.open]);

  // Load session lists when a pane's right side is visible so transcript pickers are ready.
  useEffect(() => {
    for (const agentId of visibleTurnPaneAgentIds) {
      void refreshTranscriptOptions(agentId);
    }
    // refreshTranscriptOptions only touches stable setters/imports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTurnPaneAgentIdsKey]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  function replaceQueuedTurnsByAgent(nextQueues: Record<string, QueuedTurn[]>) {
    queuedTurnsByAgentRef.current = nextQueues;
    setQueuedTurnsByAgentState(nextQueues);
  }

  function setAgentQueuedTurns(agentId: string, queuedTurns: QueuedTurn[]) {
    // Any write advances the agent's queue generation so a slower in-flight
    // refreshAgentTurnQueue() sees it was superseded and drops its stale list.
    agentTurnQueueSeqRef.current[agentId] = (agentTurnQueueSeqRef.current[agentId] ?? 0) + 1;
    const previousQueues = queuedTurnsByAgentRef.current;
    const nextQueues = {
      ...previousQueues,
      [agentId]: queuedTurns,
    };
    queuedTurnsByAgentRef.current = nextQueues;
    setQueuedTurnsByAgentState(nextQueues);
  }

  // Composer-local edit flushers, registered by each mounted NativeInput. The
  // composer holds keystrokes locally behind a short debounce, so a quit/close
  // flush must first pull those edits into draftsByAgentRef before writing to
  // disk — otherwise the last moments of typing are invisible to it.
  const composerDraftFlushersRef = useRef(new Set<() => void>());

  // Flushes every still-pending debounced draft right now (used when the window is
  // going away, so the last second of typing is not lost on a quick close).
  function flushPendingDrafts() {
    // Drain composer-local edits first; each flusher synchronously pushes into
    // draftsByAgentRef (and re-arms a disk timer that the loop below collects).
    for (const flush of composerDraftFlushersRef.current) {
      flush();
    }
    const timers = draftFlushTimersRef.current;
    for (const [agentId, timer] of Object.entries(timers)) {
      clearTimeout(timer);
      delete timers[agentId];
      void persistAgentDraft(agentId, draftsByAgentRef.current[agentId] ?? "").catch(
        () => undefined,
      );
    }
  }

  // Compact directory label for a pane tab. Worktrees under the workspace root
  // are shown relative to it (e.g. "group-1/agent-1"); home paths use ~/ and
  // other paths fall back to their last two segments so the meaningful tail stays
  // visible. The full path is preserved in the tab's title attribute.
  function formatPaneDir(rawPath: string): string {
    const workspaceRoot = config?.workspaceRoot;
    if (workspaceRoot && rawPath.startsWith(`${workspaceRoot}/`)) {
      const relative = rawPath.slice(workspaceRoot.length + 1);
      // When the workspace root is the home directory itself, the path is being
      // shown relative to home, so anchor it with ~/ instead of leaving bare
      // segments. A root that is a deeper child of home already reads clearly as
      // a relative path, so it is left unchanged.
      return config?.homeDir && workspaceRoot === config.homeDir
        ? `~/${relative}`
        : relative;
    }
    const homeDir = config?.homeDir;
    if (homeDir && rawPath === homeDir) {
      return "~";
    }
    if (homeDir && rawPath.startsWith(`${homeDir}/`)) {
      return `~/${rawPath.slice(homeDir.length + 1)}`;
    }
    const segments = rawPath.split("/").filter(Boolean);
    if (segments.length <= 2) {
      return rawPath;
    }
    return `…/${segments.slice(-2).join("/")}`;
  }

  // The directory a group's default title reflects: its root terminal (the first,
  // oldest shell pane in the group), falling back to the group's creation-time seed
  // dir when the group has no shell pane yet (empty, or agent-only — whose worktree
  // dirs shouldn't name the group). Groups are advisory, so the title tracks where
  // the group's work is rooted rather than a fixed stored directory, and is stable
  // against focus changes. Reactive: a cd in the root terminal patches panes[].cwd
  // (pane.cwd_changed), and closing it promotes the next shell — both re-derive here.
  function groupRootDir(group: GroupInfo): string {
    const rootShell = panes.find(
      (pane) => pane.groupId === group.id && pane.kind === "shell",
    );
    return rootShell?.cwd || group.dir;
  }

  function defaultGroupName(group: GroupInfo): string {
    const dir = groupRootDir(group);
    const base = dir.split("/").filter(Boolean).pop();
    return base && base.length > 0 ? base : formatPaneDir(dir);
  }

  function displayGroupName(group: GroupInfo): string {
    return group.nameOverride?.trim() || defaultGroupName(group);
  }

  // Computes the spawned pane's position locally and returns the reordered
  // list without waiting for the backend to persist that order, so the new
  // pane mounts — and its terminal becomes visible — one IPC round-trip
  // sooner. The backend's authoritative result reconciles the list when it
  // arrives; if persisting fails (e.g. the pane already closed), the backend
  // keeps spawn (append) order and the next authoritative pane update applies
  // it here too, so the failure is deliberately not surfaced as a spawn error.
  function placePaneAfterOptimistically(
    pane: PaneInfo,
    siblingPaneId: string | null,
    persistPlacement = true,
  ): PaneInfo[] {
    const current = panesRef.current.filter((existing) => existing.id !== pane.id);
    if (!siblingPaneId || siblingPaneId === pane.id) {
      return [...current, pane];
    }
    const siblingIndex = current.findIndex((existing) => existing.id === siblingPaneId);
    if (siblingIndex === -1) {
      return [...current, pane];
    }
    if (persistPlacement) {
      void placePaneAfter(pane.id, siblingPaneId)
        .then((orderedPanes) => setPanesPreservingRecoveredDismissals(orderedPanes))
        .catch(() => undefined);
    }
    return [...current.slice(0, siblingIndex + 1), pane, ...current.slice(siblingIndex + 1)];
  }

  async function refreshGroups() {
    setGroups(await listGroups());
  }

  // The new pane's grid, as a share of the pane it splits — not of the stage,
  // which is wrong for any pane nested inside a branch. Spawning at the wrong
  // grid means the first layout sync resizes a brand new PTY, and a resize
  // SIGWINCHes full-screen TUIs into a clear and re-layout.
  function estimateSplitPaneSize(
    sourcePane: PaneInfo,
    axis: PaneSplitAxis,
    scale: number,
  ): InitialPaneSize {
    const stage = estimateInitialPaneSize(false);
    const cols = sourcePane.cols > 0 ? sourcePane.cols : stage.cols;
    const rows = sourcePane.rows > 0 ? sourcePane.rows : stage.rows;
    if (axis === "horizontal") {
      return {
        rows: clamp(rows, MIN_INITIAL_ROWS, Math.max(MIN_INITIAL_ROWS, stage.rows)),
        cols: clamp(
          Math.floor(cols * scale),
          MIN_INITIAL_COLS,
          Math.max(MIN_INITIAL_COLS, stage.cols),
        ),
      };
    }
    return {
      cols: clamp(cols, MIN_INITIAL_COLS, Math.max(MIN_INITIAL_COLS, stage.cols)),
      rows: clamp(
        Math.floor(rows * scale),
        MIN_INITIAL_ROWS,
        Math.max(MIN_INITIAL_ROWS, stage.rows),
      ),
    };
  }

  async function splitPaneBelow(sourcePane: PaneInfo) {
    return splitTerminal(sourcePane, "vertical");
  }

  async function splitPaneRight(sourcePane: PaneInfo) {
    return splitTerminal(sourcePane, "horizontal");
  }

  /** Whether the pane can be split along `axis` without dropping a resulting
   * pane below the resize floor. A pane outside any split always can. */
  function canSplitTerminal(sourcePane: PaneInfo, axis: PaneSplitAxis) {
    const split = paneSplitForPane(paneSplitsRef.current, sourcePane.id);
    if (!split || split.paneIds.length < 2) {
      return true;
    }
    const stageRect = mainStageRef.current?.getBoundingClientRect();
    if (!stageRect) {
      return false;
    }
    return canSplitPaneInTree({
      split,
      paneId: sourcePane.id,
      axis,
      stage: { width: stageRect.width, height: stageRect.height },
      gutter: TERMINAL_SPLIT_GUTTER_PX,
      minWidth: TERMINAL_SPLIT_MIN_WIDTH,
      minHeight: TERMINAL_SPLIT_MIN_HEIGHT,
    });
  }

  async function splitTerminal(sourcePane: PaneInfo, requestedAxis: PaneSplitAxis) {
    const existingSplit = paneSplitForPane(paneSplitsRef.current, sourcePane.id);
    const inSplit = Boolean(existingSplit && existingSplit.paneIds.length >= 2);
    // Refusing beats producing an unusable pane, and bounding depth by real
    // screen area beats an arbitrary nesting cap.
    if (!canSplitTerminal(sourcePane, requestedAxis)) {
      return;
    }
    // Splitting along the pane's own branch axis appends a sibling; across it,
    // the pane becomes a two-child branch — the nesting step. Either way the new
    // tab lands immediately after the source, so tab order matches the tree.
    const branchAxis =
      inSplit && existingSplit ? splitAxisForPane(existingSplit, sourcePane.id) : null;
    const siblingCount =
      existingSplit && branchAxis === requestedAxis
        ? splitBranchChildCountForPane(existingSplit, sourcePane.id)
        : 1;
    const scale = siblingCount > 1 ? siblingCount / (siblingCount + 1) : 0.5;
    setError(null);
    try {
      const pane = await spawnShell(
        estimateSplitPaneSize(sourcePane, requestedAxis, scale),
        sourcePane.kind === "shell" ? sourcePane.id : null,
        sourcePane.groupId,
      );
      const orderedPanes = placePaneAfterOptimistically(pane, sourcePane.id);
      setPanesPreservingRecoveredDismissals(orderedPanes);
      savePaneSplits(
        joinPaneSplit(paneSplitsRef.current, orderedPanes, sourcePane.id, pane.id, {
          insertedPaneId: pane.id,
          source: "command",
          axis: requestedAxis,
          nestAxis: requestedAxis,
        }),
        orderedPanes,
      );
      setActivePaneId(pane.id);
      setLastActiveGroupId(pane.groupId);
      if (pane.remoteSession) requestAnimationFrame(() => requestAnimationFrame(() => recordRemoteStartup(pane.id, "visible")));
      await refreshGroups();
      requestAnimationFrame(() => {

      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshAgentTurnQueue(agentId: string) {
    const requestSeq = (agentTurnQueueSeqRef.current[agentId] ?? 0) + 1;
    agentTurnQueueSeqRef.current[agentId] = requestSeq;
    const queuedTurns = await listAgentTurnQueue(agentId);
    // A newer write (another refresh, or an event-driven queue update) landed while we
    // awaited, so our list is stale — drop it rather than overwrite fresher state.
    if (agentTurnQueueSeqRef.current[agentId] !== requestSeq) {
      return;
    }
    setAgentQueuedTurns(agentId, queuedTurns);
  }

  async function refreshTranscriptOptions(agentId: string) {
    const request = transcriptOptionsRequestTrackerRef.current.begin(agentId);
    try {
      const options = await listAgentTranscripts(agentId);
      if (!transcriptOptionsRequestTrackerRef.current.isLatest(agentId, request)) {
        return;
      }
      setTranscriptOptionsByAgent((current) => ({ ...current, [agentId]: options }));
    } catch {
      // The picker is a best-effort aid; a failed scan just leaves it hidden.
    }
  }

  function refreshVisibleTranscriptOptions(exceptAgentId?: string) {
    for (const agentId of visibleTurnPaneAgentIdsRef.current) {
      if (agentId !== exceptAgentId) {
        void refreshTranscriptOptions(agentId);
      }
    }
  }

  function paneIdsForSplitStatusGroup(paneId: string): string[] {
    const split = paneSplitForPane(paneSplitsRef.current, paneId);
    if (!split) {
      return [paneId];
    }
    const livePaneIds = new Set(panesRef.current.map((pane) => pane.id));
    const paneIds = split.paneIds.filter((candidate) => livePaneIds.has(candidate));
    return paneIds.length > 0 ? paneIds : [paneId];
  }

  function agentsForSplitStatusGroup(paneId: string): AgentInfo[] {
    const paneIds = new Set(paneIdsForSplitStatusGroup(paneId));
    return agentsRef.current.filter((agent) => agent.paneId && paneIds.has(agent.paneId));
  }

  function replaceAgents(updatedAgents: AgentInfo[]) {
    if (updatedAgents.length === 0) {
      return;
    }
    const updatedById = new Map<string, AgentInfo>(
      updatedAgents.map((agent) => [agent.id, agent]),
    );
    setAgents((current) => current.map((agent) => updatedById.get(agent.id) ?? agent));
  }

  async function acknowledgeAgentStatuses(
    targetAgents: AgentInfo[],
    includeFailed = false,
    checkBackend = false,
  ) {
    const dismissibleAgents = checkBackend
      ? targetAgents
      : targetAgents.filter(
          (agent) => agent.status === "done" || (includeFailed && agent.status === "failed"),
        );
    if (dismissibleAgents.length === 0) {
      return;
    }
    setError(null);
    try {
      const results = await Promise.all(
        dismissibleAgents.map((agent) =>
          acknowledgeAgent(agent.id, includeFailed).catch((err: unknown) => {
            // A pane close races the attention probe: the backend prunes the
            // agent before the frontend forgets its pane. Acknowledging a
            // pruned agent has nothing left to do (the close path already
            // released its waiters), so drop it instead of surfacing an error.
            if (String(err).includes(`agent ${agent.id} was not found`)) {
              return null;
            }
            throw err;
          }),
        ),
      );
      const acknowledged = results.filter((agent): agent is AgentInfo => agent !== null);
      replaceAgents(
        checkBackend ? applicableSpeculativeAcknowledgements(acknowledged) : acknowledged,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function acknowledgePaneIfDone(
    paneId: string | null,
    checkBackend = false,
    intentional = false,
  ) {
    if (!paneId) {
      return;
    }
    const attentionBase = {
      activeSurface: activeSurfaceRef.current,
      activePaneId: activePaneIdRef.current,
      paneId,
      paneExists: panesRef.current.some((pane) => pane.id === paneId),
      documentVisible: document.visibilityState === "visible",
    };
    // App focus covers both the webview and a native terminal first-responder
    // inside the focused Session window. document.hasFocus() alone misses the
    // latter, which is exactly how keyboard tab switches arrive.
    const appFocused = document.hasFocus() || nativeWindowFocusedRef.current;
    const allowed = intentional
      ? terminalPaneWasIntentionallyActivated(attentionBase)
      : terminalPaneHasUserAttention({ ...attentionBase, appFocused });
    if (!allowed) {
      return;
    }
    if (checkBackend) {
      const now = performance.now();
      const lastProbeAt = terminalAttentionProbeAtRef.current.get(paneId);
      // Intentional activation always probes: a prior ambient key/scroll probe
      // on this pane must not swallow the Done clear for a real tab switch.
      if (!intentional && !terminalAttentionProbeIsDue(lastProbeAt, now)) {
        return;
      }
      terminalAttentionProbeAtRef.current.set(paneId, now);
    }
    void acknowledgeAgentStatuses(agentsForSplitStatusGroup(paneId), false, checkBackend);
  }

  function maxTurnPaneWidth() {
    const appWidth = appRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const available = Math.floor(appWidth - effectiveSidebarWidth - TERMINAL_MIN_WIDTH);
    return Math.max(TURN_PANE_MIN_WIDTH, Math.min(TURN_PANE_MAX_WIDTH, available));
  }

  function clampTurnPaneWidth(width: number) {
    return clamp(width, TURN_PANE_MIN_WIDTH, maxTurnPaneWidth());
  }

  // The sidebar may grow until the terminal stage would fall below its minimum
  // (with the turn pane's current width reserved), capped by a comfortable
  // absolute maximum. Column splits reserve 200px per pane plus gutters.
  function maxSidebarWidth() {
    const appWidth = appRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const reservedTurnPane = hasVisibleRightBar ? turnPaneWidth : 0;
    const available = Math.floor(
      appWidth - reservedTerminalStageMinWidth - reservedTurnPane,
    );
    return Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(LEFT_SIDEBAR_MAX_WIDTH, available));
  }

  function clampSidebarWidth(width: number) {
    // Keep the sidebar boundary on a whole CSS pixel so its 1px separator
    // cannot be antialiased across two adjacent pixel columns.
    return Math.round(clamp(width, LEFT_SIDEBAR_MIN_WIDTH, maxSidebarWidth()));
  }

  function estimateInitialPaneSize(_willShowTurnPane: boolean): InitialPaneSize {
    return { cols: DEFAULT_INITIAL_COLS, rows: DEFAULT_INITIAL_ROWS };
  }

  // Preserve the existing bounded research/transcript text zoom.
  const turnFontDelta = Math.min(1, Math.max(0, (settings.textSize - APP_TEXT_SIZE) * 0.25));
  const transcriptExpandedFontDelta = activeTranscriptVisibleExpanded ? 1 : 0;
  const transcriptExpandedLineHeightDelta = activeTranscriptVisibleExpanded ? 0.1 : 0;

  const appStyle = {
    "--font-ui": bodyFontFamily,
    "--sidebar-width": `${effectiveSidebarWidth}px`,
    "--browser-overlay-left": `${BROWSER_OVERLAY_LEFT_MARGIN}px`,
    "--turn-font-delta": `${turnFontDelta}px`,
    "--transcript-expanded-font-delta": `${transcriptExpandedFontDelta}px`,
    "--transcript-expanded-line-height-delta": `${transcriptExpandedLineHeightDelta}`,
    ...(rightBarCollapsed && activePaneHasTurnSidebar
      ? { "--right-bar-restore-control-offset": "34px" }
      : {}),
    ...(activePaneReservesTurnPaneWidth ? { "--turn-pane-width": `${turnPaneWidth}px` } : {}),
    ...(splitRightPaneMode && hasVisibleRightBar
      ? { "--inline-turn-pane-width": `${turnPaneWidth}px` }
      : {}),
  } as CSSProperties;

  const titleGenerationTestVisible = settings.tabTitleProvider === "openRouter";
  const titleGenerationTestRunning = titleGenerationTest?.status === "running";

  useAppStartup({
    applySecondary: ({ storedOpenRouterKey, storedUseLoginShell, storedWorktreeLocation,
      storedResearchLaunchInstruction, queueEntries, draftEntries }) => {
      // Hydrate the OpenRouter key from the backend (its durable home). If the backend
      // has none but a key survives in an old localStorage settings blob, migrate that
      // value into the backend once; either way the in-memory settings track the key.
      setSettings((current) => {
        const backendKey = storedOpenRouterKey.trim();
        const migratedKey = current.openRouterKey.trim();
        const effectiveKey = backendKey || migratedKey;
        const effectiveUseLoginShell = storedUseLoginShell ?? current.useLoginShell;
        const effectiveWorktreeLocation =
          storedWorktreeLocation ?? current.worktreeLocation;
        const effectiveResearchLaunchInstruction = clampResearchLaunchInstruction(
          storedResearchLaunchInstruction ?? current.researchLaunchInstruction,
        );
        if (!backendKey && migratedKey) {
          void setOpenRouterKey(migratedKey).catch(() => undefined);
        }
        openRouterKeyHydratedRef.current = true;
        useLoginShellHydratedRef.current = true;
        worktreeLocationHydratedRef.current = true;
        researchLaunchInstructionHydratedRef.current = true;
        return current.openRouterKey === effectiveKey &&
          current.useLoginShell === effectiveUseLoginShell &&
          current.worktreeLocation === effectiveWorktreeLocation &&
          current.researchLaunchInstruction === effectiveResearchLaunchInstruction
          ? current
          : {
              ...current,
              openRouterKey: effectiveKey,
              useLoginShell: effectiveUseLoginShell,
              worktreeLocation: effectiveWorktreeLocation,
              researchLaunchInstruction: effectiveResearchLaunchInstruction,
            };
      });

      // Live entries win over the snapshot: a queue event or a draft the
      // user already typed since the window appeared is fresher than the
      // boot-time disk state, and clobbering a live draft would erase text
      // mid-composition (and then persist the stale value).
      replaceQueuedTurnsByAgent({
        ...Object.fromEntries(queueEntries),
        ...queuedTurnsByAgentRef.current,
      });
      const restoredDrafts = {
        ...Object.fromEntries(
          draftEntries.filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
        ...draftsByAgentRef.current,
      };
      draftsByAgentRef.current = restoredDrafts;
      setDraftsByAgentState(restoredDrafts);
    },
    applyInitial: async ({ runtimeConfig, existingGroups, existingPanes, existingPaneSplits,
      existingAgents, existingResearchTrees, existingResearchActivity,
      existingRecentActivity }, isCancelled) => {
      setConfig(runtimeConfig);
      setGroups(existingGroups);
      setPaneSplitsState(normalizePaneSplitsForPanes(existingPaneSplits, existingPanes));
      setAgents(existingAgents);
      setAgentsHydrated(true);
      const partitionedResearchTrees = partitionResearchTrees(existingResearchTrees);
      setResearchTrees(partitionedResearchTrees.active);
      setArchivedResearchTrees(partitionedResearchTrees.archived);
      setResearchActivity(existingResearchActivity);
      recentActivityItemsRef.current = existingRecentActivity.items;
      setRecentActivityItems(existingRecentActivity.items);
      setRecentActivityCursor(existingRecentActivity.nextCursor ?? null);
      const savedResearchTreeId = localStorage.getItem(ACTIVE_RESEARCH_TREE_KEY);
      const restoredResearchScope = resolveResearchScope(
        localStorage.getItem(RESEARCH_FOLDER_SCOPE_KEY),
        groupsForScope(existingGroups, "research"),
      );
      const allResearchTrees = [
        ...partitionedResearchTrees.active,
        ...partitionedResearchTrees.archived,
      ];
      const researchTreeToRestore = savedResearchTreeId
        ? treeForResearchScope(
            allResearchTrees,
            restoredResearchScope,
            savedResearchTreeId,
          )
        : null;
      const restoreResearchSelection = async () => {
        if (isCancelled()) return;
        if (!researchTreeToRestore) {
          if (savedResearchTreeId) {
            localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
          }
          if (!isCancelled()) {
            activeResearchTreeIdRef.current = null;
            setActiveResearchTreeId(null);
            setActiveResearchDetail(null);
            setActiveResearchDetailError(null);
            activeResearchPaneIdRef.current = null;
            setActiveResearchPaneId(null);
            localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
            showResearchSurface();
          }
          return;
        }
        try {
          const detail = await getResearchTree(researchTreeToRestore.id);
          if (!isCancelled()) {
            setActiveResearchTreeId(researchTreeToRestore.id);
            localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, researchTreeToRestore.id);
            setActiveResearchDetail((current) =>
              reconcileResearchTreeDetail(current, detail),
            );
            const restoredResearchPaneId = localStorage.getItem(ACTIVE_RESEARCH_PANE_KEY);
            const restoredResearchPane = existingPanes.find(
              (pane) =>
                pane.id === restoredResearchPaneId &&
                existingGroups.find((group) => group.id === pane.groupId)?.scope === "research" &&
                workspaceIsInResearchScope(pane.groupId, restoredResearchScope),
            );
            if (restoredResearchPane) {
              activeResearchPaneIdRef.current = restoredResearchPane.id;
              setActiveResearchPaneId(restoredResearchPane.id);
              activePaneIdRef.current = restoredResearchPane.id;
              setActivePaneIdState(restoredResearchPane.id);
              showResearchSurface();
            } else {
              showResearchSurface();
              if (
                researchDocumentIsVisible(
                  researchTreeToRestore.id,
                  "research",
                  researchTreeToRestore.id,
                )
              ) {
                void markResearchTreeViewed(researchTreeToRestore.id)
                  .then(() => {
                    if (isCancelled()) return;
                    setResearchTrees((current) =>
                      current.map((tree) =>
                        tree.id === researchTreeToRestore.id
                          ? { ...tree, hasUnseenUpdate: false, hasUnseenFailure: false }
                          : tree,
                      ),
                    );
                  })
                  .catch(() => undefined);
              }
            }
          }
        } catch (err) {
          // Mirror selectResearchTree's failure path when booting into
          // Research mode: keep the selection and surface the error inside
          // the document (which has a working Retry) — silently dropping
          // the key left the Research sidebar paired with a terminal pane
          // on the stage and nothing able to recover. A later navigation
          // refresh clears the selection if the tree is truly gone.
          if (!isCancelled()) {
            setActiveResearchTreeId(researchTreeToRestore.id);
            localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, researchTreeToRestore.id);
            setActiveResearchDetailError(err instanceof Error ? err.message : String(err));
            showResearchSurface();
          }
        }
      };

      if (!isCancelled()) {
        setPanesPreservingRecoveredDismissals(existingPanes);
        activePaneIdRef.current = null;
        setActivePaneIdState(null);
        activeTabPersistenceReadyRef.current = true;
        await restoreResearchSelection();
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  // Persist any debounced-but-unwritten drafts when the window is hidden or the
  // app unmounts, so a quick close never drops the last second of typing.
  useEffect(() => {
    const handlePageHide = () => flushPendingDrafts();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      flushPendingDrafts();
    };
  }, []);

  useEffect(() => {
    // Probe the backend on a real view transition. Its Done event can still be
    // crossing the event bridge, so the local agent snapshot is not sufficient.
    // Intentional: activePaneId changes are user/system navigation to this pane
    // (keyboard cycle, click, restore), including while a native terminal owns
    // first responder and document.hasFocus() is false.
    acknowledgePaneIfDone(activePaneId, true, true);
  }, [activePaneId, activeSurface]);

  useEffect(() => {
    // If the pane was already visible when Done arrived, acknowledge it as soon
    // as the event reaches React instead of waiting for another focus change.
    // Ambient: requires the Session window to be focused so a backgrounded app
    // does not clear Done on a still-selected pane.
    acknowledgePaneIfDone(activePaneId);
  }, [activePaneId, activeSurface, agents, paneSplits]);

  // Selecting a pane clears its one-time "Restored" badge automatically — the same
  // dismiss-on-select behavior as a done agent's review status — so it's never a
  // manual click. Guarded so it only fires for a pane that still carries the badge.
  useEffect(() => {
    if (!activePaneId) {
      return;
    }
    const paneIds = new Set(paneIdsForSplitStatusGroup(activePaneId));
    if (panes.some((pane) => pane.recovered && paneIds.has(pane.id))) {
      dismissRecoveredBadge(activePaneId);
    }
  }, [activePaneId, paneSplits, panes]);

  // Report the focused pane to the backend so it can stamp `last_active_at`, which
  // feeds the group's spawn-cwd heuristic (most-recently-active shell pane). One
  // effect for every setActivePaneId call site; the legacy Home sentinel is not
  // a real pane.
  useEffect(() => {
    if (!activePaneId || activePaneId === HOME_TAB_ID) {
      return;
    }
    void activatePane(activePaneId).catch(() => {});
  }, [activePaneId]);

  useEffect(() => {
    const handleFocus = () => acknowledgePaneIfDone(activePaneIdRef.current, true);
    const handleBlur = () => terminalAttentionProbeAtRef.current.clear();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleFocus();
      }
    };
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlistenNativeFocus: (() => void) | undefined;
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          handleFocus();
          // Tauri can report native focus just before WebKit updates
          // document.hasFocus(). Sample once more after that handoff.
          requestAnimationFrame(handleFocus);
        } else {
          handleBlur();
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenNativeFocus = unlisten;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unlistenNativeFocus?.();
    };
  }, []);

  // Flushes a pane's pre-attach output backlog, retrying on failure. attachPane is
  // idempotent (a repeat call is a no-op once the pane is already flushed), so retrying
  // can't double-deliver output. A silently-swallowed failure here used to leave the
  // terminal blank with no backlog and no recovery; instead we retry with backoff to
  // ride out a transient race, and surface a persistent failure — but only when the pane
  // is still open, since a pane that closed in the meantime failing to attach is expected.
  const attachPaneWithRetry = useCallback((paneId: string) => {
    const attempt = (remaining: number, delayMs: number) => {
      void attachPane(paneId).catch((err) => {
        if (remaining <= 0) {
          const stillOpen = panesRef.current.some((pane) => pane.id === paneId);
          console.error(
            `session: failed to attach pane ${paneId}${stillOpen ? "" : " (pane already closed)"}:`,
            err,
          );
          if (stillOpen) {
            setError("A terminal couldn't finish loading its output — reselect the tab to retry.");
          }
          return;
        }
        window.setTimeout(
          () => attempt(remaining - 1, Math.min(delayMs * 2, ATTACH_MAX_RETRY_MS)),
          delayMs,
        );
      });
    };
    attempt(ATTACH_MAX_RETRIES, ATTACH_INITIAL_RETRY_MS);
  }, []);

  const handleEventsReady = useCallback(() => {
    eventsReadyRef.current = true;
    const pending = pendingAttachRef.current;
    pendingAttachRef.current = new Set();
    for (const paneId of pending) {
      attachPaneWithRetry(paneId);
    }
  }, [attachPaneWithRetry]);

  function savePaneSplits(nextSplits: PaneSplitInfo[], paneSnapshot = panes) {
    const normalized = normalizePaneSplitsForPanes(nextSplits, paneSnapshot);
    setPaneSplitsState(normalized);
    void persistPaneSplits(normalized)
      .then((persisted) => {
        const paneBasis = paneSnapshotForPersistedPaneSplits(
          persisted,
          panesRef.current,
          paneSnapshot,
        );
        setPaneSplitsState(normalizePaneSplitsForPanes(persisted, paneBasis));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }

  useEffect(() => {
    setPaneSplitsState((current) => {
      const normalized = normalizePaneSplitsForPanes(current, panes);
      if (paneSplitsEqual(current, normalized)) {
        return current;
      }
      void persistPaneSplits(normalized).catch(() => undefined);
      return normalized;
    });
  }, [panes]);

  const clearResearchUnseen = useCallback((treeId: string) => {
    // Both attention flags: viewing acknowledges failures exactly like
    // ordinary settlements (the backend clears both by advancing
    // last_viewed_at). Clearing only the update dot left the sidebar and
    // mode-toggle "!" lit forever — mark_research_tree_viewed emits no
    // event, so no refetch ever corrected the local copy.
    setResearchTrees((current) => clearResearchTreeAttention(current, treeId));
    setArchivedResearchTrees((current) => clearResearchTreeAttention(current, treeId));
  }, []);
  // Records a Home visit in workspace history so Back navigation returns here.
  const recordResearchJournalVisit = useCallback(() => {
    const treeId = activeResearchTreeIdRef.current;
    setResearchWorkspaceHistory((current) => {
      const withDocument = treeId
        ? pushResearchWorkspaceHistory(current, { kind: "document", treeId })
        : current;
      const next = pushResearchWorkspaceHistory(withDocument, { kind: "journal" });
      researchWorkspaceHistoryRef.current = next;
      return next;
    });
  }, []);
  // Prunes unreachable document visits while preserving the current view.
  const pruneResearchWorkspaceVisits = useCallback((keepTree: (treeId: string) => boolean) => {
    setResearchWorkspaceHistory((current) => {
      const next = pruneResearchWorkspaceHistory(current, keepTree);
      researchWorkspaceHistoryRef.current = next;
      return next;
    });
  }, []);
  const refreshResearchNavigation = useCallback(async (
    options: { resetLoadedTail?: boolean } = {},
  ): Promise<ResearchTreeSummary[] | null> => {
    // Bump-and-check like every other refetch here (agents, panes, groups,
    // the research detail): refreshes overlap — the debounced event refresh
    // races the direct calls from archive/remove/submit — and the two list
    // invokes below resolve independently, so without the guard a slower,
    // older snapshot can be applied last and sit there (a stale "running"
    // badge, a resurrected unseen flag, a re-listed removed tree) until the
    // next research event.
    const requestSeq = researchNavRefreshSeqRef.current + 1;
    researchNavRefreshSeqRef.current = requestSeq;
    const activityRequestSeq = recentActivityHeadRequestSeqRef.current + 1;
    recentActivityHeadRequestSeqRef.current = activityRequestSeq;
    recentActivityPageRequestSeqRef.current += 1;
    loadingOlderActivityRef.current = false;
    setLoadingOlderActivity(false);
    setOlderActivityError(null);
    researchNavRefreshInFlightRef.current += 1;
    try {
      const [trees, activity, recentActivity] = await Promise.all([
        listResearchTrees(true),
        listResearchActivity(),
        listRecentActivity(),
      ]);
      if (researchNavRefreshSeqRef.current !== requestSeq) {
        return null;
      }
      const partitioned = partitionResearchTrees(trees);
      setResearchTrees((current) =>
        reconcileResearchTreeSummaries(current, partitioned.active),
      );
      setArchivedResearchTrees((current) =>
        reconcileResearchTreeSummaries(current, partitioned.archived),
      );
      setResearchActivity((current) => reconcileResearchActivity(current, activity));
      if (recentActivityHeadRequestSeqRef.current === activityRequestSeq) {
        const headCursor = recentActivity.nextCursor ?? null;
        // Archived trees are omitted from activity queries. Restoring a tree
        // only refetches the head, so drop the tail to allow older pagination
        // to re-fetch items that fell within the tail.
        const preserveLoadedTail =
          !options.resetLoadedTail &&
          headCursor !== null &&
          recentActivityItemsRef.current.some((item) =>
            activityCursorIsBefore(recentActivityItemCursor(item), headCursor),
          );
        setRecentActivityItems((current) => {
          const next = reconcileRecentActivityHead(
            current,
            recentActivity.items,
            preserveLoadedTail ? headCursor : null,
          );
          recentActivityItemsRef.current = next;
          return next;
        });
        if (!preserveLoadedTail) {
          setRecentActivityCursor(headCursor);
        }
      }
      // The backend can remove the selected tree out from under the UI (a root
      // launch that failed removes its never-launched tree). Left selected, the
      // document would spin on a tree that no longer exists with nothing able to
      // recover it — clear the selection so the empty state takes over.
      const activeTreeId = activeResearchTreeIdRef.current;
      if (activeTreeId && !trees.some((tree) => tree.id === activeTreeId)) {
        activeResearchTreeIdRef.current = null;
        setActiveResearchTreeId(null);
        setActiveResearchDetail(null);
        setActiveResearchDetailError(null);
        localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
      }
      // Navigation restoration state for trees that no longer exist would
      // otherwise accumulate in localStorage forever.
      pruneResearchNavigation(trees.map((tree) => tree.id));
      // Prune deleted trees from history.
      const knownTreeIds = new Set(trees.map((tree) => tree.id));
      pruneResearchWorkspaceVisits((id) => knownTreeIds.has(id));
      return trees;
    } finally {
      researchNavRefreshInFlightRef.current -= 1;
    }
  }, [pruneResearchWorkspaceVisits]);
  const markVisibleResearchTreeViewed = useCallback(
    async (treeId: string, options: ResearchViewedAckOptions = {}) => {
      const documentVisible = researchDocumentIsVisible(
        treeId,
        activeSurfaceRef.current,
        activeResearchTreeIdRef.current,
      );
      // Watching the run's own terminal counts as viewing the tree: the user
      // reached that pane from this document and is looking at the same run,
      // so the unseen badge must not survive it.
      const activePaneId = activePaneIdRef.current;
      const paneVisible =
        activeSurfaceRef.current === "pane" &&
        activeResearchTreeIdRef.current === treeId &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        activePaneId !== null &&
        researchNodeByPaneIdRef.current.get(activePaneId)?.treeId === treeId;
      if (!options.exposureConfirmed && !documentVisible && !paneVisible) {
        return;
      }
      const hadUnseen =
        options.knownUnseen === true ||
        [...researchTreesRef.current, ...archivedResearchTreesRef.current].some(
          (tree) => tree.id === treeId && (tree.hasUnseenUpdate || tree.hasUnseenFailure),
        );
      if (!options.force && !hadUnseen) {
        return;
      }
      if (researchViewAckInFlightRef.current.has(treeId)) {
        // A navigation result that discovered a newer settlement while an
        // exposure-edge acknowledgment was in flight needs one trailing scan.
        // Plain focus/visibility duplicates can share the current request.
        if (options.knownUnseen) {
          researchViewAckPendingRef.current.add(treeId);
        }
        return;
      }
      researchViewAckInFlightRef.current.add(treeId);
      try {
        await markResearchTreeViewed(treeId);
        // A refresh can already hold a pre-view snapshot even when its unseen
        // flag has not reached React state yet. Capture that after the mark
        // completes: if the request finishes before this continuation, the
        // local clear below corrects its result; if it is still running, the
        // replacement refresh supersedes it by sequence number.
        const staleNavigationMayStillLand = researchNavRefreshInFlightRef.current > 0;
        clearResearchUnseen(treeId);
        // A navigation refresh started before the view was recorded holds a
        // snapshot with the badges still lit; applied after the local clear it
        // would resurrect them — and with the run settled, no later event would
        // ever correct it. Refetch when a badge was already lit or a navigation
        // request can still land: the fresh request supersedes any pre-view
        // snapshot (bump-and-check above) and carries the acknowledged flags.
        if (hadUnseen || staleNavigationMayStillLand) {
          void refreshResearchNavigation().catch(() => undefined);
        }
      } finally {
        researchViewAckInFlightRef.current.delete(treeId);
        if (researchViewAckPendingRef.current.delete(treeId)) {
          queueMicrotask(() => {
            void markVisibleResearchTreeViewedRef.current(treeId, {
              knownUnseen: true,
            }).catch(() => undefined);
          });
        }
      }
    },
    [clearResearchUnseen, refreshResearchNavigation],
  );
  markVisibleResearchTreeViewedRef.current = markVisibleResearchTreeViewed;
  useEffect(() => {
    const markCurrent = () => {
      const treeId = activeResearchTreeIdRef.current;
      if (treeId) {
        void markVisibleResearchTreeViewed(treeId, { force: true }).catch(() => undefined);
      }
    };
    window.addEventListener("focus", markCurrent);
    document.addEventListener("visibilitychange", markCurrent);
    return () => {
      window.removeEventListener("focus", markCurrent);
      document.removeEventListener("visibilitychange", markCurrent);
    };
  }, [markVisibleResearchTreeViewed]);
  const selectResearchTree = useCallback(async (treeId: string) => {
    const requestSeq = researchDetailRequestSeqRef.current + 1;
    researchDetailRequestSeqRef.current = requestSeq;
    showResearchSurface();
    setJournalOpen(false);
    activeResearchPaneIdRef.current = null;
    setActiveResearchPaneId(null);
    localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    activeResearchTreeIdRef.current = treeId;
    setActiveResearchTreeId(treeId);
    localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, treeId);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    try {
      const detail = await getResearchTree(treeId);
      if (
        researchDetailRequestSeqRef.current === requestSeq &&
        activeResearchTreeIdRef.current === treeId
      ) {
        setActiveResearchDetail((current) =>
          reconcileResearchTreeDetail(current, detail),
        );
        // Selection can arrive from outside the scoped sidebar (archive
        // restore, a remembered tree on mode switch). Follow it with the
        // folder scope, or the document would show a tree the sidebar
        // doesn't list — with nothing highlighted anywhere.
        if (researchScopeRef.current !== detail.tree.workspaceId) {
          changeResearchFolderScope(detail.tree.workspaceId);
        }
        void markVisibleResearchTreeViewed(treeId, { force: true }).catch(() => undefined);
      }
    } catch (err) {
      // Surfaced inside the document (with a working Retry) rather than as a
      // global banner: without detail the document has no node to load, so
      // the error and its recovery belong where the user is looking.
      if (
        researchDetailRequestSeqRef.current === requestSeq &&
        activeResearchTreeIdRef.current === treeId
      ) {
        setActiveResearchDetailError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [
    changeResearchFolderScope,
    markVisibleResearchTreeViewed,
    setJournalOpen,
  ]);
  const recordResearchWorkspaceVisit = useCallback((visit: ResearchWorkspaceVisit) => {
    setResearchWorkspaceHistory((current) => {
      const next = pushResearchWorkspaceHistory(current, visit);
      researchWorkspaceHistoryRef.current = next;
      return next;
    });
  }, []);
  const navigateToResearchDocument = useCallback(
    (treeId: string) => {
      recordResearchWorkspaceVisit({ kind: "document", treeId });
      void selectResearchTree(treeId);
    },
    [recordResearchWorkspaceVisit, selectResearchTree],
  );
  // Opens a node of a tree: its level, and the levels before it, open as
  // column pairs, with the node selected. The store covers a document that mounts for
  // this tree; the request reaches one that is already mounted.
  const openResearchNode = useCallback(
    (treeId: string, nodeId: string) => {
      const navigationStore = researchNavigationStore();
      const navigation = navigationStore[treeId] ?? { scrollByNode: {} };
      navigation.selectedNodeId = nodeId;
      navigationStore[treeId] = navigation;
      saveResearchNavigation();
      navigateToResearchDocument(treeId);
      requestResearchNodeOpen(treeId, nodeId);
    },
    [navigateToResearchDocument],
  );
  const openRecentResearchQuery = useCallback(
    (query: RecentResearchQuery) => openResearchNode(query.treeId, query.nodeId),
    [openResearchNode],
  );
  const openResearchHighlight = useCallback(
    (item: ResearchHighlightFeedItem) => {
      // Recorded before navigation so the document's page-visit restore can
      // land on the passage instead of the saved scroll offset.
      const navigationStore = researchNavigationStore();
      const navigation = (navigationStore[item.treeId] ??= { scrollByNode: {} });
      navigation.focusHighlight = { nodeId: item.nodeId, highlightId: item.highlightId };
      openResearchNode(item.treeId, item.nodeId);
    },
    [openResearchNode],
  );
  const handleResearchRecapApplied = useCallback((node: ResearchNode) => {
    setActiveResearchDetail((current) => patchResearchDetailNode(current, node));
    setResearchActivity((current) => upsertResearchActivity(current, node));
    setRecentActivityItems((current) => {
      const next = upsertRecentActivityResearchNode(current, node);
      recentActivityItemsRef.current = next;
      return next;
    });
  }, []);
  const loadOlderActivity = useCallback(() => {
    if (!recentActivityCursor || loadingOlderActivityRef.current) return;
    const requestSeq = recentActivityPageRequestSeqRef.current + 1;
    recentActivityPageRequestSeqRef.current = requestSeq;
    loadingOlderActivityRef.current = true;
    setLoadingOlderActivity(true);
    setOlderActivityError(null);
    void listRecentActivity(50, recentActivityCursor)
      .then((page) => {
        if (recentActivityPageRequestSeqRef.current !== requestSeq) return;
        setRecentActivityItems((current) => {
          const next = mergeRecentActivityItems(current, page.items);
          recentActivityItemsRef.current = next;
          return next;
        });
        setRecentActivityCursor(page.nextCursor ?? null);
      })
      .catch((err) => {
        if (recentActivityPageRequestSeqRef.current === requestSeq) {
          setOlderActivityError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (recentActivityPageRequestSeqRef.current === requestSeq) {
          loadingOlderActivityRef.current = false;
          setLoadingOlderActivity(false);
        }
      });
  }, [recentActivityCursor]);
  const retryActiveResearchDetail = useCallback(() => {
    const treeId = activeResearchTreeIdRef.current;
    if (treeId) {
      void selectResearchTree(treeId);
    }
  }, [selectResearchTree]);
  const focusResearchHome = useCallback(() => {
    recordResearchJournalVisit();
    // Invalidate a tree request that may still be landing while Home is
    // selected; otherwise its detail can repaint behind the launcher.
    researchDetailRequestSeqRef.current += 1;
    showResearchSurface();
    setJournalOpen(true);
    activeResearchPaneIdRef.current = null;
    setActiveResearchPaneId(null);
    localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    activeResearchTreeIdRef.current = null;
    setActiveResearchTreeId(null);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
  }, [recordResearchJournalVisit, showResearchSurface, setJournalOpen]);
  // Brings the Journal page forward on the research surface. Tree selection is
  // left standing (the journal outranks the document in the stage selector),
  // so closing the journal by picking a tree is a plain selection.
  const showJournal = useCallback(() => {
    // The Journal is a peer page of a research document, not an overlay on one:
    // opening it drops the tree selection the way Home does, so the sidebar
    // never shows a selected row behind the tab that is actually forward.
    researchDetailRequestSeqRef.current += 1;
    showResearchSurface();
    activeResearchPaneIdRef.current = null;
    setActiveResearchPaneId(null);
    localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    activeResearchTreeIdRef.current = null;
    setActiveResearchTreeId(null);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
    setJournalOpen(true);
  }, [showResearchSurface, setJournalOpen]);
  // Which list the feed column shows: Home, Bookmarks, Highlights, Drafts,
  // Archive, or a user folder. Switching lists keeps the open thread.
  const [journalView, setJournalView] = useState<ResearchJournalView>({ kind: "home" });
  const researchFeedColumnVisible = researchStageView !== null;
  const openJournalView = useCallback(
    (view: ResearchJournalView) => {
      setJournalView(view);
      showResearchSurface();
    },
    [showResearchSurface],
  );
  // Folders, drafts, and moving questions between them. Toasts confirm moves
  // with Undo; drags run on pointer events shared by feed, sidebar, and strip.
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
  const {
    folderState: researchFolderState,
    folders: researchFolders,
    moveTree: moveResearchTree,
    moveTreeToNewFolder: moveResearchTreeToNewFolder,
    createFolder: createResearchFolder,
    renameFolder: renameResearchFolder,
    deleteFolder: deleteResearchFolder,
    setTrayCollapsed: setResearchTrayCollapsed,
    fileNewTree: fileNewResearchTree,
    refreshFolders: refreshResearchFolders,
    foldersLoadError: researchFoldersLoadError,
    retryFoldersLoad: retryResearchFoldersLoad,
  } = useResearchFiling({
    workspaceId: researchScope,
    activeTreesRef: researchTreesRef,
    archivedTreesRef: archivedResearchTreesRef,
    applyTreeOrder: applyResearchTreeOrder,
    refreshTrees: refreshResearchTreesAfterFiling,
    onError: setError,
    showToast: showResearchToast,
  });
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
  const startResearchCardDrag = useResearchCardDrag({
    onMoveTree: (treeId, place, beforeId) => void moveResearchTree(treeId, place, beforeId),
    onMoveDraft: (draftId, beforeId) => void moveResearchDraft(draftId, beforeId),
    onSpringOpen: (place) => setResearchTrayCollapsed(place, false),
  });
  const [researchFolderNameRequest, setResearchFolderNameRequest] =
    useState<ResearchFolderNameRequest | null>(null);
  const [pendingResearchFolderDelete, setPendingResearchFolderDelete] = useState<string | null>(
    null,
  );
  // `trigger` is the button that opened the dialog (through a menu that is
  // gone by then); focus returns to it when the dialog closes.
  const openNewResearchFolderDialog = useCallback(
    (moveTreeId?: string, trigger?: HTMLElement) => {
      setResearchFolderNameRequest({
        kind: "create",
        moveTreeId: moveTreeId ?? null,
        returnFocus: trigger ?? null,
      });
    },
    [],
  );
  const openRenameResearchFolderDialog = useCallback(
    (folderId: string, trigger?: HTMLElement) => {
      const folder = researchFolders.find((candidate) => candidate.id === folderId);
      if (folder) {
        setResearchFolderNameRequest({
          kind: "rename",
          folderId,
          name: folder.name,
          returnFocus: trigger ?? null,
        });
      }
    },
    [researchFolders],
  );
  const submitResearchFolderName = useCallback(
    async (name: string) => {
      const request = researchFolderNameRequest;
      if (!request) return;
      if (request.kind === "rename") {
        await renameResearchFolder(request.folderId, name);
        setResearchFolderNameRequest(null);
        showResearchToast("Renamed.");
        return;
      }
      if (request.moveTreeId) {
        await moveResearchTreeToNewFolder(request.moveTreeId, name);
        setResearchFolderNameRequest(null);
        return;
      }
      const folder = await createResearchFolder(name);
      setResearchFolderNameRequest(null);
      if (!folder) return;
      showResearchToast(
        <span>
          Created <b>{folder.name}</b>.
        </span>,
      );
    },
    [
      createResearchFolder,
      moveResearchTreeToNewFolder,
      renameResearchFolder,
      researchFolderNameRequest,
      showResearchToast,
    ],
  );
  // Deleting starts from the folder's own view, where the confirmation
  // states how many questions move to Unfiled.
  const requestResearchFolderDelete = useCallback(
    (folderId: string) => {
      openJournalView({ kind: "folder", folderId });
      setPendingResearchFolderDelete(folderId);
    },
    [openJournalView],
  );
  const confirmResearchFolderDelete = useCallback(
    (folderId: string) => {
      const moved = [...researchTreesRef.current, ...archivedResearchTreesRef.current].filter(
        (tree) => researchFolderStateRef.current.membership[tree.id] === folderId,
      ).length;
      setPendingResearchFolderDelete(null);
      openJournalView({ kind: "home" });
      void deleteResearchFolder(folderId).then((deleted) => {
        if (!deleted) return;
        showResearchToast(
          `Deleted folder.${
            moved ? ` ${moved} question${moved === 1 ? "" : "s"} moved to Unfiled.` : ""
          }`,
        );
      });
    },
    [deleteResearchFolder, openJournalView, showResearchToast],
  );
  const cancelResearchFolderDelete = useCallback(() => setPendingResearchFolderDelete(null), []);
  // The Highlights feed is fetched whole (highlights are few and unpaged).
  // Highlight, node, and tree events bump the version so an open feed refetches.
  const [researchHighlightItems, setResearchHighlightItems] = useState<ResearchHighlightFeedItem[]>([]);
  const [researchHighlightsLoading, setResearchHighlightsLoading] = useState(false);
  const [researchHighlightsError, setResearchHighlightsError] = useState<string | null>(null);
  const [researchHighlightsVersion, setResearchHighlightsVersion] = useState(0);
  const researchHighlightsRequestSeqRef = useRef(0);
  const refreshResearchHighlights = useCallback(async () => {
    const requestSeq = researchHighlightsRequestSeqRef.current + 1;
    researchHighlightsRequestSeqRef.current = requestSeq;
    setResearchHighlightsLoading(true);
    try {
      const items = await listResearchHighlights();
      if (researchHighlightsRequestSeqRef.current !== requestSeq) return;
      setResearchHighlightItems(items);
      setResearchHighlightsError(null);
    } catch (err) {
      if (researchHighlightsRequestSeqRef.current !== requestSeq) return;
      setResearchHighlightsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (researchHighlightsRequestSeqRef.current === requestSeq) {
        setResearchHighlightsLoading(false);
      }
    }
  }, []);
  const highlightsFeedVisible = researchStageView !== null && journalView.kind === "highlights";
  useEffect(() => {
    if (!highlightsFeedVisible) return;
    void refreshResearchHighlights();
  }, [highlightsFeedVisible, refreshResearchHighlights, researchHighlightsVersion]);
  const invalidateResearchHighlights = useCallback(() => {
    setResearchHighlightsVersion((version) => version + 1);
  }, []);
  const applyResearchWorkspaceVisit = useCallback(
    (visit: ResearchWorkspaceVisit) => {
      if (visit.kind === "journal") {
        showJournal();
        return;
      }
      void selectResearchTree(visit.treeId);
    },
    [selectResearchTree, showJournal],
  );
  const goResearchWorkspaceBack = useCallback(() => {
    const step = researchWorkspaceHistoryBack(researchWorkspaceHistoryRef.current);
    if (!step) {
      return;
    }
    researchWorkspaceHistoryRef.current = step.history;
    setResearchWorkspaceHistory(step.history);
    applyResearchWorkspaceVisit(step.visit);
  }, [applyResearchWorkspaceVisit]);
  const goResearchWorkspaceForward = useCallback(() => {
    const step = researchWorkspaceHistoryForward(researchWorkspaceHistoryRef.current);
    if (!step) {
      return;
    }
    researchWorkspaceHistoryRef.current = step.history;
    setResearchWorkspaceHistory(step.history);
    applyResearchWorkspaceVisit(step.visit);
  }, [applyResearchWorkspaceVisit]);

  const chooseResearchWorkspaceFolder = useCallback(async (): Promise<GroupInfo | null> => {
    setError(null);
    setFolderPickerStatus("Opening folder picker…");
    try {
      await waitForPaintedFrame();
      const workspace = await createResearchWorkspaceWithFolder();
      if (workspace) {
        setGroups((current) =>
          current.some((group) => group.id === workspace.id) ? current : [...current, workspace],
        );
        void refreshResearchNavigation().catch(() => undefined);
      }
      return workspace;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setFolderPickerStatus(null);
    }
  }, [refreshResearchNavigation]);
  const openResearchWorkspaceFolder = useCallback(async (workspace: GroupInfo) => {
    setError(null);
    try {
      await revealResearchWorkspace(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const moveResearchWorkspaceFolder = useCallback(async (workspace: GroupInfo) => {
    setError(null);
    setFolderPickerStatus("Opening folder picker…");
    try {
      await waitForPaintedFrame();
      const updated = await moveResearchWorkspaceWithFolder(workspace.id);
      if (updated) {
        setGroups((current) =>
          current.map((group) => (group.id === updated.id ? updated : group)),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderPickerStatus(null);
    }
  }, []);
  // Full navigation + active-detail recovery is deliberately reserved for an
  // unknown/malformed event or a rare collection-order transition. Ordinary
  // research events carry enough state to patch locally below.
  const researchRefreshTimerRef = useRef<number | null>(null);
  const researchRefreshResetTailRef = useRef(false);
  const researchNavigationRecoveryTimerRef = useRef<number | null>(null);
  const researchTreeRecoveryTimersRef = useRef(new Map<string, number>());
  const researchTreeEventVersionRef = useRef(new Map<string, number>());
  const removedResearchTreeIdsRef = useRef(new Set<string>());
  useEffect(
    () => () => {
      if (researchRefreshTimerRef.current !== null) {
        window.clearTimeout(researchRefreshTimerRef.current);
      }
      if (researchNavigationRecoveryTimerRef.current !== null) {
        window.clearTimeout(researchNavigationRecoveryTimerRef.current);
      }
      for (const timer of researchTreeRecoveryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      researchTreeRecoveryTimersRef.current.clear();
    },
    [],
  );
  const scheduleResearchRefresh = useCallback((options: { resetLoadedTail?: boolean } = {}) => {
    // Coalesce tail reset requests across callers during the debounce window.
    if (options.resetLoadedTail) {
      researchRefreshResetTailRef.current = true;
    }
    if (researchRefreshTimerRef.current !== null) {
      return;
    }
    researchRefreshTimerRef.current = window.setTimeout(() => {
      researchRefreshTimerRef.current = null;
      const resetLoadedTail = researchRefreshResetTailRef.current;
      researchRefreshResetTailRef.current = false;
      void refreshResearchNavigation({ resetLoadedTail })
        .then((trees) => {
          const treeId = activeResearchTreeIdRef.current;
          const tree = treeId ? trees?.find((candidate) => candidate.id === treeId) : null;
          if (treeId && tree && (tree.hasUnseenUpdate || tree.hasUnseenFailure)) {
            void markVisibleResearchTreeViewed(treeId, { knownUnseen: true }).catch(
              () => undefined,
            );
          }
        })
        .catch(() => undefined);
      const treeId = activeResearchTreeIdRef.current;
      if (treeId) {
        const requestSeq = researchDetailRequestSeqRef.current + 1;
        researchDetailRequestSeqRef.current = requestSeq;
        void getResearchTree(treeId)
          .then((detail) => {
            if (
              researchDetailRequestSeqRef.current === requestSeq &&
              activeResearchTreeIdRef.current === treeId
            ) {
              setActiveResearchDetail((current) =>
                reconcileResearchTreeDetail(current, detail),
              );
              setActiveResearchDetailError(null);
            }
          })
          .catch(() => undefined);
      }
    }, 250);
  }, [markVisibleResearchTreeViewed, refreshResearchNavigation]);
  const scheduleResearchNavigationRecovery = useCallback(() => {
    if (researchNavigationRecoveryTimerRef.current !== null) {
      window.clearTimeout(researchNavigationRecoveryTimerRef.current);
    }
    researchNavigationRecoveryTimerRef.current = window.setTimeout(() => {
      researchNavigationRecoveryTimerRef.current = null;
      void refreshResearchNavigation()
        .then((trees) => {
          const treeId = activeResearchTreeIdRef.current;
          const tree = treeId ? trees?.find((candidate) => candidate.id === treeId) : null;
          if (treeId && tree && (tree.hasUnseenUpdate || tree.hasUnseenFailure)) {
            void markVisibleResearchTreeViewedRef.current(treeId, {
              knownUnseen: true,
            }).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 300);
  }, [refreshResearchNavigation]);
  const scheduleResearchTreeRecovery = useCallback(
    (treeId: string) => {
      if (removedResearchTreeIdsRef.current.has(treeId)) {
        return;
      }
      const existingTimer = researchTreeRecoveryTimersRef.current.get(treeId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
      const timer = window.setTimeout(() => {
        researchTreeRecoveryTimersRef.current.delete(treeId);
        const eventVersion = researchTreeEventVersionRef.current.get(treeId) ?? 0;
        const detailRequestSeq =
          activeResearchTreeIdRef.current === treeId
            ? researchDetailRequestSeqRef.current + 1
            : null;
        if (detailRequestSeq !== null) {
          researchDetailRequestSeqRef.current = detailRequestSeq;
        }
        void getResearchTree(treeId)
          .then((detail) => {
            if ((researchTreeEventVersionRef.current.get(treeId) ?? 0) !== eventVersion) {
              scheduleResearchTreeRecovery(treeId);
              return;
            }

            const summary = researchSummaryFromDetail(detail);
            if (summary.archivedAt != null) {
              setResearchTrees((current) => removeResearchTreeSummary(current, treeId));
              setArchivedResearchTrees((current) =>
                upsertResearchTreeSummary(current, summary),
              );
            } else {
              setArchivedResearchTrees((current) =>
                removeResearchTreeSummary(current, treeId),
              );
              setResearchTrees((current) => upsertResearchTreeSummary(current, summary));
            }
            setResearchActivity((current) => replaceResearchActivityForTree(current, detail));

            for (const [nodeId, node] of researchNodeEventCacheRef.current) {
              if (node.treeId === treeId) {
                researchNodeEventCacheRef.current.delete(nodeId);
              }
            }
            for (const node of detail.nodes) {
              researchNodeEventCacheRef.current.set(node.id, node);
            }
            pruneResearchNavigationNodes(
              treeId,
              detail.nodes.map((node) => node.id),
            );

            if (
              detailRequestSeq !== null &&
              researchDetailRequestSeqRef.current === detailRequestSeq &&
              activeResearchTreeIdRef.current === treeId
            ) {
              setActiveResearchDetail((current) =>
                reconcileResearchTreeDetail(current, detail),
              );
              setActiveResearchDetailError(null);
            }
            if (summary.hasUnseenUpdate || summary.hasUnseenFailure) {
              void markVisibleResearchTreeViewedRef.current(treeId, {
                knownUnseen: true,
              }).catch(() => undefined);
            }
          })
          .catch(() => {
            if (removedResearchTreeIdsRef.current.has(treeId)) {
              return;
            }
            // The tree may have disappeared or a future backend mutation may
            // have invalidated the targeted read. Recover collection order and
            // selection with the authoritative, but much more expensive, path.
            scheduleResearchRefresh();
          });
      }, 200);
      researchTreeRecoveryTimersRef.current.set(treeId, timer);
    },
    [scheduleResearchRefresh],
  );
  const handleResearchEvent = useCallback(
    (rawEvent: SessionEvent) => {
      const parsed = parseResearchEvent(rawEvent);
      if (parsed.kind !== "event") {
        if (parsed.kind !== "notResearch") {
          scheduleResearchRefresh();
        }
        return;
      }

      const event: ParsedResearchEvent = parsed.event;
      if (event.type === "research.drafts.changed") {
        void refreshResearchDrafts(event.workspaceId);
        return;
      }
      if (event.type === "research.folders.changed") {
        void refreshResearchFolders();
        return;
      }
      const eventTreeId =
        "tree" in event
          ? event.tree.id
          : "treeId" in event
            ? event.treeId
            : "node" in event
              ? event.node.treeId
              : researchNodeEventCacheRef.current.get(event.nodeId)?.treeId ?? null;
      if (eventTreeId) {
        if (event.type !== "research.tree.removed") {
          removedResearchTreeIdsRef.current.delete(eventTreeId);
        }
        researchTreeEventVersionRef.current.set(
          eventTreeId,
          (researchTreeEventVersionRef.current.get(eventTreeId) ?? 0) + 1,
        );
      }

      const invalidateNavigationSnapshot = () => {
        const needsRecovery =
          researchNavRefreshInFlightRef.current > 0 ||
          researchNavigationRecoveryTimerRef.current !== null;
        researchNavRefreshSeqRef.current += 1;
        recentActivityPageRequestSeqRef.current += 1;
        loadingOlderActivityRef.current = false;
        setLoadingOlderActivity(false);
        if (needsRecovery) {
          // An event invalidated a pre-event collection snapshot. Retry once
          // after the event stream goes quiet; resetting this timer prevents a
          // streaming run from turning recovery into repeated list IPC.
          scheduleResearchNavigationRecovery();
        }
      };
      const invalidateVisibleDetailSnapshot = (treeId: string) => {
        if (
          activeResearchTreeIdRef.current === treeId &&
          activeResearchDetailRef.current?.tree.id === treeId
        ) {
          researchDetailRequestSeqRef.current += 1;
        }
      };
      const patchSummaryState = (
        treeId: string,
        patch: (summary: ResearchTreeSummary) => ResearchTreeSummary,
      ) => {
        if (archivedResearchTreesRef.current.some((tree) => tree.id === treeId)) {
          setArchivedResearchTrees((current) =>
            patchResearchTreeSummaries(current, patch),
          );
        } else {
          setResearchTrees((current) => patchResearchTreeSummaries(current, patch));
        }
      };
      const patchNode = (
        node: ResearchNode,
        timestamp: number,
        navigationChanged = true,
      ) => {
        const previous = researchNodeEventCacheRef.current.get(node.id);
        researchNodeEventCacheRef.current.set(node.id, node);
        if (navigationChanged) {
          invalidateNavigationSnapshot();
        }
        invalidateVisibleDetailSnapshot(node.treeId);
        setActiveResearchDetail((current) => patchResearchDetailNode(current, node));
        setResearchActivity((current) => upsertResearchActivity(current, node));
        const promotedPatch = patchRecentActivityPromoted(
          upsertRecentActivityResearchNode(recentActivityItemsRef.current, node),
          node,
        );
        recentActivityItemsRef.current = promotedPatch.items;
        setRecentActivityItems(promotedPatch.items);
        if (promotedPatch.stale) scheduleResearchRefresh();
        if (previous) {
          const patchSummary = (summary: ResearchTreeSummary) =>
            patchResearchSummaryForNode(summary, previous, node, timestamp);
          patchSummaryState(node.treeId, patchSummary);
        }
        return previous;
      };
      switch (event.type) {
        case "research.tree.created": {
          invalidateNavigationSnapshot();
          const summary = researchSummaryFromDetail({ tree: event.tree, nodes: [event.node] });
          researchNodeEventCacheRef.current.set(event.node.id, event.node);
          if (summary.archivedAt != null) {
            setArchivedResearchTrees((current) =>
              upsertResearchTreeSummary(current, summary, true),
            );
          } else {
            setResearchTrees((current) =>
              upsertResearchTreeSummary(current, summary, true),
            );
          }
          setResearchActivity((current) => upsertResearchActivity(current, event.node));
          setRecentActivityItems((current) => {
            const next = upsertRecentActivityResearchNode(current, event.node);
            recentActivityItemsRef.current = next;
            return next;
          });
          break;
        }
        case "research.document.updated": {
          patchNode(event.node, event.timestamp);
          setActiveResearchDetail((current) => patchResearchDetailTree(current, event.tree));
          const patchSummary = (summary: ResearchTreeSummary) =>
            patchResearchSummaryTree(summary, event.tree);
          patchSummaryState(event.tree.id, patchSummary);
          break;
        }
        case "research.node.created": {
          const previous = patchNode(event.node, event.timestamp);
          if (!previous) {
            patchSummaryState(event.node.treeId, (summary) =>
              patchResearchSummaryForCreatedNode(summary, event.node, event.timestamp),
            );
          }
          scheduleResearchTreeRecovery(event.node.treeId);
          break;
        }
        case "research.node.updated": {
          const cached = researchNodeEventCacheRef.current.get(event.node.id);
          const lifecycleChanged =
            !cached ||
            cached.status !== event.node.status ||
            cached.completedAt !== event.node.completedAt ||
            cached.parentNodeId !== event.node.parentNodeId;
          const activityBindingChanged =
            !cached ||
            cached.paneId !== event.node.paneId ||
            cached.agentId !== event.node.agentId;
          const previous = patchNode(
            event.node,
            event.timestamp,
            lifecycleChanged || activityBindingChanged,
          );
          if (lifecycleChanged || activeResearchDetailRef.current === null) {
            scheduleResearchTreeRecovery(event.node.treeId);
          }
          if (
            previous &&
            previous.completedAt !== event.node.completedAt &&
            event.node.completedAt != null
          ) {
            void markVisibleResearchTreeViewedRef.current(event.node.treeId, {
              knownUnseen: true,
            }).catch(() => undefined);
          }
          break;
        }
        case "research.recap.pending": {
          setRecapPendingNodeIds((current) => {
            if (current.has(event.nodeId) === event.pending) {
              return current;
            }
            const next = new Set(current);
            if (event.pending) next.add(event.nodeId);
            else next.delete(event.nodeId);
            return next;
          });
          break;
        }
        case "research.tree.updated": {
          invalidateNavigationSnapshot();
          invalidateVisibleDetailSnapshot(event.tree.id);
          setActiveResearchDetail((current) => patchResearchDetailTree(current, event.tree));
          const patchSummary = (summary: ResearchTreeSummary) =>
            patchResearchSummaryTree(summary, event.tree);
          patchSummaryState(event.tree.id, patchSummary);
          break;
        }
        case "research.tree.archived":
        case "research.tree.restored": {
          invalidateResearchHighlights();
          invalidateNavigationSnapshot();
          invalidateVisibleDetailSnapshot(event.tree.id);
          setActiveResearchDetail((current) => patchResearchDetailTree(current, event.tree));
          // Refetch navigation so the archived and active tree lists stay
          // exact. Restoring a tree resets the loaded tail to refetch its
          // activity rows.
          scheduleResearchRefresh({
            resetLoadedTail: event.type === "research.tree.restored",
          });
          if (event.type === "research.tree.archived") {
            pruneResearchWorkspaceVisits((id) => id !== event.tree.id);
          }
          break;
        }
        case "research.highlight.created": {
          const cachedNode = researchNodeEventCacheRef.current.get(event.nodeId);
          if (cachedNode) {
            const node = addResearchNodeHighlight(cachedNode, event.highlight);
            researchNodeEventCacheRef.current.set(event.nodeId, node);
            invalidateVisibleDetailSnapshot(node.treeId);
          } else if (activeResearchDetailRef.current === null) {
            scheduleResearchRefresh();
          }
          setActiveResearchDetail((current) =>
            patchResearchDetailHighlightCreated(current, event.nodeId, event.highlight),
          );
          invalidateResearchHighlights();
          break;
        }
        case "research.highlights.removed": {
          const highlightIds = event.highlightIds;
          const cachedNode = researchNodeEventCacheRef.current.get(event.nodeId);
          if (cachedNode) {
            const node = removeResearchNodeHighlights(cachedNode, highlightIds);
            researchNodeEventCacheRef.current.set(event.nodeId, node);
            invalidateVisibleDetailSnapshot(node.treeId);
          } else if (activeResearchDetailRef.current === null) {
            scheduleResearchRefresh();
          }
          setActiveResearchDetail((current) =>
            patchResearchDetailHighlightsRemoved(current, event.nodeId, highlightIds),
          );
          invalidateResearchHighlights();
          break;
        }
        case "research.node.removed": {
          invalidateResearchHighlights();
          invalidateNavigationSnapshot();
          invalidateVisibleDetailSnapshot(event.treeId);
          const removedIds = new Set(event.removedNodeIds);
          const removedNodes = event.removedNodeIds.flatMap((nodeId) => {
            const node = researchNodeEventCacheRef.current.get(nodeId);
            return node ? [node] : [];
          });
          for (const nodeId of removedIds) {
            researchNodeEventCacheRef.current.delete(nodeId);
          }
          setActiveResearchDetail((current) =>
            removeResearchDetailNodes(current, event.treeId, removedIds),
          );
          setResearchActivity((current) => removeResearchNodes(current, removedIds));
          setRecentActivityItems((current) => {
            const next = current
              .filter((item) => !removedIds.has(item.nodeId))
              .map((item) =>
                item.children
                  ? {
                      ...item,
                      children: item.children.filter((child) => !removedIds.has(child.nodeId)),
                    }
                  : item,
              );
            recentActivityItemsRef.current = next;
            return next;
          });
          patchSummaryState(event.treeId, (summary) =>
            patchResearchSummaryForRemovedNodes(
              summary,
              event.treeId,
              removedNodes,
              event.timestamp,
            ),
          );
          scheduleResearchTreeRecovery(event.treeId);
          break;
        }
        case "research.tree.removed": {
          invalidateResearchHighlights();
          invalidateNavigationSnapshot();
          removedResearchTreeIdsRef.current.add(event.treeId);
          const pendingTimer = researchTreeRecoveryTimersRef.current.get(event.treeId);
          if (pendingTimer !== undefined) {
            window.clearTimeout(pendingTimer);
            researchTreeRecoveryTimersRef.current.delete(event.treeId);
          }
          setResearchTrees((current) => removeResearchTreeSummary(current, event.treeId));
          setArchivedResearchTrees((current) =>
            removeResearchTreeSummary(current, event.treeId),
          );
          setResearchActivity((current) => {
            const removedIds = current
              .filter((node) => node.treeId === event.treeId)
              .map((node) => node.id);
            return removeResearchNodes(current, removedIds);
          });
          setRecentActivityItems((current) => {
            const next = current.filter((item) => item.treeId !== event.treeId);
            recentActivityItemsRef.current = next;
            return next;
          });
          for (const [nodeId, node] of researchNodeEventCacheRef.current) {
            if (node.treeId === event.treeId) {
              researchNodeEventCacheRef.current.delete(nodeId);
            }
          }
          pruneResearchNavigation(
            [...researchTreesRef.current, ...archivedResearchTreesRef.current]
              .filter((tree) => tree.id !== event.treeId)
              .map((tree) => tree.id),
          );
          if (activeResearchTreeIdRef.current === event.treeId) {
            focusResearchHome();
          }
          pruneResearchWorkspaceVisits((id) => id !== event.treeId);
          break;
        }
      }
    },
    [
      focusResearchHome,
      pruneResearchWorkspaceVisits,
      scheduleResearchRefresh,
      scheduleResearchNavigationRecovery,
      scheduleResearchTreeRecovery,
    ],
  );
  // Research titles use a fresh, tool-free request through the run's own
  // adapter/model. Automatic failures stay silent: the prompt-derived title
  // is already visible, and title metadata must never fail the research run.
  const generateResearchTitle = useCallback(async (nodeId: string): Promise<string | null> => {
    try {
      return await generateResearchAgentTitle(nodeId);
    } catch {
      return null;
    }
  }, []);
  const applyGeneratedResearchTreeTitle = useCallback(
    async (treeId: string, nodeId: string, originalTitle: string) => {
      const title = await generateResearchTitle(nodeId);
      if (!title || title === originalTitle) {
        return;
      }
      try {
        // Generation spans a network/model round trip; skip if the user
        // renamed the tree in the meantime.
        const current = await getResearchTree(treeId);
        if (current.tree.title !== originalTitle) {
          return;
        }
        await renameResearchTree(treeId, title);
      } catch {
        return;
      }
    },
    [generateResearchTitle],
  );
  const applyGeneratedResearchNodeTitle = useCallback(
    async (treeId: string, nodeId: string) => {
      const title = await generateResearchTitle(nodeId);
      if (!title) {
        return;
      }
      try {
        // Follow-up title generation is asynchronous too. Preserve a title the
        // user supplied while this model request was in flight.
        const current = await getResearchTree(treeId);
        if (current.nodes.find((node) => node.id === nodeId)?.title) {
          return;
        }
        await renameResearchNode(nodeId, title);
      } catch {
        return;
      }
    },
    [generateResearchTitle],
  );
  // Shared by the research and document composers: the folder the item lands
  // in — the picked one, or the default folder (created on first use).
  const resolveResearchComposerWorkspace = useCallback(
    async (workspaceId: string | null): Promise<GroupInfo> => {
      const group = workspaceId
        ? groups.find((candidate) => candidate.id === workspaceId)
        : await ensureDefaultResearchWorkspace();
      if (!group || group.scope !== "research") {
        throw new Error("The selected research workspace is no longer available.");
      }
      setGroups((current) =>
        current.some((candidate) => candidate.id === group.id) ? current : [...current, group],
      );
      return group;
    },
    [groups],
  );
  // Focuses a tree that a composer just created: research surface active, the
  // new tree selected with its detail already in hand, and the sidebar scoped
  // to its folder (a first item creates its private default folder — follow it
  // so the single-folder sidebar immediately lists the new tree).
  const adoptCreatedResearchTree = useCallback(
    (detail: ResearchTreeDetail) => {
      researchDetailRequestSeqRef.current += 1;
      // A new-research submit landing while a pristine composer page is open
      // must not leave the composer covering the tree it just created. A
      // document submit's own composer is dirty here, so it is unaffected and
      // closes itself right after this adopt.
      showResearchSurface();
      // Clear journalOpen so the new thread is visible after closing a
      // conversation or opening a draft.
      setJournalOpen(false);
      activeResearchPaneIdRef.current = null;
      setActiveResearchPaneId(null);
      localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
      activeResearchTreeIdRef.current = detail.tree.id;
      setActiveResearchTreeId(detail.tree.id);
      localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, detail.tree.id);
      setActiveResearchDetail((current) =>
        reconcileResearchTreeDetail(current, detail),
      );
      setActiveResearchDetailError(null);
      if (researchScopeRef.current !== detail.tree.workspaceId) {
        changeResearchFolderScope(detail.tree.workspaceId);
      }
    },
    [changeResearchFolderScope, setJournalOpen, showResearchSurface],
  );
  const submitNewResearch = useCallback(
    async (input: {
      prompt: string;
      adapter: string;
      model: string | null;
      effort: string | null;
      workspaceId: string | null;
    }) => {
      const probedAdapters = await refreshAdapterReadiness();
      const selectedAdapter = probedAdapters.find(
        (adapter) => adapter.id === input.adapter,
      );
      if (!adapterCanLaunchResearch(selectedAdapter)) {
        throw new Error(
          selectedAdapter
            ? adapterReadinessMessage(selectedAdapter)
            : "The selected research agent is no longer available.",
        );
      }
      const group = await resolveResearchComposerWorkspace(input.workspaceId);
      let detail: ResearchTreeDetail;
      try {
        detail = await createResearchTree({
          prompt: input.prompt,
          adapter: input.adapter,
          model: input.model,
          effort: input.effort,
          workspaceId: group.id,
        });
      } catch (err) {
        // The Home composer displays the rethrown error beside the retained fields.
        void refreshResearchNavigation().catch(() => undefined);
        void refreshAdapterReadiness({ force: true }).catch(() => undefined);
        throw err;
      }
      adoptCreatedResearchTree(detail);
      void applyGeneratedResearchTreeTitle(
        detail.tree.id,
        detail.tree.rootNodeId,
        detail.tree.title,
      );
      return detail.tree.id;
    },
    [
      adoptCreatedResearchTree,
      applyGeneratedResearchTreeTitle,
      refreshResearchNavigation,
      refreshAdapterReadiness,
      resolveResearchComposerWorkspace,
    ],
  );
  // A note stays on Home: the feed shows it at the top, unlike a research
  // launch, which opens its thread.
  const submitNewNote = useCallback(
    async (input: {
      body: string;
      adapter: string;
      model: string | null;
      effort: string | null;
      workspaceId: string | null;
      askNetwork: boolean;
    }) => {
      const group = await resolveResearchComposerWorkspace(input.workspaceId);
      const detail = await createResearchNote({ ...input, workspaceId: group.id });
      const root = detail.nodes.find((node) => node.id === detail.tree.rootNodeId);
      if (root) {
        setRecentActivityItems((current) => {
          const next = upsertRecentActivityResearchNode(current, root);
          recentActivityItemsRef.current = next;
          return next;
        });
      }
      return detail.tree.id;
    },
    [resolveResearchComposerWorkspace],
  );
  const importReport = useCallback(async (markdown: string, prompt: string) => {
    const group = await resolveResearchComposerWorkspace(researchScope);
    const available = config?.adapters.filter(
      (candidate) => candidate.supportsRecapGeneration && adapterCanLaunchResearch(candidate),
    ) ?? [];
    const adapter = available.find((candidate) => candidate.default) ?? available[0];
    const detail = await importResearchReport({
      markdown,
      prompt,
      workspaceId: group.id,
      adapter: adapter?.id ?? "",
    });
    adoptCreatedResearchTree(detail);
  }, [config, researchScope, resolveResearchComposerWorkspace, adoptCreatedResearchTree]);

  const editResearchDocument = useCallback(
    async (input: {
      nodeId: string;
      markdown: string;
      title: string | null;
      expectedResponseRevision: string;
      expectedTitle: string;
      expectedHighlightIds: string[];
    }) => {
      const result = await updateResearchDocument(input);
      if (activeResearchTreeIdRef.current === result.tree.id) {
        // Apply the authoritative metadata immediately. The document component
        // separately refetches the body when its snapshot revision changed.
        setActiveResearchDetail((current) =>
          current?.tree.id === result.tree.id
            ? {
                tree: result.tree,
                nodes: current.nodes.map((node) =>
                  node.id === result.node.id ? result.node : node,
                ),
              }
            : current,
        );
      }
      return result;
    },
    [],
  );
  const cancelResearchRun = useCallback(
    async (nodeId: string) => {
      await cancelResearchNode(nodeId);
    },
    [],
  );
  // Rejects with the backend's message: the rename dialogs stay open with the
  // typed title and show it.
  const renameResearchTreeTitle = useCallback(async (treeId: string, title: string) => {
    await renameResearchTree(treeId, title);
  }, []);
  // Unarchiving leaves the selection alone, so several threads can be
  // restored from the Archived list in a row; an open thread stays open.
  const restoreResearchTreeFromMenu = useCallback(async (treeId: string) => {
    try {
      await restoreResearchTree(treeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  // Every delete entry point (document menu, feed menus) reconciles the active
  // document the same way: the deleted thread closes back to the feed.
  const removeResearchTreeAndSelectFallback = useCallback(
    async (treeId: string) => {
      setError(null);
      await removeResearchTree(treeId);
      if (activeResearchTreeIdRef.current === treeId) {
        focusResearchHome();
      }
      pruneResearchWorkspaceVisits((id) => id !== treeId);
    },
    [focusResearchHome, pruneResearchWorkspaceVisits],
  );
  const removeResearchTreeFromMenu = useCallback(
    async (treeId: string) => {
      setError(null);
      try {
        await removeResearchTreeAndSelectFallback(treeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [removeResearchTreeAndSelectFallback],
  );
  const createResearchFollowup = useCallback(
    async (
      parentNodeId: string,
      prompt: string,
      queryAnchor?: ResearchHighlightAnchor | null,
      inline?: boolean,
      replyAnchor?: string | null,
      replacesNodeId?: string | null,
    ) => {
      const node = await forkResearchNode(
        parentNodeId,
        prompt,
        queryAnchor,
        inline ?? false,
        replyAnchor,
        replacesNodeId,
      );
      void applyGeneratedResearchNodeTitle(node.treeId, node.id);
      return node;
    },
    [applyGeneratedResearchNodeTitle],
  );
  const retryResearchRun = useCallback(
    async (nodeId: string) => {
      // The command settles the whole relaunch (reset + spawn/fork + bind)
      // before returning the refreshed tree, so reconciling it here is
      // authoritative; interleaved research.node.updated events carry the
      // same node states and reconcile idempotently.
      const detail = await retryResearchNode(nodeId);
      if (activeResearchTreeIdRef.current === detail.tree.id) {
        setActiveResearchDetail((current) =>
          reconcileResearchTreeDetail(current, detail),
        );
      }
    },
    [],
  );
  // Replies, follow-ups, and retries under notes, shared by Home's note cards
  // and the note page. The resulting node events update the feed and the open
  // document, so nothing is patched here.
  const noteActions = useMemo<NoteActions>(
    () => ({
      onAskFollowUp: async ({ parentNodeId, prompt, network, replyAnchor }) => {
        if (network) {
          await createResearchNoteFollowUp(parentNodeId, prompt);
          return;
        }
        await createResearchFollowup(parentNodeId, prompt, null, false, replyAnchor);
      },
      onRespond: async (nodeId, replyId, body) => {
        await respondToResearchNoteReply(nodeId, replyId, body);
      },
      onDeleteResponse: async (nodeId, replyId) => {
        await removeResearchNoteReply(nodeId, replyId);
      },
      onRetry: retryResearchRun,
    }),
    [createResearchFollowup, retryResearchRun],
  );
  const removeResearchBranchFromDocument = useCallback(
    async (nodeId: string) => {
      setError(null);
      const removal = await removeResearchBranch(nodeId);
      const treeId = activeResearchTreeIdRef.current;
      if (treeId === removal.treeId) {
        // The delete already committed. Prune the live detail immediately;
        // the structural event follows with a targeted authoritative tree
        // reconciliation for counts and activity.
        const removedNodeIds = new Set(removal.removedNodeIds);
        setActiveResearchDetail((current) =>
          current?.tree.id === removal.treeId
            ? {
                ...current,
                nodes: current.nodes.filter((node) => !removedNodeIds.has(node.id)),
              }
            : current,
        );
      }
      return removal;
    },
    [],
  );
  const nativeAppShortcutHandlerRef = useRef<
    (command: AppShortcutCommand, repeat: boolean) => void
  >(() => undefined);
  const handleNativeAppShortcut = useCallback(
    (command: AppShortcutCommand, repeat: boolean) => {
      nativeAppShortcutHandlerRef.current(command, repeat);
    },
    [],
  );

  useSessionEvents({
    appendHookEvent,
    setPanes: setPanesPreservingRecoveredDismissals,
    // PTY lifecycle bookkeeping must not implicitly leave a research document when
    // some unrelated terminal exits. User-driven pane activation uses the wrapper.
    setActivePaneId: setActivePaneIdState,
    setExitPreflightRequest,
    setAgents,
    setGroups,
    setThinkingAgentIds,
    setTurns,
    setTranscriptNoticeByAgent,
    setAgentQueuedTurns,
    shouldRefreshAgentThreadGraph: (agentId: string) =>
      retainedGraphHistoryAgentIdsRef.current.has(agentId),
    onAgentThreadGraphDirty: scheduleAgentThreadGraphRefresh,
    shouldRetainAgentTurns: (agentId: string) =>
      retainedTurnHistoryAgentIdsRef.current.has(agentId),
    isResearchAgent: (agentId: string) => researchAgentIdsRef.current.has(agentId),
    refreshAgentTurnQueue,
    refreshTranscriptOptions,
    refreshVisibleTranscriptOptions,
    openBrowserOverlay,
    selectPaneAfterClose: selectPaneAfterCloseWithContext,
    onEventsReady: handleEventsReady,
    onAgentSpawned: handleAgentSpawned,
    onAgentPromptSubmitted: handleAgentPromptSubmitted,
    onPaneFocusRequested: (paneId: string) => {
      if (!panesRef.current.some((pane) => pane.id === paneId)) {
        return;
      }
      setActivePaneId(paneId);

    },
    onPaneSplitsChanged: (splits: PaneSplitInfo[]) => {
      paneSplitsRef.current = splits;
      setPaneSplitsState(splits);
    },
    onAppShortcut: handleNativeAppShortcut,
    onBrowserEscapeRequested: () => {
      browserEscapeDispatcherRef.current();
    },
    onResearchChanged: handleResearchEvent,
    onUserNotificationRequested: handleUserNotificationRequested,
  });

  function dismissWorktreeCreateDialog(created: boolean) {
    setWorktreeCreateDialog(null);
    const resolve = worktreeDialogResolveRef.current;
    worktreeDialogResolveRef.current = null;
    resolve?.(created);
  }

  async function createWorktreeFromDialog() {
    const dialog = worktreeCreateDialog;
    if (!dialog || dialog.creating || !dialog.name.trim()) {
      return;
    }
    setWorktreeCreateDialog({ ...dialog, creating: true, error: null });
    if (dialog.action.kind === "fork") {
      const forked = await forkPane(dialog.pane, {
        useWorktree: true,
        worktreeName: dialog.name.trim(),
        prompt: dialog.action.prompt,
        anchor: dialog.action.anchor,
        onError: (message) => {
          setWorktreeCreateDialog((current) =>
            current && current.pane.id === dialog.pane.id
              ? { ...current, creating: false, error: message }
              : current,
          );
        },
      });
      if (forked) {
        dismissWorktreeCreateDialog(true);
      }
      return;
    }

    const selectedBranch = dialog.startRef
      ? dialog.inventory?.branches.find((branch) => branch.fullRef === dialog.startRef)
      : undefined;
    if (
      selectedBranch?.checkedOutPath &&
      focusRepositoryPane(dialog.pane.groupId, selectedBranch.checkedOutPath)
    ) {
      dismissWorktreeCreateDialog(true);
      return;
    }

    let created: PaneInfo;
    try {
      created = dialog.startRef
        ? await openRepositoryBranch(
            dialog.pane.id,
            dialog.startRef,
            dialog.name.trim(),
            estimateInitialPaneSize(false),
          )
        : await openPaneWorktree(
            dialog.pane.id,
            dialog.name.trim(),
            estimateInitialPaneSize(false),
          );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setWorktreeCreateDialog((current) =>
        current && current.pane.id === dialog.pane.id
          ? { ...current, creating: false, error: message }
          : current,
      );
      return;
    }

    const orderedPanes = placePaneAfterOptimistically(created, dialog.pane.id);
    setPanesPreservingRecoveredDismissals(orderedPanes);
    setActivePaneId(created.id);
    setLastActiveGroupId(created.groupId);
    dismissWorktreeCreateDialog(true);
    try {
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    requestAnimationFrame(() => {

    });
  }

  function focusRepositoryPane(groupId: string, path: string): boolean {
    const existing = panesRef.current.find(
      (pane) =>
        pane.groupId === groupId &&
        (pane.activeWorkspace?.gitRoot === path || pane.cwd === path),
    );
    if (!existing) return false;
    setRepositoryBrowser(null);
    setActivePaneId(existing.id);
    setLastActiveGroupId(existing.groupId);

    return true;
  }

  async function adoptRepositoryPane(source: PaneInfo, created: PaneInfo) {
    const orderedPanes = placePaneAfterOptimistically(created, source.id);
    setPanesPreservingRecoveredDismissals(orderedPanes);
    setRepositoryBrowser(null);
    setActivePaneId(created.id);
    setLastActiveGroupId(created.groupId);
    try {
      await refreshGroups();
    } catch (err) {
      setError(unknownErrorMessage(err));
    }

  }

  async function openInventoryWorktree(path: string) {
    const browser = repositoryBrowser;
    if (!browser || browser.opening || focusRepositoryPane(browser.pane.groupId, path)) return;
    setRepositoryBrowser({ ...browser, opening: path, error: null });
    try {
      const pane = await openRepositoryWorktree(
        browser.pane.id,
        path,
        estimateInitialPaneSize(false),
      );
      await adoptRepositoryPane(browser.pane, pane);
    } catch (err) {
      setRepositoryBrowser((current) =>
        current?.pane.id === browser.pane.id
          ? { ...current, opening: null, error: unknownErrorMessage(err) }
          : current,
      );
    }
  }

  async function openInventoryBranch(branch: RepositoryBranch) {
    const browser = repositoryBrowser;
    if (!browser || browser.opening) return;
    if (branch.checkedOutPath) {
      await openInventoryWorktree(branch.checkedOutPath);
      return;
    }
    const name = browser.names[branch.fullRef]?.trim();
    if (!name) return;
    setRepositoryBrowser({ ...browser, opening: branch.fullRef, error: null });
    try {
      const pane = await openRepositoryBranch(
        browser.pane.id,
        branch.fullRef,
        name,
        estimateInitialPaneSize(false),
      );
      await adoptRepositoryPane(browser.pane, pane);
    } catch (err) {
      setRepositoryBrowser((current) =>
        current?.pane.id === browser.pane.id
          ? { ...current, opening: null, error: unknownErrorMessage(err) }
          : current,
      );
    }
  }

  function focusPaneTab(paneId: string) {
    if (document.activeElement instanceof HTMLElement &&
        document.activeElement.closest(".turn-timeline")) {
      document.activeElement.blur();
    }
    const treeId = researchNodeByPaneIdRef.current.get(paneId)?.treeId;
    const researchExposureChanged = Boolean(
      treeId &&
        (activeSurfaceRef.current !== "pane" ||
          activePaneIdRef.current !== paneId ||
          activeResearchTreeIdRef.current !== treeId),
    );
    setActivePaneId(paneId);
    // Pass intentional so native-terminal keyboard cycles are not gated
    // on webview document focus.
    acknowledgePaneIfDone(paneId, true, true);
    if (treeId) {
      void markVisibleResearchTreeViewedRef.current(treeId, {
        force: researchExposureChanged,
        exposureConfirmed: true,
      }).catch(() => undefined);
    }
    requestAnimationFrame(() => {

    });
  }

  useEffect(() => {
    if (!config || adapterProbeCompletedAtRef.current > 0) {
      return;
    }
    void refreshAdapterReadiness().catch(() => undefined);
  }, [config, refreshAdapterReadiness]);

  useEffect(() => {
    if (!agentsOpen) {
      return;
    }
    void refreshAdapterReadiness().catch(() => undefined);
  }, [refreshAdapterReadiness, agentsOpen]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "remotes") {
      return;
    }
    void refreshSshConfigAliases();
  }, [refreshSshConfigAliases, settingsOpen, settingsTab]);

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "remotes") {
      setRemoteAddMenuOpen(false);
      setRemoteDeleteConfirm(null);
      const generation = ++remoteProbeRequestRef.current;
      for (const key of Object.keys(remoteProbeGenerationByKeyRef.current)) {
        remoteProbeGenerationByKeyRef.current[key] = generation;
      }
      setRemoteProbeLoadingId((current) => (current === null ? current : null));
      setRemoteProbeResults((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
    }
  }, [settingsOpen, settingsTab]);

  useEffect(() => {
    if (!remoteAddMenuOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (!remoteAddMenuRef.current?.contains(event.target as Node)) {
        setRemoteAddMenuOpen(false);
      }
    };
    const handleResize = () => setRemoteAddMenuOpen(false);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [remoteAddMenuOpen]);


  useEffect(() => {
    const refreshStaleTargets = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      const lastChecked = adapterProbeCompletedAtRef.current;
      if (Date.now() - lastChecked >= 5 * 60 * 1000) {
        void refreshAdapterReadiness({ force: true }).catch(() => undefined);
      }
    };
    window.addEventListener("focus", refreshStaleTargets);
    document.addEventListener("visibilitychange", refreshStaleTargets);
    return () => {
      window.removeEventListener("focus", refreshStaleTargets);
      document.removeEventListener("visibilitychange", refreshStaleTargets);
    };
  }, [refreshAdapterReadiness]);

  // Escape is handled here in bubble phase so a rail/group menu's capture
  // listener can consume the key first. The app-level capture dispatcher
  // would otherwise close the whole map before those menus see it.
  useEffect(() => {
    if (!terminalMapOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      terminalMapDialogRef.current?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      setTerminalMapOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [terminalMapOpen]);

  function openResearchPaneTab(paneId: string) {
    // The research detail for a newly created run trails
    // pane.removed by a debounced refresh, so the pane can already be gone
    // when the button is clicked. Falling through to focusPaneTab would
    // classify the unknown id as a legacy pane (setActivePaneId's recovery
    // fallback) and evict the user from the research surface;
    // acknowledge and stay put instead.
    if (!panesRef.current.some((pane) => pane.id === paneId)) {
      showAppToast("That research run has already closed.", "warning");
      return;
    }
    focusPaneTab(paneId);
  }
  // Pass a stable callback to the memoized ResearchDocument so unrelated App
  // renders do not cause it to render again. The ref calls the current function.
  const researchDocumentOpenPaneRef = useRef(openResearchPaneTab);
  researchDocumentOpenPaneRef.current = openResearchPaneTab;
  // The conversation's toasts use the research toast: its live region is
  // mounted before any text arrives, and it pauses under the pointer or focus.
  const handleResearchDocumentToast = useCallback(
    (message: string, tone?: "normal" | "warning") =>
      showResearchToast(message, tone === "warning" ? { tone: "warning" } : {}),
    [showResearchToast],
  );

  // The ⌘K palette's command list, rebuilt on each open from live state: tab
  // navigation, pane/session actions gated on what the active pane supports,
  // and saved prompts that insert into the active agent's composer.
  function buildPaletteCommands(): PaletteCommand[] {
    const commands: PaletteCommand[] = researchTrees.map((tree) => ({
      id: `research:${tree.id}`,
      section: "Research",
      title: tree.title,
      hint: tree.runningCount > 0 ? `${tree.runningCount} running` : undefined,
      action: () => navigateToResearchDocument(tree.id),
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
        hint: LEFT_SIDEBAR_TOGGLE_SHORTCUT_LABEL,
        action: () => setLeftSidebarCollapsedForActivePane(!leftSidebarCollapsed),
      },
      {
        id: "action:settings",
        section: "Actions",
        title: "Open Settings",
        hint: "⌘,",
        action: () => {
          setAgentsOpen(false);
          setSettingsOpen(true);
        },
      },
      {
        id: "action:agents",
        section: "Actions",
        title: "Open Agents",
        action: () => {
          setSettingsOpen(false);
          setAgentsOpen(true);
        },
      },
    );
    return commands;
  }

  // The "Restored" badge is a one-time, post-restart hint, cleared automatically
  // when its pane or split group is selected (see the activePaneId effect). Clearing
  // the flag locally and recording the pane ids keeps later backend pane refetches
  // from resurrecting the badge during this app session.
  function dismissRecoveredBadge(paneId: string) {
    const paneIds = paneIdsForSplitStatusGroup(paneId);
    for (const id of paneIds) {
      dismissedRecoveredPaneIdsRef.current.add(id);
    }
    const paneIdSet = new Set(paneIds);
    setPanesPreservingRecoveredDismissals((current) => {
      let changed = false;
      const next = current.map((pane) => {
        if (pane.recovered && paneIdSet.has(pane.id)) {
          changed = true;
          return { ...pane, recovered: false };
        }
        return pane;
      });
      return changed ? next : current;
    });
  }

  function openGroupRenameDialog(group: GroupInfo) {
    setRenameValue(displayGroupName(group));
    setRenamePaneId(null);
    setRenameGroupId(group.id);
  }

  function closeRenameDialog() {
    setRenamePaneId(null);
    setRenameGroupId(null);
  }

  async function submitRename() {
    const groupId = renameGroupId;
    if (groupId) {
      const title = renameValue.trim();
      const previous = groups.find((group) => group.id === groupId);
      const clearingUserTitle = title.length === 0;
      const nextNameOverride = clearingUserTitle ? null : title;
      closeRenameDialog();
      if (!previous) {
        return;
      }
      const previousNameOverride = previous.nameOverride?.trim() || null;
      if (
        previousNameOverride === nextNameOverride ||
        (previousNameOverride === null && nextNameOverride === defaultGroupName(previous))
      ) {
        return;
      }

      setGroups((current) =>
        current.map((group) =>
          group.id === groupId ? { ...group, nameOverride: nextNameOverride } : group,
        ),
      );
      try {
        const updated =
          previous.scope === "research"
            ? await renameResearchWorkspace(groupId, nextNameOverride)
            : await renameGroup(groupId, nextNameOverride);
        setGroups((current) =>
          current.map((group) => (group.id === groupId ? updated : group)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setGroups((current) =>
          current.map((group) => (group.id === groupId ? previous : group)),
        );
      }
      return;
    }

    const paneId = renamePaneId;
    if (!paneId) {
      return;
    }
    const title = renameValue.trim();
    const previous = panes.find((pane) => pane.id === paneId);
    const paneAgent = previous ? agents.find((agent) => agent.paneId === previous.id) : undefined;
    const clearingUserTitle = title.length === 0;
    const nextTitle = clearingUserTitle
      ? (previous ? (defaultPaneTitle(previous, paneAgent, config) ?? previous.title) : "")
      : title;
    const previousWasManuallyTitled = manuallyTitledPaneIds.has(paneId);
    closeRenameDialog();
    if (!previous) {
      return;
    }
    if (previous.title === nextTitle) {
      if (clearingUserTitle && previousWasManuallyTitled) {
        setManuallyTitledPaneIds((current) => {
          const next = new Set(current);
          next.delete(paneId);
          return next;
        });
      }
      return;
    }

    setManuallyTitledPaneIds((current) => {
      const next = new Set(current);
      if (clearingUserTitle) {
        next.delete(paneId);
      } else {
        next.add(paneId);
      }
      return next;
    });
    // Optimistically rename, then persist; revert if the backend rejects it.
    setPanesPreservingRecoveredDismissals((current) =>
      current.map((pane) => (pane.id === paneId ? { ...pane, title: nextTitle } : pane)),
    );
    try {
      const updated = await renamePane(paneId, nextTitle);
      setPanesPreservingRecoveredDismissals((current) =>
        current.map((pane) => (pane.id === paneId ? { ...pane, title: updated.title } : pane)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setManuallyTitledPaneIds((current) => {
        const next = new Set(current);
        if (previousWasManuallyTitled) {
          next.add(paneId);
        } else {
          next.delete(paneId);
        }
        return next;
      });
      setPanesPreservingRecoveredDismissals((current) =>
        current.map((pane) =>
          pane.id === paneId ? { ...pane, title: previous?.title ?? pane.title } : pane,
        ),
      );
    }
  }

  function forgetClosedPane(paneToClose: PaneInfo) {
    setPanesPreservingRecoveredDismissals((current) => {
      const nextPanes = current.filter((pane) => pane.id !== paneToClose.id);
      setActivePaneId((currentActivePaneId) => {
        if (currentActivePaneId !== paneToClose.id) {
          return currentActivePaneId;
        }
        return selectPaneAfterCloseWithContext(current, paneToClose.id);
      });
      return nextPanes;
    });
  }

  async function closePane(paneToClose: PaneInfo): Promise<boolean> {
    setError(null);
    try {
      await killPane(paneToClose.id);
      forgetClosedPane(paneToClose);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }
  closeUnavailableRemotePaneRef.current = (pane) => {
    void closePane(pane);
  };

  async function removeResearchWorkspaceFromSidebar(workspace: GroupInfo) {
    setError(null);
    const detachedTreeIds = new Set(await removeResearchWorkspace(workspace.id));
    const remainingGroups = groupsRef.current.filter((group) => group.id !== workspace.id);
    const remainingTrees = researchTreesRef.current.filter(
      (tree) => !detachedTreeIds.has(tree.id),
    );
    setGroups(remainingGroups);
    setResearchTrees(remainingTrees);
    setArchivedResearchTrees((current) =>
      current.filter((tree) => !detachedTreeIds.has(tree.id)),
    );
    setResearchActivity((current) =>
      current.filter((node) => !detachedTreeIds.has(node.treeId)),
    );
    const activeTreeId = activeResearchTreeIdRef.current;
    const activeTreeWasRemoved = Boolean(activeTreeId && detachedTreeIds.has(activeTreeId));
    const scopeWasRemoved = researchScopeRef.current === workspace.id;
    const nextScope = scopeWasRemoved
      ? (remainingGroups.find(
          (group) => group.scope === "research" && group.id !== workspace.id,
        )?.id ?? null)
      : researchScopeRef.current;
    if (scopeWasRemoved) {
      changeResearchFolderScope(nextScope);
      activeResearchPaneIdRef.current = null;
      setActiveResearchPaneId(null);
      localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
    }
    // Removing the selected folder/tree should land on an available research
    // item in the surviving scope, not leave an unexplained empty document.
    if (scopeWasRemoved || activeTreeWasRemoved) {
      const nextTree = treeForResearchScope(
        remainingTrees,
        nextScope,
        activeTreeWasRemoved ? null : activeTreeId,
      );
      if (nextTree) {
        navigateToResearchDocument(nextTree.id);
      } else {
        focusResearchHome();
      }
    }
    pruneResearchWorkspaceVisits((id) => !detachedTreeIds.has(id));
    void refreshResearchNavigation().catch(() => undefined);
  }

  async function confirmResearchFolderRemoval() {
    const dialog = closeDialog;
    if (!dialog || dialog.kind !== "researchFolderRemove" || resolvingClose) {
      return;
    }
    setResearchFolderRemovalError(null);
    setResolvingClose("removeResearchFolder");
    try {
      await removeResearchWorkspaceFromSidebar(dialog.workspace);
      setCloseDialog(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResearchFolderRemovalError(message);
      setError(message);
    } finally {
      setResolvingClose(null);
    }
  }

  async function closeDialogForPane(
    paneToClose: PaneInfo,
    options?: { confirmAlways?: boolean; checkWorktreeStatus?: boolean },
  ): Promise<CloseDialogState | null> {
    const researchNode = researchNodeByPaneId.get(paneToClose.id);
    if (
      researchNode &&
      (researchNode.status === "queued" ||
        researchNode.status === "starting" ||
        researchNode.status === "running")
    ) {
      return { kind: "researchCancel", pane: paneToClose };
    }
    // A settled node's pane is already on its way out (retirement kills it
    // within seconds). Closing it early is a plain close — the process probe
    // below would otherwise see the still-live adapter and raise a spurious
    // "running process" confirmation in that window.
    if (researchNode) {
      return null;
    }
    // A research pane whose node hasn't reached the debounced index yet is
    // still a research run — closing it cancels, and must say so rather than
    // falling through to the ordinary agent-close dialog.
    if (groupById.get(paneToClose.groupId)?.scope === "research") {
      return { kind: "researchCancel", pane: paneToClose };
    }
    const agent = agentsRef.current.find((candidate) => candidate.paneId === paneToClose.id);
    if (agent && agent.branch) {
      const checkingChanges = options?.checkWorktreeStatus !== false;
      const probeNonce = (worktreeProbeNonceRef.current += 1);
      if (checkingChanges) {
        // The dialog opens immediately and the git-status verdict patches in:
        // awaiting the probe here left ⌘W with no visible response for as
        // long as `git status` takes on the worktree (seconds on large or
        // cold-cache repos). A probe failure keeps the unknown state so the
        // dialog cannot falsely assure the user that deleting is safe. The
        // nonce ties the patch to this dialog generation: a probe from a
        // dismissed dialog (cancel → reopen the same pane) must not land its
        // older verdict on the newer dialog.
        void worktreeStatus(agent.id)
          .then(
            (status): boolean | null => status.hasChanges,
            (): boolean | null => null,
          )
          .then((hasChanges) => {
            setCloseDialog((current) =>
              current?.kind === "worktree" &&
              current.probeNonce === probeNonce &&
              current.checkingChanges
                ? { ...current, hasChanges, checkingChanges: false }
                : current,
            );
          });
      }
      return {
        kind: "worktree",
        pane: paneToClose,
        agentId: agent.id,
        worktreeDir: agent.worktreeDir,
        hasChanges: null,
        checkingChanges,
        probeNonce,
        busy:
          agent.status === "starting" ||
          agent.status === "running" ||
          agent.status === "awaitingInput" ||
          agent.status === "awaitingPermission",
      };
    }

    const liveReason =
      agent?.status === "awaitingPermission"
        ? "is waiting to approve a tool use"
        : agent?.status === "awaitingInput"
          ? "is waiting for your input"
          : agent?.status === "running" || agent?.status === "starting"
            ? "is still working"
            : null;

    // Pending queued turns that would be parked (and easy to lose track of) on close —
    // surface them through the same stop dialog rather than closing silently. This
    // covers both the closing pane's own live agent, whose own queue is otherwise not
    // counted once it goes idle, and any recovered (orphaned) queues already parked here.
    const ownQueuedCount = agent
      ? (queuedTurnsByAgentRef.current[agent.id]?.length ?? 0)
      : 0;
    const recoveredTurnCount = agents
      .filter((candidate) => candidate.orphanedQueuePaneId === paneToClose.id)
      .reduce(
        (total, candidate) =>
          total + (queuedTurnsByAgentRef.current[candidate.id]?.length ?? 0),
        0,
      );
    const pendingQueuedCount = ownQueuedCount + recoveredTurnCount;

    const reason =
      liveReason ??
      (pendingQueuedCount > 0
        ? `has ${pendingQueuedCount} queued ${
            pendingQueuedCount === 1 ? "turn" : "turns"
          }`
        : null);
    if (reason) {
      return { kind: "stop", pane: paneToClose, reason };
    }
    // Remote process inspection cannot establish that the session is idle.
    // Show the requested confirmation without waiting for that probe.
    if (paneToClose.remoteSession && options?.confirmAlways) {
      return { kind: "pane", pane: paneToClose };
    }
    try {
      const activity = await paneActivity(paneToClose.id);
      if (activity.kind === "runningProcess" && activity.processCount > 0) {
        return {
          kind: "runningProcess",
          pane: paneToClose,
          processCount: activity.processCount,
          processSummary: activity.processSummary,
        };
      }
    } catch {
      // Process inspection is best-effort. If the probe fails, let the normal close
      // path continue instead of turning an inspection error into a blocking prompt.
    }
    if (options?.confirmAlways) {
      return { kind: "pane", pane: paneToClose };
    }
    return null;
  }

  // Closing a tab that owns a git worktree opens a dialog: check the worktree for
  // uncommitted changes first, then let the user delete or keep it (or cancel).
  // Other agent panes confirm only when a live agent would be interrupted; shell
  // panes and finished/failed agents close without a prompt.
  async function requestClosePane(paneToClose: PaneInfo, options?: { confirmAlways?: boolean }) {
    const dialog = await closeDialogForPane(paneToClose, {
      confirmAlways: options?.confirmAlways,
      checkWorktreeStatus: true,
    });
    if (dialog) {
      setCloseDialog(dialog);
      return;
    }
    await closePane(paneToClose);
  }

  useEffect(() => {
    if (!exitPreflightRequest) {
      return;
    }
    // Quitting already warns that every tab, agent, and process will stop. Reusing
    // the per-pane close checks here used to fork one or two `ps` probes for every
    // ordinary pane, then discard the resulting dialog descriptions. With many tabs
    // that delayed this generic confirmation by hundreds of milliseconds.
    const paneCount = Math.max(exitPreflightRequest.paneCount, panesRef.current.length);
    const researchRunCount = Math.max(
      exitPreflightRequest.researchRunCount,
      runningResearchCount,
    );
    setExitPreflightRequest(null);
    setExitDialog(paneCount > 0 || researchRunCount > 0 ? { paneCount, researchRunCount } : null);
  }, [exitPreflightRequest, runningResearchCount]);

  useEffect(() => {
    if (!closeDialog) {
      return;
    }

    const focusCloseButton = (force = false) =>
      focusConfirmDialogButton(closeConfirmButtonRef.current, force);

    focusCloseButton(true);
    const frame = requestAnimationFrame(() => focusCloseButton());
    const settle = window.setTimeout(() => focusCloseButton(), 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [closeDialog]);

  useEffect(() => {
    if (!exitDialog) {
      return;
    }

    const focusQuitButton = (force = false) =>
      focusConfirmDialogButton(exitConfirmButtonRef.current, force);

    focusQuitButton(true);
    const frame = requestAnimationFrame(() => focusQuitButton());
    const settle = window.setTimeout(() => focusQuitButton(), 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [exitDialog]);

  useEffect(() => {
    if (!remoteDeleteConfirm) {
      return;
    }

    const focusRemoveButton = (force = false) =>
      focusConfirmDialogButton(remoteDeleteConfirmButtonRef.current, force);

    focusRemoveButton(true);
    const frame = requestAnimationFrame(() => focusRemoveButton());
    const settle = window.setTimeout(() => focusRemoveButton(), 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [remoteDeleteConfirm]);

  // Resolves the worktree close dialog: always closes the pane, and additionally
  // deletes the worktree when the user chose to.
  async function resolveCloseDialog(choice: "keep" | "delete") {
    const dialog = closeDialog;
    if (!dialog || dialog.kind !== "worktree" || resolvingClose) {
      return;
    }
    setError(null);
    setResolvingClose(choice);
    try {
      await closeWorktreePane(dialog.agentId, choice === "delete");
      forgetClosedPane(dialog.pane);
      setCloseDialog(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Worktree deletion runs after the pane is killed. If cleanup fails, the
      // command reports an error even though the backend no longer has the pane;
      // reconcile that partial success so the UI cannot retain a dead tab/agent.
      try {
        const [latestPanes, latestAgents, latestGroups] = await Promise.all([
          listPanes(),
          listAgents(),
          listGroups(),
        ]);
        if (!latestPanes.some((pane) => pane.id === dialog.pane.id)) {
          setPanesPreservingRecoveredDismissals(latestPanes);
          setAgents(latestAgents);
          setGroups(latestGroups);
        }
      } catch {
        // Preserve the cleanup error; a later backend event/resync can reconcile
        // state if this best-effort read also fails.
      }
      setError(message);
      setCloseDialog(null);
    } finally {
      setResolvingClose(null);
    }
  }

  // Confirms stopping a live agent that has no worktree to clean up.
  async function confirmStopAndClose() {
    const dialog = closeDialog;
    if (!dialog || (dialog.kind !== "stop" && dialog.kind !== "researchCancel")) {
      return;
    }
    setCloseDialog(null);
    await closePane(dialog.pane);
  }

  async function confirmPaneClose() {
    const dialog = closeDialog;
    if (!dialog || (dialog.kind !== "pane" && dialog.kind !== "runningProcess")) {
      return;
    }
    setCloseDialog(null);
    await closePane(dialog.pane);
  }

  async function confirmExit() {
    if (quittingRef.current) {
      return;
    }
    quittingRef.current = true;
    setQuitting(true);
    setError(null);
    // Let React commit the pending button and give WebKit a full paint before
    // AppKit begins the comparatively slow application teardown.
    await waitForNextPaint();
    flushPendingDrafts();
    try {
      const activeResearchNodeIds = researchActivity
        .filter((node) => isActiveResearchStatus(node.status))
        .map((node) => node.id);
      // Settled, not fail-fast: the activity snapshot can be moments stale, so
      // a run that finished (and lost its pane) in the meantime rejects with
      // "not active" — which must not abort the quit. Runs whose cancel truly
      // failed are killed by app teardown and reconciled to Failed on the next
      // start, so proceeding is safe either way.
      const cancellations = await Promise.allSettled(
        activeResearchNodeIds.map((nodeId) => cancelResearchNode(nodeId)),
      );
      for (const cancellation of cancellations) {
        if (cancellation.status === "rejected") {
          console.warn("research cancellation during quit failed:", cancellation.reason);
        }
      }
      await confirmAppExit();
    } catch (err) {
      quittingRef.current = false;
      setQuitting(false);
      setExitDialog(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Forks the active session into a new tab (resuming it) — as a sibling right
  // after the current tab, nested under it when `nest` is set, or joined into a
  // split directly below it when `splitBelow` is set — and focuses the fork. The
  // backend also emits agent.forked, which refetches the ordered pane list, so the
  // optimistic placement below is just to avoid a flicker.
  async function forkPane(
    pane: PaneInfo,
    options: {
      useWorktree: boolean;
      worktreeName?: string;
      prompt?: string;
      anchor?: MessageAnchor;
      splitBelow?: boolean;
      onError?: (message: string) => void;
    },
  ): Promise<boolean> {
    setError(null);
    try {
      const fork = await forkAgent(pane.id, options);
      if (options.splitBelow) {
        const orderedPanes = placePaneAfterOptimistically(fork, pane.id, false);
        setPanesPreservingRecoveredDismissals(orderedPanes);
        savePaneSplits(
          joinPaneSplit(paneSplitsRef.current, orderedPanes, pane.id, fork.id, {
            insertedPaneId: fork.id,
            source: "command",
          }),
          orderedPanes,
        );
        setActivePaneId(fork.id);
        setLastActiveGroupId(fork.groupId);
        requestAnimationFrame(() => {

        });
      } else {
        setPanesPreservingRecoveredDismissals(placePaneAfterOptimistically(fork, pane.id, false));
        setActivePaneId(fork.id);
      }
      expandNewAgentTranscriptByDefault(fork);
      if (options.prompt && fork.agentId) {
        pendingFirstTitleByAgentRef.current.set(
          fork.agentId,
          createPendingFirstMessageTitle(fork.id),
        );
        applyPendingFirstMessageTitle(fork.agentId, options.prompt);
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.onError) {
        options.onError(message);
      } else {
        setError(message);
      }
      return false;
    }
  }

  const terminalHandlersRef = useRef({
    noteUserInput,
  });
  terminalHandlersRef.current = {
    noteUserInput,
  };
  // Mirror active-tab state into refs so the always-on keydown listener never reads
  // stale state.
  useEffect(() => {
    activePaneRef.current = activePane;
    browserOverlayByPaneRef.current = browserOverlayByPane;
    activeBrowserOwnerIdRef.current = activeBrowserOwnerId;
    toggleActiveBrowserOverlayRef.current = toggleActiveBrowserOverlay;
    closeActiveBrowserOverlayRef.current = closeActiveBrowserOverlay;
    requestClosePaneRef.current = requestClosePane;
    splitPaneBelowRef.current = splitPaneBelow;
    splitPaneRightRef.current = splitPaneRight;
    canToggleActiveTranscriptExpandedRef.current = Boolean(
      activeSurfaceRef.current === "pane" &&
        activePane &&
        (activePaneCanToggleTurnSidebar ||
          (splitOverlayTranscriptMode && splitOverlayTurnPaneSurfaces.length > 0)),
    );
    toggleActiveTranscriptExpandedRef.current = toggleActiveTranscriptExpanded;
  });

  // Keyboard-ownership arbitration between the webview and the native terminal
  // surfaces. Two responsibilities:
  //
  // 1. Track whether a web editable element really holds DOM focus (composer,
  //    rename input, search field…). While it does, the native pane must not
  //    claim AppKit first responder — see the `focused` layout flag.
  //
  // 2. Recover from first-responder theft. WKWebView grabs first responder on
  //    its own schedule (initial page load, engine-internal focus churn); when
  //    that happens without any web editable claiming the keyboard, the active
  //    terminal still owns it, so bounce first responder straight back. The
  //    theft itself is the signal: the page receives a window `focus` event.
  //    Focus-in claims web ownership synchronously from the event target so the
  //    first typed key cannot race the native layout update. Focus-out and
  //    window-focus recovery sample one frame later, after activeElement settles.
  useEffect(() => {
    let frame: number | null = null;
    let restoreFrame: number | null = null;
    let restoringRememberedEditable = false;
    let disposed = false;
    let unlistenNativeFocus: (() => void) | undefined;
    const restorableEditable = (target: HTMLElement | null) =>
      Boolean(
        target &&
          target.isConnected &&
          isEditableTarget(target) &&
          !target.matches(":disabled"),
      );
    const sample = () => {
      frame = null;
      const editable = document.hasFocus() && isEditableTarget(document.activeElement);
      webEditableFocusedRef.current = editable;
      setWebEditableFocused(editable);
    };
    const schedule = () => {
      if (frame === null) {
        frame = requestAnimationFrame(sample);
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      const editable = document.hasFocus() && isEditableTarget(event.target);
      if (editable && event.target instanceof HTMLElement) {
        lastFocusedWebEditableRef.current = event.target;
      }
      webEditableFocusedRef.current = editable;
      setWebEditableFocused(editable);
    };
    const restoreWindowEditable = (returningToApp: boolean) => {
      const active =
        document.activeElement instanceof HTMLElement &&
        isEditableTarget(document.activeElement)
          ? document.activeElement
          : null;
      const remembered = appBlurWebEditableRef.current;
      const owner = windowFocusKeyboardOwner({
        currentWebEditable: active !== null,
        rememberedWebEditable: restorableEditable(remembered),
        returningToApp: returningToApp || restoringRememberedEditable,
      });
      if (owner === "current-web-editable") {
        lastFocusedWebEditableRef.current = active;
        webEditableFocusedRef.current = true;
        setWebEditableFocused(true);
        return true;
      }
      if (owner !== "remembered-web-editable" || !remembered) {
        restoringRememberedEditable = false;
        return false;
      }
      // Block native ownership synchronously, then focus both now and on the
      // next frame: Tauri can announce native activation just before WKWebView
      // is ready to accept first responder again.
      restoringRememberedEditable = true;
      lastFocusedWebEditableRef.current = remembered;
      webEditableFocusedRef.current = true;
      setWebEditableFocused(true);
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      remembered.focus({ preventScroll: true });
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame);
      }
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = null;
        if (!restorableEditable(remembered)) {
          appBlurWebEditableRef.current = null;
          restoringRememberedEditable = false;
          sample();
          return;
        }
        if (document.activeElement !== remembered) {
          remembered.focus({ preventScroll: true });
        }
        restoringRememberedEditable = false;
        sample();
      });
      return true;
    };
    const bounceStolenFocus = () => {
      const returningToApp = !nativeWindowFocusedRef.current;
      lastWindowFocusSeqRef.current = ++focusOrderSeqRef.current;
      schedule();
      if (restoreWindowEditable(returningToApp)) {
        return;
      }
    };
    // Also stamps the input-vs-window-focus ordering used to tell user-driven
    // focus from WebKit's own restoration churn (see the refs' declaration).
    const noteUserIntent = () => {
      lastUserInputSeqRef.current = ++focusOrderSeqRef.current;
      schedule();
    };
    window.addEventListener("focusin", handleFocusIn);
    window.addEventListener("focusout", schedule);
    window.addEventListener("blur", schedule);
    window.addEventListener("focus", bounceStolenFocus);
    // Recovery backstop for editables that vanish on a path the explicit
    // re-samples (pane membership, the known modals) don't cover: WebKit emits
    // no focusout when a focused element's subtree is removed, so
    // webEditableFocused can wedge true with focus back on <body>, leaving
    // every terminal keyboard-dead. Keys and clicks only reach the DOM at all
    // while the native surface doesn't own the keyboard, so re-sampling on
    // them is cheap (rAF-coalesced, no-op state update) and heals any such
    // wedge on the user's next keystroke or click, whatever overlay caused it.
    window.addEventListener("keydown", noteUserIntent, true);
    window.addEventListener("pointerdown", noteUserIntent, true);
    const appWindow = getCurrentWindow();
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        nativeWindowFocusedRef.current = focused;
        if (!focused) {
          appBlurWebEditableRef.current = webEditableFocusedRef.current
            ? lastFocusedWebEditableRef.current
            : null;
          return;
        }
        lastWindowFocusSeqRef.current = ++focusOrderSeqRef.current;
        if (!restoreWindowEditable(true)) {
          schedule();
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenNativeFocus = unlisten;
        }
      })
      .catch(() => undefined);
    sample();
    return () => {
      disposed = true;
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("focusout", schedule);
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", bounceStolenFocus);
      window.removeEventListener("keydown", noteUserIntent, true);
      window.removeEventListener("pointerdown", noteUserIntent, true);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame);
      }
      unlistenNativeFocus?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (activeSurface !== "pane") {
      return;
    }
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
    const editable = document.hasFocus() && isEditableTarget(document.activeElement);
    webEditableFocusedRef.current = editable;
    setWebEditableFocused(editable);
  }, [activeSurface]);

  // Backstop for editables that unmount together with a closing pane (the
  // terminal and transcript find inputs live inside pane subtrees): WebKit
  // emits no focusout when a focused element is removed, so without this a
  // pane closing under a focused find input leaves webEditableFocused wedged
  // true and every remaining terminal keyboard-dead. Re-sample focus whenever
  // pane membership changes.
  const paneIdsKey = panes.map((pane) => pane.id).join("\n");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setWebEditableFocused(
        document.hasFocus() && isEditableTarget(document.activeElement),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [paneIdsKey]);

  // Backstop for editables that unmount with a closing modal: the ⌘K palette,
  // rename dialogs, settings, and the command palette all hold DOM focus in an input.
  // WebKit may remove that input without focusout, leaving the active terminal
  // keyboard-dead until another real focus event.
  const modalEditorOpen =
    commandPaletteOpen ||
    settingsOpen ||
    agentsOpen ||
    terminalMapOpen ||
    Boolean(renamePaneId || renameGroupId);
  useEffect(() => {
    if (modalEditorOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setWebEditableFocused(
        document.hasFocus() && isEditableTarget(document.activeElement),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [modalEditorOpen]);

  const mountedTurnPaneCellsKey = visibleRightBarSurfaces
    .map((surface) => surface.pane.id)
    .join("\n");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const restored = document.activeElement;
      if (
        !userInputSinceWindowFocus() &&
        restored instanceof HTMLElement &&
        isEditableTarget(restored) &&
        restored.closest(".turn-pane")
      ) {
        restored.blur();
      }
      setWebEditableFocused(
        document.hasFocus() && isEditableTarget(document.activeElement),
      );
      const paneId = activePaneIdRef.current;
      if (paneId) {

      }
    });
    return () => cancelAnimationFrame(frame);
  }, [mountedTurnPaneCellsKey, userInputSinceWindowFocus]);

  // Live snapshot of the app-level overlay state for the Escape dispatcher
  // below, which is registered exactly once. Mirrored every render, read only
  // at event time.
  const escapeOverlayStateRef = useRef({
    remoteAddMenuOpen,
    remoteDeleteConfirm,
    remoteSettingsSaving,
    worktreeCreateDialog,
    repositoryBrowser,
    closeDialog,
    exitDialog,
    renamePaneId,
    renameGroupId,
    resolvingClose,
    quitting,
    settingsOpen,
    agentsOpen,
    error,
  });
  useEffect(() => {
    escapeOverlayStateRef.current = {
      remoteAddMenuOpen,
      remoteDeleteConfirm,
      remoteSettingsSaving,
      worktreeCreateDialog,
      repositoryBrowser,
      closeDialog,
      exitDialog,
      renamePaneId,
      renameGroupId,
      resolvingClose,
      quitting,
      settingsOpen,
      agentsOpen,
      error,
    };
  });

  // Escape can originate in three separate AppKit responders while the
  // browser is visible: the outer app webview, the child human-browser
  // WKWebView, or a native terminal whose ownership release is still crossing
  // the bridge. The native monitor funnels all three through this live
  // dispatcher. The DOM listener below uses it too so lightbox/browser
  // priority stays single-sourced.
  browserEscapeDispatcherRef.current = () => {
    if (getImageLightbox() !== null) {
      closeImageLightbox();
      return "exclusive";
    }
    if (getDiagramLightbox() !== null) {
      closeDiagramLightbox();
      return "exclusive";
    }
    if (!activeBrowserOwnerId || !browserOverlayByPane[activeBrowserOwnerId]?.open) {
      return null;
    }
    closeActiveBrowserOverlayRef.current();
    return "exclusive";
  };

  // One capture-phase listener dispatches Escape across the app-level
  // overlays in a fixed order. These used to be independent window listeners
  // whose effects re-registered when their deps changed, so their relative
  // position in the same-target capture order silently followed registration
  // history; state lives in the ref above so this listener never re-registers
  // and the order below is the whole story.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // Native modal dialogs own Escape and focus while they are open.
      if (document.querySelector("dialog[open]")) return;
      const overlays = escapeOverlayStateRef.current;

      const browserEscapeDisposition = browserEscapeDispatcherRef.current();
      if (browserEscapeDisposition !== null) {
        event.preventDefault();
        event.stopPropagation();
        if (browserEscapeDisposition === "exclusive") {
          event.stopImmediatePropagation();
        }
        return;
      }

      if (overlays.remoteAddMenuOpen) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setRemoteAddMenuOpen(false);
        requestAnimationFrame(() => remoteAddMenuButtonRef.current?.focus());
        return;
      }

      if (overlays.remoteDeleteConfirm) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (!overlays.remoteSettingsSaving) {
          setRemoteDeleteConfirm(null);
        }
        return;
      }

      // The remaining overlays dismiss together on one Escape, as they did as
      // independent listeners that each observed the same keydown.
      const dialogsOpen = Boolean(
        overlays.repositoryBrowser ||
          overlays.worktreeCreateDialog ||
          overlays.closeDialog ||
          overlays.exitDialog,
      );
      let stopPropagation = false;
      if (dialogsOpen) {
        stopPropagation = true;
        event.preventDefault();
        // Don't dismiss the worktree dialog while its close/delete is running.
        if (!overlays.resolvingClose) {
          setCloseDialog(null);
        }
        if (!overlays.repositoryBrowser?.opening) {
          setRepositoryBrowser(null);
        }
        if (!overlays.worktreeCreateDialog?.creating) {
          setWorktreeCreateDialog(null);
          const resolve = worktreeDialogResolveRef.current;
          worktreeDialogResolveRef.current = null;
          resolve?.(false);
        }
        if (!overlays.quitting) {
          setExitDialog(null);
        }
      }
      if (overlays.settingsOpen) {
        stopPropagation = true;
        event.preventDefault();
        setSettingsOpen(false);
      }
      if (overlays.agentsOpen) {
        stopPropagation = true;
        event.preventDefault();
        setAgentsOpen(false);
      }
      // Dismiss the workspace error banner with Escape only when no dialog or
      // rename editor is handling the key.
      if (
        overlays.error &&
        !dialogsOpen &&
        !overlays.renamePaneId &&
        !overlays.renameGroupId
      ) {
        stopPropagation = true;
        event.preventDefault();
        setError(null);
      }
      if (stopPropagation) {
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // Persist application settings whenever they change, so the choice survives a
  // restart. Writing on the initial value is harmless.
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // Persist the OpenRouter key to the backend (its durable, owner-only home) whenever it
  // changes — but only after it has been hydrated from the backend, so the initial
  // in-memory value doesn't clobber the stored key before boot loads it.
  useEffect(() => {
    if (!openRouterKeyHydratedRef.current) {
      return;
    }
    void setOpenRouterKey(settings.openRouterKey).catch(() => undefined);
  }, [settings.openRouterKey]);

  useEffect(() => {
    titleGenerationTestSeqRef.current += 1;
    setTitleGenerationTest(null);
  }, [
    settings.tabTitleProvider,
    settings.openRouterKey,
    settings.openRouterModel,
  ]);

  useEffect(() => {
    let disposed = false;
    void getShowHideShortcut()
      .then((setting) => {
        if (!disposed) {
          setShowHideShortcutSetting(setting);
        }
      })
      .catch((err) => {
        if (!disposed) {
          setShowHideShortcutSetting({
            accelerator: null,
            registered: false,
            error: unknownErrorMessage(err),
            captureActive: false,
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Closing Settings can unmount the focused capture input without a reliable
  // blur event. Always restore the configured global shortcut in that case.
  useEffect(() => {
    if (!settingsOpen && showHideShortcutSetting.captureActive) {
      setShowHideShortcutCapturing(false);
    }
  }, [settingsOpen, showHideShortcutSetting.captureActive]);

  useEffect(
    () => () => {
      if (appToastTimerRef.current !== null) {
        window.clearTimeout(appToastTimerRef.current);
      }
    },
    [],
  );
  // Keep the machine awake while the toggle is on and at least one agent may
  // still be working, including while an in-flight tool waits for permission or
  // user feedback.
  // Releasing the lock once every agent is at rest lets normal power management
  // resume.
  const anyAgentBusy = useMemo(
    () => agents.some((agent) => agentStatusKeepsMachineAwake(agent.status)),
    [agents],
  );
  useEffect(() => {
    const active = desiredPreventSleepState(
      agentsHydrated,
      settings.preventSleep,
      anyAgentBusy,
    );
    if (active === null) {
      return;
    }
    void setPreventSleep(active).catch(() => undefined);
    if (!active) {
      return;
    }
    // Re-assert periodically while the lock is wanted: the backend declines (and
    // releases) it while on battery under 10%, so this lets a drop below — or a
    // recovery / plugging in — take effect without waiting for an agent state change.
    const interval = window.setInterval(() => {
      void setPreventSleep(true).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [agentsHydrated, settings.preventSleep, anyAgentBusy]);

  // Mirror the login-shell preference to the backend, which keeps its own
  // persisted copy (read on the spawn path, including startup recovery that runs
  // before this fires). Hydrate that durable value first, then mirror later changes
  // so a fresh spawn — and the next restart's recovery — honors what the dialog shows.
  useEffect(() => {
    if (!useLoginShellHydratedRef.current) {
      return;
    }
    void setUseLoginShell(settings.useLoginShell).catch((err) => {
      setError(`Could not save the login-shell setting: ${unknownErrorMessage(err)}`);
    });
  }, [settings.useLoginShell]);

  // The backend owns this preference because worktrees can also be created by
  // CLI/control-socket and queued forks without a frontend request in flight.
  useEffect(() => {
    if (!worktreeLocationHydratedRef.current) {
      return;
    }
    void setWorktreeLocation(settings.worktreeLocation).catch((err) => {
      setError(`Could not save the worktree-location setting: ${unknownErrorMessage(err)}`);
    });
  }, [settings.worktreeLocation]);

  // The backend owns this preference because research launch prompts (fresh
  // runs and every follow-up kind) are assembled on the Rust side. Hydrate the
  // durable value first, then mirror later edits so the next launch honors
  // what the dialog shows.
  useEffect(() => {
    if (!researchLaunchInstructionHydratedRef.current) {
      return;
    }
    void setResearchLaunchInstruction(settings.researchLaunchInstruction).catch((err) => {
      setError(`Could not save the research-instructions setting: ${unknownErrorMessage(err)}`);
    });
  }, [settings.researchLaunchInstruction]);

  // Escape handling for the worktree close/exit dialogs and the settings panel
  // lives in the app-level Escape dispatcher; this effect only resets transient
  // controls when it closes. Keep settingsTab so reopening returns to the same
  // section.
  useEffect(() => {
    if (!settingsOpen) {
      setOpenRouterKeyVisible(false);
      setShowHideShortcutCapturing(false);
    }
  }, [settingsOpen]);

  // Focus and select the name when the rename dialog opens, so the user can type
  // a new name straight away.
  useEffect(() => {
    if (renamePaneId || renameGroupId) {
      const input = renameInputRef.current;
      input?.focus();
      input?.select();
    }
  }, [renamePaneId, renameGroupId]);

  useEffect(() => {
    if (worktreeCreateDialog) {
      const input = worktreeNameInputRef.current;
      input?.focus();
      input?.select();
    }
  }, [worktreeCreateDialog?.pane.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.metaKey) {
        setShortcutHintsVisible(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Meta" || !event.metaKey) {
        setShortcutHintsVisible(false);
      }
    };
    const hideShortcutHints = () => setShortcutHintsVisible(false);
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hideShortcutHints();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", hideShortcutHints);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", hideShortcutHints);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {

    const executeShortcut = (rawCommand: AppShortcutCommand, repeat: boolean) => {
      if (document.querySelector("dialog[open]")) return;
      const command = rawCommand;
      // No app command repeats while its chord is held.
      if (repeat) {
        return;
      }
      switch (command.type) {
        case "focusResearchHome":
          focusResearchHome();
          window.requestAnimationFrame(() => {
            document
              .querySelector<HTMLTextAreaElement>(".new-research-launcher textarea")
              ?.focus();
          });
          return;
        case "toggleLeftSidebar":
          setLeftSidebarCollapsedForActivePane(!leftSidebarCollapsedRef.current);
          return;
        case "openSettings":
          setAgentsOpen(false);
          setSettingsOpen(true);
          return;
        case "openCommandPalette":
          setCommandPaletteOpen(true);
          return;
        case "focusFollowups":
          requestResearchFollowupsFocus();
          return;
        case "openFolderMenu":
          requestResearchFolderMenuToggle();
          return;
        case "toggleSourceBrowser": {
          const anyBrowserOpen = anyBrowserOverlayOpen(browserOverlayByPaneRef.current);
          if (anyBrowserOpen) {
            closeAllBrowserOverlays();
            return;
          }
          void hideEveryHumanBrowser().then((hidden) => {
            if (hidden > 0) {
              return;
            }
            const browserOwnerId =
              activeSurfaceRef.current === "research"
                ? activeResearchTreeIdRef.current
                  ? researchBrowserOwnerId(activeResearchTreeIdRef.current)
                  : null
                : null;
            if (browserOwnerId) {
              toggleBrowserOverlay(browserOwnerId);
            }
          });
          return;
        }
      }
    };

    nativeAppShortcutHandlerRef.current = executeShortcut;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShowHideShortcutCaptureTarget(event.target) || event.defaultPrevented) {
        return;
      }
      const pane = activeSurfaceRef.current === "pane" ? activePaneRef.current : undefined;
      if (
        pane &&
        shouldCloseRemotePaneOnControlD(
          {
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            repeat: event.repeat,
            editableTarget: isEditableTarget(event.target),
            paneTarget:
              isTerminalTarget(event.target) ||
              event.target === document.body ||
              event.target === document.documentElement,
          },
          pane,
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        closeUnavailableRemotePaneRef.current(pane);
        return;
      }
      const command = resolveAppShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        terminalTarget: isTerminalTarget(event.target),
      });
      if (!command) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      executeShortcut(command, event.repeat);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      nativeAppShortcutHandlerRef.current = () => undefined;
    };
  }, [
    activePaneId,
    panes,
    sidebarPanes,
    activePane,
    lastActiveGroupId,
    groupById,
    researchSurfaceActive,
    researchHomeActive,
    activeResearchTreeId,
    focusResearchHome,
  ]);

  useEffect(() => {
    if (!hasVisibleRightBar) {
      return;
    }

    const handleResize = () => {
      setTurnPaneWidth((current) => clampTurnPaneWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [hasVisibleRightBar]);

  // Keep the sidebar within bounds as the window resizes or the turn pane claims
  // space (deps refresh the clamp's view of available width).
  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [hasVisibleRightBar, turnPaneWidth, reservedTerminalStageMinWidth]);

  async function updateShowHideShortcut(accelerator: string | null) {
    const request = ++showHideShortcutRequestRef.current;
    setShowHideShortcutSaving(true);
    setShowHideShortcutSetting((current) => ({
      ...current,
      accelerator,
      error: null,
    }));
    try {
      const setting = await setShowHideShortcut(accelerator);
      if (showHideShortcutRequestRef.current === request) {
        setShowHideShortcutSetting(setting);
      }
    } catch (err) {
      if (showHideShortcutRequestRef.current === request) {
        setShowHideShortcutSetting((current) => ({
          ...current,
          error: unknownErrorMessage(err),
        }));
      }
    } finally {
      setShowHideShortcutSaving(false);
    }
  }

  function captureShowHideShortcut(event: ReactKeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    event.stopPropagation();

    const { accelerator, error } = shortcutFromKeyboardEvent(event);
    if (error) {
      setShowHideShortcutSetting((current) => ({ ...current, error }));
      return;
    }
    if (!accelerator) {
      return;
    }
    void updateShowHideShortcut(accelerator);
  }

  function clearShowHideShortcut() {
    void updateShowHideShortcut(null);
  }

  function setShowHideShortcutCapturing(active: boolean) {
    const request = ++showHideShortcutRequestRef.current;
    setShowHideShortcutSetting((current) => ({ ...current, captureActive: active }));
    void setShowHideShortcutCaptureActive(active)
      .then((setting) => {
        if (showHideShortcutRequestRef.current === request) {
          setShowHideShortcutSetting(setting);
        }
      })
      .catch((err) => {
        if (showHideShortcutRequestRef.current === request) {
          setShowHideShortcutSetting((current) => ({
            ...current,
            captureActive: false,
            error: unknownErrorMessage(err),
          }));
        }
      });
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const releasePointer = claimResizePointer(event);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      setSidebarWidth(clampSidebarWidth(nextWidth));
    };
    const stopResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      releasePointer();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function resizeSidebarWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    setSidebarWidth((current) =>
      clampSidebarWidth(current + (event.key === "ArrowRight" ? step : -step)),
    );
  }

  // Opening a card whose root isn't in the loaded feed (Archive, or a folder
  // member paged out of it) keeps the list in the feed column beside the thread.
  // Opening a question selects the clicked row and replaces any saved
  // branch selection. Clicking the already-open thread keeps its selection.
  const openFeedResearchTree = useCallback(
    (treeId: string) => {
      if (
        !isResearchTreeSelectionChange(
          activeResearchTreeId,
          researchSurfaceActive && researchStageView === "document",
          treeId,
        )
      ) {
        return;
      }
      const rootNodeId = researchTrees.find((tree) => tree.id === treeId)?.rootNodeId;
      if (rootNodeId) openResearchNode(treeId, rootNodeId);
      else navigateToResearchDocument(treeId);
    },
    [
      activeResearchTreeId,
      navigateToResearchDocument,
      openResearchNode,
      researchStageView,
      researchSurfaceActive,
      researchTrees,
    ],
  );
  const openFeedView = useCallback(
    (view: ResearchFeedView) => {
      setPendingResearchFolderDelete(null);
      openJournalView(view);
    },
    [openJournalView],
  );
  const moveResearchTreeFromFeed = useCallback(
    (treeId: string, place: string) => void moveResearchTree(treeId, place),
    [moveResearchTree],
  );
  // The open conversation's open nodes (the message selected in its root
  // pair and each open branch's head), whose starred child rows the feed
  // shows selected. Node ids are unique across trees, so ids left from
  // another tree match nothing.
  const [openResearchNodeIds, setOpenResearchNodeIds] = useState<string[]>([]);
  // Remove star on a feed child row; the node update event drops the row.
  const unstarResearchFeedChild = useCallback(
    (child: ResearchFeedChild) => {
      void setResearchNodePromoted(child.nodeId, false).then(
        () => showResearchToast(child.branch ? "Branch unstarred." : "Unstarred."),
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      );
    },
    [showResearchToast],
  );
  // Follow persists on the tree; the resulting tree update event patches the
  // feed and the open document, so nothing is set here.
  const followResearchTreeFromFeed = useCallback(
    (treeId: string, followed: boolean) => {
      void setResearchTreeFollowed(treeId, followed).then(
        () => showResearchToast(followed ? "Following. You'll be notified of replies." : "Unfollowed."),
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      );
    },
    [showResearchToast],
  );
  const bookmarkResearchTreeFromFeed = useCallback(
    (treeId: string, bookmarked: boolean) => {
      void setResearchTreeBookmarked(treeId, bookmarked).then(
        () => showResearchToast(bookmarked ? "Bookmarked." : "Bookmark removed."),
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      );
    },
    [showResearchToast],
  );
  // The open question's Follow, Bookmark and Move to, listed in its root
  // answer menus with the same state as its feed row's menu.
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
  const activeResearchTreeMenu = useMemo<ResearchDocumentTreeMenu | undefined>(() => {
    const tree = activeResearchTreeState;
    if (!tree) return undefined;
    return {
      currentPlace: researchTreePlace(tree, researchFolderState),
      folders: researchFolders,
      bookmarked: Boolean(tree.bookmarked),
      followed: Boolean(tree.followed),
      followDisabledReason: tree.archivedAt ? "Archived questions don't send notifications" : null,
      onSetBookmarked: (bookmarked) => bookmarkResearchTreeFromFeed(tree.id, bookmarked),
      onSetFollowed: (followed) => followResearchTreeFromFeed(tree.id, followed),
      onMove: (place) => moveResearchTreeFromFeed(tree.id, place),
      onNewFolder: (trigger) => openNewResearchFolderDialog(tree.id, trigger),
    };
  }, [
    activeResearchTreeState,
    researchFolderState,
    researchFolders,
    bookmarkResearchTreeFromFeed,
    followResearchTreeFromFeed,
    moveResearchTreeFromFeed,
    openNewResearchFolderDialog,
  ]);
  // A draft opens in the content column beside the feed, which keeps its
  // view; opening a thread replaces it.
  const [openResearchDraftId, setOpenResearchDraftId] = useState<string | null>(null);
  const openResearchDraft = researchSurfaceActive
    ? (researchDrafts.find((draft) => draft.id === openResearchDraftId) ?? null)
    : null;
  useEffect(() => {
    if (activeResearchTreeId) setOpenResearchDraftId(null);
  }, [activeResearchTreeId]);
  const openResearchDraftInColumn = useCallback(
    (draft: ResearchDraft) => {
      if (activeResearchTreeIdRef.current) focusResearchHome();
      else showResearchSurface();
      setOpenResearchDraftId(draft.id);
    },
    [focusResearchHome, showResearchSurface],
  );
  const saveOpenResearchDraft = useCallback(
    async (draft: ResearchDraft, prompt: string) => {
      await saveResearchDraftText(draft.id, prompt, draft.workspaceId);
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
  const removeResearchHighlightFromFeed = useCallback(
    (item: ResearchHighlightFeedItem) => {
      void removeResearchHighlights(item.nodeId, [item.highlightId])
        .then(() => refreshResearchHighlights())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [refreshResearchHighlights],
  );

  const renamingGroup = renameGroupId ? groupById.get(renameGroupId) : undefined;
  const renamingResearchFolder =
    renamingGroup?.scope === "research" ? renamingGroup : undefined;
  const linkMenuLocalPath = linkMenu ? pathFromSessionFileHref(linkMenu.url) : undefined;
  const linkMenuPaneId = linkMenu?.paneId ?? null;
  const worktreeStartBranch = worktreeCreateDialog?.startRef
    ? worktreeCreateDialog.inventory?.branches.find(
        (branch) => branch.fullRef === worktreeCreateDialog.startRef,
      )
    : undefined;

  // The Home feed stays mounted beside an open thread, where every streamed
  // update re-renders App; stable props let the memoized feed skip those.
  const feedOwnsHistory = researchStageView === "journal";
  const feedResearchTrees = useMemo(
    () => [...researchTrees, ...archivedResearchTrees],
    [researchTrees, archivedResearchTrees],
  );
  // A question asked from a user folder's view is filed in that folder; from
  // any other list it goes to Unfiled.
  const composerFolderId = journalView.kind === "folder" ? journalView.folderId : null;
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
  const submitFeedNote = useCallback(
    async (input: Parameters<typeof submitNewNote>[0]) => {
      const treeId = await submitNewNote(input);
      if (composerFolderId) fileNewResearchTree(treeId, composerFolderId);
    },
    [composerFolderId, fileNewResearchTree, submitNewNote],
  );
  const saveComposerDraft = useCallback(
    async (prompt: string) => {
      await saveResearchDraftText(null, prompt);
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
    async (draft: ResearchDraft, prompt: string) => {
      const choice = composerLaunchChoiceRef.current?.();
      if (!choice) {
        throw new Error("No research agent is ready. Review agents in Settings.");
      }
      await submitNewResearch({ prompt, ...choice, workspaceId: draft.workspaceId });
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
    [deleteResearchDraftEntry, showResearchToast, submitNewResearch],
  );
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
          onOpenAgentSettings={() => {
            setSettingsOpen(false);
            setAgentsOpen(true);
          }}
          onCreate={submitFeedResearch}
          onPost={submitFeedNote}
          onSaveDraft={saveComposerDraft}
        />
      ) : null,
    [
      configAdapters,
      composerFolderName,
      settings.requireCmdEnterToSend,
      researchScope,
      saveComposerDraft,
      submitFeedResearch,
      submitFeedNote,
    ],
  );
  // Show setup guide on Home only when no agents can run research.
  const feedSetupGuide = useMemo(
    () =>
      !configAdapters || configAdapters.some(adapterCanLaunchResearch) ? undefined : (
        <AgentSetupGuide
          adapters={configAdapters}
          loading={adapterProbeLoading}
          error={adapterProbeError}
          onRefresh={() => void refreshAdapterReadiness({ force: true }).catch(() => undefined)}
          onCopied={showAppToast}
          onError={setAdapterProbeError}
        />
      ),
    [configAdapters, adapterProbeLoading, adapterProbeError, refreshAdapterReadiness, showAppToast],
  );
  const refreshFeed = useCallback(() => void refreshResearchNavigation(), [refreshResearchNavigation]);
  // The workspace switcher sits at the bottom of the full sidebar; in the
  // strip it is an icon whose menu opens as a popover, with the account
  // control inside, so both (and ⌘O) stay reachable below 900px.
  const renderResearchFolderSwitcher = (
    variant: "sidebar" | "strip",
    footer?: ReactNode,
  ) => (
    <ResearchFolderSwitcher
      variant={variant}
      footer={footer}
      folders={researchGroups}
      scope={researchScope}
      treeCounts={researchFolderTreeCounts}
      folderPickerBusy={folderPickerStatus !== null}
      shortcutHintsShown={shortcutHintsShown}
      onSelectScope={(scope) => {
        changeResearchFolderScope(scope);
        // Keep the selection inside the new scope.
        const allTrees = [...researchTrees, ...archivedResearchTrees];
        const scopedTrees = treesForResearchScope(allTrees, scope);
        const activeInScope = scopedTrees.some(
          (tree) => tree.id === activeResearchTreeId,
        );
        const activeResearchPane = panesRef.current.find(
          (pane) => pane.id === activeResearchPaneIdRef.current,
        );
        const activePaneInScope =
          !activeResearchPane ||
          workspaceIsInResearchScope(activeResearchPane.groupId, scope);
        if (!activePaneInScope) {
          activeResearchPaneIdRef.current = null;
          setActiveResearchPaneId(null);
          localStorage.removeItem(ACTIVE_RESEARCH_PANE_KEY);
        }
        if (researchHomeActive) {
          return;
        }
        if (!activeInScope || !activePaneInScope) {
          const tree = treeForResearchScope(allTrees, scope, activeResearchTreeId);
          if (tree) {
            void selectResearchTree(tree.id);
          } else {
            activeResearchTreeIdRef.current = null;
            setActiveResearchTreeId(null);
            setActiveResearchDetail(null);
            setActiveResearchDetailError(null);
            localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
            // Preserve any selected research pane in the current scope.
            // focusResearchHome would clear that selection.
            showResearchSurface();
          }
        }
      }}
      onNewFolder={chooseResearchWorkspaceFolder}
      onOpenFolder={openResearchWorkspaceFolder}
      onRenameFolder={openGroupRenameDialog}
      onMoveFolder={moveResearchWorkspaceFolder}
      onRemoveFolder={(workspace) => {
        setResearchFolderRemovalError(null);
        setCloseDialog({ kind: "researchFolderRemove", workspace });
      }}
    />
  );


  // The shell is a plain container: its sidebar (an aside) and the
  // workspace (the main landmark) sit side by side, not nested.
  return (
    <div
      ref={appRef}
      className={`app-shell ${hasGlobalTurnSidebar ? "has-turn-sidebar" : ""}${
        researchSidebarStrip && IS_MAC ? " has-titlebar-strip" : ""
      }${
        activeTranscriptVisibleExpanded ? " has-expanded-transcript" : ""
      }${settings.reduceMotion ? " reduce-motion" : ""}`}
      style={appStyle}
    >
      {!researchSidebarStrip ? (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={maxSidebarWidth()}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
        />
      ) : null}
      {researchSidebarStrip ? (
        <ResearchSidebarStrip
          current={journalView}
          folders={researchFolders}
          forced={windowNarrowForSidebar}
          reserveTitlebar={IS_MAC}
          expandShortcut={LEFT_SIDEBAR_TOGGLE_SHORTCUT_LABEL}
          onExpand={() => setLeftSidebarCollapsedForActivePane(false)}
          onNavigate={openJournalView}
          onNewFolder={() => openNewResearchFolderDialog()}
          footer={
            <>
              {renderResearchFolderSwitcher("strip", <GithubAccountControl />)}
              <ResearchStripButton
                label="Agents"
                selected={agentsOpen}
                onClick={() => {
                  setSettingsOpen(false);
                  setAgentsOpen(true);
                }}
              >
                <Bot size={16} aria-hidden="true" />
              </ResearchStripButton>
              <ResearchStripButton
                label={settings.appearance === "light" ? "Dark mode" : "Light mode"}
                onClick={toggleAppearance}
              >
                {settings.appearance === "light" ? (
                  <Moon size={16} aria-hidden="true" />
                ) : (
                  <Sun size={16} aria-hidden="true" />
                )}
              </ResearchStripButton>
              <ResearchStripButton
                label="Settings (⌘,)"
                selected={settingsOpen}
                onClick={() => {
                  setAgentsOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <Settings size={16} aria-hidden="true" />
              </ResearchStripButton>
            </>
          }
        />
      ) : (
        <aside className={`sidebar is-research-mode${settings.codeMode ? " is-code-mode" : ""}`}>
          <div className="titlebar-drag" data-tauri-drag-region aria-hidden="true" />
          {/* Keep the collapse and expand buttons at the same position beside
              the traffic lights. */}
          <button
            type="button"
            className="icon-button sidebar-header-button sidebar-collapse-toggle"
            title={`Collapse sidebar to icons (${LEFT_SIDEBAR_TOGGLE_SHORTCUT_LABEL})`}
            aria-label="Collapse sidebar"
            onClick={() => setLeftSidebarCollapsedForActivePane(true)}
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
              onClick={() => {
                setAgentsOpen(false);
                setSettingsOpen(true);
              }}
            >
              <Settings size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`icon-button sidebar-header-button${agentsOpen ? " is-active" : ""}`}
              aria-label="Agents"
              title="Agents"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => {
                setSettingsOpen(false);
                setAgentsOpen(true);
              }}
            >
              <Bot size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button sidebar-header-button"
              aria-label={
                settings.appearance === "light" ? "Switch to dark mode" : "Switch to light mode"
              }
              aria-pressed={settings.appearance === "light"}
              title={settings.appearance === "light" ? "Dark mode" : "Light mode"}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleAppearance}
            >
              {settings.appearance === "light" ? (
                <Moon size={15} aria-hidden="true" />
              ) : (
                <Sun size={15} aria-hidden="true" />
              )}
            </button>
          </div>
          <div className="research-sidebar-body">
            <ResearchSidebarNav
              current={journalView}
              folders={researchFolders}
              onNavigate={openJournalView}
              onNewFolder={() => openNewResearchFolderDialog()}
              onRenameFolder={openRenameResearchFolderDialog}
              onDeleteFolder={requestResearchFolderDelete}
              foldersLoadError={researchFoldersLoadError}
              onRetryFoldersLoad={retryResearchFoldersLoad}
              homeShortcutHint={shortcutHintsShown ? RESEARCH_HOME_SHORTCUT_LABEL : null}
            />
          </div>
          {renderResearchFolderSwitcher("sidebar")}
          <GithubAccountControl />
        </aside>
      )}

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commandPaletteOpen ? buildPaletteCommands() : []}
      />

      {agentsOpen ? (
        <div
          className="settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setAgentsOpen(false);
            }
          }}
        >
          <div
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agents-title"
          >
            <div className="settings-header">
              <h2 id="agents-title">Agent Setup</h2>
              <button
                type="button"
                className="control-button settings-close"
                aria-label="Close agent setup"
                onClick={() => setAgentsOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="settings-content">
              <AgentSetupGuide
                adapters={config?.adapters ?? []}
                loading={adapterProbeLoading}
                error={adapterProbeError}
                onRefresh={() =>
                  void refreshAdapterReadiness({ force: true }).catch(() => undefined)
                }
                onCopied={showAppToast}
                onError={setAdapterProbeError}
              />
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div
          className="settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsOpen(false);
            }
          }}
        >
          <div
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-header">
              <h2 id="settings-title">Settings</h2>
              <button
                type="button"
                className="control-button settings-close"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div
              className="settings-tabs"
              role="tablist"
              aria-label="Settings sections"
            >
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === "basic"}
                className={`control-button${settingsTab === "basic" ? " is-active" : ""}`}
                onClick={() => setSettingsTab("basic")}
              >
                Basic
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === "remotes"}
                className={`control-button${settingsTab === "remotes" ? " is-active" : ""}`}
                onClick={() => setSettingsTab("remotes")}
              >
                Remotes
              </button>
            </div>

            {settingsTab === "remotes" ? (
              <div className="settings-content settings-remotes" role="tabpanel">
                <div className="settings-agents-heading">
                  <div>
                    <h3>Remote machines</h3>
                  </div>
                  <div className="settings-remote-add-group" ref={remoteAddMenuRef}>
                    <button
                      type="button"
                      className="control-button settings-remote-add settings-remote-add-main"
                      disabled={remoteSettingsSaving || remoteSettingsDraftIsNew}
                      onClick={() => {
                        setRemoteAddMenuOpen(false);
                        beginAddingRemote();
                      }}
                    >
                      <Plus size={13} aria-hidden="true" />
                      Add
                    </button>
                    <button
                      ref={remoteAddMenuButtonRef}
                      type="button"
                      className="control-button settings-remote-add settings-remote-add-menu-button"
                      disabled={remoteSettingsSaving || remoteSettingsDraftIsNew}
                      aria-label="Add remote options"
                      aria-haspopup="menu"
                      aria-expanded={remoteAddMenuOpen}
                      aria-controls="settings-remote-add-menu"
                      onClick={() => {
                        const opening = !remoteAddMenuOpen;
                        setRemoteAddMenuOpen(opening);
                        if (opening && !sshConfigAliasesLoading) {
                          void refreshSshConfigAliases();
                        }
                      }}
                    >
                      <ChevronDown size={13} aria-hidden="true" />
                    </button>
                    {remoteAddMenuOpen ? (
                      <div
                        id="settings-remote-add-menu"
                        className="popover-surface popover-surface--context settings-remote-add-menu"
                        role="menu"
                        aria-label="Add remote options"
                      >
                        <div className="group-context-actions">
                          <button
                            type="button"
                            role="menuitem"
                            className="control-button"
                            autoFocus
                            onClick={() => {
                              setRemoteAddMenuOpen(false);
                              beginAddingRemote();
                            }}
                          >
                            <Plus size={13} aria-hidden="true" />
                            <span>Add manually</span>
                          </button>
                          <div className="context-menu-divider" role="separator" />
                          <div className="settings-remote-add-menu-label" role="presentation">
                            From SSH config
                          </div>
                          <div
                            className="settings-remote-add-menu-aliases"
                            role="group"
                            aria-label="From SSH config"
                          >
                            {availableSshConfigAliases.map((alias) => (
                              <button
                                type="button"
                                role="menuitem"
                                className="control-button"
                                key={alias}
                                onClick={() => {
                                  setRemoteAddMenuOpen(false);
                                  beginAddingRemoteFromSshAlias(alias);
                                }}
                              >
                                <Globe size={13} aria-hidden="true" />
                                <span title={alias}>{alias}</span>
                              </button>
                            ))}
                            {availableSshConfigAliases.length === 0 ? (
                              <div
                                className="settings-remote-add-menu-empty"
                                role="menuitem"
                                aria-disabled="true"
                                aria-live="polite"
                                title={sshConfigAliasesError ?? undefined}
                              >
                                {sshConfigAliasesLoading
                                  ? "Loading SSH hosts…"
                                  : sshConfigAliasesError
                                    ? "Couldn’t load SSH config"
                                    : sshConfigAliases.length > 0
                                      ? "All SSH hosts are already added"
                                      : "No SSH hosts found"}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="settings-agent-list settings-remote-list">
                  {remoteSettingsDraftIsNew && remoteSettingsDraftState ? (
                    <section className="settings-agent-card settings-remote-card">
                      <div className="settings-remote-new-heading">
                        <Globe size={16} aria-hidden="true" />
                        <strong>New remote</strong>
                      </div>
                      {renderRemoteSettingsForm()}
                    </section>
                  ) : null}
                  {(config?.remotes ?? []).map((remote) => {
                    const isExpanded = expandedSettingsRemoteId === remote.id;
                    const safeRemoteId = encodeURIComponent(remote.id);
                    const summaryId = `settings-remote-summary-${safeRemoteId}`;
                    const detailsId = `settings-remote-details-${safeRemoteId}`;
                    return (
                      <section className="settings-agent-card settings-remote-card" key={remote.id}>
                        <button
                          id={summaryId}
                          type="button"
                          className="settings-agent-summary settings-remote-summary"
                          aria-expanded={isExpanded}
                          aria-controls={detailsId}
                          onClick={() => toggleRemoteSettings(remote)}
                        >
                          <Globe size={16} className="settings-remote-icon" aria-hidden="true" />
                          <span className="settings-agent-identity">
                            <strong>{remote.label}</strong>
                            <span className="settings-agent-summary-meta">{remote.host}</span>
                          </span>
                          <span className="settings-remote-source">
                            {remote.source === "config" ? "Config file" : "Saved"}
                          </span>
                          <ChevronDown
                            size={13}
                            className={`settings-agent-chevron${isExpanded ? " is-open" : ""}`}
                            aria-hidden="true"
                          />
                        </button>
                        {isExpanded ? (
                          <div id={detailsId} role="region" aria-labelledby={summaryId}>
                            {remote.source === "preferences" ? (
                              renderRemoteSettingsForm()
                            ) : (
                              <div className="settings-remote-detail settings-remote-readonly">
                                <dl className="settings-agent-details">
                                  <div>
                                    <dt>ID</dt>
                                    <dd>{remote.id}</dd>
                                  </div>
                                  <div>
                                    <dt>Multiplexer</dt>
                                    <dd>{remote.multiplexer}</dd>
                                  </div>
                                  <div>
                                    <dt>Workspace root</dt>
                                    <dd>{remote.workspaceRoot ?? "Default"}</dd>
                                  </div>
                                  <div>
                                    <dt>Session CLI</dt>
                                    <dd>{remote.sessionCli ?? "session-cli"}</dd>
                                  </div>
                                </dl>
                                {remoteSettingsError ? (
                                  <p className="settings-agent-error" role="alert">
                                    {remoteSettingsError}
                                  </p>
                                ) : null}
                                {renderRemoteProbeStatus(remote.id)}
                                <div className="settings-remote-actions">
                                  <button
                                    type="button"
                                    className="control-button settings-remote-test"
                                    disabled={remoteProbeLoadingId === remote.id}
                                    onClick={() => void testRemoteSettings(remoteSettingsDraft(remote))}
                                  >
                                    {remoteProbeLoadingId === remote.id ? "Testing…" : "Test connection"}
                                  </button>
                                  <button
                                    type="button"
                                    className="control-button"
                                    disabled={remoteProbeLoadingId === remote.id}
                                    onClick={() => beginCopyingRemote(remote)}
                                  >
                                    Copy to my remotes
                                  </button>
                                </div>
                                <p className="settings-hint">
                                  This remote is declared in <code>session.config.json</code>. Edit the
                                  file to change it, or copy it into an editable saved remote.
                                </p>
                              </div>
                            )}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                  {(config?.remotes?.length ?? 0) === 0 && !remoteSettingsDraftIsNew ? (
                    <div className="settings-remote-empty">
                      <Globe size={22} aria-hidden="true" />
                      <span>No remote machines saved yet.</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : settingsTab === "basic" ? (
              <div className="settings-content" role="tabpanel">
            <label className="settings-row settings-toggle">
              <span className="settings-label">Require ⌘↵ to send</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.requireCmdEnterToSend}
                onChange={(event) => {
                  const requireCmdEnterToSend = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, requireCmdEnterToSend }));
                }}
              />
            </label>

            <div className="settings-row settings-research-instructions-row">
              <div className="settings-label-stack">
                <label htmlFor="settings-research-instructions" className="settings-label">
                  Research instructions
                </label>
                <p className="settings-hint settings-hint-weak">
                  Sent with every research launch
                </p>
              </div>
              <textarea
                id="settings-research-instructions"
                className="form-field settings-input settings-textarea"
                rows={1}
                placeholder={DEFAULT_RESEARCH_LAUNCH_INSTRUCTION}
                value={settings.researchLaunchInstruction}
                onChange={(event) => {
                  const researchLaunchInstruction = clampResearchLaunchInstruction(
                    event.currentTarget.value,
                  );
                  setSettings((current) => ({ ...current, researchLaunchInstruction }));
                }}
              />
            </div>

            <div className="settings-row settings-shortcut-row">
              <div className="settings-label">
                <label htmlFor="settings-show-hide-shortcut">Show/hide app shortcut</label>
                {showHideShortcutValue ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="settings-link-button settings-inline-link-button"
                      disabled={showHideShortcutSaving}
                      onClick={clearShowHideShortcut}
                    >
                      Clear
                    </button>
                  </>
                ) : null}
              </div>
              <input
                id="settings-show-hide-shortcut"
                className="form-field settings-input settings-shortcut-input"
                data-shortcut-capture="show-hide"
                value={showHideShortcutValue}
                placeholder="e.g. Option+Space"
                readOnly
                aria-invalid={showHideShortcutMessage ? true : undefined}
                aria-describedby={
                  showHideShortcutMessage ? "settings-show-hide-shortcut-message" : undefined
                }
                onPointerDown={() => setShowHideShortcutCapturing(true)}
                onFocus={() => setShowHideShortcutCapturing(true)}
                onBlur={() => setShowHideShortcutCapturing(false)}
                onKeyDown={captureShowHideShortcut}
              />
            </div>
            {showHideShortcutMessage || showHideShortcutSaving ? (
              <p
                id="settings-show-hide-shortcut-message"
                className={`settings-hint settings-shortcut-message${
                  showHideShortcutMessage ? " is-error" : ""
                }`}
              >
                {showHideShortcutSaving ? "Saving shortcut..." : showHideShortcutMessage}
              </p>
            ) : null}
            {showHideShortcutConflictLabel ? (
              <p className="settings-hint settings-shortcut-message">
                {`Session also uses this shortcut to ${showHideShortcutConflictLabel}; while registered system-wide, it will show/hide the app instead.`}
              </p>
            ) : null}

            <label className="settings-row settings-toggle">
              <span className="settings-label">Keep awake while agents run (&gt;10% battery)</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.preventSleep}
                onChange={(event) => {
                  // Capture before the updater, which runs after currentTarget
                  // has been nulled out.
                  const preventSleep = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, preventSleep }));
                }}
              />
            </label>

            <label className="settings-row settings-toggle">
              <span className="settings-label">Use login shell</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.useLoginShell}
                onChange={(event) => {
                  const useLoginShell = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, useLoginShell }));
                }}
              />
            </label>

            <div className="settings-divider" role="separator" />

            <div className="settings-row">
              <label htmlFor="settings-appearance" className="settings-label">
                Appearance
              </label>
              <select
                id="settings-appearance"
                className="settings-select"
                value={settings.appearance}
                onChange={(event) => {
                  const appearance = event.currentTarget.value as AppSettings["appearance"];
                  setSettings((current) => ({ ...current, appearance }));
                }}
              >
                {APPEARANCE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="settings-color-theme" className="settings-label">
                Color theme
              </label>
              <select
                id="settings-color-theme"
                className="settings-select"
                value={settings.colorTheme}
                onChange={(event) => {
                  const colorTheme = event.currentTarget.value as AppSettings["colorTheme"];
                  setSettings((current) => ({ ...current, colorTheme }));
                }}
              >
                {COLOR_THEME_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="settings-body-font" className="settings-label">
                Body font
              </label>
              <select
                id="settings-body-font"
                className="settings-select"
                value={availableBodyFonts === null ? "" : settings.bodyFontId}
                disabled={availableBodyFonts === null}
                onChange={(event) => {
                  const bodyFontId = event.currentTarget.value;
                  setSettings((current) => ({ ...current, bodyFontId }));
                }}
              >
                {availableBodyFonts === null ? (
                  <option value="">Detecting installed fonts…</option>
                ) : (
                  availableBodyFonts.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))
                )}
              </select>
            </div>

            <label className="settings-row settings-toggle">
              <span className="settings-label">Show keyboard shortcut hints</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.showShortcutHints}
                onChange={(event) => {
                  const showShortcutHints = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, showShortcutHints }));
                }}
              />
            </label>

            <label className="settings-row settings-toggle">
              <span className="settings-label">Reduce motion</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.reduceMotion}
                onChange={(event) => {
                  const reduceMotion = event.currentTarget.checked;
                  setSettings((current) => ({ ...current, reduceMotion }));
                }}
              />
            </label>

            <div className="settings-divider" role="separator" />

            <div className="settings-row">
              <label htmlFor="settings-tab-title-provider" className="settings-label">
                Generate tab titles
              </label>
              <select
                id="settings-tab-title-provider"
                className="settings-select"
                value={settings.tabTitleProvider}
                onChange={(event) => {
                  const tabTitleProvider =
                    event.currentTarget.value as AppSettings["tabTitleProvider"];
                  setSettings((current) => ({ ...current, tabTitleProvider }));
                }}
              >
                {TAB_TITLE_PROVIDER_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {settings.tabTitleProvider === "openRouter" ? (
              <>
                <p className="settings-hint">
                  Sends the first message of each new tab to OpenRouter to summarize a title.
                </p>

                <div className="settings-row">
                  <label htmlFor="settings-openrouter-key" className="settings-label">
                    OpenRouter key
                  </label>
                  <div className="settings-secret-input">
                    <input
                      id="settings-openrouter-key"
                      className="form-field settings-input"
                      type={openRouterKeyVisible ? "text" : "password"}
                      value={settings.openRouterKey}
                      placeholder="sk-or-v1-..."
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        const openRouterKey = event.currentTarget.value;
                        setSettings((current) => ({ ...current, openRouterKey }));
                      }}
                    />
                    <button
                      type="button"
                      className="control-button settings-secret-toggle"
                      aria-label={
                        openRouterKeyVisible ? "Hide OpenRouter key" : "Show OpenRouter key"
                      }
                      aria-pressed={openRouterKeyVisible}
                      onClick={() => setOpenRouterKeyVisible((visible) => !visible)}
                    >
                      {openRouterKeyVisible ? (
                        <EyeOff size={14} aria-hidden="true" />
                      ) : (
                        <Eye size={14} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="settings-row">
                  <label htmlFor="settings-openrouter-model" className="settings-label">
                    OpenRouter model
                  </label>
                  <input
                    id="settings-openrouter-model"
                    className="form-field settings-input"
                    type="text"
                    value={settings.openRouterModel}
                    placeholder="google/gemma-4-31b-it:free"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      const openRouterModel = event.currentTarget.value;
                      setSettings((current) => ({ ...current, openRouterModel }));
                    }}
                  />
                </div>
              </>
            ) : null}
            {titleGenerationTestVisible ? (
              <div className="settings-title-test">
                <div className="settings-row">
                  <span className="settings-label">Test title generation</span>
                  <button
                    type="button"
                    className="control-button settings-test-button"
                    disabled={titleGenerationTestRunning}
                    aria-describedby={
                      titleGenerationTest ? "settings-title-test-message" : undefined
                    }
                    onClick={() => void testFirstMessageTitleGeneration()}
                  >
                    {titleGenerationTestRunning ? (
                      <LoaderCircle
                        className="settings-test-spinner"
                        size={14}
                        aria-hidden="true"
                      />
                    ) : (
                      <MessageSquareText size={14} aria-hidden="true" />
                    )}
                    {titleGenerationTestRunning ? "Testing..." : "Test title"}
                  </button>
                </div>
                {titleGenerationTest ? (
                  <p
                    id="settings-title-test-message"
                    className={`settings-hint settings-title-test-message is-${titleGenerationTest.status}`}
                  >
                    {titleGenerationTest.status === "running"
                      ? `${titleGenerationTest.providerLabel} is generating a title...`
                      : titleGenerationTest.status === "success"
                        ? `${titleGenerationTest.providerLabel}: "${titleGenerationTest.title}"`
                        : `${titleGenerationTest.providerLabel}: ${titleGenerationTest.message}`}
                  </p>
                ) : null}
              </div>
            ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {repositoryBrowser ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !repositoryBrowser.opening) {
              setRepositoryBrowser(null);
            }
          }}
        >
          <div
            className="confirm-dialog repository-browser-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="repository-browser-title"
          >
            <div className="repository-browser-header">
              <div>
                <h2 id="repository-browser-title">Branches and worktrees</h2>
                {repositoryBrowser.inventory ? (
                  <p title={repositoryBrowser.inventory.repositoryRoot}>
                    {formatPaneDir(repositoryBrowser.inventory.repositoryRoot)}
                  </p>
                ) : null}
              </div>
              <button
                className="control-button"
                type="button"
                disabled={Boolean(repositoryBrowser.opening)}
                onClick={() => setRepositoryBrowser(null)}
                aria-label="Close branches and worktrees"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            {!repositoryBrowser.inventory && !repositoryBrowser.error ? (
              <p className="repository-browser-loading">
                <LoaderCircle
                  className="confirm-dialog-action-spinner"
                  size={14}
                  aria-hidden="true"
                />{" "}
                Loading repository…
              </p>
            ) : null}
            {repositoryBrowser.error ? (
              <p className="confirm-dialog-error" role="alert">
                {repositoryBrowser.error}
              </p>
            ) : null}
            {repositoryBrowser.inventory ? (
              <div className="repository-browser-content">
                <section>
                  <h3>Worktrees</h3>
                  <div className="repository-browser-list">
                    {repositoryBrowser.inventory.worktrees.map((worktree) => (
                      <div className="repository-browser-row" key={worktree.path}>
                        <div className="repository-browser-row-copy">
                          <strong>{worktree.branch ?? "Detached HEAD"}</strong>
                          <span title={worktree.path}>{formatPaneDir(worktree.path)}</span>
                        </div>
                        <button
                          className="control-button"
                          type="button"
                          disabled={Boolean(repositoryBrowser.opening) || worktree.prunable}
                          onClick={() => void openInventoryWorktree(worktree.path)}
                        >
                          {repositoryBrowser.opening === worktree.path ? "Opening…" : "Open"}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
                <section>
                  <h3>Branches</h3>
                  <div className="repository-browser-list">
                    {repositoryBrowser.inventory.branches.map((branch) => (
                      <div className="repository-browser-row" key={branch.fullRef}>
                        <div className="repository-browser-row-copy">
                          <strong>{branch.name}</strong>
                          <span>
                            {branch.remote
                              ? "Remote branch"
                              : branch.checkedOutPath
                                ? `Checked out at ${formatPaneDir(branch.checkedOutPath)}`
                                : branch.upstream
                                  ? `Tracks ${branch.upstream.replace(/^refs\/remotes\//, "")}`
                                  : "Local branch"}
                          </span>
                        </div>
                        {!branch.checkedOutPath ? (
                          <input
                            className="repository-browser-name"
                            aria-label={`Worktree name for ${branch.name}`}
                            value={repositoryBrowser.names[branch.fullRef] ?? ""}
                            disabled={Boolean(repositoryBrowser.opening)}
                            maxLength={240}
                            spellCheck={false}
                            onChange={(event) => {
                              const name = event.currentTarget.value;
                              setRepositoryBrowser((current) =>
                                current
                                  ? { ...current, names: { ...current.names, [branch.fullRef]: name } }
                                  : current,
                              );
                            }}
                          />
                        ) : null}
                        <button
                          className="control-button"
                          type="button"
                          disabled={
                            Boolean(repositoryBrowser.opening) ||
                            (!branch.checkedOutPath &&
                              !repositoryBrowser.names[branch.fullRef]?.trim())
                          }
                          onClick={() => void openInventoryBranch(branch)}
                        >
                          {repositoryBrowser.opening === branch.fullRef ? "Opening…" : "Open"}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {worktreeCreateDialog ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !worktreeCreateDialog.creating) {
              dismissWorktreeCreateDialog(false);
            }
          }}
        >
          <form
            className="confirm-dialog rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-worktree-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void createWorktreeFromDialog();
            }}
          >
            <h2 id="create-worktree-dialog-title">
              {worktreeCreateDialog.action.kind === "fork"
                ? "Fork session in worktree"
                : "Open worktree"}
            </h2>
            {worktreeCreateDialog.action.kind === "open" ? (
              <>
                <label className="confirm-dialog-field-label" htmlFor="create-worktree-start">
                  Start at
                </label>
                <select
                  id="create-worktree-start"
                  className="rename-dialog-input"
                  value={worktreeCreateDialog.startRef ?? ""}
                  disabled={worktreeCreateDialog.creating}
                  onChange={(event) => {
                    const startRef = event.currentTarget.value || null;
                    setWorktreeCreateDialog((current) => {
                      if (!current) return current;
                      const branch = startRef
                        ? current.inventory?.branches.find(
                            (candidate) => candidate.fullRef === startRef,
                          )
                        : undefined;
                      return {
                        ...current,
                        startRef,
                        name: branch ? repositoryWorktreeName(branch) : current.suggestedName,
                        error: null,
                      };
                    });
                  }}
                >
                  <option value="">Current commit (new branch)</option>
                  {worktreeCreateDialog.inventory?.branches.some((branch) => !branch.remote) ? (
                    <optgroup label="Local branches">
                      {worktreeCreateDialog.inventory.branches
                        .filter((branch) => !branch.remote)
                        .map((branch) => (
                          <option key={branch.fullRef} value={branch.fullRef}>
                            {branch.name}
                            {branch.checkedOutPath ? " — checked out" : ""}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                  {worktreeCreateDialog.inventory?.branches.some((branch) => branch.remote) ? (
                    <optgroup label="Remote branches">
                      {worktreeCreateDialog.inventory.branches
                        .filter((branch) => branch.remote)
                        .map((branch) => (
                          <option key={branch.fullRef} value={branch.fullRef}>
                            {branch.name}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                  {worktreeCreateDialog.inventoryLoading ? (
                    <option disabled>Loading branches…</option>
                  ) : null}
                </select>
                {worktreeCreateDialog.inventoryError ? (
                  <p className="confirm-dialog-error" role="alert">
                    Could not load branches: {worktreeCreateDialog.inventoryError}
                  </p>
                ) : null}
              </>
            ) : null}
            <label className="confirm-dialog-field-label" htmlFor="create-worktree-name">
              Worktree name
            </label>
            <input
              ref={worktreeNameInputRef}
              id="create-worktree-name"
              className="rename-dialog-input"
              value={worktreeCreateDialog.name}
              disabled={worktreeCreateDialog.creating}
              spellCheck={false}
              maxLength={240}
              onChange={(event) => {
                const name = event.currentTarget.value;
                setWorktreeCreateDialog((current) =>
                  current ? { ...current, name, error: null } : current,
                );
              }}
              aria-describedby="create-worktree-name-hint"
            />
            <p id="create-worktree-name-hint" className="rename-dialog-hint">
              {worktreeCreateDialog.action.kind === "fork"
                ? "Use letters, numbers, hyphens, or underscores. The worktree and branch use this exact name and start at this tab’s current commit."
                : worktreeStartBranch?.checkedOutPath
                  ? `This branch is already checked out at ${formatPaneDir(worktreeStartBranch.checkedOutPath)}. Session will open that checkout.`
                  : worktreeStartBranch?.remote
                    ? `Use letters, numbers, hyphens, or underscores. Session creates a local branch and worktree with this name, tracking ${worktreeStartBranch.name}.`
                    : worktreeStartBranch
                      ? `Use letters, numbers, hyphens, or underscores. The worktree uses this name and checks out ${worktreeStartBranch.name}.`
                      : "Use letters, numbers, hyphens, or underscores. The worktree and new branch use this exact name and start at this tab’s current commit."}
            </p>
            {worktreeCreateDialog.error ? (
              <p className="confirm-dialog-error" role="alert">
                {worktreeCreateDialog.error}
              </p>
            ) : null}
            <div className="confirm-dialog-actions">
              <button
                className="control-button"
                type="button"
                disabled={worktreeCreateDialog.creating}
                onClick={() => dismissWorktreeCreateDialog(false)}
              >
                Cancel
              </button>
              <ConfirmDialogActionButton
                type="submit"
                disabled={!worktreeCreateDialog.name.trim() || worktreeCreateDialog.creating}
                pending={worktreeCreateDialog.creating}
                pendingLabel={
                  worktreeCreateDialog.action.kind === "fork" ? "Creating…" : "Opening…"
                }
              >
                {worktreeCreateDialog.action.kind === "fork" ? "Fork session" : "Open worktree"}
              </ConfirmDialogActionButton>
            </div>
          </form>
        </div>
      ) : null}

      {remoteDeleteConfirm ? (
        <div
          className="confirm-dialog-backdrop settings-remote-delete-dialog"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !remoteSettingsSaving) {
              setRemoteDeleteConfirm(null);
            }
          }}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-delete-dialog-title"
            aria-busy={remoteSettingsSaving}
          >
            <h2 id="remote-delete-dialog-title">Remove {remoteDeleteConfirm.label}?</h2>
            <p>Existing groups stay connected to this machine.</p>
            {remoteSettingsError ? (
              <p className="confirm-dialog-error" role="alert">
                {remoteSettingsError}
              </p>
            ) : null}
            <div className="confirm-dialog-actions">
              <button
                className="control-button"
                type="button"
                disabled={remoteSettingsSaving}
                onClick={() => setRemoteDeleteConfirm(null)}
              >
                Cancel
              </button>
              <ConfirmDialogActionButton
                ref={remoteDeleteConfirmButtonRef}
                type="button"
                className="danger"
                autoFocus
                pending={remoteSettingsSaving}
                pendingLabel="Removing…"
                onClick={() => void removeRemoteSettings(remoteDeleteConfirm.id)}
              >
                Remove remote
              </ConfirmDialogActionButton>
            </div>
          </div>
        </div>
      ) : null}

      {closeDialog ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !resolvingClose) {
              setCloseDialog(null);
            }
          }}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-dialog-title"
          >
            <h2 id="close-dialog-title">
              {closeDialog.kind === "researchFolderRemove"
                ? `Remove ${displayGroupName(closeDialog.workspace)}?`
                : `Close "${closeDialog.pane.title}?"`}
            </h2>
            {closeDialog.kind === "researchFolderRemove" ? (
              <>
                <p>Remove this workspace from Session?</p>
                <p>The folder and its files will remain on disk, with history in the .session directory.</p>
                {researchFolderRemovalError ? (
                  <p className="confirm-dialog-error" role="alert">
                    {researchFolderRemovalError}
                  </p>
                ) : null}
                <div className="confirm-dialog-actions">
                  <button className="control-button"
                    type="button"
                    disabled={resolvingClose !== null}
                    onClick={() => setCloseDialog(null)}
                  >
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
                    autoFocus
                    disabled={resolvingClose !== null}
                    onClick={() => void confirmResearchFolderRemoval()}
                  >
                    {resolvingClose === "removeResearchFolder" ? "Removing…" : "Remove workspace"}
                  </button>
                </div>
              </>
            ) : closeDialog.kind === "worktree" ? (
              <>
                <p>
                  {closeDialog.busy
                    ? "The agent is still working — closing this tab will stop it."
                    : "Closing this tab will stop the agent."}
                </p>
                <p>
                  {closeDialog.checkingChanges ? (
                    <>
                      Checking the worktree {formatPaneDir(closeDialog.worktreeDir)} for
                      uncommitted changes…
                    </>
                  ) : closeDialog.hasChanges === true ? (
                    <span className="confirm-dialog-changes">
                      The worktree {formatPaneDir(closeDialog.worktreeDir)} has uncommitted changes
                      that will be lost if deleted.
                    </span>
                  ) : closeDialog.hasChanges === false ? (
                    <>
                      The worktree {formatPaneDir(closeDialog.worktreeDir)} has no uncommitted
                      changes.
                    </>
                  ) : (
                    <span className="confirm-dialog-changes">
                      Session could not check the worktree {formatPaneDir(closeDialog.worktreeDir)} for
                      uncommitted changes. Deleting it may discard work.
                    </span>
                  )}{" "}
                  Delete the worktree?
                </p>
                <div className="confirm-dialog-actions">
                  <button className="control-button"
                    type="button"
                    disabled={resolvingClose !== null}
                    onClick={() => setCloseDialog(null)}
                  >
                    Cancel
                  </button>
                  <ConfirmDialogActionButton
                    type="button"
                    className="danger"
                    // Deleting stays gated on the status verdict: before the
                    // dialog opened eagerly the user could never delete ahead
                    // of the probe, so keep that ordering.
                    disabled={resolvingClose !== null || closeDialog.checkingChanges}
                    pending={resolvingClose === "delete"}
                    pendingLabel="Deleting…"
                    onClick={() => void resolveCloseDialog("delete")}
                  >
                    Delete worktree
                  </ConfirmDialogActionButton>
                  <ConfirmDialogActionButton
                    ref={closeConfirmButtonRef}
                    type="button"
                    autoFocus
                    disabled={resolvingClose !== null}
                    pending={resolvingClose === "keep"}
                    pendingLabel="Closing…"
                    onClick={() => void resolveCloseDialog("keep")}
                  >
                    Keep worktree
                  </ConfirmDialogActionButton>
                </div>
              </>
            ) : closeDialog.kind === "researchCancel" ? (
              <>
                <p>Closing cancels this research run. Its completed work and follow-up history remain available.</p>
                <div className="confirm-dialog-actions">
                  <button className="control-button" type="button" onClick={() => setCloseDialog(null)}>
                    Keep running
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
                    autoFocus
                    onClick={() => void confirmStopAndClose()}
                  >
                    Cancel research
                  </button>
                </div>
              </>
            ) : closeDialog.kind === "stop" ? (
              <>
                <p>This agent {closeDialog.reason}. Close the tab and stop it?</p>
                <div className="confirm-dialog-actions">
                  <button className="control-button" type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
                    autoFocus
                    onClick={() => void confirmStopAndClose()}
                  >
                    Close tab
                  </button>
                </div>
              </>
            ) : closeDialog.kind === "runningProcess" ? (
              <>
                <p>
                  {closeDialog.processCount === 1
                    ? closeDialog.processSummary
                      ? `This tab has a running process: ${closeDialog.processSummary}.`
                      : "This tab has a running process."
                    : `This tab has ${closeDialog.processCount} running processes.`}
                </p>
                <p>Closing this tab will terminate running processes in it.</p>
                <div className="confirm-dialog-actions">
                  <button className="control-button" type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
                    autoFocus
                    onClick={() => void confirmPaneClose()}
                  >
                    Close tab
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Close this tab?</p>
                <div className="confirm-dialog-actions">
                  <button className="control-button" type="button" onClick={() => setCloseDialog(null)}>
                    Cancel
                  </button>
                  <button
                    ref={closeConfirmButtonRef}
                    type="button"
                    className="control-button danger"
                    autoFocus
                    onClick={() => void confirmPaneClose()}
                  >
                    Close tab
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {exitDialog ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !quitting) {
              setExitDialog(null);
            }
          }}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exit-dialog-title"
            aria-busy={quitting}
          >
            <h2 id="exit-dialog-title">Quit Session?</h2>
            {exitDialog.paneCount > 0 ? (
              <p>
                Quitting will close{" "}
                {exitDialog.paneCount === 1
                  ? "the open tab"
                  : `all ${exitDialog.paneCount} tabs`}{" "}
                and stop any running agents or processes.
              </p>
            ) : (
              <p>Quitting will stop running agents or processes.</p>
            )}
            {exitDialog.researchRunCount > 0 ? (
              <p>
                {exitDialog.researchRunCount} active research run
                {exitDialog.researchRunCount === 1 ? "" : "s"} will be cancelled and kept in
                Research history.
              </p>
            ) : null}
            <div className="confirm-dialog-actions">
              <button className="control-button" type="button" disabled={quitting} onClick={() => setExitDialog(null)}>
                Cancel
              </button>
              <ConfirmDialogActionButton
                ref={exitConfirmButtonRef}
                type="button"
                className="danger"
                autoFocus
                pending={quitting}
                pendingLabel="Closing terminals..."
                onClick={() => void confirmExit()}
              >
                Quit Session
              </ConfirmDialogActionButton>
            </div>
          </div>
        </div>
      ) : null}

      {renamePaneId || renameGroupId ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeRenameDialog();
            }
          }}
        >
          <form
            className="confirm-dialog rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <h2 id="rename-dialog-title">
              {renamingResearchFolder
                ? "Rename workspace"
                : renameGroupId
                  ? "Rename group"
                  : "Rename tab"}
            </h2>
            <input
              ref={renameInputRef}
              className="rename-dialog-input"
              value={renameValue}
              onChange={(event) => setRenameValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeRenameDialog();
                }
              }}
              aria-label={
                renamingResearchFolder ? "Workspace name" : renameGroupId ? "Group name" : "Tab name"
              }
              aria-describedby={renamingResearchFolder ? "rename-folder-hint" : undefined}
            />
            {renamingResearchFolder ? (
              <p id="rename-folder-hint" className="rename-dialog-hint">
                Contents will remain in {renamingResearchFolder.dir}
              </p>
            ) : null}
            <div className="confirm-dialog-actions">
              <button className="control-button" type="button" onClick={closeRenameDialog}>
                Cancel
              </button>
              <button className="control-button" type="submit">Rename</button>
            </div>
          </form>
        </div>
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

        <div
          ref={mainStageRef}
          className={`main-stage${
            researchSurfaceActive ? " is-research" : ""
          }${
            !researchSurfaceActive && visibleTerminalPaneIds.length === 0 ? " is-empty" : ""
          }`}
        >
          {/* The feed column lists Home, a folder, Drafts, Archive, Bookmarks,
              or Highlights beside the content column, which shows the open
              thread (or a placeholder). One wrapper for both states keeps the
              feed mounted, and its scroll position, while threads open and
              close beside it. */}
          {researchFeedColumnVisible ? (
            <ResearchColumns
              hasDocument={researchStageView === "document" || openResearchDraft !== null}
              feed={
                config ? (
                  journalView.kind === "highlights" ? (
                    <ResearchHighlightsFeed
                      items={researchHighlightItems}
                      loading={researchHighlightsLoading}
                      error={researchHighlightsError}
                      onOpen={openResearchHighlight}
                      onRemove={removeResearchHighlightFromFeed}
                      onRefresh={() => void refreshResearchHighlights()}
                    />
                  ) : (
                    <ResearchActivityFeed
                      {...activityFeedState}
                      view={journalView}
                      selectedTreeId={researchStageView === "document" ? activeResearchTreeId : null}
                      selectedChildNodeIds={openResearchNodeIds}
                      selectedDraftId={openResearchDraft?.id ?? null}
                      onImportReport={importReport}
                      composer={feedComposer}
                      setupGuide={feedSetupGuide}
                      items={recentActivityItems}
                      researchTrees={feedResearchTrees}
                      folders={researchFolders}
                      folderState={researchFolderState}
                      drafts={researchDrafts}
                      nextCursor={recentActivityCursor}
                      loadingOlder={loadingOlderActivity}
                      olderError={olderActivityError}
                      onOpenResearchQuery={openRecentResearchQuery}
                      onOpenDraft={openResearchDraftInColumn}
                      onOpenTree={openFeedResearchTree}
                      onOpenView={openFeedView}
                      onResearchRecapApplied={handleResearchRecapApplied}
                      onError={setError}
                      onRenameResearch={renameResearchTreeTitle}
                      onRestoreResearch={restoreResearchTreeFromMenu}
                      onRemoveResearch={removeResearchTreeFromMenu}
                      onSetResearchBookmarked={bookmarkResearchTreeFromFeed}
                      onSetResearchFollowed={followResearchTreeFromFeed}
                      onMoveTree={moveResearchTreeFromFeed}
                      onUnstarChild={unstarResearchFeedChild}
                      onNewFolder={openNewResearchFolderDialog}
                      onRenameFolder={openRenameResearchFolderDialog}
                      onRequestDeleteFolder={requestResearchFolderDelete}
                      pendingDeleteFolderId={pendingResearchFolderDelete}
                      onConfirmDeleteFolder={confirmResearchFolderDelete}
                      onCancelDeleteFolder={cancelResearchFolderDelete}
                      onToggleTray={toggleResearchTray}
                      onDeleteDraft={deleteResearchDraftFromFeed}
                      onDragStart={startResearchCardDrag}
                      onLoadOlder={loadOlderActivity}
                      onRefresh={refreshFeed}
                      // Use feed history when no thread is open; otherwise use
                      // the open thread's history.
                      onBack={feedOwnsHistory ? goResearchWorkspaceBack : undefined}
                      onForward={feedOwnsHistory ? goResearchWorkspaceForward : undefined}
                    />
                  )
                ) : null
              }
            >
              {researchStageView === "document" && activeResearchTreeId ? (
                // Remount on tree changes to reset selection, fetched content,
                // and the follow-up draft before paint. Resetting them in effects
                // would briefly show and refetch the previous tree's node.
                <ResearchDocument
                  key={activeResearchTreeId}
                  detail={activeResearchDetail}
                  treeTitle={
                    activeResearchDetail?.tree.title ??
                    researchTrees.find((tree) => tree.id === activeResearchTreeId)?.title ??
                    archivedResearchTrees.find((tree) => tree.id === activeResearchTreeId)?.title
                  }
                  archived={Boolean(activeResearchDetail?.tree.archivedAt)}
                  recapPendingNodeIds={recapPendingNodeIds}
                  detailError={activeResearchDetailError}
                  onRetryDetail={retryActiveResearchDetail}
                  onFork={createResearchFollowup}
                  noteActions={noteActions}
                  onRemoveBranch={removeResearchBranchFromDocument}
                  onRemoveTree={removeResearchTreeAndSelectFallback}
                  onRenameTree={renameResearchTreeTitle}
                  onUpdateDocument={editResearchDocument}
                  onCancel={cancelResearchRun}
                  onRetryNode={retryResearchRun}
                  linkActions={linkActionsForPane(researchBrowserOwnerId(activeResearchTreeId))}
                  onError={setError}
                  onToast={handleResearchDocumentToast}
                  shortcutHintsShown={shortcutHintsShown}
                  requireCmdEnterToSend={settings.requireCmdEnterToSend}
                  onOpenNodesChange={setOpenResearchNodeIds}
                  treeMenu={activeResearchTreeMenu}
                  workspaceCanGoBack={canGoWorkspaceBack(researchWorkspaceHistory)}
                  workspaceCanGoForward={canGoWorkspaceForward(researchWorkspaceHistory)}
                  onWorkspaceBack={goResearchWorkspaceBack}
                  onWorkspaceForward={goResearchWorkspaceForward}
                />
              ) : openResearchDraft ? (
                <ResearchDraftView
                  key={openResearchDraft.id}
                  draft={openResearchDraft}
                  requireCmdEnterToSend={settings.requireCmdEnterToSend}
                  onSave={(prompt) => saveOpenResearchDraft(openResearchDraft, prompt)}
                  onSend={(prompt) => sendResearchDraft(openResearchDraft, prompt)}
                />
              ) : (
                <div className="research-columns-filler">
                  <p>Select a question to open its conversation.</p>
                </div>
              )}
            </ResearchColumns>
          ) : null}
        </div>
      </main>

      {activeBrowserOwnerId && activeBrowserOverlay?.open ? (
        <BrowserOverlay
          key={activeBrowserOwnerId}
          paneId={activeBrowserOwnerId}
          url={activeBrowserOverlay.url}
          reloadNonce={activeBrowserOverlay.reloadNonce}
          sandbox={activeBrowserOverlay.sandbox}
          mode={activeBrowserOverlay.mode}
          bodyFontId={settings.bodyFontId}
          size={activeBrowserOverlay.size}
          fullWidth={activeBrowserOverlay.fullWidth ?? false}
          toggleShortcutLabel={activePaneHasTurnPaneHeader ? null : EXPAND_TOGGLE_SHORTCUT_LABEL}
          occluded={nativeBrowserOccluded}
          geometryRevision={nativeBrowserGeometryRevision}
          onNavigate={navigateActiveBrowserOverlay}
          onLocationChange={(url) => setHumanBrowserLocation(activeBrowserOwnerId, url)}
          onRefresh={refreshActiveBrowserOverlay}
          onOpenExternal={(currentUrl) => {
            if (!currentUrl) {
              return;
            }
            if (isFileServerUrl(currentUrl, configRef.current?.fileServerPort ?? null)) {
              void browserOpenPreviewExternal(currentUrl).catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              });
              return;
            }
            void openExternalUrl(currentUrl);
          }}
          onClose={closeActiveBrowserOverlay}
          onModeChange={(mode, currentUrl) =>
            setBrowserOverlayMode(activeBrowserOwnerId, mode, currentUrl)
          }
          onResize={(size) => setBrowserOverlaySize(activeBrowserOwnerId, size)}
          onFullWidthChange={(fullWidth) =>
            setBrowserOverlayFullWidth(activeBrowserOwnerId, fullWidth)
          }
        />
      ) : null}
      {linkMenu ? (
        <LinkContextMenu
          x={linkMenu.x}
          y={linkMenu.y}
          canOpenInternal={
            linkMenuPaneId !== null &&
            (canRenderInInternalBrowser(linkMenu.url) ||
              (linkMenuLocalPath !== undefined &&
                canPreviewLocalFilePath(linkMenuLocalPath)))
          }
          onOpenInternal={() => {
            openLinkForPane(linkMenu.paneId, linkMenu.url);
            setLinkMenu(null);
          }}
          onOpenExternal={() => {
            if (linkMenuLocalPath !== undefined && linkMenuPaneId !== null) {
              void browserRevealLocalPath(linkMenuPaneId, linkMenuLocalPath).catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              });
            } else {
              void openExternalUrl(linkMenu.url).catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              });
            }
            setLinkMenu(null);
          }}
          externalLabel={
            linkMenuLocalPath !== undefined
              ? IS_MAC
                ? "Reveal in Finder"
                : "Reveal in file manager"
              : undefined
          }
          externalKind={linkMenuLocalPath !== undefined ? "reveal" : undefined}
          onOpenWithDefaultApp={
            linkMenuLocalPath !== undefined && linkMenuPaneId !== null
              ? () => {
                  void browserOpenLocalPathExternal(linkMenuPaneId, linkMenuLocalPath).catch(
                    (err) => {
                      setError(err instanceof Error ? err.message : String(err));
                    },
                  );
                  setLinkMenu(null);
                }
              : null
          }
          onClose={() => setLinkMenu(null)}
        />
      ) : null}

      <UserNotificationStack
        notifications={userNotifications}
        onDismiss={dismissUserNotification}
        onOpenPane={handleNotificationOpenPane}
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
      {researchFolderNameRequest ? (
        <ResearchFolderNameDialog
          request={researchFolderNameRequest}
          folders={researchFolders}
          onSubmit={submitResearchFolderName}
          onClose={() => setResearchFolderNameRequest(null)}
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
