import { useAppStartup } from "./hooks/useAppStartup";
import { RESEARCH_WORKSPACE_SCOPE_KEY, useResearchNavigationState } from "./hooks/useResearchNavigationState";
import { useUserNotifications } from "./hooks/useUserNotifications";
import { useEditableFocusRestore } from "./hooks/useEditableFocusRestore";
import { reconcileRemoteReservation } from "./lib/remoteStartup";
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
import LinkContextMenu from "./components/LinkContextMenu";
import {
  UserNotificationStack,
} from "./components/UserNotificationStack";
import type { LinkActions } from "./components/TranscriptMarkdown";
import ResearchWorkspaceSwitcher from "./components/research/ResearchWorkspaceSwitcher";
import ResearchAgentsSwitcher from "./components/research/ResearchAgentsSwitcher";
import GithubAccountControl from "./components/GithubAccountControl";
import { formatResearchModelSummary } from "./lib/researchModelSummary";
import {
  resolveResearchScope,
  treeForResearchScope,
  treesForResearchScope,
} from "./lib/researchScope";
import ResearchThreadPage, { type ResearchThreadTreeMenu } from "./components/research/ResearchThreadPage";
import ResearchDraftView from "./components/research/ResearchDraftView";
import ResearchActivityFeed from "./components/research/ResearchActivityFeed";
import ResearchColumns from "./components/research/ResearchColumns";
import { ResearchEmptyContent } from "./components/research/ResearchColumnChrome";
import ResearchHighlightsFeed from "./components/research/ResearchHighlightsFeed";
import { useActivityFeedState } from "./hooks/useActivityFeedState";
import ResearchQueryComposer, {
  type ResearchLaunchChoice,
} from "./components/research/ResearchQueryComposer";
import type { PostActions } from "./components/research/ResearchPost";
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
  IS_MAC,
  isTerminalTarget,
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
import {
  requestResearchFollowupsFocus,
  requestResearchWorkspaceMenuToggle,
  requestResearchNodeOpen,
} from "./lib/researchShortcuts";
import { useSessionEvents } from "./hooks/useSessionEvents";
import type {
  BrowserOverlayMode,
  BrowserOverlaySize,
  BrowserOverlayState,
  ExitDialogState,
  ExitPreflightRequest,
} from "./appTypes";
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
  canGoResearchBack,
  canGoResearchForward,
  currentResearchVisit,
  pruneResearchVisits,
  pushResearchVisit,
  replaceResearchVisit,
  researchVisitAction,
  researchVisitBack,
  researchVisitFor,
  researchVisitForward,
  researchVisitsAfterRemoval,
  seedResearchVisits,
  type ResearchVisit,
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
  patchRecentActivityStarred,
  upsertRecentActivityResearchNode,
} from "./lib/activity";
import { isActiveResearchStatus } from "./lib/researchChains";
import {
  groupsForScope,
  researchAttention,
} from "./lib/workspaceScope";
import {
  RESEARCH_SIDEBAR_AUTO_RAIL_WIDTH,
  type ResearchFeedView,
  type ResearchFeedPage,
} from "./lib/sidebarMode";
import {
  RESEARCH_DRAFTS_FOLDER_ID,
  researchTreePlace,
  treesWithWorkspaceOrder,
  type ResearchDropPosition,
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
  ResearchTreeDeleteDialog,
  ResearchTreeDeleteOfferDialog,
} from "./components/research/ResearchTreeMenu";
import { researchTreeContents, type ResearchTreeContents } from "./lib/researchTreeContents";
import {
  ResearchSidebarNav,
  ResearchSidebarRail,
  ResearchRailButton,
} from "./components/research/ResearchSidebarNav";
import { stripTaggedUserInstructionBlocks } from "./lib/taggedInstructions";
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
  browserOpenLocalPathExternal,
  browserOpenPreviewExternal,
  browserRevealLocalPath,
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
  updateResearchPost,
  forkResearchNode,
  markResearchTreeViewed,
  renameResearchNode,
  listResearchHighlights,
  removeResearchHighlights,
  renameResearchTree,
  setResearchNodeStarred,
  setResearchTreeBookmarked,
  removeResearchTree,
  removeResearchBranch,
  restoreResearchTree,
  retryResearchNode,
  rerunResearchNode,
  setOpenRouterKey,
  openRouterChatCompletion,
  getShowHideShortcut,
  activatePane,
  probeRemote,
  probeAgentAdapters,
  generateResearchAgentTitle,
  listSshConfigAliases,
  destroyHumanBrowser,
  hideAllHumanBrowsers,
  reloadHumanBrowser,
  listResearchActivity,
  listRecentActivity,
  listRecentActivityForTrees,
  listResearchTrees,
  getResearchTree,
  createResearchPost,
  createResearchPostFollowUp,
  openExternalUrl,
  browserOpenCodexInlineVisualization,
  browserOpenCodexVisualizationReference,
  browserOpenLocalPath,
  renamePane,
  setNativeBrowserBackground,
  setNativeBrowserOverlayOpen,
  setShowHideShortcut,
  setShowHideShortcutCaptureActive,
  setPreventSleep,
  setUseLoginShell,
  setResearchLaunchInstruction,
  setWorktreeLocation,
  upsertRemote,
} from "./lib/api";
import type {
  AgentInfo,
  GroupInfo,
  PaneInfo,
  SessionEvent,
  RecentResearchQuery,
  NodeAnchor,
  ResearchDraft,
  ResearchHighlightFeedItem,
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
  RuntimeConfig,
  RemoteChoice,
  RemoteProbeResult,
  SavedRemote,
} from "./types";
import type { ShowHideShortcutSetting } from "./lib/api";
import { nodeRun, nodeStatus } from "./lib/researchNodeTypes";

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
const RESEARCH_SIDEBAR_RAIL_WIDTH = 52;
type ResearchViewedAckOptions = {
  /** A real exposure edge (selection, focus, composer close) should check the
   * backend even when the current sidebar snapshot carries no attention bit. */
  force?: boolean;
  /** The accepted navigation snapshot already proved this tree has attention. */
  knownUnseen?: boolean;
};
const ACTIVE_RESEARCH_TREE_KEY = "session.active-research-tree.v1";

// Browser-overlay / link-action owner for a research tree's thread page. Keyed
// per tree so an overlay opened from one tree's links doesn't follow the user
// into another tree (each tree keeps its own overlay, like panes do).
const RESEARCH_BROWSER_OWNER_PREFIX = "__research_thread__:";
function researchBrowserOwnerId(treeId: string) {
  return `${RESEARCH_BROWSER_OWNER_PREFIX}${treeId}`;
}
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

