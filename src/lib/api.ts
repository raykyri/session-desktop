import { trackRemoteStartup, recordRemoteStartup, reconcileRemoteReservation, forgetRemoteStartup } from "./remoteStartup";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RecentActivityPage } from "./activity";
import type { PaneLayoutItem } from "./paneTree";
import type { WorktreeLocation } from "./settings";
import {
  HumanBrowserLifecycleQueue,
  retryHumanBrowserLifecycle,
} from "./humanBrowserLifecycleQueue";
import type {
  AgentInfo,
  GithubAccount,
  GithubDeviceLogin,
  GithubLoginPoll,
  GroupInfo,
  HomeTurnHistoryPage,
  InitialPaneSize,
  MessageAnchor,
  PaneActivity,
  PaneInfo,
  PaneSplitInfo,
  SessionEvent,
  QueuedTurn,
  ResearchBranchRemoval,
  RecentResearchQueryCursor,
  ResearchHighlight,
  ResearchHighlightFeedItem,
  ResearchHighlightAnchor,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
  ResearchNode,
  ResearchNodeContent,
  ResearchRecapCandidate,
  UpdateResearchDocumentResult,
  SendNextQueuedAgentTurnResult,
  RuntimeConfig,
  RemoteChoice,
  RemoteProbeResult,
  RepositoryInventory,
  SavedRemote,
  TranscriptOption,
  ThreadGraph,
  Turn,
  WorktreeStatus,
} from "../types";

export function getRuntimeConfig() {
  return invoke<RuntimeConfig>("get_runtime_config");
}

export function listSshConfigAliases() {
  return invoke<string[]>("list_ssh_config_aliases");
}

export function upsertRemote(id: string, remote: SavedRemote) {
  return invoke<RemoteChoice[]>("upsert_remote", { id, remote });
}

export function deleteRemote(id: string) {
  return invoke<RemoteChoice[]>("delete_remote", { id });
}

export function probeRemote(remote: SavedRemote) {
  return invoke<RemoteProbeResult>("probe_remote", { remote });
}

export function probeAgentAdapters(options?: { groupId?: string | null; force?: boolean }) {
  return invoke<RuntimeConfig["adapters"]>("probe_agent_adapters", {
    groupId: options?.groupId ?? null,
    force: options?.force ?? false,
  });
}

// Shows the main window. It starts hidden (visible: false in tauri.conf.json)
// so launches never flash a blank translucent shell; App calls this once the
// boot snapshot has been applied and the first real paint is imminent.
export function markAppWindowReady() {
  return invoke<void>("app_window_ready");
}

// The OpenRouter API key lives in the backend's owner-only preferences file, not in
// webview localStorage, so the secret isn't readable at rest by injected scripts.
export function getOpenRouterKey() {
  return invoke<string>("openrouter_key_get");
}

export function setOpenRouterKey(key: string) {
  return invoke<void>("openrouter_key_set", { key });
}

export function getGithubAccount() {
  return invoke<GithubAccount | null>("github_account_get");
}

export function startGithubLogin() {
  return invoke<GithubDeviceLogin>("github_login_start");
}

export function pollGithubLogin() {
  return invoke<GithubLoginPoll>("github_login_poll");
}

export function cancelGithubLogin() {
  return invoke<void>("github_login_cancel");
}

export function logoutGithub() {
  return invoke<void>("github_logout");
}

export function openRouterChatCompletion(payload: unknown) {
  return invoke<{ status: number; body: string }>("openrouter_chat_completion", {
    payload,
  });
}

export function setActiveTab(tabId: string | null) {
  return invoke<void>("active_tab_set", { tabId });
}

export interface ShowHideShortcutSetting {
  accelerator: string | null;
  registered: boolean;
  error?: string | null;
  captureActive: boolean;
}

export function getShowHideShortcut() {
  return invoke<ShowHideShortcutSetting>("show_hide_shortcut_get");
}

export function setShowHideShortcut(accelerator: string | null) {
  return invoke<ShowHideShortcutSetting>("show_hide_shortcut_set", { accelerator });
}

export function setShowHideShortcutCaptureActive(active: boolean) {
  return invoke<ShowHideShortcutSetting>("show_hide_shortcut_capture_set", { active });
}

export function listPanes() {
  return invoke<PaneInfo[]>("list_panes");
}

export function listGroups() {
  return invoke<GroupInfo[]>("list_groups");
}

