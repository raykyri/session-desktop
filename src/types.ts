import type { TweetSnapshot } from "./lib/tweets";

export interface RuntimeConfig {
  workspaceRoot: string;
  socketPath: string;
  adapters: AgentAdapterMetadata[];
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
  /** Whether the adapter has a supported research runtime. */
  supportsResearch: boolean;
  /** Whether the adapter can run the isolated structured-output summary request. */
  supportsRecapGeneration: boolean;
  configuredBinary: string;
  resolvedBinary: string | null;
  readiness: AgentReadiness;
  researchReadiness: AgentReadiness;
  message: string | null;
  version: string | null;
  auth: "authenticated" | "unauthenticated" | "unknown";
  /** Why sign-in could not be verified when `auth` is "unknown" after a
   * probe: the status command failed or its output was not recognized. */
  authDetail?: string | null;
  checkedAt: number | null;
  loginCommand: string | null;
  installCommand: string | null;
  installUrl: string | null;
  updateCommand: string | null;
  instanceId: string;
  target: {
    kind: "local";
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
  sessionId?: string | null;
  transcriptPath?: string | null;
  threadId?: string | null;
  branchId?: string | null;
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

export type ResearchNodeStatus =
  | "queued"
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

/** A node's type, the tag of its body: a post (written by the user and shown
 * as a note: text, a saved link or an X post), an exchange (a question and
 * the agent run that answers it), or a document (long-form content with no
 * run: an imported report, an authored document, or an exported terminal
 * transcript). */
export type ResearchNodeType = "post" | "exchange" | "document";

/** Where a document's content came from. */
export type DocumentSource = "imported" | "authored" | "transcript";

/** How a post renders, decided by the backend when its text is written:
 * "link" when the whole text is one http(s) URL (a saved link, or an X post
 * with its tweet attachment), "text" otherwise. */
export type PostFormat = "text" | "link";

/** What a follow-up was asked about in its parent: a passage of the parent's
 * answer or document, or a stored reply on the parent post (no longer
 * created; replies are not shown). */
export type NodeAnchor =
  | { kind: "passage"; anchor: ResearchHighlightAnchor }
  | { kind: "reply"; replyId: string };

export type PostReplyAuthor =
  | { kind: "author" }
  | { kind: "member"; id: string; displayName: string; handle?: string | null };

export interface PostReply {
  id: string;
  author: PostReplyAuthor;
  /** Markdown. */
  body: string;
  /** Set on the post author's response to a member's top-level reply. */
  inReplyTo?: string | null;
  createdAt: number;
}

/** Sharing state of a post. A post with a delivery record is shared with
 * other users; one without is private. The desktop app creates notes without
 * one and does not show replies; posts written by earlier builds with "Post
 * to network" keep theirs. Nothing is transmitted; `posted` records the
 * intent. */
export interface PostDelivery {
  status: "posted";
  postedAt: number;
  /** Chronological. Omitted by the backend when empty. */
  replies?: PostReply[];
}


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

/** An image pasted or dropped into a composer. `id` names its file in the
 * backend's research image store (src-tauri/src/research_images.rs). */
export interface ResearchImageAttachment {
  kind: "image";
  id: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  fileName?: string;
}

export type ResearchMessageAttachment = ResearchTweetAttachment | ResearchImageAttachment;

export interface ResearchTree {
  id: string;
  title: string;
  rootNodeId: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  /** When the tree was moved to the Trash; trees in the Trash are left out of
   * every list but the Trash's own. */
  trashedAt?: number | null;
  lastViewedAt?: number | null;
}

/** What a person wrote: a post's text, an exchange's question, or the
 * question an imported report answers. */
export interface UserMessage {
  /** Markdown, or a single URL for a link post. */
  text: string;
  /** Omitted by the backend when empty. */
  attachments?: ResearchMessageAttachment[];
}

/** An exchange's agent, or the default agent for a post's or document's AI
 * follow-ups; follow-ups inherit model and effort. */
export interface AgentSpec {
  adapter: string;
  model?: string | null;
  effort?: string | null;
}

/** An exchange's run. The backend stores the session, agent, and pane binding;
 * these flags describe the state needed by the interface. */
export interface RunState {
  status: ResearchNodeStatus;
  error?: string | null;
  /** The failure's kind, when Session recognized it: "auth" for an agent
   * that is not signed in. Absent for other errors. */
  errorKind?: "auth" | null;
  startedAt?: number | null;
  completedAt?: number | null;
  /** Set after the durable response snapshot is written so viewers can refetch
   * content they may have read before the adapter finished flushing. */
  responseSnapshotAt?: number | null;
  /** The native session was recorded, so a follow-up can fork it. */
  sessionReady: boolean;
}

/** The fields every node shares. */
interface ResearchNodeBase {
  id: string;
  treeId: string;
  parentNodeId?: string | null;
  /** True when this follow-up continues its parent's conversation at the same
   * level (the same messages column) instead of opening a branch. At most one
   * existing inline child per node. Optional in hand-built fixtures. */
  inline?: boolean;
  /** What this follow-up was asked about in its parent. A passage anchor is
   * marked in the parent's answer as the anchor of the branch. */
  anchor?: NodeAnchor | null;
  /** Short generated title for breadcrumbs and menus; the message stays the
   * displayed text. */
  title?: string | null;
  /** The workspace the node was created in; the tree's is authoritative. */
  groupId: string;
  createdAt: number;
  highlights: ResearchHighlight[];
  /** On the first node of an inline chain: the order its messages column
   * lists the chain in, set by reordering the column. Display only; see
   * `chainDisplayOrder`. Absent: oldest first. */
  chainOrder?: string[];
}

/** A post node is shown as a note: text or a saved link the user wrote. Its
 * children are AI follow-ups (exchanges) and follow-up notes (posts). The
 * stored type stays `post`. */
export interface ResearchPostNode extends ResearchNodeBase {
  type: "post";
  message: UserMessage;
  format: PostFormat;
  /** Only on shared posts (see PostDelivery). */
  delivery?: PostDelivery | null;
  /** Default agent for AI follow-ups; not provenance. */
  followUpAgent: AgentSpec;
  /** When the text was last replaced by an edit. */
  editedAt?: number | null;
}

export interface ResearchExchangeNode extends ResearchNodeBase {
  type: "exchange";
  message: UserMessage;
  agent: AgentSpec;
  run: RunState;
  recap?: ResearchRecap | null;
}

export interface ResearchDocumentNode extends ResearchNodeBase {
  type: "document";
  /** The question an imported report answers, or a transcript's first user
   * turn; absent for an authored document. Authored documents and
   * transcripts show as one row (see nodeMessage). */
  message?: UserMessage | null;
  source: DocumentSource;
  /** The agent that produced an imported report or a transcript. */
  followUpAgent?: AgentSpec | null;
  /** Set when the body's snapshot was last written. */
  responseSnapshotAt?: number | null;
  recap?: ResearchRecap | null;
  /** When the body was last replaced by an edit. */
  editedAt?: number | null;
}

/** A research node as commands and events send it (`ResearchNodeView`). */
export type ResearchNode = ResearchPostNode | ResearchExchangeNode | ResearchDocumentNode;

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

/** Compact research-root (run or post) history returned to Home's feed. */
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
  /** Absent in hand-built fixtures; the backend always sends it. */
  type?: ResearchNodeType;
  /** A document's source. */
  source?: DocumentSource | null;
  /** A post's format. */
  format?: PostFormat | null;
  /** A post's sharing state, with replies cut to the first five top-level
   * threads; `replyCount` is the full top-level count. */
  delivery?: PostDelivery | null;
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
}

/** A user folder that groups research trees within one workspace. */
export interface ResearchFolder {
  id: string;
  name: string;
  workspaceId: string;
  /** When the folder was moved to the Trash. Trees filed in it keep their
   * membership, so they return to it on Restore; until then they show as
   * Unfiled. */
  trashedAt?: number | null;
}

/** Folder records plus the tree → folder membership. Membership values are a
 * folder id or RESEARCH_DRAFTS_FOLDER_ID; `collapsed` holds folder ids and
 * the system tray ids whose Home trays are collapsed. `parents` maps a child
 * tree to the question, document or post it is listed under (one level deep), and
 * `collapsedGroups` holds the parents whose children are hidden. The backend
 * omits the last two when empty; the API layer fills them in. */
export interface ResearchFolderState {
  folders: ResearchFolder[];
  membership: Record<string, string>;
  collapsed: string[];
  parents: Record<string, string>;
  collapsedGroups: string[];
}

/** An unsent question saved from the composer, scoped to one workspace. */
export interface ResearchDraft {
  id: string;
  workspaceId: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  /** Image attachments only. Omitted by the backend when empty. */
  attachments?: ResearchMessageAttachment[];
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
  /** The root node's type — what this sidebar item fundamentally is. */
  type: ResearchNodeType;
  workspaceId: string;
  runningCount: number;
  failedCount: number;
  completedCount: number;
  cancelledCount: number;
  updatedAt: number;
  archivedAt?: number | null;
  /** Set only in the Trash's list (listResearchTrash). */
  trashedAt?: number | null;
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
  /** Branches created from a passage whose quote is not in the new body; they
   * keep their anchors. */
  unmatchedBranchCount: number;
}

export interface UpdateResearchPostResult {
  tree: ResearchTree;
  node: ResearchNode;
  removedHighlightCount: number;
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

export interface ThreadParticipant {
  kind: "user" | "assistant" | "session";
  actorId: string;
  adapter?: string | null;
  agentId?: string | null;
  label?: string | null;
}

export interface SessionEvent {
  type: string;
  paneId?: string | null;
  agentId?: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
}
