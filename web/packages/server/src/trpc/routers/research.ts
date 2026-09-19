// The `research` router: threads, nodes, and their content
// (`03-api-and-events.md` §2).

import {
  documents as documentsRepo,
  feedItems,
  nodes,
  queue,
  researchDocuments,
  snapshots,
  trees,
} from "@session/db";
import type { ResearchTreeDetail } from "@session/shared";
import {
  METADATA_MODEL_ID,
  defaultTitle,
  deriveResearchDocumentTitle,
  researchHighlightAnchorSchema,
  stripImportedReportCitations,
} from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { emitFeedItemRemoved, emitFeedItemUpsertedForNode } from "../../events/feed.js";
import {
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
  enqueueRun,
  nodeContent,
  queuePositionOf,
} from "../../research/admission.js";
import { MAX_DOCUMENTS_PER_QUESTION } from "../../uploads/limits.js";
import { unlinkOrphans } from "../../uploads/storage.js";
import { protectedProcedure, publicProcedure, router } from "../base.js";
import { catalogUserId } from "../catalog.js";
import { publish } from "../emit.js";
import { repo, required } from "../errors.js";

const documentIds = z.array(z.string()).max(MAX_DOCUMENTS_PER_QUESTION).optional();

/** The node a mutation just changed, with its queue position while it waits. */
function publishNode(
  ctx: Parameters<typeof publish>[0],
  node: { id: string; status: string },
  queuePosition?: number,
): void {
  publish(ctx, "research.node.updated", {
    node,
    ...(queuePosition === undefined ? {} : { queuePosition }),
  });
}

