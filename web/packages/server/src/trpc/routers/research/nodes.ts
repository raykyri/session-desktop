// `research.*` procedures on single nodes: follow-ups, retry, cancel, rename,
// content, document edits, branch removal and titles (`03-api-and-events.md`
// §2).

import { feedItems, nodes, queue, researchDocuments, trees } from "@session/db";
import type {
  ResearchBranchRemoval,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
  UpdateResearchDocumentResult,
} from "@session/shared";
import { defaultTitle, nodeAnchorSchema, nodeModelId } from "@session/shared";
import { nodePrompt, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { emitFeedItemUpsertedForNode } from "../../../events/feed.js";
import { resolveMessageAttachments } from "../../../journal/attachments.js";
import {
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
  enqueueRun,
  nodeContent,
  queuePositionOf,
} from "../../../research/admission.js";
import { protectedProcedure, publicProcedure } from "../../base.js";
import { catalogUserId } from "../../catalog.js";
import { publish } from "../../emit.js";
import { repo, required } from "../../errors.js";

import { publishNode } from "./common.js";

export const nodeProcedures = {
  forkNode: protectedProcedure
    .input(
      z.object({
        parentNodeId: z.string(),
        prompt: z.string().min(1),
        model: z.string().optional(),
        anchor: nodeAnchorSchema.nullish(),
        inline: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ResearchNode> => {
      const parent = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.parentNodeId)),
        `research node ${input.parentNodeId} was not found`,
      );
      const model = input.model ?? nodeModelId(parent);
      assertModelUsable(ctx, model);
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      const attachments = await resolveMessageAttachments(
        { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger },
        input.prompt,
      );
      const node = repo(() =>
        nodes.admitChild(ctx.db, ctx.user.id, {
          parentNodeId: input.parentNodeId,
          message: {
            text: input.prompt,
            ...(attachments.length === 0 ? {} : { attachments }),
          },
          // A follow-up on another model starts at that model's default
          // effort; one on the same model keeps the parent's.
          ...(input.model === undefined || input.model === nodeModelId(parent)
            ? {}
            : { agent: { model } }),
          ...(input.inline === undefined ? {} : { inline: input.inline }),
          ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
        }),
      );
      enqueueRun(ctx, node.id, model);
      publish(ctx, "research.node.created", { node });
      publishNode(ctx, node, queuePositionOf(ctx, node.id));
      const feedItem = feedItems.forTree(ctx.db, node.treeId);
      if (feedItem) emitFeedItemUpsertedForNode(ctx, feedItem.id);
      return node;
    }),

  retryNode: protectedProcedure
    .input(z.object({ nodeId: z.string(), model: z.string().optional() }))
    .mutation(({ ctx, input }): ResearchTreeDetail => {
      const existing = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      const model = input.model ?? nodeModelId(existing);
      assertModelUsable(ctx, model);
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      // `resetForRetry` enqueues inside its own transaction, so the run is
      // queued the moment the status flips.
      const node = repo(() =>
        input.model === undefined
          ? nodes.resetForRetry(ctx.db, ctx.user.id, input.nodeId)
          : nodes.resetForRetry(ctx.db, ctx.user.id, input.nodeId, input.model),
      );
      ctx.runs.start(node.id);
      publishNode(ctx, node, queuePositionOf(ctx, node.id));
      emitFeedItemUpsertedForNode(ctx, node.id);
      return repo(() => trees.detail(ctx.db, ctx.user.id, node.treeId));
    }),

  cancelNode: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }): ResearchNode => {
      const existing = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      if (existing.type !== "exchange" || nodes.isTerminalStatus(existing.run.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Research node is already in terminal status: ${nodeStatus(existing)}`,
        });
      }
      const node = repo(() => nodes.setStatus(ctx.db, ctx.user.id, input.nodeId, "cancelled"));
      queue.release(ctx.db, node.id);
      ctx.runs.cancel(node.id);
      publishNode(ctx, node);
      emitFeedItemUpsertedForNode(ctx, node.id);
      return node;
    }),

  renameNode: protectedProcedure
    .input(z.object({ nodeId: z.string(), title: z.string() }))
    .mutation(({ ctx, input }): ResearchNode => {
      const node = repo(() => nodes.rename(ctx.db, ctx.user.id, input.nodeId, input.title));
      publishNode(ctx, node);
      emitFeedItemUpsertedForNode(ctx, node.id);
      return node;
    }),

  getNodeContent: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }): ResearchNodeContent => {
      const userId = catalogUserId(ctx);
      if (userId === null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `research node ${input.nodeId} was not found`,
        });
      }
      return nodeContent({ db: ctx.db, user: { id: userId } }, input.nodeId);
    }),

  updateDocument: protectedProcedure
    .input(
      z.object({
        nodeId: z.string(),
        markdown: z.string(),
        title: z.string().nullish(),
        expectedTitle: z.string(),
        expectedResponseRevision: z.string(),
        expectedHighlightIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }): UpdateResearchDocumentResult => {
      const result = repo(() =>
        researchDocuments.update(ctx.db, ctx.user.id, {
          nodeId: input.nodeId,
          markdown: input.markdown,
          ...(input.title === undefined ? {} : { title: input.title }),
          expectedTitle: input.expectedTitle,
          expectedResponseRevision: input.expectedResponseRevision,
          ...(input.expectedHighlightIds === undefined
            ? {}
            : { expectedHighlightIds: input.expectedHighlightIds }),
        }),
      );
      publish(ctx, "research.document.updated", {
        tree: result.tree,
        node: result.node,
        responseRevision: result.responseRevision,
        markdownChanged: result.markdownChanged,
        removedHighlightCount: result.removedHighlightCount,
      });
      emitFeedItemUpsertedForNode(ctx, result.node.id);
      return result;
    }),

  removeBranch: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }): ResearchBranchRemoval => {
      const removal = repo(() => nodes.removeBranch(ctx.db, ctx.user.id, input.nodeId));
      publish(ctx, "research.node.removed", {
        treeId: removal.treeId,
        parentNodeId: removal.parentNodeId,
        removedNodeIds: removal.removedNodeIds,
      });
      const feedItem = feedItems.forTree(ctx.db, removal.treeId);
      if (feedItem) emitFeedItemUpsertedForNode(ctx, feedItem.id);
      return removal;
    }),

  /**
   * Executes metadata generation with a timeout. If title generation fails,
   * retains the existing node title or falls back to the default title of
   * the node's text.
   */
  generateTitle: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(async ({ ctx, input }): Promise<string> => {
      const node = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      const generated = await ctx.runs
        .requestTitle(ctx.user.id, node.id)
        .catch((error: unknown) => {
          ctx.logger.warn({ nodeId: node.id, error }, "title generation failed");
          return null;
        });
      return generated ?? node.title ?? defaultTitle(nodePrompt(node));
    }),

  listActivity: protectedProcedure.query(({ ctx }): ResearchNode[] =>
    repo(() => nodes.listActive(ctx.db, ctx.user.id)),
  ),
};