export function ensureDefaultResearchWorkspace() {
  return invoke<GroupInfo>("ensure_default_research_workspace_command");
}

export function createResearchWorkspaceWithFolder() {
  return invoke<GroupInfo | null>("research_workspace_create_pick");
}

export function renameResearchWorkspace(workspaceId: string, name: string | null) {
  return invoke<GroupInfo>("research_workspace_rename", { workspaceId, name });
}

export function moveResearchWorkspaceWithFolder(workspaceId: string) {
  return invoke<GroupInfo | null>("research_workspace_move_pick", { workspaceId });
}

export function removeResearchWorkspace(workspaceId: string) {
  return invoke<string[]>("research_workspace_remove", { workspaceId });
}

export function revealResearchWorkspace(workspaceId: string) {
  return invoke<void>("research_workspace_reveal", { workspaceId });
}

export function renameGroup(groupId: string, name: string | null) {
  return invoke<GroupInfo>("group_rename", { groupId, name });
}

export function listAgents() {
  return invoke<AgentInfo[]>("list_agents");
}

export function listTurns(agentId?: string | null) {
  return invoke<Turn[]>("list_turns", { agentId: agentId ?? null });
}

export function listHomeTurnHistory(
  agentId: string,
  before?: string | null,
  limit = 100,
) {
  return invoke<HomeTurnHistoryPage>("list_home_turn_history", {
    agentId,
    before: before ?? null,
    limit,
  });
}

export function getThreadGraph(threadId: string) {
  return invoke<ThreadGraph | null>("get_thread_graph", { threadId });
}

export function listResearchTrees(includeArchived = false) {
  return invoke<ResearchTreeSummary[]>("list_research_trees", { includeArchived });
}

export function reorderResearchTrees(
  workspaceId: string,
  archived: boolean,
  treeIds: string[],
) {
  return invoke<void>("reorder_research_trees", { workspaceId, archived, treeIds });
}

export function listResearchActivity() {
  return invoke<ResearchNode[]>("list_research_activity");
}

export function listRecentActivity(
  limit = 50,
  before?: RecentResearchQueryCursor | null,
) {
  return invoke<RecentActivityPage>("list_recent_activity", {
    limit,
    before: before ?? null,
  });
}

/** Creates a note tree. `askNetwork` notes are posted to the network (no
 * transport yet); a body that is a single URL can be saved with
 * `askNetwork: false` as a link or post. The agent fields are the default
 * for the note's AI follow-ups. */
export function createResearchNote(request: {
  body: string;
  adapter: string;
  model?: string | null;
  effort?: string | null;
  workspaceId: string;
  askNetwork: boolean;
}) {
  return invoke<ResearchTreeDetail>("create_research_note", { request });
}

/** A network follow-up: another note under a network note. */
export function createResearchNoteFollowUp(parentNodeId: string, body: string) {
  return invoke<ResearchNode>("create_research_note_follow_up", { parentNodeId, body });
}

/** The note author's response to a member's reply. */
export function respondToResearchNoteReply(nodeId: string, inReplyTo: string, body: string) {
  return invoke<ResearchNode>("add_research_note_reply", { nodeId, inReplyTo, body });
}

/** Deletes one of the note author's own responses. */
export function removeResearchNoteReply(nodeId: string, replyId: string) {
  return invoke<ResearchNode>("remove_research_note_reply", { nodeId, replyId });
}

export function getResearchTree(treeId: string) {
  return invoke<ResearchTreeDetail>("get_research_tree", { treeId });
}

export function createResearchTree(request: {
  prompt: string;
  title?: string | null;
  adapter: string;
  model?: string | null;
  effort?: string | null;
  workspaceId: string;
}) {
  return invoke<ResearchTreeDetail>("create_research_tree", { request });
}

export function generateResearchAgentTitle(nodeId: string) {
  return invoke<string>("generate_research_agent_title", { nodeId });
}

export function getResearchRecapDefaultInstructions() {
  return invoke<string>("research_recap_default_instructions");
}

export function generateResearchRecapCandidate(request: {
  nodeId: string;
  expectedResponseRevision: string;
  adapter: string;
  model?: string | null;
  instructions: string;
}) {
  return invoke<ResearchRecapCandidate>("generate_research_recap_candidate", { request });
}

