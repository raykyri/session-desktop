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
  assertEffortAccepted,
  assertMetadataAllowed,
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
  enqueueRun,
  nodeContent,
  queuePositionOf,
} from "../../../research/admission.js";
import { publishQueue } from "../../../research/followups.js";
import {
  assertModelReadsImages,
  markImagesAttached,
  resolveImageAttachments,
} from "../../../research/images.js";
import { notifyNewNode } from "../../../research/notifications.js";
import { protectedProcedure, publicProcedure } from "../../base.js";
import { publishToTree } from "../../emit.js";
import { repo, required } from "../../errors.js";

import { detailWithQueues, dispatchFollowups, publishNode, publishTreeEvent } from "./common.js";

export const nodeProcedures = {
  /**
   * Creates a follow-up of `parentNodeId` (`fork_research_node`). A branch,
   * or with `inline` the parent's inline follow-up when its slot is free;
   * continuing a chain whose last answer is still running goes through
   * `followups.ask`, which queues it.
   *
   * `agent` picks any registry model the account may use and an effort that
   * model accepts; absent, the parent's agent. `replacesNodeId` names a
   * failed or stopped question this one replaces (an edited question): the
   * new node is admitted and the old one removed in one transaction.
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
      // A viewer is refused before anything is resolved or charged.
      requireNodeRole(ctx, input.parentNodeId, "commenter");
      const parent = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.parentNodeId)),
        `research node ${input.parentNodeId} was not found`,
      );
      const model = input.agent?.model ?? nodeModelId(parent);
      // A follow-up on the parent's model keeps the parent's effort unless it
      // names one; one on another model starts at that model's default.
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
      const admitted = repo(() =>
        nodes.admitChildDetailed(ctx.db, ctx.user.id, {
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
      const node = admitted.node;
      markImagesAttached(ctx.db, images);
      enqueueRun(ctx, node.id, model);
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
        // The queue now waits under the new question: announced under both
        // heads, so a client holding it under the old one drops it there.
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
      return detailWithQueues(ctx, ctx.user.id, node.treeId);
    }),

  /**
   * Reruns a settled question in place (`rerun_research_node`): as
   * `retryNode`, and a complete answer is accepted too and replaced. Its
   * snapshot and recap are deleted; highlights stay and re-anchor by quote.
   * The answer it follows must be complete, except for an inline follow-up
   * of an answer that is itself running again: the rerun then waits in the
   * run queue until that answer settles.
   */
  rerunNode: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTreeDetail => {
      const existing = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      assertModelUsable(ctx, nodeModelId(existing));
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      const node = repo(() => nodes.resetForRerun(ctx.db, ctx.user.id, input.nodeId));
      ctx.runs.start(node.id);
      publishNode(ctx, node, queuePositionOf(ctx, node.id));
      emitFeedItemUpsertedForNode(ctx, node.id);
      return detailWithQueues(ctx, ctx.user.id, node.treeId);
    }),

  /**
   * Stores the display order of the messages column whose inline chain
   * starts at `headNodeId` (`set_research_chain_order`). `nodeIds` must be
   * exactly the chain's nodes. Display only: a follow-up still continues the
   * chain's last node.
   */
  setChainOrder: protectedProcedure
    .input(
      z.object({
        headNodeId: z.string(),
        nodeIds: z.array(z.string()),
        /** The display order the caller reordered from. When given, a column
         * someone else reordered since is refused with `CONFLICT`. */
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
      // The person who asked, or the thread's owner, may stop a run.
      const standing = requireNodeRole(ctx, input.nodeId, "commenter");
      if (standing.role !== "owner" && standing.node.authorId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: access.ACCESS_MESSAGES.ownContent });
      }
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
      // A rerun of its inline follow-up held behind it fails now rather than
      // when its wait runs out; a running node's settlement does this too.
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
      // The tree is the caller's view; the rest of the audience gets it
      // without the per-person fields.
      publishTreeEvent(ctx, "research.document.updated", {
        tree: result.tree,
        node: result.node,
        responseRevision: result.responseRevision,
        markdownChanged: result.markdownChanged,
        removedHighlightCount: result.removedHighlightCount,
      });
      // Branches asked about a passage moved with their quote.
      for (const branch of movedBranches) publishNode(ctx, branch);
      emitFeedItemUpsertedForNode(ctx, result.node.id);
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
      // Removing a chain's failed or stopped tail lets its queue send again.
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
      // A title is a rename: the owner's, or the author's of their own node
      // (`access.assertMayChangeNode`); the requester pays for the run.
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
