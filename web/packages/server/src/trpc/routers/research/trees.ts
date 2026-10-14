// `research.*` procedures on whole threads: listing, ordering, creating,
// renaming, viewing, archiving and deleting (`03-api-and-events.md` §2).

import { researchDocuments, trees } from "@session/db";
import type { ResearchTree, ResearchTreeDetail, ResearchTreeSummary } from "@session/shared";
import { METADATA_MODEL_ID } from "@session/shared";
import { stripImportedReportCitations } from "@session/shared/lib/researchDocuments";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { emitFeedItemRemoved, emitFeedItemUpsertedForNode } from "../../../events/feed.js";
import { resolveMessageAttachments } from "../../../journal/attachments.js";
import {
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
  enqueueRun,
  queuePositionOf,
} from "../../../research/admission.js";
import { protectedProcedure, publicProcedure } from "../../base.js";
import { catalogUserId } from "../../catalog.js";
import { publish } from "../../emit.js";
import { repo, required } from "../../errors.js";

import { publishNode } from "./common.js";

export const treeProcedures = {
  listTrees: publicProcedure
    .input(
      z
        .object({ workspaceId: z.string().optional(), includeArchived: z.boolean().optional() })
        .optional(),
    )
    .query(({ ctx, input }): ResearchTreeSummary[] => {
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

  getTree: publicProcedure
    .input(z.object({ treeId: z.string() }))
    .query(({ ctx, input }): ResearchTreeDetail => {
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
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ResearchTreeDetail> => {
      assertModelUsable(ctx, input.model);
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      // The posts the question links to are resolved before the node exists,
      // so the snapshot is on the row the run and every later reader see
      // (`journal/attachments.ts`). Admission is checked first: a launch that
      // is going to be refused should not spend a fetch.
      const attachments = await resolveMessageAttachments(
        { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger },
        input.prompt,
      );
      const detail = repo(() =>
        trees.admitRoot(ctx.db, ctx.user.id, {
          workspaceId: input.workspaceId,
          type: "exchange",
          message: {
            text: input.prompt,
            ...(attachments.length === 0 ? {} : { attachments }),
          },
          agent: { model: input.model },
          ...(input.title === undefined ? {} : { title: input.title }),
        }),
      );
      const node = required(detail.nodes[0], "the new thread has no root node");
      enqueueRun(ctx, node.id, input.model);
      publish(ctx, "research.tree.created", { tree: detail.tree, node });
      publishNode(ctx, node, queuePositionOf(ctx, node.id));
      emitFeedItemUpsertedForNode(ctx, node.id);
      return detail;
    }),

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
      const detail = repo(() =>
        researchDocuments.importReport(ctx.db, ctx.user.id, {
          workspaceId: input.workspaceId,
          prompt: input.prompt,
          markdown,
          // Nothing generated the report here. Its follow-ups default to the
          // metadata model, which also writes its summary.
          agent: { model: METADATA_MODEL_ID },
        }),
      );
      const root = required(detail.nodes[0], "the imported thread has no root node");
      publish(ctx, "research.tree.created", { tree: detail.tree, node: root });
      emitFeedItemUpsertedForNode(ctx, root.id);
      return detail;
    }),

  renameTree: protectedProcedure
    .input(z.object({ treeId: z.string(), title: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const tree = repo(() => trees.rename(ctx.db, ctx.user.id, input.treeId, input.title));
      publish(ctx, "research.tree.updated", { tree });
      return tree;
    }),

  markTreeViewed: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const tree = repo(() => trees.markViewed(ctx.db, ctx.user.id, input.treeId));
      publish(ctx, "research.tree.updated", { tree });
      return tree;
    }),

  /** Archives the thread with the children listed under it. */
  archiveTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() => trees.archiveGroup(ctx.db, ctx.user.id, input.treeId));
      for (const tree of [...change.children, change.tree]) {
        publish(ctx, "research.tree.archived", { tree });
      }
      for (const item of change.removedFeedItems) emitFeedItemRemoved(ctx.eventBus, item);
      return change.tree;
    }),

  /** Unarchives the thread with its children in the Archive. */
  restoreTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() => trees.restoreGroup(ctx.db, ctx.user.id, input.treeId));
      for (const tree of [...change.children, change.tree]) {
        publish(ctx, "research.tree.restored", { tree });
        emitFeedItemUpsertedForNode(ctx, tree.rootNodeId);
      }
      return change.tree;
    }),

  /** Deletes the thread now, in or out of the Trash, with the children
   * listed under it. */
  removeTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const removed = repo(() => trees.remove(ctx.db, ctx.user.id, input.treeId));
      for (const treeId of removed.treeIds) {
        publish(ctx, "research.tree.removed", { treeId });
      }
      for (const item of removed.removedFeedItems) emitFeedItemRemoved(ctx.eventBus, item);
      if (removed.trashed) {
        publish(ctx, "research.trash.changed", { workspaceId: removed.workspaceId });
      }
      return { ok: true, treeIds: removed.treeIds };
    }),
};