export function applyResearchRecapCandidate(request: {
  nodeId: string;
  expectedResponseRevision: string;
  expectedCurrentRecapId?: string | null;
  candidate: ResearchRecapCandidate;
}) {
  return invoke<ResearchNode>("apply_research_recap_candidate", { request });
}

export function updateResearchDocument(request: {
  nodeId: string;
  markdown: string;
  title?: string | null;
  expectedResponseRevision: string;
  expectedTitle: string;
  expectedHighlightIds: string[];
}) {
  return invoke<UpdateResearchDocumentResult>("update_research_document", { request });
}

export function getResearchNodeContent(nodeId: string) {
  return invoke<ResearchNodeContent>("get_research_node_content", { nodeId });
}

export function forkResearchNode(
  parentNodeId: string,
  prompt: string,
  queryAnchor?: ResearchHighlightAnchor | null,
  inline = false,
  replyAnchor?: string | null,
) {
  return invoke<ResearchNode>("fork_research_node", {
    parentNodeId,
    prompt,
    queryAnchor: queryAnchor ?? null,
    replyAnchor: replyAnchor ?? null,
    inline,
  });
}

/** Relaunches a failed (or cancelled) run in place: the node keeps its id and
 * launch inputs, resets to queued, and goes back through the ordinary launch
 * machinery. Returns the refreshed tree detail. */
export function retryResearchNode(nodeId: string) {
  return invoke<ResearchTreeDetail>("retry_research_node", { nodeId });
}

export function cancelResearchNode(nodeId: string) {
  return invoke<ResearchNode>("cancel_research_node", { nodeId });
}

export function renameResearchTree(treeId: string, title: string) {
  return invoke<ResearchTree>("rename_research_tree", { treeId, title });
}

export function listResearchHighlights() {
  return invoke<ResearchHighlightFeedItem[]>("list_research_highlights");
}

export function setResearchTreeFollowed(treeId: string, followed: boolean) {
  return invoke<ResearchTree>("set_research_tree_followed", { treeId, followed });
}

export function setResearchTreeBookmarked(treeId: string, bookmarked: boolean) {
  return invoke<ResearchTree>("set_research_tree_bookmarked", { treeId, bookmarked });
}

export function renameResearchNode(nodeId: string, title: string) {
  return invoke<ResearchNode>("rename_research_node", { nodeId, title });
}

export function createResearchHighlight(
  nodeId: string,
  anchor: ResearchHighlightAnchor,
) {
  return invoke<ResearchHighlight>("create_research_highlight", {
    nodeId,
    anchor,
  });
}

export function removeResearchHighlights(nodeId: string, highlightIds: string[]) {
  return invoke<ResearchHighlight[]>("remove_research_highlights", {
    nodeId,
    highlightIds,
  });
}

export function markResearchTreeViewed(treeId: string) {
  return invoke<ResearchTree>("mark_research_tree_viewed", { treeId });
}

export function archiveResearchTree(treeId: string) {
  return invoke<ResearchTree>("archive_research_tree", { treeId });
}

export function restoreResearchTree(treeId: string) {
  return invoke<ResearchTree>("restore_research_tree", { treeId });
}

export function removeResearchTree(treeId: string) {
  return invoke<void>("remove_research_tree", { treeId });
}

export function removeResearchBranch(nodeId: string) {
  return invoke<ResearchBranchRemoval>("remove_research_branch", { nodeId });
}

export function listAgentTurnQueue(agentId: string) {
  return invoke<QueuedTurn[]>("list_agent_turn_queue", { agentId });
}

export function listAgentTranscripts(agentId: string) {
  return invoke<TranscriptOption[]>("list_agent_transcripts", { agentId });
}

export async function spawnShell(
  initialSize?: InitialPaneSize | null,
  sourcePaneId?: string | null,
  groupId?: string | null,
  remoteId?: string | null,
) {
  const started = performance.now();
  const pane = await invoke<PaneInfo>("spawn_shell", {
    initialSize: initialSize ?? null,
    sourcePaneId: sourcePaneId ?? null,
    groupId: groupId ?? null,
    remoteId: remoteId ?? null,
  });
  if (pane.remoteSession) {
    trackRemoteStartup(pane.id, started);
    recordRemoteStartup(pane.id, "reserved");
    const observed = reconcileRemoteReservation(pane).remoteConnection;
    if (observed?.state === "connected") recordRemoteStartup(pane.id, "ready");
    if (observed?.state === "failed") forgetRemoteStartup(pane.id);
  }
  return pane;
}

