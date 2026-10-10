import type { TweetSnapshot } from "./lib/tweets";

export type PaneKind = "shell" | "agent";

export interface RuntimeConfig {
  workspaceRoot: string;
  socketPath: string;
  adapters: AgentAdapterMetadata[];
  /** Machines a workspace can be created on. Empty means local-only. Pass a
   * choice's `id` as `remoteId` when creating a group to bind it there. */
  remotes: RemoteChoice[];
  // The user's home directory (empty if HOME is unset), used to render
  // home-relative paths as ~/… rather than bare relative segments.
  homeDir: string;
  // Port of the loopback file server, so the UI can recognize token-bearing file-server
  // URLs (see isFileServerUrl) and always sandbox them. Null until the server has bound.
  fileServerPort: number | null;
}

/** GitHub profile persisted after device-flow sign-in. `id` is the stable
 * identity; `login` can be renamed. */
export interface GithubAccount {
  id: number;
  login: string;
  name?: string;
  avatarUrl: string;
}

export interface GithubDeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresInSecs: number;
  intervalSecs: number;
}

export type GithubLoginPoll =
  | { status: "pending"; intervalSecs: number }
  | { status: "complete"; account: GithubAccount }
  | { status: "expired" }
  | { status: "denied" };

export interface AgentAdapterMetadata {
  id: string;
  label: string;
  default: boolean;
  /** Whether the adapter can fork a native terminal session. */
  supportsFork: boolean;
  /** Whether the adapter has a supported research runtime. */
  supportsResearch: boolean;
  /** Whether the adapter can run the isolated structured-output summary request. */
  supportsRecapGeneration: boolean;
  /** Whether the adapter can fork from a chosen message rather than the session
   * head. Gates the transcript's per-message fork action, which is hidden
   * rather than disabled for adapters without it. */
  supportsForkAtMessage: boolean;
  supportsRemote: boolean;
  configuredBinary: string;
  resolvedBinary: string | null;
  readiness: AgentReadiness;
  researchReadiness: AgentReadiness;
  message: string | null;
  version: string | null;
  auth: "authenticated" | "unauthenticated" | "unknown";
  checkedAt: number | null;
  loginCommand: string | null;
  installCommand: string | null;
  installUrl: string | null;
  updateCommand: string | null;
  instanceId: string;
  target: {
    kind: "local" | "remote";
    id: string | null;
    label: string;
  };
}

export type AgentReadiness =
  | "ready"
  | "missing"
  | "needsAuth"
  | "unsupportedVersion"
  | "error";

export interface PaneInfo {
  id: string;
  title: string;
  /** Last sanitized OSC 0/2 title reported by the terminal program. */
  lastOscTitle?: string | null;
  kind: PaneKind;
  agentId?: string | null;
  groupId: string;
  cwd: string;
  /** Display-only workspace observation for shell tabs (checkout kind, git
   * root, branch), resolved by the backend at spawn and on each shell prompt.
   * Agent tabs leave this unset and use AgentInfo.activeWorkspace instead. */
  activeWorkspace?: ActiveWorkspace | null;
  /** Durable coordinates of a session-owned tmux session on a remote host. */
  remoteSession?: RemoteSessionIdentity | null;
  /** Health of the disposable SSH attachment to a durable remote session. */
  remoteConnection?: RemoteConnectionInfo | null;
  /** SSH destination for a client session opened inside a local (or other)
   * group. Restart re-runs `ssh` to this host. */
  sshTarget?: string | null;
  cols: number;
  rows: number;
  status: "starting" | "running" | "exited" | "killed" | "failed";
  // Wall-clock millis when the pane was last focused. Stamped by the backend at
  // spawn and on activation; feeds the group spawn-cwd heuristic.
  lastActiveAt?: number;
  // True for panes recreated from persisted state after a Session restart.
  recovered?: boolean;
  // Deprecated compatibility field. Flat tab layouts always use zero.
  depth?: number;
}

export interface RemoteSessionIdentity {
  remoteId: string;
  tmuxServer: string;
  tmuxSession: string;
  supportDir?: string;
}

