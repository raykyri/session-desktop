// Zod schemas for the research wire types in `../wire/research.ts`, for code
// that validates values at a trust boundary (the server's tRPC inputs and
// JSON columns). The wire types are the definition; `test/wireSchemas.test.ts`
// checks that each schema's output type matches its wire type, so the two
// cannot drift. The desktop does not import this module.

import { z } from "zod";

import { turnSchema } from "./turn.js";
import { tweetSnapshotSchema } from "./tweet.js";

export const researchNodeStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

export const researchNodeTypeSchema = z.enum(["post", "exchange", "document"]);

export const documentSourceSchema = z.enum(["imported", "authored", "transcript"]);

export const postFormatSchema = z.enum(["text", "link"]);

export const researchHighlightAnchorSchema = z.object({
  version: z.literal(1),
  projection: z.literal("answer-v1"),
  responseRevision: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
});

export const researchHighlightSchema = z.object({
  id: z.string(),
  anchor: researchHighlightAnchorSchema,
  createdAt: z.number(),
  authorId: z.string().nullish(),
});

export const researchTreeRoleSchema = z.enum(["owner", "commenter", "viewer"]);

export const researchTreeVisibilitySchema = z.enum(["private", "public"]);

export const researchParticipantSchema = z.object({
  id: z.string(),
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export const nodeAnchorSchema = z.object({
  kind: z.literal("passage"),
  anchor: researchHighlightAnchorSchema,
});

export const researchTweetAttachmentSchema = z.object({
  kind: z.literal("tweet"),
  schemaVersion: z.literal(1),
  sourceUrl: z.string(),
  tweetId: z.string(),
  placement: z.enum(["inline", "trailing"]),
  provider: z.enum(["xSyndication", "xOembed"]),
  status: z.enum(["resolved", "unavailable"]),
  attemptedAt: z.number(),
  fetchedAt: z.number().optional(),
  tweet: tweetSnapshotSchema.optional(),
  failure: z.enum(["timeout", "notFound", "invalidPayload", "network"]).optional(),
});

export const researchImageAttachmentSchema = z.object({
  kind: z.literal("image"),
  id: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().optional(),
  height: z.number().optional(),
  fileName: z.string().optional(),
});

export const researchMessageAttachmentSchema = z.discriminatedUnion("kind", [
  researchTweetAttachmentSchema,
  researchImageAttachmentSchema,
]);

export const researchTreeSchema = z.object({
  id: z.string(),
  title: z.string(),
  rootNodeId: z.string(),
  workspaceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullish(),
  trashedAt: z.number().nullish(),
  lastViewedAt: z.number().nullish(),
  ownerId: z.string().optional(),
  visibility: researchTreeVisibilitySchema.optional(),
  role: researchTreeRoleSchema.optional(),
  trashedBy: z.string().nullish(),
  followed: z.boolean().optional(),
});

export const userMessageSchema = z.object({
  text: z.string(),
  attachments: z.array(researchMessageAttachmentSchema).optional(),
});

export const agentSpecSchema = z.object({
  adapter: z.string(),
  model: z.string().nullish(),
  effort: z.string().nullish(),
});

export const runStateSchema = z.object({
  status: researchNodeStatusSchema,
  error: z.string().nullish(),
  errorKind: z.literal("auth").nullish(),
  startedAt: z.number().nullish(),
  completedAt: z.number().nullish(),
  responseSnapshotAt: z.number().nullish(),
  sessionReady: z.boolean(),
  attempt: z.number().optional(),
  responsePreview: z.string().nullish(),
  resumePending: z.boolean().optional(),
});

export const researchRecapSchema = z.object({
  id: z.string().nullish(),
  text: z.string(),
  responseRevision: z.string(),
  generatedAt: z.number().nullish(),
  adapter: z.string().nullish(),
  model: z.string().nullish(),
  instructions: z.string().nullish(),
});

export const researchRecapCandidateSchema = z.object({
  id: z.string(),
  text: z.string(),
  responseRevision: z.string(),
  generatedAt: z.number(),
  adapter: z.string(),
  model: z.string().nullable(),
  instructions: z.string(),
});

const researchNodeBaseSchema = z.object({
  id: z.string(),
  treeId: z.string(),
  parentNodeId: z.string().nullish(),
  inline: z.boolean().optional(),
  anchor: nodeAnchorSchema.nullish(),
  title: z.string().nullish(),
  groupId: z.string(),
  createdAt: z.number(),
  highlights: z.array(researchHighlightSchema),
  chainOrder: z.array(z.string()).optional(),
  authorId: z.string().nullish(),
});

export const researchPostNodeSchema = researchNodeBaseSchema.extend({
  type: z.literal("post"),
  message: userMessageSchema,
  format: postFormatSchema,
  followUpAgent: agentSpecSchema,
  editedAt: z.number().nullish(),
  editedBy: z.string().nullish(),
});

export const researchExchangeNodeSchema = researchNodeBaseSchema.extend({
  type: z.literal("exchange"),
  message: userMessageSchema,
  agent: agentSpecSchema,
  run: runStateSchema,
  recap: researchRecapSchema.nullish(),
});

export const researchDocumentNodeSchema = researchNodeBaseSchema.extend({
  type: z.literal("document"),
  message: userMessageSchema.nullish(),
  source: documentSourceSchema,
  followUpAgent: agentSpecSchema.nullish(),
  responseSnapshotAt: z.number().nullish(),
  recap: researchRecapSchema.nullish(),
  editedAt: z.number().nullish(),
  editedBy: z.string().nullish(),
});

export const researchNodeSchema = z.discriminatedUnion("type", [
  researchPostNodeSchema,
  researchExchangeNodeSchema,
  researchDocumentNodeSchema,
]);

export const recentResearchQuerySchema = z.object({
  // Annotated so the emitted declaration keeps the recursion; without it the
  // `.d.ts` elides the nested object to `any`.
  get children(): z.ZodOptional<z.ZodArray<typeof recentResearchQuerySchema>> {
    return z.array(recentResearchQuerySchema).optional();
  },
  nodeId: z.string(),
  treeId: z.string(),
  parentNodeId: z.string().nullish(),
  inline: z.boolean(),
  prompt: z.string(),
  queryTarget: z.string().nullish(),
  attachments: z.array(researchMessageAttachmentSchema).optional(),
  title: z.string().nullish(),
  adapter: z.string(),
  model: z.string().nullish(),
  type: researchNodeTypeSchema.optional(),
  source: documentSourceSchema.nullish(),
  format: postFormatSchema.nullish(),
  status: researchNodeStatusSchema,
  error: z.string().nullish(),
  createdAt: z.number(),
  recap: z.string().nullish(),
});

export const recentResearchQueryCursorSchema = z.object({
  createdAt: z.number(),
  nodeId: z.string(),
});

export const researchFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  trashedAt: z.number().nullish(),
});