export function openPaneWorktree(
  paneId: string,
  worktreeName: string,
  initialSize?: InitialPaneSize | null,
) {
  return invoke<PaneInfo>("open_pane_worktree", {
    paneId,
    worktreeName,
    initialSize: initialSize ?? null,
  });
}

export function suggestPaneWorktreeName(paneId: string) {
  return invoke<string>("suggest_pane_worktree_name", { paneId });
}

export function paneRepositoryInventory(paneId: string) {
  return invoke<RepositoryInventory>("pane_repository_inventory", { paneId });
}

export async function openRepositoryWorktree(
  paneId: string,
  path: string,
  initialSize?: InitialPaneSize | null,
) {
  const started = performance.now();
  const pane = await invoke<PaneInfo>("open_repository_worktree", {
    paneId,
    path,
    initialSize: initialSize ?? null,
  });
  if (pane.remoteSession) {
    trackRemoteStartup(pane.id, started);
    recordRemoteStartup(pane.id, "reserved");
    const observed = reconcileRemoteReservation(pane).remoteConnection;
    if (observed?.state === "connected") recordRemoteStartup(pane.id, "ready");
    if (observed?.state === "failed") forgetRemoteStartup(pane.id);
  }
  return pane;
}

export async function openRepositoryBranch(
  paneId: string,
  fullRef: string,
  worktreeName: string,
  initialSize?: InitialPaneSize | null,
) {
  const started = performance.now();
  const pane = await invoke<PaneInfo>("open_repository_branch", {
    paneId,
    fullRef,
    worktreeName,
    initialSize: initialSize ?? null,
  });
  if (pane.remoteSession) {
    trackRemoteStartup(pane.id, started);
    recordRemoteStartup(pane.id, "reserved");
    const observed = reconcileRemoteReservation(pane).remoteConnection;
    if (observed?.state === "connected") recordRemoteStartup(pane.id, "ready");
    if (observed?.state === "failed") forgetRemoteStartup(pane.id);
  }
  return pane;
}

export function getUseLoginShell() {
  return invoke<boolean>("use_login_shell_get");
}

export function setUseLoginShell(enabled: boolean) {
  return invoke<void>("use_login_shell_set", { enabled });
}

export function getWorktreeLocation() {
  return invoke<WorktreeLocation>("worktree_location_get");
}

export function setWorktreeLocation(location: WorktreeLocation) {
  return invoke<void>("worktree_location_set", { location });
}

export function getResearchLaunchInstruction() {
  return invoke<string>("research_launch_instruction_get");
}

export function setResearchLaunchInstruction(instruction: string) {
  return invoke<void>("research_launch_instruction_set", { instruction });
}

// Forks the session in `paneId` into a new tab immediately after it and resumes
// the session. `prompt` is submitted as the fork's launch message.
//
// `anchor` forks from a chosen message instead of the session head: the backend
// synthesizes a transcript ending just before it and resumes that. The anchor is
// resolved against the pane's own transcript, so it can only ever address that
// session's messages.
export function forkAgent(
  paneId: string,
  options?: {
    useWorktree?: boolean;
    worktreeName?: string;
    prompt?: string;
    anchor?: MessageAnchor;
  },
) {
  return invoke<PaneInfo>("agent_fork", {
    paneId,
    useWorktree: options?.useWorktree ?? false,
    worktreeName: options?.worktreeName,
    prompt: options?.prompt,
    anchor: options?.anchor,
  });
}

/** Marks/clears that the user is actively typing for an agent, so the backend holds
 *  off auto-draining its queue. Clearing drains a held turn if the agent is idle. */
export function setAgentTyping(agentId: string, typing: boolean) {
  return invoke<SendNextQueuedAgentTurnResult>("agent_set_typing", { agentId, typing });
}

/** Opens an http(s)/mailto URL in the user's default external browser/mail client. */
export function openExternalUrl(url: string) {
  return invoke<void>("open_external_url", { url });
}

/** Opens the source file behind a protected session preview as a validated file:// URL. */
export function browserOpenPreviewExternal(url: string) {
  return invoke<void>("browser_open_preview_external", { url });
}

type BrowserOpenLocalPathResult = {
  disposition: "preview" | "revealed";
  url: string | null;
  sandbox: boolean;
};