export const researchRouter = router({
  listTrees: publicProcedure
    .input(
      z
        .object({ workspaceId: z.string().optional(), includeArchived: z.boolean().optional() })
        .optional(),
    )
    .query(({ ctx, input }) => {
      const userId = catalogUserId(ctx);
      if (userId === null) return [];
      return repo(() =>
        trees.summaries(ctx.db, userId, {
          workspaceId: input?.workspaceId ?? null,
          includeArchived: input?.includeArchived ?? false,
        }),
      );
    }),

  reorderTrees: protectedProcedure
    .input(
      z.object({ workspaceId: z.string(), archived: z.boolean(), treeIds: z.array(z.string()) }),
    )
    .mutation(({ ctx, input }) => {
      repo(() =>
        trees.reorder(ctx.db, ctx.user.id, input.workspaceId, input.archived, input.treeIds),
      );
      return { ok: true };
    }),

  getTree: publicProcedure.input(z.object({ treeId: z.string() })).query(({ ctx, input }) => {
    const userId = catalogUserId(ctx);
    if (userId === null) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `research tree ${input.treeId} was not found`,
      });
    }
    required(
      repo(() => trees.get(ctx.db, userId, input.treeId)),
      `research tree ${input.treeId} was not found`,
    );
    return repo(() => trees.detail(ctx.db, userId, input.treeId));
  }),

  createTree: protectedProcedure
    .input(
      z.object({
        prompt: z.string().min(1),
        title: z.string().optional(),
        model: z.string(),
        workspaceId: z.string(),
        documentIds,
      }),
    )
    .mutation(({ ctx, input }): ResearchTreeDetail => {
      assertModelUsable(ctx, input.model);
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      const detail = repo(() =>
        trees.admitRoot(ctx.db, ctx.user.id, {
          workspaceId: input.workspaceId,
          prompt: input.prompt,
          model: input.model,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.documentIds === undefined ? {} : { documentIds: input.documentIds }),
        }),
      );
      const node = required(detail.nodes[0], "the new thread has no root node");
      enqueueRun(ctx, node.id, input.model);
      publish(ctx, "research.tree.created", { tree: detail.tree, node });
      publishNode(ctx, node, queuePositionOf(ctx, node.id));
      emitFeedItemUpsertedForNode(ctx, node.id);
      return detail;
    }),

  forkNode: protectedProcedure
    .input(
      z.object({
        parentNodeId: z.string(),
        prompt: z.string().min(1),
        model: z.string().optional(),
        queryAnchor: researchHighlightAnchorSchema.nullish(),
        inline: z.boolean().optional(),
        documentIds,
      }),
    )
    .mutation(({ ctx, input }) => {
      const parent = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.parentNodeId)),
        `research node ${input.parentNodeId} was not found`,
      );
      const model = input.model ?? parent.model;
      assertModelUsable(ctx, model);
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      const node = repo(() =>
        nodes.admitChild(ctx.db, ctx.user.id, {
          parentNodeId: input.parentNodeId,
          prompt: input.prompt,
          model,
          ...(input.inline === undefined ? {} : { inline: input.inline }),
          ...(input.queryAnchor === undefined ? {} : { queryAnchor: input.queryAnchor }),
          ...(input.documentIds === undefined ? {} : { documentIds: input.documentIds }),
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
      const model = input.model ?? existing.model;
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
    .mutation(({ ctx, input }) => {
      const existing = required(
        repo(() => nodes.get(ctx.db, ctx.user.id, input.nodeId)),
        `research node ${input.nodeId} was not found`,
      );
      if (nodes.isTerminalStatus(existing.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Research node is already in terminal status: ${existing.status}`,
        });
      }
      const node = repo(() => nodes.setStatus(ctx.db, ctx.user.id, input.nodeId, "cancelled"));
      queue.release(ctx.db, node.id);
      ctx.runs.cancel(node.id);
      publishNode(ctx, node);
      emitFeedItemUpsertedForNode(ctx, node.id);
      return node;
    }),

  renameTree: protectedProcedure
    .input(z.object({ treeId: z.string(), title: z.string() }))
    .mutation(({ ctx, input }) => {
      const tree = repo(() => trees.rename(ctx.db, ctx.user.id, input.treeId, input.title));
      publish(ctx, "research.tree.updated", { tree });
      return tree;
    }),

  renameNode: protectedProcedure
    .input(z.object({ nodeId: z.string(), title: z.string() }))
    .mutation(({ ctx, input }) => {
      const node = repo(() => nodes.rename(ctx.db, ctx.user.id, input.nodeId, input.title));
      publishNode(ctx, node);
      emitFeedItemUpsertedForNode(ctx, node.id);
      return node;
    }),

  getNodeContent: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ ctx, input }) => {
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
    .mutation(({ ctx, input }) => {
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

  markTreeViewed: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const tree = repo(() => trees.markViewed(ctx.db, ctx.user.id, input.treeId));
      publish(ctx, "research.tree.updated", { tree });
      return tree;
    }),

  setTreeFollowed: protectedProcedure
    .input(z.object({ treeId: z.string(), value: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const tree = repo(() => trees.setFollowed(ctx.db, ctx.user.id, input.treeId, input.value));
      publish(ctx, "research.tree.updated", { tree });
      return tree;
    }),

  setTreeBookmarked: protectedProcedure
    .input(z.object({ treeId: z.string(), value: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const tree = repo(() => trees.setBookmarked(ctx.db, ctx.user.id, input.treeId, input.value));
      publish(ctx, "research.tree.updated", { tree });
      emitFeedItemUpsertedForNode(ctx, tree.rootNodeId);
      return tree;
    }),

  archiveTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const feedItem = feedItems.forTree(ctx.db, input.treeId);
      const tree = repo(() => trees.archive(ctx.db, ctx.user.id, input.treeId));
      publish(ctx, "research.tree.archived", { tree });
      emitFeedItemRemoved(ctx.eventBus, feedItem);
      return tree;
    }),

  restoreTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const tree = repo(() => trees.restore(ctx.db, ctx.user.id, input.treeId));
      publish(ctx, "research.tree.restored", { tree });
      emitFeedItemUpsertedForNode(ctx, tree.rootNodeId);
      return tree;
    }),

  removeTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }) => {
      required(
        repo(() => trees.get(ctx.db, ctx.user.id, input.treeId)),
        `research tree ${input.treeId} was not found`,
      );
      const feedItem = feedItems.forTree(ctx.db, input.treeId);
      repo(() => trees.remove(ctx.db, ctx.user.id, input.treeId));
      publish(ctx, "research.tree.removed", { treeId: input.treeId });
      emitFeedItemRemoved(ctx.eventBus, feedItem);
      return { ok: true };
    }),

  removeBranch: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ ctx, input }) => {
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
   * Executes metadata generation with a timeout. If title generation fails, retains the existing node title or falls back to defaultTitle(prompt).
   */
  generateTitle: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
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
      return generated ?? node.title ?? defaultTitle(node.prompt);
    }),

  listActivity: protectedProcedure.query(({ ctx }) =>
    repo(() => nodes.listActive(ctx.db, ctx.user.id)),
  ),

  importReport: protectedProcedure
    .input(
      z.object({
        markdown: z.string().min(1),
        prompt: z.string().min(1),
        workspaceId: z.string(),
      }),
    )
    .mutation(({ ctx, input }): ResearchTreeDetail => {
      const markdown = stripImportedReportCitations(input.markdown);
      // Inside `repo` so an oversized report is a `BAD_REQUEST` with its own
      // message rather than an unhandled `INTERNAL_SERVER_ERROR`.
      repo(() => researchDocuments.validateDocumentMarkdown(markdown));
      const detail = repo(() =>
        trees.admitRoot(ctx.db, ctx.user.id, {
          workspaceId: input.workspaceId,
          prompt: input.prompt,
          // Imported reports are filed against the metadata model: nothing
          // generated them here, but the recap that follows runs there.
          model: METADATA_MODEL_ID,
          title: deriveResearchDocumentTitle(markdown),
          kind: "document",
          origin: "imported",
          status: "complete",
        }),
      );
      const node = required(detail.nodes[0], "the imported thread has no root node");
      repo(() =>
        snapshots.commit(ctx.db, ctx.user.id, {
          nodeId: node.id,
          turns: [researchDocuments.documentTurn(node.id, markdown)],
          outcome: { status: "complete" },
        }),
      );
      const fresh = repo(() => trees.detail(ctx.db, ctx.user.id, detail.tree.id));
      const root = required(fresh.nodes[0], "the imported thread has no root node");
      publish(ctx, "research.tree.created", { tree: fresh.tree, node: root });
      emitFeedItemUpsertedForNode(ctx, root.id);
      return fresh;
    }),
});

export const documentsRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string().optional() }).optional())
    .query(({ ctx, input }) =>
      repo(() =>
        input?.workspaceId === undefined
          ? documentsRepo.list(ctx.db, ctx.user.id)
          : documentsRepo.list(ctx.db, ctx.user.id, input.workspaceId),
      ),
    ),
  remove: protectedProcedure
    .input(z.object({ documentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      required(
        repo(() => documentsRepo.get(ctx.db, ctx.user.id, input.documentId)),
        `document ${input.documentId} was not found`,
      );
      // Deleting a document requires removing both the database row and the file on disk to prevent orphaned files from exhausting storage.
      const removal = repo(() => documentsRepo.remove(ctx.db, ctx.user.id, input.documentId));
      await unlinkOrphans(ctx.config.documentsDir, removal.orphanedPaths, ctx.logger);
      return { ok: true };
    }),
});
