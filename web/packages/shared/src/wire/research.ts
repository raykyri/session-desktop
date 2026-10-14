// Research wire types: trees, nodes, folders, drafts and the payloads that
// carry them. The desktop backend serializes these (src-tauri/src/research.rs,
// `ResearchNodeView` and its neighbours), so every field here must stay
// compatible with what it sends. The web adopts the same envelope in phase 2
// and replaces its flat `types/research.ts` with it.
//
// Optional fields are written `?: T | null`, as the backend omits or nulls
// them. Values arrive as JSON, which has no `undefined`.

import type { Turn } from "./turn.js";
import type { TweetSnapshot } from "./tweet.js";

/** `queued → starting → running → complete | failed | cancelled`. The desktop
 * backend sends the first six (`ResearchNodeStatus` in research.rs).
 * `interrupted` is the web's: a deploy or crash stopped an admitted run that
 * the server resumes. */
export type ResearchNodeStatus =
  "queued" | "starting" | "running" | "complete" | "failed" | "cancelled" | "interrupted";

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

export interface ResearchHighlightAnchor {
  version: 1;
  projection: "answer-v1";
  responseRevision: string;
  /** UTF-16 code-unit offsets into the `answer-v1` projection. */
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

export interface ResearchHighlight {
  id: string;
  anchor: ResearchHighlightAnchor;
  createdAt: number;
}

/** What a follow-up was asked about in its parent: a passage of the parent's
 * answer or document. */
export type NodeAnchor = { kind: "passage"; anchor: ResearchHighlightAnchor };

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

/** The fields every node shares. */
export interface ResearchNodeBase {
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

/** Compact research-root (run or post) history returned to Home's feed. The
 * desktop also builds entries from nodes in the client (`lib/activity.ts`),
 * where the fields marked `| undefined` can hold `undefined`. */
export interface RecentResearchQuery {
  /** Direct child questions, included with Home feed roots. */
  children?: RecentResearchQuery[] | undefined;
  nodeId: string;
  treeId: string;
  parentNodeId?: string | null | undefined;
  inline: boolean;
  prompt: string;
  /** Selected parent-answer text this follow-up replies to. */
  queryTarget?: string | null | undefined;
  attachments?: ResearchMessageAttachment[];
  title?: string | null | undefined;
  adapter: string;
  model?: string | null | undefined;
  /** Absent in hand-built fixtures; the backend always sends it. */
  type?: ResearchNodeType;
  /** A document's source. */
  source?: DocumentSource | null;
  /** A post's format. */
  format?: PostFormat | null;
  status: ResearchNodeStatus;
  /** Why the run failed. */
  error?: string | null;
  createdAt: number;
  /** Current answer recap, when one has been generated. */
  recap?: string | null | undefined;
}

export interface RecentResearchQueryCursor {
  createdAt: number;
  nodeId: string;
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
 * folder id or the drafts tray id (`RESEARCH_DRAFTS_FOLDER_ID`); `collapsed`
 * holds folder ids and the system tray ids whose Home trays are collapsed.
 * `parents` maps a child tree to the question, document or post it is listed
 * under (one level deep), and `collapsedGroups` holds the parents whose
 * children are hidden. The desktop backend omits the last two when empty; the
 * desktop API layer fills them in. */
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
  /** Set only in the Trash's list. */
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