function researchThreadIsVisible(treeId: string, activeTreeId: string | null): boolean {
  return (
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

const BROWSER_OVERLAY_LEFT_MARGIN = 64;
const EXPAND_TOGGLE_SHORTCUT_LABEL = "⌘⇧E / Ctrl+Shift+E";
const LEFT_SIDEBAR_TOGGLE_SHORTCUT_LABEL = "⇧⌘G";
// The width the research stage keeps when the sidebar is resized.
const RESEARCH_STAGE_MIN_WIDTH = 380;

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

function MainApp() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const panesRef = useRef<PaneInfo[]>([]);
  const agentsRef = useRef<AgentInfo[]>([]);
  const browserOverlayByPaneRef = useRef<Record<string, BrowserOverlayState>>({});
  const nativeHumanBrowserOwnerIdsRef = useRef<Set<string>>(new Set());
  const closeActiveBrowserOverlayRef = useRef<() => void>(() => {});
  const browserEscapeDispatcherRef = useRef<() => "exclusive" | null>(
    () => null,
  );
  const pendingFirstTitleByAgentRef = useRef<Map<string, PendingFirstMessageTitle>>(new Map());
  // Set once the OpenRouter key has been loaded from the backend, so the
  // persist-on-change effect doesn't push the pre-hydration in-memory value back.
  const openRouterKeyHydratedRef = useRef(false);
  // The backend preference is the startup/recovery source of truth. Do not let the
  // localStorage mirror write its default back before that durable value is loaded.
  const useLoginShellHydratedRef = useRef(false);
  const worktreeLocationHydratedRef = useRef(false);
  const researchLaunchInstructionHydratedRef = useRef(false);
  const titleGenerationTestSeqRef = useRef(0);
  const appToastTimerRef = useRef<number | null>(null);
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
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const setPanesReconciled = useCallback((update: SetStateAction<PaneInfo[]>) => {
    setPanes((current) => {
      const next =
        typeof update === "function"
          ? (update as (current: PaneInfo[]) => PaneInfo[])(current)
          : update;
      return next.map(reconcileRemoteReservation);
    });
  }, []);
  const [manuallyTitledPaneIds, setManuallyTitledPaneIds] = useState<Set<string>>(
    () => new Set(),
  );
  const manuallyTitledPaneIdsRef = useRef(manuallyTitledPaneIds);
  manuallyTitledPaneIdsRef.current = manuallyTitledPaneIds;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  // False while a fresh/reloaded WebContent document still holds the empty
  // placeholder above. Until listAgents() succeeds, it is not safe to infer
  // that the backend has no active agents and release its existing wake lock.
  const [agentsHydrated, setAgentsHydrated] = useState(false);
  const [activeResearchTreeId, setActiveResearchTreeId] = useState<string | null>(null);
  const activeResearchTreeIdRef = useRef(activeResearchTreeId);
  const researchDetailRequestSeqRef = useRef(0);
  const researchNavRefreshSeqRef = useRef(0);
  const researchNavRefreshInFlightRef = useRef(0);
  // Bumped by refreshes and events; a feed-root load that started before
  // one is fetched again.
  const recentActivityRootRequestSeqRef = useRef(0);
  const recentActivityHeadRequestSeqRef = useRef(0);
  const researchViewAckInFlightRef = useRef(new Set<string>());
  const researchViewAckPendingRef = useRef(new Set<string>());
  const markVisibleResearchTreeViewedRef = useRef<
    (treeId: string, options?: ResearchViewedAckOptions) => Promise<void>
  >(async () => undefined);
  activeResearchTreeIdRef.current = activeResearchTreeId;
  const [researchTrees, setResearchTrees] = useState<ResearchTreeSummary[]>([]);
  // After "Ask as a question": the offer to delete the edited thread, then
  // the delete confirmation for it.
  const [researchDeleteOffer, setResearchDeleteOffer] = useState<{
    treeId: string;
    newTreeId: string;
    contents: ResearchTreeContents;
  } | null>(null);
  const [researchOfferDeletingTreeId, setResearchOfferDeletingTreeId] = useState<string | null>(null);
  const [archivedResearchTrees, setArchivedResearchTrees] = useState<ResearchTreeSummary[]>([]);
  const activityFeedState = useActivityFeedState();
  const [recentActivityItems, setRecentActivityItems] = useState<RecentResearchQuery[]>([]);
  const recentActivityItemsRef = useRef(recentActivityItems);
  recentActivityItemsRef.current = recentActivityItems;
  const {
    feedOpen,
    setFeedOpen,
    researchVisits,
    researchVisitsRef,
    updateResearchVisits,
    researchWorkspaceScope,
    changeResearchWorkspaceScope,
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
  // thread page shows an unexplained spinner forever: the content effect can't
  // run (no detail-derived node id), so no in-page retry can recover.
  const [activeResearchDetailError, setActiveResearchDetailError] = useState<string | null>(null);
  const [shortcutHintsVisible, setShortcutHintsVisible] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  // The sidebar starts as the icon rail; the expand button, ⌘⇧G and the
  // command palette expand it for the session.
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(true);
  const leftSidebarCollapsedRef = useRef(leftSidebarCollapsed);
  leftSidebarCollapsedRef.current = leftSidebarCollapsed;
  // Below 900px of window width the sidebar shows as the icon rail without
  // changing the saved preference; collapsing also shows the rail.
  const [windowNarrowForSidebar, setWindowNarrowForSidebar] = useState(
    () => window.innerWidth < RESEARCH_SIDEBAR_AUTO_RAIL_WIDTH,
  );
  useEffect(() => {
    const onResize = () =>
      setWindowNarrowForSidebar(window.innerWidth < RESEARCH_SIDEBAR_AUTO_RAIL_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const researchSidebarRail = leftSidebarCollapsed || windowNarrowForSidebar;
  const effectiveSidebarWidth = researchSidebarRail ? RESEARCH_SIDEBAR_RAIL_WIDTH : sidebarWidth;
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
  // The agent instance the Agent Setup dialog opens on; null selects the first
  // agent whose setup is incomplete.
  const [agentSetupInstanceId, setAgentSetupInstanceId] = useState<string | null>(null);
  const openAgentSetup = useCallback((instanceId: string | null = null) => {
    setSettingsOpen(false);
    setAgentSetupInstanceId(instanceId);
    setAgentsOpen(true);
  }, []);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
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
    // No surface shows panes; opening a notification's source pane records
    // it as the most recently active one, as selecting it did.
    onOpenPane: (paneId) => {
      if (panesRef.current.some((pane) => pane.id === paneId)) {
        void activatePane(paneId).catch(() => {});
      }
    },
  });
  const [folderPickerStatus, setFolderPickerStatus] = useState<string | null>(null);
  // The research workspace whose removal the confirmation dialog asks about.
  const [researchFolderRemoval, setResearchFolderRemoval] = useState<GroupInfo | null>(null);
  const [researchFolderRemovalError, setResearchFolderRemovalError] = useState<string | null>(null);
  const researchFolderRemovalButtonRef = useRef<HTMLButtonElement | null>(null);
  // True while the removal runs, so the dialog stays open (and its buttons
  // disabled) until the operation finishes.
  const [removingResearchFolder, setRemovingResearchFolder] = useState(false);
  const [exitDialog, setExitDialog] = useState<ExitDialogState | null>(null);
  const [quitting, setQuitting] = useState(false);
  const quittingRef = useRef(false);
  const exitConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const [exitPreflightRequest, setExitPreflightRequest] =
    useState<ExitPreflightRequest | null>(null);
  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [titleGenerationTest, setTitleGenerationTest] =
    useState<TitleGenerationTestState | null>(null);
  // Per-pane browser overlay state, so each tab keeps its own page and open/closed.
  const [browserOverlayByPane, setBrowserOverlayByPane] = useState<
    Record<string, BrowserOverlayState>
  >({});
  browserOverlayByPaneRef.current = browserOverlayByPane;
  // Right-click chooser for a link: web URLs choose internal vs external;
  // local paths choose protected preview, reveal, or an explicit OS open.
  const [linkMenu, setLinkMenu] = useState<{
    url: string;
    x: number;
    y: number;
    paneId: string | null;
  } | null>(null);
  const researchHomeActive = activeResearchTreeId === null;
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const researchGroups = useMemo(() => groupsForScope(groups, "research"), [groups]);
  const researchScope = useMemo(
    () => resolveResearchScope(researchWorkspaceScope, researchGroups),
    [researchWorkspaceScope, researchGroups],
  );
  const researchScopeRef = useRef(researchScope);
  researchScopeRef.current = researchScope;
  // What the research stage shows beside the feed column: the open thread,
  // or (with no thread open, or the feed brought forward) the feed alone.
  const researchStageView =
    feedOpen || !activeResearchTreeId ? ("feed" as const) : ("thread" as const);
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
  const researchAttentionState = useMemo(() => researchAttention(researchTrees), [researchTrees]);
  const runningResearchCount = researchAttentionState.runningCount;
  const activeBrowserOwnerId = activeResearchTreeId
    ? researchBrowserOwnerId(activeResearchTreeId)
    : null;
  const activeBrowserOverlay = activeBrowserOwnerId
    ? browserOverlayByPane[activeBrowserOwnerId]
    : undefined;

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
      setPanesReconciled((current) =>
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
    registerShellCodexFirstMessageTitle(agent, paneId, source);
  }

  function handleAgentPromptSubmitted(agentId: string, prompt: string) {
    applyPendingFirstMessageTitle(agentId, prompt);
  }

  // Drop browser/UI state only when its real owner disappears. Browser owners
  // include research trees as well as terminal panes; unrelated pane metadata
  // updates must not retire a research thread's preserved browser.
  useEffect(() => {
    panesRef.current = panes;
    const ids = new Set(panes.map((pane) => pane.id));
    const browserOwnerIds = new Set(ids);
    for (const tree of [...researchTrees, ...archivedResearchTrees]) {
      browserOwnerIds.add(researchBrowserOwnerId(tree.id));
    }
    setManuallyTitledPaneIds((current) => {
      const next = new Set([...current].filter((paneId) => ids.has(paneId)));
      return next.size === current.size ? current : next;
    });
    setBrowserOverlayByPane((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([ownerId]) => browserOwnerIds.has(ownerId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    for (const [agentId, pending] of pendingFirstTitleByAgentRef.current) {
      if (!ids.has(pending.paneId)) {
        pendingFirstTitleByAgentRef.current.delete(agentId);
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

  // Drop pending title requests for agents that no longer exist.
  useEffect(() => {
    const ids = new Set(agents.map((agent) => agent.id));
    for (const agentId of pendingFirstTitleByAgentRef.current.keys()) {
      if (!ids.has(agentId)) {
        pendingFirstTitleByAgentRef.current.delete(agentId);
      }
    }
  }, [agents]);

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

  // One stable LinkActions object per link owner. The research thread page feeds
  // this into the shared provider. Context changes bypass memoization — a fresh
  // object per App render re-rendered every markdown link on every unrelated
  // state change. Actions read the opener through
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
  // The native browser view draws above the webview, so it yields to any
  // app-level dialog or menu that would otherwise sit underneath it.
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
      linkMenu,
  );
  const nativeBrowserOccluded = Boolean(
    nativeModalOccluded || appToast || userNotifications.length > 0 || folderPickerStatus,
  );
  useLayoutEffect(() => {
    if (!IS_MAC) {
      return;
    }
    void setNativeBrowserOverlayOpen(activeBrowserOverlay?.open === true).catch(
      () => undefined,
    );
  }, [activeBrowserOverlay?.open]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // Compact directory label, the fallback name of a group whose directory has
  // no last segment. Paths under the workspace root are shown relative to it
  // (e.g. "group-1/agent-1"); home paths use ~/ and other paths fall back to
  // their last two segments so the meaningful tail stays visible.
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

  // The sidebar may grow until the stage would fall below its minimum, capped
  // by a comfortable absolute maximum.
  function maxSidebarWidth() {
    const appWidth = appRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const available = Math.floor(appWidth - RESEARCH_STAGE_MIN_WIDTH);
    return Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(LEFT_SIDEBAR_MAX_WIDTH, available));
  }

  function clampSidebarWidth(width: number) {
    // Keep the sidebar boundary on a whole CSS pixel so its 1px separator
    // cannot be antialiased across two adjacent pixel columns.
    return Math.round(clamp(width, LEFT_SIDEBAR_MIN_WIDTH, maxSidebarWidth()));
  }

  // Preserve the existing bounded research/transcript text zoom.
  const turnFontDelta = Math.min(1, Math.max(0, (settings.textSize - APP_TEXT_SIZE) * 0.25));

  const appStyle = {
    "--font-ui": bodyFontFamily,
    "--sidebar-width": `${effectiveSidebarWidth}px`,
    "--browser-overlay-left": `${BROWSER_OVERLAY_LEFT_MARGIN}px`,
    "--turn-font-delta": `${turnFontDelta}px`,
  } as CSSProperties;

  const titleGenerationTestVisible = settings.tabTitleProvider === "openRouter";
  const titleGenerationTestRunning = titleGenerationTest?.status === "running";

  useAppStartup({
    applySecondary: ({ storedOpenRouterKey, storedUseLoginShell, storedWorktreeLocation,
      storedResearchLaunchInstruction }) => {
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
    },
    applyInitial: async ({ runtimeConfig, existingGroups, existingPanes,
      existingAgents, existingResearchTrees, existingResearchActivity,
      existingRecentActivity }, isCancelled) => {
      setConfig(runtimeConfig);
      setGroups(existingGroups);
      setAgents(existingAgents);
      setAgentsHydrated(true);
      const partitionedResearchTrees = partitionResearchTrees(existingResearchTrees);
      setResearchTrees(partitionedResearchTrees.active);
      setArchivedResearchTrees(partitionedResearchTrees.archived);
      setResearchActivity(existingResearchActivity);
      recentActivityItemsRef.current = existingRecentActivity.items;
      setRecentActivityItems(existingRecentActivity.items);
      const savedResearchTreeId = localStorage.getItem(ACTIVE_RESEARCH_TREE_KEY);
      const restoredResearchScope = resolveResearchScope(
        localStorage.getItem(RESEARCH_WORKSPACE_SCOPE_KEY),
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
            // Back/forward starts at Home.
            updateResearchVisits((current) => seedResearchVisits(current, researchVisitFor(null, null)));
            activeResearchTreeIdRef.current = null;
            setActiveResearchTreeId(null);
            setActiveResearchDetail(null);
            setActiveResearchDetailError(null);
          }
          return;
        }
        // Back/forward starts at the restored thread, so the first switch to
        // another question can go back to it. The thread page names the
        // message once it restores one.
        const seedRestoredVisit = () =>
          updateResearchVisits((current) =>
            seedResearchVisits(current, researchVisitFor(researchTreeToRestore.id, null)),
          );
        try {
          const detail = await getResearchTree(researchTreeToRestore.id);
          if (!isCancelled()) {
            seedRestoredVisit();
            setActiveResearchTreeId(researchTreeToRestore.id);
            localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, researchTreeToRestore.id);
            setActiveResearchDetail((current) =>
              reconcileResearchTreeDetail(current, detail),
            );
            if (researchThreadIsVisible(researchTreeToRestore.id, researchTreeToRestore.id)) {
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
        } catch (err) {
          // Mirror selectResearchTree's failure path: keep the selection and
          // surface the error inside the thread page (which has a working
          // Retry). A later navigation refresh clears the selection if the
          // tree is truly gone.
          if (!isCancelled()) {
            seedRestoredVisit();
            setActiveResearchTreeId(researchTreeToRestore.id);
            localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, researchTreeToRestore.id);
            setActiveResearchDetailError(err instanceof Error ? err.message : String(err));
          }
        }
      };

      if (!isCancelled()) {
        setPanesReconciled(existingPanes);
        await restoreResearchSelection();
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const clearResearchUnseen = useCallback((treeId: string) => {
    // Both attention flags: viewing acknowledges failures exactly like
    // ordinary settlements (the backend clears both by advancing
    // last_viewed_at). Clearing only the update dot left the sidebar and
    // mode-toggle "!" lit forever — mark_research_tree_viewed emits no
    // event, so no refetch ever corrected the local copy.
    setResearchTrees((current) => clearResearchTreeAttention(current, treeId));
    setArchivedResearchTrees((current) => clearResearchTreeAttention(current, treeId));
  }, []);
  // Back/forward history (researchHistory.ts): every change of what the
  // research surface shows — a thread's selected message, or Home with no
  // thread open — is recorded here, so back and forward replay switches
  // between questions within a thread and across threads in order.
  const recordResearchVisit = useCallback(
    (visit: ResearchVisit) => updateResearchVisits((current) => pushResearchVisit(current, visit)),
    [updateResearchVisits],
  );
  // Removes visits to removed trees. The visit on screen stays: the caller
  // is still showing it and navigates away itself.
  const pruneResearchTreeVisits = useCallback(
    (keepTree: (treeId: string) => boolean) =>
      updateResearchVisits((current) =>
        pruneResearchVisits(current, (visit) => visit.kind === "home" || keepTree(visit.treeId), {
          keepCurrent: true,
        }),
      ),
    [updateResearchVisits],
  );
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
    recentActivityRootRequestSeqRef.current += 1;
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
        // only refetches the head, so drop the tail; the feed loads the
        // roots of listed cards that are no longer loaded.
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
      }
      // The backend can remove the selected tree out from under the UI (a root
      // launch that failed removes its never-launched tree). Left selected, the
      // thread page would spin on a tree that no longer exists with nothing able to
      // recover it — clear the selection so the empty state takes over.
      const activeTreeId = activeResearchTreeIdRef.current;
      if (activeTreeId && !trees.some((tree) => tree.id === activeTreeId)) {
        recordResearchVisit({ kind: "home" });
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
      pruneResearchTreeVisits((id) => knownTreeIds.has(id));
      return trees;
    } finally {
      researchNavRefreshInFlightRef.current -= 1;
    }
  }, [pruneResearchTreeVisits, recordResearchVisit]);
  const markVisibleResearchTreeViewed = useCallback(
    async (treeId: string, options: ResearchViewedAckOptions = {}) => {
      const threadVisible = researchThreadIsVisible(treeId, activeResearchTreeIdRef.current);
      if (!threadVisible) {

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
    setFeedOpen(false);
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
        // workspace scope, or the thread page would show a tree the sidebar
        // doesn't list — with nothing highlighted anywhere.
        if (researchScopeRef.current !== detail.tree.workspaceId) {
          changeResearchWorkspaceScope(detail.tree.workspaceId);
        }
        void markVisibleResearchTreeViewed(treeId, { force: true }).catch(() => undefined);
      }
    } catch (err) {
      // Surfaced inside the thread page (with a working Retry) rather than as a
      // global banner: without detail the thread page has no node to load, so
      // the error and its recovery belong where the user is looking.
      if (
        researchDetailRequestSeqRef.current === requestSeq &&
        activeResearchTreeIdRef.current === treeId
      ) {
        setActiveResearchDetailError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [
    changeResearchWorkspaceScope,
    markVisibleResearchTreeViewed,
    setFeedOpen,
  ]);
  /** Whether `treeId`'s thread page is mounted and on screen. */
  const researchThreadShown = useCallback(
    (treeId: string) =>
      activeResearchTreeIdRef.current === treeId && researchStageViewRef.current === "thread",
    [],
  );
  // Opens a thread at the message it restores (its last selection). The
  // visit names no message until the thread page reports the one it
  // restored. The thread already on screen is left as it is.
  const navigateToResearchThread = useCallback(
    (treeId: string) => {
      if (researchThreadShown(treeId)) {
        return;
      }
      recordResearchVisit({ kind: "node", treeId, nodeId: null });
      void selectResearchTree(treeId);
    },
    [recordResearchVisit, researchThreadShown, selectResearchTree],
  );
  // Opens a node of a tree: its level, and the levels before it, open as
  // column pairs, with the node selected. The store covers a thread page
  // that mounts for this tree. A thread page already showing the tree gets
  // the request instead, selects the node in place (no refetch, so its
  // columns do not blink) and records the visit itself; when its loaded
  // tree does not have the node yet, the tree is fetched again.
  const openResearchNode = useCallback(
    (treeId: string, nodeId: string) => {
      const navigationStore = researchNavigationStore();
      const navigation = navigationStore[treeId] ?? { scrollByNode: {} };
      navigation.selectedNodeId = nodeId;
      navigationStore[treeId] = navigation;
      saveResearchNavigation();
      if (researchThreadShown(treeId) && requestResearchNodeOpen(treeId, nodeId)) {
        return;
      }
      recordResearchVisit({ kind: "node", treeId, nodeId });
      void selectResearchTree(treeId);
    },
    [recordResearchVisit, researchThreadShown, selectResearchTree],
  );
  const openRecentResearchQuery = useCallback(
    (query: RecentResearchQuery) => openResearchNode(query.treeId, query.nodeId),
    [openResearchNode],
  );
  const openResearchHighlight = useCallback(
    (item: ResearchHighlightFeedItem) => {
      // Recorded before navigation so the thread page's visit restore can
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
  /** Loads the feed roots of trees listed in Home or Bookmarks whose root is
   * not loaded. A response that an event or refresh made stale is fetched
   * again. */
  const loadActivityForTrees = useCallback(async (treeIds: string[]) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestSeq = recentActivityRootRequestSeqRef.current;
      const roots = await listRecentActivityForTrees(treeIds);
      if (recentActivityRootRequestSeqRef.current !== requestSeq) continue;
      setRecentActivityItems((current) => {
        const next = mergeRecentActivityItems(current, roots);
        recentActivityItemsRef.current = next;
        return next;
      });
      return;
    }
  }, []);
  const retryActiveResearchDetail = useCallback(() => {
    const treeId = activeResearchTreeIdRef.current;
    if (treeId) {
      void selectResearchTree(treeId);
    }
  }, [selectResearchTree]);
  const focusResearchHome = useCallback(() => {
    recordResearchVisit({ kind: "home" });
    // Invalidate a tree request that may still be landing while Home is
    // selected; otherwise its detail can repaint behind the launcher.
    researchDetailRequestSeqRef.current += 1;
    setFeedOpen(true);
    activeResearchTreeIdRef.current = null;
    setActiveResearchTreeId(null);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
  }, [recordResearchVisit, setFeedOpen]);
  // Brings the feed page forward on the research surface. Tree selection is
  // left standing (the feed outranks the thread in the stage selector),
  // so closing the feed by picking a tree is a plain selection.
  const showFeed = useCallback(() => {
    // The feed is a peer page of a research thread, not an overlay on one:
    // opening it drops the tree selection the way Home does, so the sidebar
    // never shows a selected row behind the tab that is actually forward.
    researchDetailRequestSeqRef.current += 1;
    activeResearchTreeIdRef.current = null;
    setActiveResearchTreeId(null);
    setActiveResearchDetail(null);
    setActiveResearchDetailError(null);
    localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
    setFeedOpen(true);
  }, [setFeedOpen]);
  // Which list the feed column shows: Home, Bookmarks, Highlights, Drafts,
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
    onMoveTree: (treeId, place, position) => void moveResearchTree(treeId, place, position),
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
      openFeedPage({ kind: "folder", folderId });
      setPendingResearchFolderDelete(folderId);
    },
    [openFeedPage],
  );
  const confirmResearchFolderDelete = useCallback(
    (folderId: string) => {
      const moved = [...researchTreesRef.current, ...archivedResearchTreesRef.current].filter(
        (tree) => researchFolderStateRef.current.membership[tree.id] === folderId,
      ).length;
      setPendingResearchFolderDelete(null);
      openFeedPage({ kind: "home" });
      void deleteResearchFolder(folderId).then((deleted) => {
        if (!deleted) return;
        showResearchToast(
          `Deleted folder.${
            moved ? ` ${moved} question${moved === 1 ? "" : "s"} moved to Unfiled.` : ""
          }`,
        );
      });
    },
    [deleteResearchFolder, openFeedPage, showResearchToast],
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
  const highlightsFeedVisible = feedPage.kind === "highlights";
  useEffect(() => {
    if (!highlightsFeedVisible) return;
    void refreshResearchHighlights();
  }, [highlightsFeedVisible, refreshResearchHighlights, researchHighlightsVersion]);
  const invalidateResearchHighlights = useCallback(() => {
    setResearchHighlightsVersion((version) => version + 1);
  }, []);
  // Shows a visit that back or forward moved to, without recording it.
  const applyResearchVisit = useCallback(
    (visit: ResearchVisit) => {
      const action = researchVisitAction(
        visit,
        activeResearchTreeIdRef.current,
        researchStageViewRef.current === "thread",
      );
      if (visit.kind === "home" || action === "home") {
        showFeed();
        return;
      }
      if (visit.nodeId) {
        const navigationStore = researchNavigationStore();
        const navigation = (navigationStore[visit.treeId] ??= { scrollByNode: {} });
        navigation.selectedNodeId = visit.nodeId;
        saveResearchNavigation();
      }
      if (action === "in-place") {
        if (!visit.nodeId || requestResearchNodeOpen(visit.treeId, visit.nodeId, { record: false })) {
          return;
        }
      }
      void selectResearchTree(visit.treeId);
    },
    [selectResearchTree, showFeed],
  );
  const goResearchBack = useCallback(() => {
    const step = researchVisitBack(researchVisitsRef.current);
    if (!step) {
      return;
    }
    updateResearchVisits(() => step.history);
    applyResearchVisit(step.visit);
  }, [applyResearchVisit, updateResearchVisits]);
  const goResearchForward = useCallback(() => {
    const step = researchVisitForward(researchVisitsRef.current);
    if (!step) {
      return;
    }
    updateResearchVisits(() => step.history);
    applyResearchVisit(step.visit);
  }, [applyResearchVisit, updateResearchVisits]);
  // The thread page's reports: the reader's own navigation pushes a visit;
  // a selection the page made itself (the message it restored on opening)
  // replaces the visit on screen when that is a visit to this thread.
  const reportResearchNavigation = useCallback(
    (treeId: string, nodeId: string, mode: "push" | "replace") => {
      const visit: ResearchVisit = { kind: "node", treeId, nodeId };
      updateResearchVisits((current) => {
        const shown = currentResearchVisit(current);
        return mode === "replace" && shown?.kind === "node" && shown.treeId === treeId
          ? replaceResearchVisit(current, visit)
          : pushResearchVisit(current, visit);
      });
    },
    [updateResearchVisits],
  );
  // Removed messages: their visits go; `selection` is the message the
  // thread page moved to.
  const pruneResearchNodeVisits = useCallback(
    (treeId: string, keepNode: (nodeId: string) => boolean, selection: string | null) => {
      const keep = (visit: ResearchVisit) =>
        visit.kind === "home" || visit.treeId !== treeId || visit.nodeId === null || keepNode(visit.nodeId);
      updateResearchVisits((current) =>
        selection
          ? researchVisitsAfterRemoval(current, keep, { kind: "node", treeId, nodeId: selection })
          : pruneResearchVisits(current, keep),
      );
    },
    [updateResearchVisits],
  );

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
        recentActivityRootRequestSeqRef.current += 1;
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
        const starredPatch = patchRecentActivityStarred(
          upsertRecentActivityResearchNode(recentActivityItemsRef.current, node),
          node,
        );
        recentActivityItemsRef.current = starredPatch.items;
        setRecentActivityItems(starredPatch.items);
        if (starredPatch.stale) scheduleResearchRefresh();
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
            nodeStatus(cached) !== nodeStatus(event.node) ||
            nodeRun(cached)?.completedAt !== nodeRun(event.node)?.completedAt ||
            cached.parentNodeId !== event.node.parentNodeId;
          const activityBindingChanged =
            !cached || nodeRun(cached)?.holdsProcess !== nodeRun(event.node)?.holdsProcess;
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
            nodeRun(previous)?.completedAt !== nodeRun(event.node)?.completedAt &&
            nodeRun(event.node)?.completedAt != null
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
            pruneResearchTreeVisits((id) => id !== event.tree.id);
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
          pruneResearchTreeVisits((id) => id !== event.treeId);
          break;
        }
      }
    },
    [
      focusResearchHome,
      pruneResearchTreeVisits,
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
      // Clear feedOpen so the new thread is visible after closing a
      // conversation or opening a draft.
      setFeedOpen(false);
      // A new question is a visit like opening one: Back returns to what was
      // open before it.
      recordResearchVisit({ kind: "node", treeId: detail.tree.id, nodeId: null });
      activeResearchTreeIdRef.current = detail.tree.id;
      setActiveResearchTreeId(detail.tree.id);
      localStorage.setItem(ACTIVE_RESEARCH_TREE_KEY, detail.tree.id);
      setActiveResearchDetail((current) =>
        reconcileResearchTreeDetail(current, detail),
      );
      setActiveResearchDetailError(null);
      if (researchScopeRef.current !== detail.tree.workspaceId) {
        changeResearchWorkspaceScope(detail.tree.workspaceId);
      }
    },
    [changeResearchWorkspaceScope, recordResearchVisit, setFeedOpen],
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
  const submitNewPost = useCallback(
    async (input: {
      body: string;
      adapter: string;
      model: string | null;
      effort: string | null;
      workspaceId: string | null;
    }) => {
      const group = await resolveResearchComposerWorkspace(input.workspaceId);
      const detail = await createResearchPost({ ...input, workspaceId: group.id });
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
        // Apply the authoritative metadata immediately. The thread page
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
  const editResearchPost = useCallback(
    async (input: { nodeId: string; text: string; expectedText: string }) => {
      const result = await updateResearchPost(input);
      if (activeResearchTreeIdRef.current === result.tree.id) {
        setActiveResearchDetail((current) =>
          current?.tree.id === result.tree.id
            ? {
                tree: result.tree,
                nodes: current.nodes.map((node) => (node.id === result.node.id ? result.node : node)),
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
  // Every delete entry point (thread menus, feed menus) reconciles the active
  // thread the same way: the deleted thread closes back to the feed.
  const removeResearchTreeAndSelectFallback = useCallback(
    async (treeId: string) => {
      setError(null);
      await removeResearchTree(treeId);
      if (activeResearchTreeIdRef.current === treeId) {
        focusResearchHome();
      }
      pruneResearchTreeVisits((id) => id !== treeId);
    },
    [focusResearchHome, pruneResearchTreeVisits],
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
      anchor?: NodeAnchor | null,
      inline?: boolean,
      replacesNodeId?: string | null,
    ) => {
      const node = await forkResearchNode(
        parentNodeId,
        prompt,
        anchor,
        inline ?? false,
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
  // As retryResearchRun, for a rerun that may replace a complete answer.
  const rerunResearchRun = useCallback(async (nodeId: string) => {
    const detail = await rerunResearchNode(nodeId);
    if (activeResearchTreeIdRef.current === detail.tree.id) {
      setActiveResearchDetail((current) => reconcileResearchTreeDetail(current, detail));
    }
  }, []);
  // Follow-ups and retries under notes, in a note's follow-ups column. The
  // resulting node events update the feed and the open thread, so nothing is
  // patched here.
  const postActions = useMemo<PostActions>(
    () => ({
      onAskFollowUp: async ({ parentNodeId, prompt, asNote }) => {
        if (asNote) {
          await createResearchPostFollowUp(parentNodeId, prompt);
          return;
        }
        await createResearchFollowup(parentNodeId, prompt, null, false);
      },
      onRetry: retryResearchRun,
    }),
    [createResearchFollowup, retryResearchRun],
  );
  const removeResearchBranchFromThread = useCallback(
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
    setPanes: setPanesReconciled,
    setExitPreflightRequest,
    setAgents,
    setGroups,
    openBrowserOverlay,
    onAgentSpawned: handleAgentSpawned,
    onAgentPromptSubmitted: handleAgentPromptSubmitted,
    onAppShortcut: handleNativeAppShortcut,
    onBrowserEscapeRequested: () => {
      browserEscapeDispatcherRef.current();
    },
    onResearchChanged: handleResearchEvent,
    onUserNotificationRequested: handleUserNotificationRequested,
  });

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

  // The thread page's toasts use the research toast: its live region is
  // mounted before any text arrives, and it pauses under the pointer or focus.
  const handleResearchThreadToast = useCallback(
    (message: string, tone?: "normal" | "warning") =>
      showResearchToast(message, tone === "warning" ? { tone: "warning" } : {}),
    [showResearchToast],
  );

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
        hint: LEFT_SIDEBAR_TOGGLE_SHORTCUT_LABEL,
        action: () => setLeftSidebarCollapsed(!leftSidebarCollapsed),
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
        action: () => openAgentSetup(),
      },
    );
    return commands;
  }

  // Research workspaces are the only groups any surface renames.
  function openGroupRenameDialog(group: GroupInfo) {
    setRenameValue(displayGroupName(group));
    setRenameGroupId(group.id);
  }

  function closeRenameDialog() {
    setRenameGroupId(null);
  }

  async function submitRename() {
    const groupId = renameGroupId;
    if (!groupId) {
      return;
    }
    const title = renameValue.trim();
    const previous = groups.find((group) => group.id === groupId);
    const nextNameOverride = title.length === 0 ? null : title;
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
      const updated = await renameResearchWorkspace(groupId, nextNameOverride);
      setGroups((current) =>
        current.map((group) => (group.id === groupId ? updated : group)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGroups((current) =>
        current.map((group) => (group.id === groupId ? previous : group)),
      );
    }
  }

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
      changeResearchWorkspaceScope(nextScope);
    }
    // Removing the selected folder/tree should land on an available research
    // item in the surviving scope, not leave an unexplained empty thread page.
    if (scopeWasRemoved || activeTreeWasRemoved) {
      const nextTree = treeForResearchScope(
        remainingTrees,
        nextScope,
        activeTreeWasRemoved ? null : activeTreeId,
      );
      if (nextTree) {
        navigateToResearchThread(nextTree.id);
      } else {
        focusResearchHome();
      }
    }
    pruneResearchTreeVisits((id) => !detachedTreeIds.has(id));
    void refreshResearchNavigation().catch(() => undefined);
  }

  async function confirmResearchFolderRemoval() {
    const workspace = researchFolderRemoval;
    if (!workspace || removingResearchFolder) {
      return;
    }
    setResearchFolderRemovalError(null);
    setRemovingResearchFolder(true);
    try {
      await removeResearchWorkspaceFromSidebar(workspace);
      setResearchFolderRemoval(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResearchFolderRemovalError(message);
      setError(message);
    } finally {
      setRemovingResearchFolder(false);
    }
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
    if (!researchFolderRemoval) {
      return;
    }

    const focusCloseButton = (force = false) =>
      focusConfirmDialogButton(researchFolderRemovalButtonRef.current, force);

    focusCloseButton(true);
    const frame = requestAnimationFrame(() => focusCloseButton());
    const settle = window.setTimeout(() => focusCloseButton(), 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [researchFolderRemoval]);

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
    try {
      const activeResearchNodeIds = researchActivity
        .filter((node) => isActiveResearchStatus(nodeStatus(node)))
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

  // Mirror browser state into refs so the always-on Escape listener never
  // reads stale state.
  useEffect(() => {
    browserOverlayByPaneRef.current = browserOverlayByPane;
    closeActiveBrowserOverlayRef.current = closeActiveBrowserOverlay;
  });

  useEditableFocusRestore();
  // Live snapshot of the app-level overlay state for the Escape dispatcher
  // below, which is registered exactly once. Mirrored every render, read only
  // at event time.
  const escapeOverlayStateRef = useRef({
    remoteAddMenuOpen,
    remoteDeleteConfirm,
    remoteSettingsSaving,
    researchFolderRemoval,
    exitDialog,
    renameGroupId,
    removingResearchFolder,
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
      researchFolderRemoval,
      exitDialog,
      renameGroupId,
      removingResearchFolder,
      quitting,
      settingsOpen,
      agentsOpen,
      error,
    };
  });


  // Escape can originate in two separate AppKit responders while the browser
  // is visible: the outer app webview and the child human-browser WKWebView.
  // The native monitor funnels both through this live dispatcher. The DOM
  // listener below uses it too so lightbox/browser priority stays
  // single-sourced.

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
      const dialogsOpen = Boolean(overlays.researchFolderRemoval || overlays.exitDialog);
      let stopPropagation = false;
      if (dialogsOpen) {
        stopPropagation = true;
        event.preventDefault();
        // Don't dismiss the removal dialog while the removal is running.
        if (!overlays.removingResearchFolder) {
          setResearchFolderRemoval(null);
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
    if (renameGroupId) {
      const input = renameInputRef.current;
      input?.focus();
      input?.select();
    }
  }, [renameGroupId]);

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
    const executeShortcut = (command: AppShortcutCommand, repeat: boolean) => {
      if (document.querySelector("dialog[open]")) return;
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
          setLeftSidebarCollapsed(!leftSidebarCollapsedRef.current);
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
          requestResearchWorkspaceMenuToggle();
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
            const browserOwnerId = activeResearchTreeIdRef.current
              ? researchBrowserOwnerId(activeResearchTreeIdRef.current)
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
  }, [focusResearchHome]);

  // Keep the sidebar within bounds as the window resizes.
  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);


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
          researchStageView === "thread",
          treeId,
        )
      ) {
        return;
      }
      const rootNodeId = researchTrees.find((tree) => tree.id === treeId)?.rootNodeId;
      if (rootNodeId) openResearchNode(treeId, rootNodeId);
      else navigateToResearchThread(treeId);
    },
    [
      activeResearchTreeId,
      navigateToResearchThread,
      openResearchNode,
      researchStageView,
      researchTrees,

    ],
  );
  const openFeedView = useCallback(
    (view: ResearchFeedView) => {
      setPendingResearchFolderDelete(null);
      openFeedPage(view);
    },
    [openFeedPage],
  );
  const moveResearchTreeFromFeed = useCallback(
    (treeId: string, place: string) => void moveResearchTree(treeId, place),
    [moveResearchTree],
  );
  const reorderResearchTreeFromFeed = useCallback(
    (treeId: string, place: string, position: ResearchDropPosition) =>
      void moveResearchTree(treeId, place, position),
    [moveResearchTree],
  );
  const moveResearchDraftFromFeed = useCallback(
    (draftId: string, beforeId: string | null) => void moveResearchDraft(draftId, beforeId),
    [moveResearchDraft],
  );
  // The open conversation's open nodes (the message selected in its root
  // pair and each open branch's head), whose starred child rows the feed
  // shows selected. Node ids are unique across trees, so ids left from
  // another tree match nothing.
  const [openResearchNodeIds, setOpenResearchNodeIds] = useState<string[]>([]);
  // Remove star on a feed child row; the node update event drops the row.
  const unstarResearchFeedChild = useCallback(
    (child: ResearchFeedChild) => {
      void setResearchNodeStarred(child.nodeId, false).then(
        () => showResearchToast(child.branch ? "Branch unstarred." : "Unstarred."),
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
  // The open question's Bookmark and Move to, listed in its root
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
  const activeResearchTreeMenu = useMemo<ResearchThreadTreeMenu | undefined>(() => {
    const tree = activeResearchTreeState;
    if (!tree) return undefined;
    return {
      currentPlace: researchTreePlace(tree, researchFolderState),
      folders: researchFolders,
      bookmarked: Boolean(tree.bookmarked),
      onSetBookmarked: (bookmarked) => bookmarkResearchTreeFromFeed(tree.id, bookmarked),
      onMove: (place) => moveResearchTreeFromFeed(tree.id, place),
      onNewFolder: (trigger) => openNewResearchFolderDialog(tree.id, trigger),
    };
  }, [
    activeResearchTreeState,
    researchFolderState,
    researchFolders,
    bookmarkResearchTreeFromFeed,
    moveResearchTreeFromFeed,
    openNewResearchFolderDialog,
  ]);
  // A draft opens in the content column beside the feed, which keeps its
  // view; opening a thread replaces it.
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

  // Back and forward for the content column's header (the open thread's,
  // or the empty column's with no thread open).
  const researchHistoryNav = {
    canGoBack: canGoResearchBack(researchVisits),
    canGoForward: canGoResearchForward(researchVisits),
    backTitle: `Back (${IS_MAC ? "⌘[" : "Ctrl+["})`,
    forwardTitle: `Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`,
    onBack: goResearchBack,
    onForward: goResearchForward,
  };
  // The Home feed stays mounted beside an open thread, where every streamed
  // update re-renders App; stable props let the memoized feed skip those.
  const feedResearchTrees = useMemo(
    () => [...researchTrees, ...archivedResearchTrees],
    [researchTrees, archivedResearchTrees],
  );
  // A question asked from a user folder's view is filed in that folder; from
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
  // "Ask as a question" in the editor column: a new thread with the edited
  // text, asked with the Home ask box's selected agent and model (as a draft
  // sent from Drafts is), in the edited thread's folder. It opens selected.
  // Once the new thread exists, a dialog offers to delete the edited thread
  // (see ResearchTreeDeleteOfferDialog), counted from its nodes as they were
  // when the question was asked.
  const askResearchEditorQuestion = useCallback(
    async (prompt: string) => {
      const choice = composerLaunchChoiceRef.current?.();
      if (!choice) {
        throw new Error("No research agent is ready. Review agents in Settings.");
      }
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
  const readResearchQuestionModel = useCallback(() => {
    const choice = composerLaunchChoiceRef.current?.();
    return choice ? formatResearchModelSummary(choice.adapter, choice.model) || choice.adapter : null;
  }, []);
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
          onOpenAgentSettings={() => openAgentSetup()}
          onCreate={submitFeedResearch}
          onPost={submitFeedPost}
          onSaveDraft={saveComposerDraft}
        />
      ) : null,
    [
      configAdapters,
      composerFolderName,
      openAgentSetup,
      settings.requireCmdEnterToSend,
      researchScope,
      saveComposerDraft,
      submitFeedResearch,
      submitFeedPost,
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
  // The workspace switcher, the Agents module and the account control sit at
  // the bottom of the full sidebar, in that order. In the rail the workspace
  // switcher is an icon whose menu opens as a popover with the account control
  // inside, so both (and ⌘O) stay reachable below 900px; the Agents icon
  // follows it.
  const renderResearchWorkspaceSwitcher = (
    variant: "sidebar" | "rail",
    footer?: ReactNode,
  ) => (
    <ResearchWorkspaceSwitcher
      variant={variant}
      footer={footer}
      folders={researchGroups}
      scope={researchScope}
      treeCounts={researchFolderTreeCounts}
      folderPickerBusy={folderPickerStatus !== null}
      shortcutHintsShown={shortcutHintsShown}
      onSelectScope={(scope) => {
        changeResearchWorkspaceScope(scope);
        // Keep the selection inside the new scope.
        const allTrees = [...researchTrees, ...archivedResearchTrees];
        const scopedTrees = treesForResearchScope(allTrees, scope);
        const activeInScope = scopedTrees.some(
          (tree) => tree.id === activeResearchTreeId,
        );
        if (researchHomeActive) {
          return;
        }
        if (!activeInScope) {
          const tree = treeForResearchScope(allTrees, scope, activeResearchTreeId);
          if (tree) {
            navigateToResearchThread(tree.id);
          } else {
            if (activeResearchTreeIdRef.current) recordResearchVisit({ kind: "home" });
            activeResearchTreeIdRef.current = null;
            setActiveResearchTreeId(null);
            setActiveResearchDetail(null);
            setActiveResearchDetailError(null);
            localStorage.removeItem(ACTIVE_RESEARCH_TREE_KEY);
          }
        }
      }}
      onNewFolder={chooseResearchWorkspaceFolder}
      onOpenFolder={openResearchWorkspaceFolder}
      onRenameFolder={openGroupRenameDialog}
      onMoveFolder={moveResearchWorkspaceFolder}
      onRemoveFolder={(workspace) => {
        setResearchFolderRemovalError(null);
        setResearchFolderRemoval(workspace);
      }}
    />
  );
  const renderResearchAgentsSwitcher = (variant: "sidebar" | "rail") => (
    <ResearchAgentsSwitcher
      variant={variant}
      adapters={config?.adapters ?? null}
      loading={adapterProbeLoading}
      error={adapterProbeError}
      onOpenSetup={openAgentSetup}
      onRefresh={() => void refreshAdapterReadiness({ force: true }).catch(() => undefined)}
    />
  );


  // The shell is a plain container: its sidebar (an aside) and the
  // workspace (the main landmark) sit side by side, not nested.
  return (
    <div
      ref={appRef}
      className={`app-shell${researchSidebarRail && IS_MAC ? " has-titlebar-rail" : ""}${
        settings.reduceMotion ? " reduce-motion" : ""
      }`}
      style={appStyle}
    >
      {!researchSidebarRail ? (
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
      {researchSidebarRail ? (
        <ResearchSidebarRail
          current={feedPage}
          folders={researchFolders}
          forced={windowNarrowForSidebar}
          reserveTitlebar={IS_MAC}
          expandShortcut={LEFT_SIDEBAR_TOGGLE_SHORTCUT_LABEL}
          onExpand={() => setLeftSidebarCollapsed(false)}
          onNavigate={openFeedPage}
          onNewFolder={() => openNewResearchFolderDialog()}
          footer={
            <>
              {renderResearchWorkspaceSwitcher("rail", <GithubAccountControl />)}
              {renderResearchAgentsSwitcher("rail")}
              <ResearchRailButton
                label={settings.appearance === "light" ? "Dark mode" : "Light mode"}
                onClick={toggleAppearance}
              >
                {settings.appearance === "light" ? (
                  <Moon size={16} aria-hidden="true" />
                ) : (
                  <Sun size={16} aria-hidden="true" />
                )}
              </ResearchRailButton>
              <ResearchRailButton
                label="Settings (⌘,)"
                selected={settingsOpen}
                onClick={() => {
                  setAgentsOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <Settings size={16} aria-hidden="true" />
              </ResearchRailButton>
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
            onClick={() => setLeftSidebarCollapsed(true)}
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
              current={feedPage}
              folders={researchFolders}
              onNavigate={openFeedPage}
              onNewFolder={() => openNewResearchFolderDialog()}
              onRenameFolder={openRenameResearchFolderDialog}
              onDeleteFolder={requestResearchFolderDelete}
              foldersLoadError={researchFoldersLoadError}
              onRetryFoldersLoad={retryResearchFoldersLoad}
              homeShortcutHint={shortcutHintsShown ? RESEARCH_HOME_SHORTCUT_LABEL : null}
            />
          </div>
          {renderResearchWorkspaceSwitcher("sidebar")}
          {renderResearchAgentsSwitcher("sidebar")}
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
                initialInstanceId={agentSetupInstanceId}
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
                      onClick={(event) => {
                        // WebKit does not focus a clicked button; focus it so
                        // a second click, which closes the menu (whose item
                        // has focus), leaves focus here.
                        event.currentTarget.focus({ preventScroll: true });
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

      {researchFolderRemoval ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !removingResearchFolder) {
              setResearchFolderRemoval(null);
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
              {`Remove ${displayGroupName(researchFolderRemoval)}?`}
            </h2>
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
                disabled={removingResearchFolder}
                onClick={() => setResearchFolderRemoval(null)}
              >
                Cancel
              </button>
              <button
                ref={researchFolderRemovalButtonRef}
                type="button"
                className="control-button danger"
                autoFocus
                disabled={removingResearchFolder}
                onClick={() => void confirmResearchFolderRemoval()}
              >
                {removingResearchFolder ? "Removing…" : "Remove workspace"}
              </button>
            </div>
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

      {renameGroupId ? (
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
              {renamingResearchFolder ? "Rename workspace" : "Rename group"}
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
              aria-label={renamingResearchFolder ? "Workspace name" : "Group name"}
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

        <div className="main-stage is-research">
          {/* The feed column lists Home, a folder, Drafts, Archive, Bookmarks,
              or Highlights beside the content column, which shows the open
              thread (or a placeholder). One wrapper for both states keeps the
              feed mounted, and its scroll position, while threads open and
              close beside it. */}
          <ResearchColumns
            hasThread={researchStageView === "thread" || openResearchDraft !== null}
            feed={
              config ? (
                feedPage.kind === "highlights" ? (
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
                    view={feedPage}
                    selectedTreeId={researchStageView === "thread" ? activeResearchTreeId : null}
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
                    onLoadTrees={loadActivityForTrees}
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
                    onMoveTree={moveResearchTreeFromFeed}
                    onReorderTree={reorderResearchTreeFromFeed}
                    onReorderDraft={moveResearchDraftFromFeed}
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
                    onRefresh={refreshFeed}
                    // Mouse buttons and swipes over the feed walk the same
                    // history as the thread's controls.
                    onBack={goResearchBack}
                    onForward={goResearchForward}
                  />
                )
              ) : null
            }
          >
            {researchStageView === "thread" && activeResearchTreeId ? (
              // Remount on tree changes to reset selection, fetched content,
              // and the follow-up draft before paint. Resetting them in effects
              // would briefly show and refetch the previous tree's node.
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
                onRemoveTree={removeResearchTreeAndSelectFallback}
                onRenameTree={renameResearchTreeTitle}
                onUpdateDocument={editResearchDocument}
                onUpdatePost={editResearchPost}
                onAskAsQuestion={askResearchEditorQuestion}
                readQuestionModel={readResearchQuestionModel}
                onCancel={cancelResearchRun}
                onRetryNode={retryResearchRun}
                onRerunNode={rerunResearchRun}
                linkActions={linkActionsForPane(researchBrowserOwnerId(activeResearchTreeId))}
                onError={setError}
                onToast={handleResearchThreadToast}
                shortcutHintsShown={shortcutHintsShown}
                requireCmdEnterToSend={settings.requireCmdEnterToSend}
                onOpenNodesChange={setOpenResearchNodeIds}
                treeMenu={activeResearchTreeMenu}
                canGoBack={researchHistoryNav.canGoBack}
                canGoForward={researchHistoryNav.canGoForward}
                onBack={goResearchBack}
                onForward={goResearchForward}
                onNavigate={reportResearchNavigation}
                onPruneVisits={pruneResearchNodeVisits}
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
              <ResearchEmptyContent history={researchHistoryNav}>
                <p>Select a question to open its conversation.</p>
              </ResearchEmptyContent>
            )}
          </ResearchColumns>
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
          toggleShortcutLabel={EXPAND_TOGGLE_SHORTCUT_LABEL}
          occluded={nativeBrowserOccluded}
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
          fallbackFocus={askedResearchRow}
          onClose={() => setResearchOfferDeletingTreeId(null)}
          onRemove={removeResearchTreeFromMenu}
        />
      ) : null}
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
