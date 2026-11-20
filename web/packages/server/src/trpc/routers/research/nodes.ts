// `research.*` procedures on single nodes: follow-ups, retry, rerun, chain
// order, cancel, rename, content, document edits, branch removal and titles (`03-api-and-events.md`
// §2).

import { access, feedItems, nodes, queue, researchDocuments } from "@session/db";
import type {
  ResearchBranchRemoval,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
  UpdateResearchDocumentResult,
} from "@session/shared";
import { defaultTitle, nodeAnchorSchema, nodeEffort, nodeModelId } from "@session/shared";
import { nodePrompt, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { emitFeedItemUpsertedForNode } from "../../../events/feed.js";
import { resolveMessageAttachments } from "../../../journal/attachments.js";
import { requireNodeRole } from "../../../research/access.js";
import {
  admitWithinLimits,
  assertEffortAccepted,
  assertMetadataAllowed,
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
  nodeContent,
  queuePositionOf,
  queueRun,
  scheduleDocumentRecap,
} from "../../../research/admission.js";
import { publishQueue } from "../../../research/followups.js";
import { assertModelReadsImages, resolveImageAttachments } from "../../../research/images.js";
import { notifyNewNode } from "../../../research/notifications.js";
import { protectedProcedure, publicProcedure } from "../../base.js";
import { publishToTree } from "../../emit.js";
import { repo, required } from "../../errors.js";

import { detailWithQueues, dispatchFollowups, publishNode, publishTreeEvent } from "./common.js";

export const nodeProcedures = {
  /**
   * Creates a follow-up node connected to `parentNodeId` (`fork_research_node`).
   * Creates a branch, or an inline follow-up when `inline` is set and the slot is
   * available; continuing an active chain uses `followups.ask` to queue.
   *
   * Configures the model and effort, defaulting to the parent node's configuration.
   * `replacesNodeId` replaces an existing failed or cancelled node within a single
   * transaction.
   */
  forkNode: protectedProcedure
    .input(
      z.object({
        parentNodeId: z.string(),
        prompt: z.string().min(1),
        agent: z.object({ model: z.string(), effort: z.string().nullish() }).optional(),
        anchor: nodeAnchorSchema.nullish(),
        inline: z.boolean().optional(),
        replacesNodeId: z.string().optional(),
        /** Ids from `POST /api/images`. */
        images: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ResearchNode> => {
      // Reject viewer role before resolving attachments or checking limits.
      requireNodeRole(ctx, input.parentNodeId, "commenter");
      const parent = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.parentNodeId)),
        `research node ${input.parentNodeId} was not found`,
      );
      const model = input.agent?.model ?? nodeModelId(parent);
      // Inherit the parent's effort level if the same model is used; otherwise
      // use the model's default effort.
      const effort =
        input.agent?.effort !== undefined
          ? input.agent.effort
          : model === nodeModelId(parent)
            ? nodeEffort(parent)
            : null;
      assertModelUsable(ctx, model);
      assertEffortAccepted(model, effort);
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      const images = resolveImageAttachments(ctx.db, ctx.user.id, input.images);
      assertModelReadsImages(model, images);
      const attachments = [
        ...(await resolveMessageAttachments(
          { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger },
          input.prompt,
        )),
        ...images,
      ];
      // Verify limits again in the write transaction in case concurrent runs
      // were admitted while attachments were being resolved.
      const admitted = admitWithinLimits(ctx, (db) => {
        const child = repo(() =>
          nodes.admitChildDetailed(db, ctx.user.id, {
            parentNodeId: input.parentNodeId,
            message: {
              text: input.prompt,
              ...(attachments.length === 0 ? {} : { attachments }),
            },
            agent: { model, effort },
            ...(input.inline === undefined ? {} : { inline: input.inline }),
            ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
            ...(input.replacesNodeId === undefined ? {} : { replacesNodeId: input.replacesNodeId }),
          }),
        );
        queueRun(db, ctx.user.id, child.node.id, model);
        return child;
      });
      const node = admitted.node;
      ctx.runs.start(node.id);
      if (admitted.replacedNodeId !== null) {
        publishToTree(ctx, node.treeId, "research.node.removed", {
          treeId: node.treeId,
          parentNodeId: input.parentNodeId,
          removedNodeIds: [admitted.replacedNodeId],
          removedBy: ctx.user.id,
        });
      }
      publishToTree(ctx, node.treeId, "research.node.created", { node });
      publishNode(ctx, node, queuePositionOf(ctx, node.id));
      if (admitted.reorderedHead) {
        publishNode(ctx, admitted.reorderedHead);
      }
      if (admitted.movedQueue && admitted.replacedNodeId !== null) {
        // Reassign queued follow-ups to the replacement node and notify clients
        // under both head node IDs.
        publishQueue(ctx, ctx.user.id, node.treeId, admitted.replacedNodeId);
        publishQueue(ctx, ctx.user.id, node.treeId, node.id);
      }
      const feedItem = feedItems.forTree(ctx.db, node.treeId);
      if (feedItem) emitFeedItemUpsertedForNode(ctx, feedItem.id);
      notifyNewNode(ctx, ctx.user.id, node);
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
      // `resetForRetry` enqueues in the same transaction as the limit check,
      // so the run is queued the moment the status flips.
      const node = admitWithinLimits(ctx, (db) =>
        repo(() =>
          input.model === undefined
            ? nodes.resetForRetry(db, ctx.user.id, input.nodeId)
            : nodes.resetForRetry(db, ctx.user.id, input.nodeId, input.model),
        ),
      );
      ctx.runs.start(node.id);
      publishNode(ctx, node, queuePositionOf(ctx, node.id));
      emitFeedItemUpsertedForNode(ctx, node.id);
      return detailWithQueues(ctx, ctx.user.id, node.treeId);
    }),

  /**
   * Reruns a completed research node in place (`rerun_research_node`), resetting
   * existing answers and recaps while preserving highlights. Dependent inline
   * follow-ups wait in the queue until the parent run completes.
   */
  rerunNode: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTreeDetail => {
      const existing = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      assertModelUsable(ctx, nodeModelId(existing));
      const node = admitWithinLimits(ctx, (db) =>
        repo(() => nodes.resetForRerun(db, ctx.user.id, input.nodeId)),
      );
      ctx.runs.start(node.id);
      publishNode(ctx, node, queuePositionOf(ctx, node.id));
      emitFeedItemUpsertedForNode(ctx, node.id);
      return detailWithQueues(ctx, ctx.user.id, node.treeId);
    }),

  /**
   * Sets the display ordering for the message chain starting at `headNodeId`
   * (`set_research_chain_order`). `nodeIds` must contain all nodes in the chain.
   * Affects display order only; follow-ups continue from the terminal node.
   */
  setChainOrder: protectedProcedure
    .input(
      z.object({
        headNodeId: z.string(),
        nodeIds: z.array(z.string()),
        /** The display order the caller reordered from. When provided, requests
         * that conflict with concurrent reordering return `CONFLICT`. */
        expectedOrder: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }): ResearchNode => {
      const result = repo(() =>
        nodes.setChainOrder(
          ctx.db,
          ctx.user.id,
          input.headNodeId,
          input.nodeIds,
          input.expectedOrder,
        ),
      );
      if (result.changed) {
        publishNode(ctx, result.node);
        dispatchFollowups(ctx, result.node.treeId);
      }
      return result.node;
    }),

  cancelNode: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }): ResearchNode => {
      // Only the node author or thread owner may cancel a run.
      const standing = requireNodeRole(ctx, input.nodeId, "commenter");
      if (standing.role !== "owner" && standing.node.authorId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: access.ACCESS_MESSAGES.ownContent });
      }
      const existing = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      // Only queued, running, or interrupted runs may be stopped (`nodes.stopRun`).
      const node = repo(() => nodes.stopRun(ctx.db, input.nodeId));
      if (node === null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Research node is already in terminal status: ${nodeStatus(existing)}`,
        });
      }
      // Wake dependent child runs; child reruns fail immediately if the parent is cancelled.
      queue.wakeChildrenOf(ctx.db, node.id);
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
    .query(({ ctx, input }): ResearchNodeContent =>
      // Guests read public threads (`access.treeAccess`).
      nodeContent({ db: ctx.db, user: ctx.user }, input.nodeId),
    ),

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
      const { movedBranches, ...result } = repo(() =>
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
      // Emit tree event with user-specific fields to the caller, and without
      // per-user fields to other thread viewers.
      publishTreeEvent(ctx, "research.document.updated", {
        tree: result.tree,
        node: result.node,
        responseRevision: result.responseRevision,
        markdownChanged: result.markdownChanged,
        removedHighlightCount: result.removedHighlightCount,
      });
      // Update branch positions when their anchor text moves.
      for (const branch of movedBranches) publishNode(ctx, branch);
      emitFeedItemUpsertedForNode(ctx, result.node.id);
      // Clear the existing recap and schedule a new recap when document content changes.
      if (result.markdownChanged) scheduleDocumentRecap(ctx, result.node.id);
      return result;
    }),

  removeBranch: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }): ResearchBranchRemoval => {
      const removal = repo(() => nodes.removeBranch(ctx.db, ctx.user.id, input.nodeId));
      publishToTree(ctx, removal.treeId, "research.node.removed", {
        treeId: removal.treeId,
        parentNodeId: removal.parentNodeId,
        removedNodeIds: removal.removedNodeIds,
        removedBy: ctx.user.id,
      });
      const feedItem = feedItems.forTree(ctx.db, removal.treeId);
      if (feedItem) emitFeedItemUpsertedForNode(ctx, feedItem.id);
      // Removing a terminal failed or stopped node allows queued follow-ups to proceed.
      dispatchFollowups(ctx, removal.treeId);
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
      // Validate rename permission for the thread owner or node author
      // (`access.assertMayChangeNode`); the requesting user is billed for the run.
      const standing = requireNodeRole(ctx, input.nodeId, "commenter");
      repo(() => access.assertMayChangeNode(ctx.db, standing, ctx.user.id));
      assertMetadataAllowed(ctx);
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
