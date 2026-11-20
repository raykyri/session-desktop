// `research.*` procedures on whole threads: listing, ordering, creating,
// renaming, viewing, archiving and deleting (`03-api-and-events.md` §2).

import { researchDocuments, trees } from "@session/db";
import type { ResearchTree, ResearchTreeDetail, ResearchTreeSummary } from "@session/shared";
import { METADATA_MODEL_ID } from "@session/shared";
import { stripImportedReportCitations } from "@session/shared/lib/researchDocuments";
import { z } from "zod";

import { sessionEvent } from "../../../events/bus.js";
import { emitFeedItemRemoved, emitFeedItemUpsertedForNode } from "../../../events/feed.js";
import { resolveMessageAttachments } from "../../../journal/attachments.js";
import {
  admitWithinLimits,
  assertEffortAccepted,
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
  queuePositionOf,
  queueRun,
  scheduleDocumentRecap,
} from "../../../research/admission.js";
import { assertModelReadsImages, resolveImageAttachments } from "../../../research/images.js";
import { protectedProcedure, publicProcedure } from "../../base.js";
import { publish } from "../../emit.js";
import { repo, required } from "../../errors.js";

import {
  afterDeparture,
  detailWithQueues,
  dispatchFollowups,
  publishNode,
  publishTree,
} from "./common.js";