/** Safely open a local path: preview known renderable files in the sandboxed
 * overlay and reveal unknown/binary formats in the OS file manager. Relative
 * paths resolve against the pane's live cwd. */
export function browserOpenLocalPath(paneId: string, path: string, artifactId?: string) {
  return invoke<BrowserOpenLocalPathResult>("browser_open_local_path", {
    paneId,
    path,
    artifactId,
  });
}

/** Reveal a root-confined local path without opening or executing it. */
export function browserRevealLocalPath(paneId: string, path: string) {
  return invoke<void>("browser_reveal_local_path", { paneId, path });
}

/** Deliberately hand a root-confined local path to its OS default app. */
export function browserOpenLocalPathExternal(paneId: string, path: string) {
  return invoke<void>("browser_open_local_path_external", { paneId, path });
}

/** Resolve a Codex inline-visualization basename within the pane's own session
 * directory and open its fragment in the sandboxed browser overlay. */
export function browserOpenCodexInlineVisualization(paneId: string, file: string) {
  return invoke<{ url: string; sandbox: boolean }>(
    "browser_open_codex_inline_visualization",
    { paneId, file },
  );
}

/** Open an absolute fragment path from the current Codex visualization
 * content-reference contract after backend root confinement. */
export function browserOpenCodexVisualizationReference(paneId: string, path: string) {
  return invoke<{ url: string; sandbox: boolean }>(
    "browser_open_codex_visualization_reference",
    { paneId, path },
  );
}

export type HumanBrowserSnapshot = {
  ownerId: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
};

type HumanBrowserEvent = {
  ownerId: string;
  kind: "navigation" | "title" | "newWindow";
  url: string | null;
  title: string | null;
  loading: boolean | null;
};

type HumanBrowserSync = {
  ownerId: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  navigationRevision: number;
};

// Visibility belongs to one app-global native surface, so sync revisions order
// all geometry/show requests. The backend additionally tracks lifecycle order
// per owner so another pane's update cannot accidentally suppress a destroy.
let humanBrowserSurfaceRevision = 0;
let humanBrowserGeneration: Promise<number> | null = null;
const humanBrowserLifecycleQueue = new HumanBrowserLifecycleQueue();

function getHumanBrowserGeneration() {
  humanBrowserGeneration ??= invoke<number>("human_browser_generation");
  return humanBrowserGeneration;
}

export function syncHumanBrowser(request: HumanBrowserSync) {
  return humanBrowserLifecycleQueue.enqueue(() =>
    retryHumanBrowserLifecycle(async () => {
      humanBrowserSurfaceRevision += 1;
      const revision = humanBrowserSurfaceRevision;
      const generation = await getHumanBrowserGeneration();
      return invoke<HumanBrowserSnapshot | null>("human_browser_sync", {
        request: { ...request, generation, revision },
      });
    }),
  );
}

export function destroyHumanBrowser(ownerId: string) {
  return humanBrowserLifecycleQueue.enqueue(() =>
    retryHumanBrowserLifecycle(async () => {
      humanBrowserSurfaceRevision += 1;
      const revision = humanBrowserSurfaceRevision;
      const generation = await getHumanBrowserGeneration();
      return invoke<void>("human_browser_destroy", {
        request: { ownerId, generation, revision },
      });
    }),
  );
}

/** Collapse every native child. Returns how many views were hidden. */
export function hideAllHumanBrowsers() {
  return humanBrowserLifecycleQueue.enqueue(() =>
    retryHumanBrowserLifecycle(async () => {
      humanBrowserSurfaceRevision += 1;
      const revision = humanBrowserSurfaceRevision;
      const generation = await getHumanBrowserGeneration();
      return invoke<number>("human_browser_hide_all", {
        request: { generation, revision },
      });
    }),
  );
}

export async function getHumanBrowserSnapshot(ownerId: string) {
  const generation = await getHumanBrowserGeneration();
  return invoke<HumanBrowserSnapshot | null>("human_browser_snapshot", {
    request: { ownerId, generation },
  });
}

export function reloadHumanBrowser(ownerId: string) {
  return humanBrowserLifecycleQueue.enqueue(async () => {
    const generation = await getHumanBrowserGeneration();
    return invoke<void>("human_browser_reload", {
      request: { ownerId, generation },
    });
  });
}