export type RemoteConnectionState =
  | "connecting"
  | "checking"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";

export interface RemoteConnectionInfo {
  state: RemoteConnectionState;
  startupStartedAt?: number | null;
  startupTimings?: Record<string, number>;
  hookHealth?: "checking" | "healthy" | "authenticationFailed" | "unavailable" | null;
  message?: string | null;
  stage?: string | null;
  reason?: string | null;
  attempt?: number;
  nextRetryAt?: number;
  disconnectedAt?: number;
  lastConnectedAt?: number;
  lastVerifiedAt?: number;
  recoveryDurationMs?: number;
  recoveryAction?: string | null;
  sessionExists?: boolean | null;
}

export type PaneSplitIntentSource = "command" | "join" | "drag-half" | "drag-divider";

export type PaneSplitIntentPosition = "above" | "below";

export type PaneSplitAxis = "vertical" | "horizontal";

export interface PaneSplitIntent {
  kind: "inserted-relative";
  anchorPaneId: string;
  position: PaneSplitIntentPosition;
  source: PaneSplitIntentSource;
  createdAt: number;
}

/** A single pane occupying a leaf of a nested split's layout tree. */
export interface PaneSplitPaneNode {
  kind: "pane";
  paneId: string;
  /** Fraction of the parent node along the parent's axis. Missing means equal share. */
  size?: number;
}

/** An interior node: two or more children laid out along `axis`. */
export interface PaneSplitBranchNode {
  kind: "split";
  axis: PaneSplitAxis;
  /** Fraction of the parent node along the parent's axis. Missing means equal share. */
  size?: number;
  children: PaneSplitNode[];
}

export type PaneSplitNode = PaneSplitPaneNode | PaneSplitBranchNode;

export interface PaneSplitInfo {
  id: string;
  paneIds: string[];
  sizes: Record<string, number>;
  intent?: Record<string, PaneSplitIntent>;
  /** Layout axis. Omitted or `vertical` is the stacked (top/bottom) default.
   * With a `root`, this mirrors the root node's axis. */
  axis?: PaneSplitAxis;
  /** Nesting structure over `paneIds`. Present only when the layout is actually
   * nested (depth >= 2); a flat split omits it and behaves exactly as before.
   * The tree's in-order leaves always equal `paneIds`, so tab order and geometry
   * cannot disagree. Older builds ignore this and render the flat run. */
  root?: PaneSplitNode;
}

export type PaneActivity =
  | {
      kind: "idle";
      processCount: 0;
      processSummary?: null;
    }
  | {
      kind: "runningProcess";
      processCount: number;
      processSummary?: string | null;
    };

export interface InitialPaneSize {
  cols: number;
  rows: number;
}

export type RemoteMultiplexer = "tmux" | "herdr";

/** An effective saved machine, from config or the UI-owned preferences store. */
export interface RemoteChoice {
  id: string;
  label: string;
  host: string;
  multiplexer: RemoteMultiplexer;
  sessionCli?: string | null;
  workspaceRoot?: string | null;
  source: "config" | "preferences";
  /** False for a multiplexer session cannot drive yet — list it, but don't offer
   * a launch that is going to fail. */
  usable: boolean;
}

export interface SavedRemote {
  host: string;
  label?: string | null;
  multiplexer: RemoteMultiplexer;
  sessionCli?: string | null;
  workspaceRoot?: string | null;
}

export interface RemoteProbeCheck {
  id: "ssh" | "tmux" | "sessionCli";
  label: string;
  status: "passed" | "failed" | "skipped";
  message: string;
}

export interface RemoteProbeResult {
  checks: RemoteProbeCheck[];
  adapters: AgentAdapterMetadata[];
}

/** The remote host a group is bound to. Mirrors Rust's `RemoteRef`. */
export interface RemoteRef {
  id: string;
  label: string;
  host: string;
  multiplexer: RemoteMultiplexer;
  /** How to invoke the Session CLI on that host; defaults to `session-cli`. */
  sessionCli?: string | null;
  /** Where agent worktrees live there. A group's `managedDir` is always local,
   * so a remote group needs somewhere on its own machine to put them. */
  workspaceRoot?: string | null;
}

