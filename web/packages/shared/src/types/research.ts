// Research wire types, ported from the desktop `src/types.ts` with the
// modifications in `docs/02-domain-model-and-database.md` §2: the terminal-era
// fields (`worktreeDir`, `agentId`, `paneId`, `runtime`, `threadId`,
// `transcriptPath`, `nativeSessionId`, `promptNativeId`, `effort`) are gone,
// `groupId` is `workspaceId`, `adapter` is `model` and holds a registry id
// (`models/registry.ts`), and runs carry an `attempt` counter and the ids of
// the documents attached to them.
//
// Each type is defined by its zod schema and the TypeScript type is inferred
// from it, so the validator and the type cannot drift. Schemas are applied at
// every trust boundary: JSON columns in `db`, tRPC inputs, and event payloads.

import { z } from "zod";

import { turnSchema } from "./turn.js";
import { tweetSnapshotSchema } from "./tweet.js";

/** `queued → running → complete | failed | cancelled | interrupted`. The
 * desktop's `starting` is gone (the web loop has no process to spawn);
 * `interrupted` is new and means a deploy or crash stopped an admitted run
 * that will be resumed. */
export const researchNodeStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

export type ResearchNodeStatus = z.infer<typeof researchNodeStatusSchema>;

/** What produced a node's content: an agent run, or user-authored markdown.
 * The desktop's `conversation` kind existed only for terminal exports. The
 * server omits the field for runs, so absence means "run". */
export const researchNodeKindSchema = z.enum(["run", "document"]);

export type ResearchNodeKind = z.infer<typeof researchNodeKindSchema>;

/** Provenance for content that did not come from a research launch. */
export const researchNodeOriginSchema = z.enum(["imported"]);

export type ResearchNodeOrigin = z.infer<typeof researchNodeOriginSchema>;

export const researchHighlightAnchorSchema = z.object({
  version: z.literal(1),
  projection: z.literal("answer-v1"),
  responseRevision: z.string(),
  /** UTF-16 code-unit offsets into the `answer-v1` projection. Constrained
   * here rather than only in `validateHighlightAnchor`, which inherited the
   * desktop's checks but not its `usize` offsets: a negative or fractional
   * pair can satisfy every one of those checks (`start >= end` is false,
   * `end - start === exact.length` holds) and reach storage. Parsing runs at
   * the tRPC boundary ahead of the validator, so the validator's own message
   * order is untouched. */
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
});

export type ResearchHighlightAnchor = z.infer<typeof researchHighlightAnchorSchema>;

export const researchHighlightSchema = z.object({
  id: z.string(),
  anchor: researchHighlightAnchorSchema,
  createdAt: z.number(),
});

export type ResearchHighlight = z.infer<typeof researchHighlightSchema>;

/** One saved highlight with its thread context, for the Highlights feed. */
export const researchHighlightFeedItemSchema = z.object({
  highlightId: z.string(),
  nodeId: z.string(),
  treeId: z.string(),
  treeTitle: z.string(),
  /** The highlighted node's title or prompt; the tree title for documents. */
  nodeLabel: z.string(),
  exact: z.string(),
  /** Surrounding context captured with the anchor, for excerpt display. */
  prefix: z.string(),
  suffix: z.string(),
  createdAt: z.number(),
});

export type ResearchHighlightFeedItem = z.infer<typeof researchHighlightFeedItemSchema>;

export const researchRecapSchema = z.object({
  id: z.string().nullish(),
  text: z.string(),
  responseRevision: z.string(),
  generatedAt: z.number().nullish(),
  model: z.string().nullish(),
  /** Absent for automatic summaries using the built-in default. */
  instructions: z.string().nullish(),
});

export type ResearchRecap = z.infer<typeof researchRecapSchema>;

export const researchRecapCandidateSchema = z.object({
  id: z.string(),
  text: z.string(),
  responseRevision: z.string(),
  generatedAt: z.number(),
  model: z.string(),
  instructions: z.string(),
});

export type ResearchRecapCandidate = z.infer<typeof researchRecapCandidateSchema>;

/** Which pipeline produced the snapshot. `xSyndication` is the full payload
 * the desktop reads (media, quotes, cards, counts); `xOembed` is the reduced
 * one the publish endpoint returns when syndication refuses, and carries only
 * author, text, and date (`journal/oembed.ts`). Stored so a card can be told
 * apart from a full one later without refetching it. */
export const tweetAttachmentProviderSchema = z.enum(["xSyndication", "xOembed"]);

