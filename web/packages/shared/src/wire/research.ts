// Research wire types: trees, nodes, folders, drafts and the payloads that
// carry them. The desktop backend serializes these (src-tauri/src/research.rs,
// `ResearchNodeView` and its neighbours), so every field here must stay
// compatible with what it sends. The web server sends the same shapes; the
// few fields only the web sends are marked "Web only" and are optional, so
// the desktop never has to produce them.
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
  /** Web only: who saved the highlight; null once their account is gone.
   * The desktop has one person and omits it. */
  authorId?: string | null;
}

/** Web only: a person's role in a shared thread. `owner` is the thread's
 * creator; a signed-in reader of a public thread who is not a member is a
 * `viewer`. */
export type ResearchTreeRole = "owner" | "commenter" | "viewer";

/** Web only: who archived a thread for the reader. `owner`: its owner did
 * (only they can unarchive it); `me`: the reader's own Archive. */
export type ResearchTreeArchivedBy = "owner" | "me";

/** Web only: `public` threads are readable by anyone, guests included, and
 * listed in the All Users feed; `private` threads by their owner and the
 * people they are shared with. */
export type ResearchTreeVisibility = "private" | "public";

/** Web only: someone who wrote in, or is a member of, a shared thread. */
export interface ResearchParticipant {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
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
  /** `xSyndication` is the full payload (media, quotes, cards, counts).
   * `xOembed` is the reduced one the web server falls back to when
   * syndication refuses a post: author, text and date only. The desktop only
   * produces `xSyndication`. */
  provider: "xSyndication" | "xOembed";
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
  /** Web only: the thread's owner. */
  ownerId?: string;
  /** Web only. */
  visibility?: ResearchTreeVisibility;
  /** Web only: the reader's role. `archivedAt`, `trashedAt` and
   * `lastViewedAt` are the reader's own: a member's Archive and Trash are
   * per person, and the owner's Trash hides the thread from everyone else. */
  role?: ResearchTreeRole;
  /** Web only: who moved the thread to the Trash, while it is there. */
  trashedBy?: string | null;
  /** Web only, per reader: who archived the thread for them, while it is
   * archived for them. `owner`: its owner did, and only the owner can
   * unarchive it; `me`: the reader's own Archive. */
  archivedBy?: ResearchTreeArchivedBy;
  /** Web only: whether the reader follows the thread (gets notifications
   * for it). */
  followed?: boolean;
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
  /** The native session was recorded, so a follow-up can fork it. The web
   * stores the conversation when the run completes, so it sets this once the
   * status is `complete`. */
  sessionReady: boolean;
  /** Web only: 1 for the first run; incremented by Retry and by auto-resume. */
  attempt?: number;
  /** Web only: the opening of the answer, for compact cards. */
  responsePreview?: string | null;
  /** Web only, on an `interrupted` run: true while the server still intends
   * to resume it, false once it gave up. An interrupted run that will not be
   * resumed is settled for every purpose except its status name: it can be
   * retried, rerun, or deleted like a failed run. */
  resumePending?: boolean;
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
  /** The workspace the node was created in; the tree's is authoritative.
   * The desktop's name for it; the web sends its workspace id here. */
  groupId: string;
  createdAt: number;
  highlights: ResearchHighlight[];
  /** On the first node of an inline chain: the order its messages column
   * lists the chain in, set by reordering the column. Display only; see
   * `chainDisplayOrder`. Absent: oldest first. */
  chainOrder?: string[];
  /** Web only: who wrote the node (asked the question, wrote the note or
   * document); null once their account is gone. The desktop omits it. */
  authorId?: string | null;
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
  /** Web only: who made that edit. */
  editedBy?: string | null;
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
  /** Web only: who made that edit. */
  editedBy?: string | null;
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
  /** Web only: who saved the highlight; null when their account is gone. */
  authorId?: string | null;
  /** Web only: the reader's role in the highlight's thread. The owner may
   * remove any highlight, others only their own. */
  role?: ResearchTreeRole;
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
  /** Web only: the thread's owner. */
  ownerId?: string;
  /** Web only. */
  visibility?: ResearchTreeVisibility;
  /** Web only: the reader's role (`ResearchTree.role`). */
  role?: ResearchTreeRole;
  /** Web only: `ResearchTree.archivedBy`. */
  archivedBy?: ResearchTreeArchivedBy;
}

export interface ResearchTreeDetail {
  tree: ResearchTree;
  nodes: ResearchNode[];
  /** The follow-ups waiting in the queue (the web server's, or the
   * desktop backend's), keyed by the head of the inline chain each
   * continues, in send order. Chains with no queued follow-up are absent. */
  queues?: Record<string, ResearchFollowupQueueItem[]>;
  /** Web only: the owner, the members, and everyone who wrote a node or a
   * highlight in the thread, for author attribution. */
  participants?: ResearchParticipant[];
}

/** A follow-up asked at the end of an inline chain while the chain could
 * not take it (its last answer was still running), stored by the web server
 * or the desktop backend and sent in order as the chain frees up. */
export interface ResearchFollowupQueueItem {
  id: string;
  treeId: string;
  /** The first node of the inline chain the follow-up continues. */
  headNodeId: string;
  /** Web only: who asked; the run is billed to them when the item is sent.
   * The desktop omits it. */
  authorId?: string;
  message: UserMessage;
  /** The agent the follow-up runs on once sent. */
  agent: AgentSpec;
  position: number;
  createdAt: number;
  /** Why the server refused the last send (a daily limit, a model that is no
   * longer available). The chain's queue waits on this item until it is
   * retried or cancelled. */
  failedReason: string | null;
}

export interface ResearchBranchRemoval {
  treeId: string;
  parentNodeId: string;
  removedNodeIds: string[];
  /** Web only: who removed the branch. */
  removedBy?: string;
}

export interface ResearchNodeContent {
  node: ResearchNode;
  turns: Turn[];
  /** Why turns is empty for a finished node (snapshot and transcript both unavailable). */
  sourceError?: string;
  /** Present only when the displayed turns came from a durable full snapshot. */
  responseRevision?: string;
  /** Web only: text streamed since the last committed turn, for the live
   * tail. Absent once the run completes. */
  inFlightText?: string;
  /** Web only: the node sequence number this content was read at. A client
   * applies only run events with a greater `seq` and refetches on a gap. */
  seq?: number;
  /** Web only: 1-based place in the admission queue while the run is
   * `queued`. */
  queuePosition?: number;
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