export interface GroupInfo {
  id: string;
  name: string;
  nameOverride?: string | null;
  dir: string;
  managedDir: string;
  baseRepo?: string | null;
  baseRef?: string | null;
  parentId?: string | null;
  createdAt: number;
  collapsed: boolean;
  scope: "terminal" | "research";
  importedResearchArchiveId?: string | null;
  remote?: RemoteRef | null;
  agents: string[];
}

export interface AgentInfo {
  id: string;
  groupId: string;
  adapter: string;
  worktreeDir: string;
  branch?: string | null;
  /** Display-only command workspace observed from the live agent. Launch,
   * resume, fork, and cleanup continue to use worktreeDir/branch. */
  activeWorkspace?: ActiveWorkspace | null;
  paneId?: string | null;
  orphanedQueuePaneId?: string | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  threadId?: string | null;
  branchId?: string | null;
  /** Adapter-owned leaf within the agent's native session tree. This is not
   * session's thread-graph branch id and may change when the native agent forks. */
  nativeLeafId?: string | null;
  status:
    | "starting"
    | "running"
    | "awaitingInput"
    | "awaitingPermission"
    | "done"
    | "idle"
    | "failed";
  model?: string | null;
  /** Reasoning effort the session was launched with; absent for the default. */
  effort?: string | null;
  // True when auto-drain is held: pause-after, or the last turn failed /
  // interrupted / disconnected. Clears when the user unpauses.
  paused?: boolean;
  createdAt: number;
}

export interface ActiveWorkspace {
  cwd: string;
  gitRoot?: string | null;
  branch?: string | null;
  kind: "directory" | "gitCheckout" | "mainCheckout" | "linkedWorktree";
  source: "session" | "claude" | "codex";
  managedBySession: boolean;
}