export type TweetAttachmentProvider = z.infer<typeof tweetAttachmentProviderSchema>;

export const researchTweetAttachmentSchema = z.object({
  kind: z.literal("tweet"),
  schemaVersion: z.literal(1),
  sourceUrl: z.string(),
  tweetId: z.string(),
  placement: z.enum(["inline", "trailing"]),
  provider: tweetAttachmentProviderSchema,
  status: z.enum(["resolved", "unavailable"]),
  attemptedAt: z.number(),
  fetchedAt: z.number().optional(),
  tweet: tweetSnapshotSchema.optional(),
  failure: z.enum(["timeout", "notFound", "invalidPayload", "network"]).optional(),
});

export const researchMessageAttachmentSchema = researchTweetAttachmentSchema;

export type ResearchMessageAttachment = z.infer<typeof researchMessageAttachmentSchema>;

export const researchTreeSchema = z.object({
  id: z.string(),
  title: z.string(),
  rootNodeId: z.string(),
  workspaceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullish(),
  lastViewedAt: z.number().nullish(),
  /** Home's Follow control; persisted on the thread. */
  followed: z.boolean().optional(),
  /** Home's Bookmark control; persisted on the thread. */
  bookmarked: z.boolean().optional(),
});

export type ResearchTree = z.infer<typeof researchTreeSchema>;

export const researchNodeSchema = z.object({
  id: z.string(),
  treeId: z.string(),
  workspaceId: z.string(),
  parentNodeId: z.string().nullish(),
  /** The passage of the parent's response this follow-up was asked about.
   * Anchors the node's card beside that passage in the parent's view. */
  queryAnchor: researchHighlightAnchorSchema.nullish(),
  /** True when this follow-up continues its parent's answer inside the same
   * document (the thread spine) instead of branching into a rail card. At
   * most one inline child per node; absent means false. */
  inline: z.boolean().optional(),
  /** The bare question. The launch messages are assembled by the runtime. */
  prompt: z.string(),
  attachments: z.array(researchMessageAttachmentSchema).optional(),
  /** Ids of the documents attached as context to this run, in display order. */
  documentIds: z.array(z.string()),
  /** Short generated title for breadcrumbs and menus. */
  title: z.string().nullish(),
  responsePreview: z.string().nullish(),
  /** Registry id from `models/registry.ts`. */
  model: z.string(),
  kind: researchNodeKindSchema.optional(),
  origin: researchNodeOriginSchema.nullish(),
  status: researchNodeStatusSchema,
  error: z.string().nullish(),
  /** 1 for the first run; incremented by Retry and by auto-resume. */
  attempt: z.number(),
  /** Set when the durable response snapshot lands — the viewer's signal to
   * refetch content it may have read while the run was still streaming. */
  responseSnapshotAt: z.number().nullish(),
  recap: researchRecapSchema.optional(),
  createdAt: z.number(),
  startedAt: z.number().nullish(),
  completedAt: z.number().nullish(),
  highlights: z.array(researchHighlightSchema),
});

export type ResearchNode = z.infer<typeof researchNodeSchema>;

export const researchTreeSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  rootNodeId: z.string(),
  /** The root node's kind — what this sidebar item fundamentally is. */
  kind: researchNodeKindSchema,
  workspaceId: z.string(),
  runningCount: z.number(),
  failedCount: z.number(),
  completedCount: z.number(),
  cancelledCount: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullish(),
  followed: z.boolean().optional(),
  bookmarked: z.boolean().optional(),
  hasUnseenUpdate: z.boolean(),
  /** A failure settled after the tree was last viewed. An attention flag —
   * viewing the tree acknowledges it — unlike `failedCount`, a lifetime
   * total. */
  hasUnseenFailure: z.boolean(),
});

export type ResearchTreeSummary = z.infer<typeof researchTreeSummarySchema>;

export const researchTreeDetailSchema = z.object({
  tree: researchTreeSchema,
  nodes: z.array(researchNodeSchema),
});

export type ResearchTreeDetail = z.infer<typeof researchTreeDetailSchema>;

export const researchBranchRemovalSchema = z.object({
  treeId: z.string(),
  parentNodeId: z.string(),
  removedNodeIds: z.array(z.string()),
});

export type ResearchBranchRemoval = z.infer<typeof researchBranchRemovalSchema>;

export const researchNodeCardSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  responsePreview: z.string().nullish(),
  status: researchNodeStatusSchema,
  createdAt: z.number(),
});