export function navigateHumanBrowserHistory(ownerId: string, direction: "back" | "forward") {
  return humanBrowserLifecycleQueue.enqueue(async () => {
    const generation = await getHumanBrowserGeneration();
    return invoke<void>("human_browser_navigate_history", {
      request: { ownerId, generation },
      direction,
    });
  });
}

export function listenToHumanBrowserEvents(
  onEvent: (event: HumanBrowserEvent) => void,
): Promise<UnlistenFn> {
  return listen<HumanBrowserEvent>("human-browser-event", (event) => onEvent(event.payload));
}

export type BrowserAutomationSnapshot = {
  available: boolean;
  tabId: number | null;
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  imageDataUrl: string | null;
  width: number;
  height: number;
  error: string | null;
};

export function getBrowserAutomationSnapshot(
  paneId: string,
  width: number,
  height: number,
  scaleFactor: number,
) {
  return invoke<BrowserAutomationSnapshot>("browser_automation_snapshot", {
    paneId,
    width,
    height,
    scaleFactor,
  });
}

/** One mirrored frame pushed by Chromium's screencast, ready for an <img>. */
type BrowserScreencastFrame = {
  paneId: string;
  tabId: number;
  url: string;
  title: string;
  width: number;
  height: number;
  imageDataUrl: string;
};

/**
 * Start (or reconfigure) the pane's screencast and report the mirrored tab.
 * The backend only touches Chromium when the tab, size, or scale changed, so
 * this doubles as the overlay's metadata heartbeat.
 */
export function startBrowserScreencast(
  paneId: string,
  width: number,
  height: number,
  scaleFactor: number,
) {
  return invoke<BrowserAutomationSnapshot>("browser_automation_start_screencast", {
    paneId,
    width,
    height,
    scaleFactor,
  });
}

export function stopBrowserScreencast(paneId: string) {
  return invoke<void>("browser_automation_stop_screencast", { paneId });
}

export function listenToBrowserScreencastFrames(
  onFrame: (frame: BrowserScreencastFrame) => void,
): Promise<UnlistenFn> {
  return listen<BrowserScreencastFrame>("browser-screencast-frame", (event) =>
    onFrame(event.payload),
  );
}

export function navigateBrowserAutomation(paneId: string, url: string) {
  return invoke<void>("browser_automation_navigate", { paneId, url });
}

export function reloadBrowserAutomation(paneId: string) {
  return invoke<void>("browser_automation_reload", { paneId });
}

export function navigateBrowserAutomationHistory(
  paneId: string,
  direction: "back" | "forward",
) {
  return invoke<void>("browser_automation_navigate_history", { paneId, direction });
}

export function sendBrowserAutomationMouse(
  paneId: string,
  kind: "move" | "down" | "up" | "click" | "scroll",
  x: number,
  y: number,
  deltaX?: number,
  deltaY?: number,
  button?: "left" | "middle" | "right" | "none",
  buttons?: number,
  modifiers?: number,
) {
  return invoke<void>("browser_automation_mouse", {
    paneId,
    kind,
    x,
    y,
    deltaX: deltaX ?? null,
    deltaY: deltaY ?? null,
    button: button ?? null,
    buttons: buttons ?? null,
    modifiers: modifiers ?? null,
  });
}

export function insertBrowserAutomationText(paneId: string, text: string) {
  return invoke<void>("browser_automation_insert_text", { paneId, text });
}

export function sendBrowserAutomationKey(
  paneId: string,
  key: string,
  code: string,
  windowsVirtualKeyCode: number,
  modifiers = 0,
) {
  return invoke<void>("browser_automation_key", {
    paneId,
    key,
    code,
    windowsVirtualKeyCode,
    modifiers,
  });
}

export function setAgentDraft(agentId: string, draft: string) {
  return invoke<void>("agent_set_draft", { agentId, draft });
}

export function getAgentDraft(agentId: string) {
  return invoke<string | null>("agent_get_draft", { agentId });
}

export function getInterfaceDraft(key: string) {
  return invoke<string | null>("interface_draft_get", { key });
}

export function setInterfaceDraft(key: string, value: string | null) {
  return invoke<void>("interface_draft_set", { key, value });
}

export function acknowledgeAgent(agentId: string, includeFailed = false) {
  return invoke<AgentInfo>("agent_acknowledge", { agentId, includeFailed });
}