export interface RepositoryWorktree {
  path: string;
  head: string;
  branch?: string | null;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface RepositoryBranch {
  name: string;
  fullRef: string;
  head: string;
  upstream?: string | null;
  remote: boolean;
  checkedOutPath?: string | null;
}

export interface RepositoryInventory {
  repositoryRoot: string;
  worktrees: RepositoryWorktree[];
  branches: RepositoryBranch[];
}

/** One artifact-tray entry: a file or loopback URL opened from an agent pane via
 * `session open`. File artifacts carry `path` (canonical, absolute) and are re-opened
 * through `browserOpenLocalPath`, which mints a fresh file-server URL; URL
 * artifacts carry the loopback `url` directly. */
export interface ArtifactInfo {
  id: string;
  groupId: string | null;
  paneId: string;
  path?: string | null;
  url?: string | null;
  createdAt: number;
}

export type ShellAgentJobState = "foreground" | "backgrounded" | "stopped";

export interface ShellAgentJobInfo {
  jobId: string;
  agentId: string;
  paneId: string;
  state: ShellAgentJobState;
}

export type ResearchNodeStatus =
  | "queued"
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

/** What produced a node's content: an agent run, user-authored markdown, a
 * terminal conversation exported as a severed point-in-time snapshot, or a
 * note (a user's question to their network, or a saved link) with no
 * response of its own. The backend omits the field for runs, so absence
 * means "run". */
export type ResearchNodeKind = "run" | "document" | "conversation" | "note";

export type NoteReplyAuthor =
  | { kind: "author" }
  | { kind: "member"; id: string; displayName: string; handle?: string | null };

export interface NoteReply {
  id: string;
  author: NoteReplyAuthor;
  /** Markdown. */
  body: string;
  /** Set on the note author's response to a member's top-level reply. */
  inReplyTo?: string | null;
  createdAt: number;
}

/** Network state of a note posted with Ask network. Nothing is transmitted
 * yet; `posted` records the user's intent. */
export interface NoteDelivery {
  status: "posted";
  postedAt: number;
  /** Chronological. Omitted by the backend when empty. */
  replies?: NoteReply[];
}

/** Provenance for content that did not come from a research launch. */
export type ResearchNodeOrigin = "terminalExport" | "imported";

export interface ResearchTweetAttachment {
  kind: "tweet";
  schemaVersion: 1;
  sourceUrl: string;
  tweetId: string;
  placement: "inline" | "trailing";
  provider: "xSyndication";
  status: "resolved" | "unavailable";
  attemptedAt: number;
  fetchedAt?: number;
  tweet?: TweetSnapshot;
  failure?: "timeout" | "notFound" | "invalidPayload" | "network";
}

export type ResearchMessageAttachment = ResearchTweetAttachment;

export interface ResearchTree {
  id: string;
  title: string;
  rootNodeId: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  lastViewedAt?: number | null;
  /** Home's Follow control; persisted on the thread. */
  followed?: boolean;
  /** Home's Bookmark control; persisted on the thread. */
  bookmarked?: boolean;
}

export interface ResearchNode {
  id: string;
  treeId: string;
  parentNodeId?: string | null;
  /** The passage of the parent's answer this follow-up was asked about. The
   * parent's answer marks it as the anchor of the branch. */
  queryAnchor?: ResearchHighlightAnchor | null;
  /** True when this follow-up continues its parent's conversation at the same
   * level (the same messages column) instead of opening a branch. At most one
   * existing inline child per node; absent means false. */
  inline?: boolean;
  prompt: string;
  attachments?: ResearchMessageAttachment[];
  /** Short generated title for breadcrumbs and menus; the document body still
   * shows the full prompt. */
  title?: string | null;
  adapter: string;
  model?: string | null;
  /** Reasoning effort the run launches with; inherited by follow-ups. */
  effort?: string | null;
  groupId: string;
  worktreeDir: string;
  nativeSessionId?: string | null;
  transcriptPath?: string | null;
  promptNativeId?: string | null;
  agentId?: string | null;
  paneId?: string | null;
  /** How the run executes. Absent means the historical hidden TUI pane. */
  runtime?: "pane" | "sdk" | null;
  /** The run agent's thread-graph record id, kept for backend reaping. */
  threadId?: string | null;
  kind?: ResearchNodeKind;
  /** Present on nodes whose content did not come from a research launch —
   * today, conversations exported from a terminal session. */
  origin?: ResearchNodeOrigin | null;
  /** Only on notes posted with Ask network. */
  delivery?: NoteDelivery | null;
  /** On a follow-up of a note: the id of the reply it was asked about. */
  replyAnchor?: string | null;
  status: ResearchNodeStatus;
  error?: string | null;
  /** Set when the durable response snapshot lands — the viewer's signal to
   * refetch content it may have read before the adapter finished flushing. */
  responseSnapshotAt?: number | null;
  recap?: ResearchRecap;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  /** Set when the node is starred: a starred follow-up or branch is listed
   * under its question in the feed. Never set on a root node. */
  promotedAt?: number | null;
  highlights: ResearchHighlight[];
}

export interface ResearchRecap {
  id?: string | null;
  text: string;
  responseRevision: string;
  generatedAt?: number | null;
  adapter?: string | null;
  model?: string | null;
  /** Absent for automatically generated summaries using the built-in default. */
  instructions?: string | null;
}

export interface ResearchRecapCandidate {
  id: string;
  text: string;
  responseRevision: string;
  generatedAt: number;
  adapter: string;
  model: string | null;
  instructions: string;
}

/** Compact research-root (run or note) history returned to Home's feed. */
export interface RecentResearchQuery {
  /** Direct child questions, included with Home feed roots. */
  children?: RecentResearchQuery[];
  nodeId: string;
  treeId: string;
  parentNodeId?: string | null;
  inline: boolean;
  prompt: string;
  /** Selected parent-answer text this follow-up replies to. */
  queryTarget?: string | null;
  attachments?: ResearchMessageAttachment[];
  title?: string | null;
  adapter: string;
  model?: string | null;
  origin?: ResearchNodeOrigin | null;
  /** Absent in hand-built fixtures; the backend always sends it. */
  kind?: ResearchNodeKind;
  /** A note's network state, with replies cut to the first five top-level
   * threads; `replyCount` is the full top-level count. */
  delivery?: NoteDelivery | null;
  replyCount?: number;
  replyAnchor?: string | null;
  /** Author of the reply `replyAnchor` names, as "Ana" or "You". */
  replyAnchorAuthor?: string | null;
  status: ResearchNodeStatus;
  /** Why the run failed. */
  error?: string | null;
  createdAt: number;
  /** Current answer recap, when one has been generated. */
  recap?: string | null;
  /** When the node was starred to be listed under its question in the feed. */
  promotedAt?: number | null;
  /** Non-inline edges between the tree root and this node: 0 for the root and
   * its inline follow-ups, 1 for a branch of the root, 2 for a branch of that. */
  branchDepth?: number;
  /** Root entries only: every starred node in the tree, in tree order. */
  promoted?: RecentResearchQuery[];
}

/** A user folder that groups research trees within one workspace. */
export interface ResearchFolder {
  id: string;
  name: string;
  workspaceId: string;
}

/** Folder records plus the tree → folder membership. Membership values are a
 * folder id or RESEARCH_DRAFTS_FOLDER_ID; `collapsed` holds folder ids and
 * the system tray ids whose Home trays are collapsed. */
export interface ResearchFolderState {
  folders: ResearchFolder[];
  membership: Record<string, string>;
  starred: string[];
  collapsed: string[];
}

/** An unsent question saved from the composer, scoped to one workspace. */
export interface ResearchDraft {
  id: string;
  workspaceId: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

export interface RecentResearchQueryCursor {
  createdAt: number;
  nodeId: string;
}

export interface ResearchHighlight {
  id: string;
  anchor: ResearchHighlightAnchor;
  createdAt: number;
}

export interface ResearchHighlightAnchor {
  version: 1;
  projection: "answer-v1";
  responseRevision: string;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

/** One saved highlight with its thread context, for the Highlights feed. */
export interface ResearchHighlightFeedItem {
  highlightId: string;
  nodeId: string;
  treeId: string;
  treeTitle: string;
  /** The highlighted node's title or prompt; the tree title for documents. */
  nodeLabel: string;
  exact: string;
  /** Surrounding context captured with the anchor, for excerpt display. */
  prefix: string;
  suffix: string;
  createdAt: number;
}

export interface ResearchTreeSummary {
  id: string;
  title: string;
  rootNodeId: string;
  /** The root node's kind — what this sidebar item fundamentally is. */
  kind: ResearchNodeKind;
  workspaceId: string;
  runningCount: number;
  failedCount: number;
  completedCount: number;
  cancelledCount: number;
  updatedAt: number;
  archivedAt?: number | null;
  followed?: boolean;
  bookmarked?: boolean;
  hasUnseenUpdate: boolean;
  /** A failure settled after the tree was last viewed. Attention flag —
   * viewing the tree acknowledges it — unlike failedCount, a lifetime total. */
  hasUnseenFailure: boolean;
}

export interface ResearchTreeDetail {
  tree: ResearchTree;
  nodes: ResearchNode[];
}

export interface ResearchBranchRemoval {
  treeId: string;
  parentNodeId: string;
  removedNodeIds: string[];
}

export interface ResearchNodeContent {
  node: ResearchNode;
  turns: Turn[];
  /** Why turns is empty for a finished node (snapshot and transcript both unavailable). */
  sourceError?: string;
  /** Present only when the displayed turns came from a durable full snapshot. */
  responseRevision?: string;
}

export interface UpdateResearchDocumentResult {
  tree: ResearchTree;
  node: ResearchNode;
  responseRevision: string;
  markdownChanged: boolean;
  removedHighlightCount: number;
}

// Where a queued turn is delivered when it is reached: absent means the agent's
// own composer; "fork" resumes the session into a new forked pane (optionally in a
// fresh worktree); "newSession" starts a fresh session in the same directory.
export type QueuedTurnDelivery =
  | { kind: "fork"; useWorktree?: boolean }
  | { kind: "newSession" };

export interface QueuedTurn {
  // Stable, unique identity assigned by the backend. Duplicate-text turns are
  // otherwise indistinguishable, so drag/mutation code keys and targets turns by
  // this id (and passes it as expectedId) rather than by index+text.
  id: string;
  text: string;
  pauseAfter: boolean;
  waitFor?: QueuedTurnWait | null;
  delivery?: QueuedTurnDelivery | null;
}

// A prompt queued application-wide before it has an owner — the home view's
// Drafts rail. Assigning it to an agent marks it consumed (kept as history)
// rather than deleting it.
export interface GlobalDraft {
  id: string;
  text: string;
  createdAt: number;
  consumed?: { agentId: string; at: number } | null;
}

export interface QueuedTurnWait {
  agentId: string;
  paneId?: string | null;
  label?: string | null;
}

export interface WaitTarget {
  agentId: string;
  paneId: string;
  label: string;
  status: AgentInfo["status"];
  queueCount?: number;
  queueBlocked?: boolean;
}

export type TurnBlock =
  | { type: "text"; text: string }
  | { type: "toolUse"; id?: string | null; name: string; input: unknown }
  | { type: "toolResult"; toolUseId?: string | null; content: unknown; isError: boolean }
  | { type: "raw"; value: unknown };

export interface Turn {
  id: string;
  agentId: string;
  sessionId?: string | null;
  role: string;
  blocks: TurnBlock[];
  sourceIndex: number;
  /** Milliseconds since the Unix epoch when the native transcript recorded
   * this turn; absent for adapters or records without time data. */
  timestamp?: number | null;
  participant?: ThreadParticipant | null;
  status?: "superseded" | "interrupted" | "uncertain" | null;
  statusReason?: "codexRollback" | "interrupted" | "claudePromptBranch" | "unknownBranch" | null;
  /** Active model-context membership is independent from execution outcome. */
  contextStatus?: "rolledBack" | null;
  nativeId?: string | null;
  parentNativeId?: string | null;
  nativeMessageId?: string | null;
}

/** Identifies the message a fork branches from. Mirrors the adapters' anchor:
 * Claude keys off the uuid chain, Codex off the transcript line index. */
export interface MessageAnchor {
  nativeId?: string | null;
  parentNativeId?: string | null;
  sourceIndex: number;
}

export interface ThreadGraph {
  version: 1;
  threadId: string;
  focusedBranchId: string;
  nextCreatedOrder: number;
  rootTurnIds: string[];
  branches: Record<string, ThreadBranch>;
  nodes: Record<string, ThreadNode>;
  conversationHistory?: ConversationHistoryRef | null;
  /** Legacy excerpts saved from assistant messages. Parsed so older graph
   * files still load; the UI no longer creates or displays them. */
  annotations?: TranscriptAnnotation[];
}

export interface ConversationHistoryRef {
  snapshotId: string;
}

export interface ConversationHistorySnapshot {
  id: string;
  adapter: string;
  turns: Turn[];
  previousSnapshotId?: string | null;
}

export interface TranscriptAnnotation {
  id: string;
  sourceTurnId: string;
  text: string;
  createdAt: number;
}

export interface ThreadBranch {
  id: string;
  threadId: string;
  parentBranchId?: string | null;
  baseTurnId?: string | null;
  createdFromTurnId?: string | null;
  headTurnIds: string[];
  label?: string | null;
  createdByAgentId?: string | null;
  createdByActorId?: string | null;
  createdAt: number;
  status: "active" | "archived";
}

export type ThreadNode = TurnNode | HandoffNode | BranchStartNode;

export interface BaseThreadNode {
  id: string;
  threadId: string;
  branchId: string;
  parentTurnIds: string[];
  participant: ThreadParticipant;
  createdAt: number;
  createdOrder: number;
  status?: "active" | "superseded" | "interrupted" | "uncertain" | null;
  statusReason?: "codexRollback" | "interrupted" | "claudePromptBranch" | "unknownBranch" | null;
  contextStatus?: "rolledBack" | null;
}

export interface TurnNode extends BaseThreadNode {
  kind: "turn";
  turn: {
    role: string;
    blocks: TurnBlock[];
    sourceIndex?: number | null;
    timestamp?: number | null;
  };
  native?: NativeTurnRef | null;
}

export interface HomeTurnSummary {
  id: string;
  text: string;
  settledAt: number | null;
}

export interface HomeTurnHistoryPage {
  turns: HomeTurnSummary[];
  /** Turn id cursor for the next older page (pass as `before` to listHomeTurnHistory). */
  nextBefore: string | null;
}

export interface HandoffNode extends BaseThreadNode {
  kind: "handoff";
  participant: { kind: "session"; actorId: "session"; label: "session" };
  handoff: HandoffPayload;
}

export interface BranchStartNode extends BaseThreadNode {
  kind: "branchStart";
  participant: { kind: "session"; actorId: "session"; label: "session" };
  branchStart: {
    parentBranchId?: string | null;
    baseTurnId?: string | null;
    targetBranchId: string;
  };
}

export interface ThreadParticipant {
  kind: "user" | "assistant" | "session";
  actorId: string;
  adapter?: string | null;
  agentId?: string | null;
  label?: string | null;
}

export interface HandoffPayload {
  sourceAgentId: string;
  sourceAdapter: string;
  sourceBranchId: string;
  sourceTurnId: string;
  targetAgentId: string;
  targetAdapter: string;
  targetBranchId: string;
  contextPath: string;
}

export interface NativeTurnRef {
  adapter: string;
  agentId: string;
  sessionId?: string | null;
  transcriptPath?: string | null;
  nativeId?: string | null;
  parentNativeId?: string | null;
  nativeMessageId?: string | null;
  sourceIndex: number;
}

// A selectable past/parallel session for the right pane's transcript picker, used
// to correct an agent that auto-recovered onto the wrong session file.
export interface TranscriptOption {
  path: string;
  sessionId?: string | null;
  modifiedMs: number;
  preview?: string | null;
  lineCount: number;
  // The transcript the agent is currently bound to.
  isActive: boolean;
  // Another agent is tailing this file; selecting it would collide.
  boundToOtherAgent: boolean;
}

// Where a saved prompt lives: "global" is ~/.session/prompts/ (visible from every
// workspace), "project" is <workspaceRoot>/.session/prompts/ (this workspace only).
export type PromptScope = "global" | "project";

// A reusable composer message from the prompt library. Backed by a markdown file
// whose filename stem is the name; see PromptScope for where it lives. Prompts
// are titleless in the UI — the name is derived from the content's first line
// and only surfaces as the filename on disk.
export interface SavedPrompt {
  name: string;
  content: string;
  modifiedMs: number;
  scope: PromptScope;
}

export interface PromptLibrary {
  prompts: SavedPrompt[];
  // False when the workspace root is the home directory, making the two scopes
  // one folder — the UI then collapses to a single Global section.
  hasProjectScope: boolean;
}

export interface WorktreeStatus {
  hasChanges: boolean;
  changedFiles: number;
}

export type SubmitAgentTurnMode = "auto" | "send" | "queue" | "steer";

export interface SubmitAgentTurnResult {
  queued: boolean;
  pendingTurns: number;
  queuedTurns: QueuedTurn[];
}

export interface RemoveQueuedAgentTurnResult {
  removedTurn: string;
  pendingTurns: number;
  queuedTurns: QueuedTurn[];
}

export interface ReorderQueuedAgentTurnResult {
  pendingTurns: number;
  queuedTurns: QueuedTurn[];
}

export interface SendNextQueuedAgentTurnResult {
  sent: boolean;
  pendingTurns: number;
  queuedTurns: QueuedTurn[];
}

export interface MoveQueuedAgentTurnResult {
  sent: boolean;
  sourceQueuedTurns: QueuedTurn[];
  targetQueuedTurns: QueuedTurn[];
}

export interface TranscriptHookEvent {
  type: string;
  paneId?: string | null;
  agentId: string;
  hookEvent: string;
  payload: unknown;
  timestamp: number;
}

export interface TranscriptCopyPayload {
  version: 1;
  exportedAt: string;
  agent: AgentInfo;
  pane: PaneInfo;
  transcriptText: string;
  turns: Turn[];
  hooks: TranscriptHookEvent[];
}

export interface SessionEvent {
  type: string;
  paneId?: string | null;
  agentId?: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
}