export type ResearchNodeCard = z.infer<typeof researchNodeCardSchema>;

/** Everything one `research.getNodeContent` call must supply to render an
 * active or settled node (`05-run-lifecycle-and-streaming.md` §4). */
export const researchNodeContentSchema = z.object({
  node: researchNodeSchema,
  turns: z.array(turnSchema),
  children: z.array(researchNodeCardSchema),
  /** Text streamed since the last committed turn, for the live tail. Absent
   * once the run settles. */
  inFlightText: z.string().optional(),
  /** Node sequence number this snapshot was taken at. A client applies only
   * run events with a greater `seq` and refetches on a gap. */
  seq: z.number().optional(),
  /** Position in the admission queue while `status` is `queued`; 0 means the
   * run has been claimed. */
  queuePosition: z.number().optional(),
  /** Why `turns` is empty for a finished node. */
  sourceError: z.string().optional(),
  /** Present only when the displayed turns came from a durable snapshot. */
  responseRevision: z.string().optional(),
});

export type ResearchNodeContent = z.infer<typeof researchNodeContentSchema>;

export const updateResearchDocumentResultSchema = z.object({
  tree: researchTreeSchema,
  node: researchNodeSchema,
  responseRevision: z.string(),
  markdownChanged: z.boolean(),
  removedHighlightCount: z.number(),
});

export type UpdateResearchDocumentResult = z.infer<typeof updateResearchDocumentResultSchema>;

/** Compact research-run history returned to Recent Activity. */
export interface RecentResearchQuery {
  /** Direct child questions, included with Home feed roots. */
  children?: RecentResearchQuery[] | undefined;
  nodeId: string;
  treeId: string;
  workspaceId?: string | undefined;
  parentNodeId?: string | null | undefined;
  inline: boolean;
  prompt: string;
  /** Selected parent-answer text this follow-up replies to. */
  queryTarget?: string | null | undefined;
  attachments?: ResearchMessageAttachment[] | undefined;
  title?: string | null | undefined;
  model: string;
  origin?: ResearchNodeOrigin | null | undefined;
  status: ResearchNodeStatus;
  createdAt: number;
  /** Current answer recap, when one has been generated. */
  recap?: string | null | undefined;
}

export const recentResearchQuerySchema: z.ZodType<RecentResearchQuery> = z.lazy(() =>
  z.object({
    children: z.array(recentResearchQuerySchema).optional(),
    nodeId: z.string(),
    treeId: z.string(),
    workspaceId: z.string().optional(),
    parentNodeId: z.string().nullish(),
    inline: z.boolean(),
    prompt: z.string(),
    queryTarget: z.string().nullish(),
    attachments: z.array(researchMessageAttachmentSchema).optional(),
    title: z.string().nullish(),
    model: z.string(),
    origin: researchNodeOriginSchema.nullish(),
    status: researchNodeStatusSchema,
    createdAt: z.number(),
    recap: z.string().nullish(),
  }),
);

export const recentResearchQueryCursorSchema = z.object({
  createdAt: z.number(),
  nodeId: z.string(),
});

export type RecentResearchQueryCursor = z.infer<typeof recentResearchQueryCursorSchema>;

export const recentResearchQueryPageSchema = z.object({
  items: z.array(recentResearchQuerySchema),
  nextCursor: recentResearchQueryCursorSchema.nullish(),
});

export type RecentResearchQueryPage = z.infer<typeof recentResearchQueryPageSchema>;

/** Stable keyset cursor for the mixed Recent Activity feed. Source rank is a
 * deterministic tie-breaker: research (1) sorts ahead of journal (0). */
export const recentActivityCursorSchema = z.object({
  occurredAt: z.number(),
  sourceRank: z.number(),
  id: z.string(),
});

export type RecentActivityCursor = z.infer<typeof recentActivityCursorSchema>;

/** A purely organizational grouping of research trees inside a workspace. */
export const researchFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
});

export type ResearchFolder = z.infer<typeof researchFolderSchema>;

export const researchFolderStateSchema = z.object({
  folders: z.array(researchFolderSchema),
  /** treeId -> folderId */
  membership: z.record(z.string(), z.string()),
  /** Starred tree and folder ids, in the starred list's display order. */
  starred: z.array(z.string()),
  /** Folder ids whose member rows are hidden in the sidebar. */
  collapsed: z.array(z.string()),
});

export type ResearchFolderState = z.infer<typeof researchFolderStateSchema>;