/**
 * Tells the backend the listener for this pane is live, flushing any PTY output
 * buffered before the webview subscribed (e.g. the cold-start prompt). Must be
 * called only after listenToEvents has resolved.
 */
export function attachPane(paneId: string) {
  return invoke<void>("pane_attach", { paneId });
}

/** Keep overlay transitions ordered across asynchronous native calls. */
let nativeBrowserOverlayUpdate: Promise<void> = Promise.resolve();
export function setNativeBrowserOverlayOpen(active: boolean) {
  nativeBrowserOverlayUpdate = nativeBrowserOverlayUpdate.catch(() => undefined)
    .then(() => invoke<void>("native_support_set_browser_overlay_open", { active }));
  return nativeBrowserOverlayUpdate;
}

/** Cross-document iframe keys never reach the app document's handlers. */
export function setNativeIframeShortcutFallback(active: boolean) {
  return invoke<void>("native_support_set_iframe_shortcut_fallback", { active });
}

let nativeBrowserBackgroundUpdate: Promise<void> = Promise.resolve();
export function setNativeBrowserBackground(red: number, green: number, blue: number) {
  nativeBrowserBackgroundUpdate = nativeBrowserBackgroundUpdate.catch(() => undefined)
    .then(() => invoke<void>("native_support_set_browser_background", { red, green, blue }));
  return nativeBrowserBackgroundUpdate;
}

export function paneActivity(paneId: string) {
  return invoke<PaneActivity>("pane_activity", { paneId });
}

export function killPane(paneId: string) {
  return invoke<void>("pane_kill", { paneId });
}

// Records the focused pane so the backend can pick a group's most-recently-active
// shell pane when resolving a spawn cwd. Best-effort; failures are ignored.
export function activatePane(paneId: string) {
  return invoke<void>("pane_activate", { paneId });
}

export function renamePane(paneId: string, title: string) {
  return invoke<PaneInfo>("pane_rename", { paneId, title });
}

/** Atomically sets the flat sidebar tab order in one call. */
export function setPaneLayout(items: PaneLayoutItem[]) {
  return invoke<PaneInfo[]>("pane_set_layout", { items });
}

/** Moves `paneId` immediately after `siblingPaneId` in the flat sidebar order. */
export function placePaneAfter(paneId: string, siblingPaneId: string) {
  return invoke<PaneInfo[]>("pane_place_after", { paneId, siblingPaneId });
}

export function getPaneSplits() {
  return invoke<PaneSplitInfo[]>("pane_splits_get");
}

export function setPaneSplits(splits: PaneSplitInfo[]) {
  return invoke<PaneSplitInfo[]>("pane_splits_set", { splits });
}

export function worktreeStatus(agentId: string) {
  return invoke<WorktreeStatus>("worktree_status", { agentId });
}

export function closeWorktreePane(agentId: string, deleteWorktree: boolean) {
  return invoke<void>("worktree_close_pane", { agentId, deleteWorktree });
}

export function confirmAppExit() {
  return invoke<void>("app_confirm_exit");
}

/** Arms (or releases) the macOS wake lock that keeps the machine awake. */
export function setPreventSleep(active: boolean) {
  return invoke<void>("app_set_prevent_sleep", { active });
}

export function listenToEvents(onEvent: (event: SessionEvent) => void): Promise<UnlistenFn> {
  return listen<SessionEvent>("session-event", (event) => onEvent(event.payload));
}

/**
 * Tells the backend the session-event subscription is live. Until then the native
 * shortcut classifiers decline to consume chords, since the events they emit
 * would be dropped with nobody listening. The backend clears the flag itself
 * on every page navigation.
 */
export function markEventsListenerReady() {
  return invoke<void>("mark_events_listener_ready");
}

/** Acknowledges the native post-wake document event-loop health probe. */
export function acknowledgeInterfaceHealthProbe(generation: number) {
  return invoke<void>("acknowledge_interface_health_probe", { generation });
}

/** Verify and reattach the existing remote session; never starts another shell. */
export function reconnectPane(paneId: string) {
  return invoke<void>("pane_reconnect", { paneId });
}

export function readResearchReport(path: string): Promise<string> {
  return invoke<string>("read_research_report", { path });
}

export function importResearchReport(request: {
  markdown: string;
  prompt: string;
  adapter: string;
  workspaceId: string;
}): Promise<ResearchTreeDetail> {
  return invoke<ResearchTreeDetail>("import_research_report", { request });
}