export const treeProcedures = {
  listTrees: publicProcedure
    .input(
      z
        .object({ workspaceId: z.string().optional(), includeArchived: z.boolean().optional() })
        .optional(),
    )
    .query(({ ctx, input }): ResearchTreeSummary[] => {
      // Unauthenticated requests receive the public catalog of shared threads.
      if (ctx.user === null) {
        return repo(() =>
          trees.publicSummaries(ctx.db, null, { workspaceId: input?.workspaceId ?? null }),
        );
      }
      const userId = ctx.user.id;
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
      // Accessible by the owner, members, or any user for public threads (`access.treeAccess`).
      const userId = ctx.user?.id ?? null;
      required(
        repo(() => trees.get(ctx.db, userId, input.treeId)),
        `research tree ${input.treeId} was not found`,
      );
      return detailWithQueues(ctx, userId, input.treeId);
    }),

  createTree: protectedProcedure
    .input(
      z.object({
        prompt: z.string().min(1),
        title: z.string().optional(),
        model: z.string(),
        /** Reasoning effort accepted by the model; defaults to null if omitted. */
        effort: z.string().nullish(),
        workspaceId: z.string(),
        /** Ids from `POST /api/images`. */
        images: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ResearchTreeDetail> => {
      assertModelUsable(ctx, input.model);
      assertEffortAccepted(input.model, input.effort);
      assertWithinDailyLimits(ctx);
      assertQueueHasRoom(ctx);
      const images = resolveImageAttachments(ctx.db, ctx.user.id, input.images);
      assertModelReadsImages(input.model, images);
      // Resolve linked post attachments before node creation so snapshots are
      // recorded on the initial row (`journal/attachments.ts`). Check admission
      // limits first to avoid unnecessary fetch operations if rejected.
      const attachments = [
        ...(await resolveMessageAttachments(
          { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger },
          input.prompt,
        )),
        ...images,
      ];
      // Re-verify limits in the write transaction in case concurrent requests
      // were admitted during attachment resolution.
      const { detail, node } = admitWithinLimits(ctx, (db) => {
        const admitted = repo(() =>
          trees.admitRoot(db, ctx.user.id, {
            workspaceId: input.workspaceId,
            type: "exchange",
            message: {
              text: input.prompt,
              ...(attachments.length === 0 ? {} : { attachments }),
            },
            agent: { model: input.model, effort: input.effort ?? null },
            ...(input.title === undefined ? {} : { title: input.title }),
          }),
        );
        const root = required(admitted.nodes[0], "the new thread has no root node");
        queueRun(db, ctx.user.id, root.id, input.model);
        return { detail: admitted, node: root };
      });
      ctx.runs.start(node.id);
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
      // Handled via `repo` to convert validation errors into `BAD_REQUEST`.
      const detail = repo(() =>
        researchDocuments.importReport(ctx.db, ctx.user.id, {
          workspaceId: input.workspaceId,
          prompt: input.prompt,
          markdown,
          // Reports are imported externally. Follow-up runs use the metadata model
          // by default, which also generates the summary.
          agent: { model: METADATA_MODEL_ID },
        }),
      );
      const root = required(detail.nodes[0], "the imported thread has no root node");
      publish(ctx, "research.tree.created", { tree: detail.tree, node: root });
      emitFeedItemUpsertedForNode(ctx, root.id);
      // Schedule a recap generation for the imported document.
      scheduleDocumentRecap(ctx, root.id);
      return detail;
    }),

  renameTree: protectedProcedure
    .input(z.object({ treeId: z.string(), title: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const tree = repo(() => trees.rename(ctx.db, ctx.user.id, input.treeId, input.title));
      publishTree(ctx, "research.tree.updated", tree);
      return tree;
    }),

  markTreeViewed: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const tree = repo(() => trees.markViewed(ctx.db, ctx.user.id, input.treeId));
      publish(ctx, "research.tree.updated", { tree });
      return tree;
    }),

  /** Archives the thread and its descendant child threads. */
  archiveTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() => trees.archiveGroup(ctx.db, ctx.user.id, input.treeId));
      for (const tree of [...change.children, change.tree]) {
        // Archiving by owner archives the thread globally; archiving by a member archives only their view.
        if (tree.role === "owner") publishTree(ctx, "research.tree.archived", tree);
        else publish(ctx, "research.tree.archived", { tree });
      }
      for (const item of change.removedFeedItems) emitFeedItemRemoved(ctx, item);
      return change.tree;
    }),

  /** Restores the archived thread and its descendant child threads. */
  restoreTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() => trees.restoreGroup(ctx.db, ctx.user.id, input.treeId));
      for (const tree of [...change.children, change.tree]) {
        if (tree.role !== "owner") {
          publish(ctx, "research.tree.restored", { tree });
          continue;
        }
        publishTree(ctx, "research.tree.restored", tree);
        emitFeedItemUpsertedForNode(ctx, tree.rootNodeId);
        // Dispatch queued follow-ups when a thread is restored.
        dispatchFollowups(ctx, tree.id);
      }
      return change.tree;
    }),

  /** Deletes the thread permanently, including child threads. For non-owner
   * members, this operation leaves the shared thread rather than deleting it
   * for other users. */
  removeTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const removed = repo(() => trees.remove(ctx.db, ctx.user.id, input.treeId));
      // Threads are hidden immediately; background deletion cleans up remaining records.
      if (!removed.departure) ctx.deletions.kick();
      if (removed.departure) {
        // When a member leaves, cancel their queued follow-ups and active runs,
        // matching `sharing.leave` behavior.
        afterDeparture(ctx, removed.departure);
      } else {
        // Notify thread members and active viewers of thread deletion before
        // access records are removed.
        for (const treeId of removed.treeIds) {
          const event = sessionEvent("research.tree.removed", {
            treeId,
            removedBy: ctx.user.id,
          });
          const told = [ctx.user.id, ...(removed.memberIds[treeId] ?? [])];
          ctx.eventBus.emitToUsers(told, event);
          ctx.eventBus.emitToOpenReaders(treeId, event, told);
          ctx.eventBus.refreshAudience(treeId);
        }
      }
      for (const item of removed.removedFeedItems) emitFeedItemRemoved(ctx, item);

      if (removed.trashed) {
        publish(ctx, "research.trash.changed", { workspaceId: removed.workspaceId });
      }
      return { ok: true, treeIds: removed.treeIds };
    }),
};