export const researchFolderStateSchema = z.object({
  folders: z.array(researchFolderSchema),
  membership: z.record(z.string(), z.string()),
  collapsed: z.array(z.string()),
  parents: z.record(z.string(), z.string()),
  collapsedGroups: z.array(z.string()),
});

export const researchDraftSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  attachments: z.array(researchMessageAttachmentSchema).optional(),
});

export const researchHighlightFeedItemSchema = z.object({
  highlightId: z.string(),
  nodeId: z.string(),
  treeId: z.string(),
  treeTitle: z.string(),
  nodeLabel: z.string(),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  createdAt: z.number(),
  authorId: z.string().nullish(),
  role: researchTreeRoleSchema.optional(),
});

export const researchTreeSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  rootNodeId: z.string(),
  type: researchNodeTypeSchema,
  workspaceId: z.string(),
  runningCount: z.number(),
  failedCount: z.number(),
  completedCount: z.number(),
  cancelledCount: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullish(),
  trashedAt: z.number().nullish(),
  hasUnseenUpdate: z.boolean(),
  hasUnseenFailure: z.boolean(),
  ownerId: z.string().optional(),
  visibility: researchTreeVisibilitySchema.optional(),
  role: researchTreeRoleSchema.optional(),
});

export const researchFollowupQueueItemSchema = z.object({
  id: z.string(),
  treeId: z.string(),
  headNodeId: z.string(),
  authorId: z.string(),
  message: userMessageSchema,
  agent: agentSpecSchema,
  position: z.number(),
  createdAt: z.number(),
  failedReason: z.string().nullable(),
});

export const researchTreeDetailSchema = z.object({
  tree: researchTreeSchema,
  nodes: z.array(researchNodeSchema),
  queues: z.record(z.string(), z.array(researchFollowupQueueItemSchema)).optional(),
  participants: z.array(researchParticipantSchema).optional(),
});

export const researchBranchRemovalSchema = z.object({
  treeId: z.string(),
  parentNodeId: z.string(),
  removedNodeIds: z.array(z.string()),
  removedBy: z.string().optional(),
});

export const researchNodeContentSchema = z.object({
  node: researchNodeSchema,
  turns: z.array(turnSchema),
  sourceError: z.string().optional(),
  responseRevision: z.string().optional(),
  inFlightText: z.string().optional(),
  seq: z.number().optional(),
  queuePosition: z.number().optional(),
});

export const updateResearchDocumentResultSchema = z.object({
  tree: researchTreeSchema,
  node: researchNodeSchema,
  responseRevision: z.string(),
  markdownChanged: z.boolean(),
  removedHighlightCount: z.number(),
  unmatchedBranchCount: z.number(),
});

export const updateResearchPostResultSchema = z.object({
  tree: researchTreeSchema,
  node: researchNodeSchema,
  removedHighlightCount: z.number(),
});
