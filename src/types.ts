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
  createdAt: number;
  scope: "terminal" | "research";
  importedResearchArchiveId?: string | null;
  agents: string[];
}

export interface AgentInfo {
  id: string;
  groupId: string;
  adapter: string;
  worktreeDir: string;
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

// The research wire model (trees, nodes, folders, drafts, turns, events) is
// defined in web/packages/shared/src/wire and shared with the web app. It is
// re-exported here so desktop modules keep importing it from "../types".
export type {
  AgentSpec,
  DocumentSource,
  MessageAnchor,
  NodeAnchor,
  PostFormat,
  RecentResearchQuery,
  RecentResearchQueryCursor,
  ResearchBranchRemoval,
  ResearchDocumentNode,
  ResearchDraft,
  ResearchExchangeNode,
  ResearchFolder,
  ResearchFolderState,
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchHighlightFeedItem,
  ResearchImageAttachment,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchNodeContent,
  ResearchNodeStatus,
  ResearchNodeType,
  ResearchPostNode,
  ResearchRecap,
  ResearchRecapCandidate,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
  ResearchTweetAttachment,
  RunState,
  SessionEvent,
  ThreadParticipant,
  Turn,
  TurnBlock,
  UpdateResearchDocumentResult,
  UpdateResearchPostResult,
  UserMessage,
} from "@session/shared/wire";
