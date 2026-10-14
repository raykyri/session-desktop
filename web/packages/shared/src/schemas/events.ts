// Zod schemas for the event types in `../wire/events.ts`.

import { z } from "zod";

import {
  researchFollowupQueueItemSchema,
  researchHighlightSchema,
  researchNodeSchema,
  researchTreeSchema,
} from "./research.js";

export const sessionEventSchema = z.object({
  type: z.string(),
  paneId: z.string().nullish(),
  agentId: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
});

export const parsedResearchEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("research.tree.created"),
    tree: researchTreeSchema,
    node: researchNodeSchema,
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.document.updated"),
    tree: researchTreeSchema,
    node: researchNodeSchema,
    responseRevision: z.string(),
    markdownChanged: z.boolean(),
    removedHighlightCount: z.number(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.enum(["research.node.created", "research.node.updated"]),
    node: researchNodeSchema,
    queuePosition: z.number().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.enum(["research.tree.updated", "research.tree.archived", "research.tree.restored"]),
    tree: researchTreeSchema,
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.highlight.created"),
    nodeId: z.string(),
    highlight: researchHighlightSchema,
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.highlights.removed"),
    nodeId: z.string(),
    highlightIds: z.array(z.string()),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.recap.pending"),
    nodeId: z.string(),
    pending: z.boolean(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.tree.removed"),
    treeId: z.string(),
    trashed: z.literal(true).optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.node.removed"),
    treeId: z.string(),
    parentNodeId: z.string(),
    removedNodeIds: z.array(z.string()),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.drafts.changed"),
    workspaceId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.folders.changed"),
    workspaceId: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.trash.changed"),
    workspaceId: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("research.queue.changed"),
    treeId: z.string(),
    headNodeId: z.string(),
    items: z.array(researchFollowupQueueItemSchema),
    timestamp: z.number(),
  }),
]);
