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
  assertEffortAccepted,
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
  enqueueRun,
  queuePositionOf,
  scheduleDocumentRecap,
} from "../../../research/admission.js";
import {
  assertModelReadsImages,
  markImagesAttached,
  resolveImageAttachments,
} from "../../../research/images.js";
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
      // A guest's list is the public catalog: every account's public
      // threads.
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
      // Anyone who may read the thread: its owner, its members, and anyone,
      // guests included, for a public thread (`access.treeAccess`).
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
        /** A reasoning effort the model accepts; absent or null, its default. */
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
      // The posts the question links to are resolved before the node exists,
      // so the snapshot is on the row the run and every later reader see
      // (`journal/attachments.ts`). Admission is checked first: a launch that
      // is going to be refused should not spend a fetch.
      const attachments = [
        ...(await resolveMessageAttachments(
          { db: ctx.db, fetch: ctx.fetch, logger: ctx.logger },
          input.prompt,
        )),
        ...images,
      ];
      const detail = repo(() =>
        trees.admitRoot(ctx.db, ctx.user.id, {
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
      const node = required(detail.nodes[0], "the new thread has no root node");
      markImagesAttached(ctx.db, images);
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
      // The report's recap, as the desktop schedules one after an import.
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

  /** Archives the thread with the children listed under it. */
  archiveTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }): ResearchTree => {
      const change = repo(() => trees.archiveGroup(ctx.db, ctx.user.id, input.treeId));
      for (const tree of [...change.children, change.tree]) {
        // The owner's Archive is the thread's; a member's is their own.
        if (tree.role === "owner") publishTree(ctx, "research.tree.archived", tree);
        else publish(ctx, "research.tree.archived", { tree });
      }
      for (const item of change.removedFeedItems) emitFeedItemRemoved(ctx, item);
      return change.tree;
    }),

  /** Unarchives the thread with its children in the Archive. */
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
        // Queues wait while their thread is archived.
        dispatchFollowups(ctx, tree.id);
      }
      return change.tree;
    }),

  /** Deletes the thread now, in or out of the Trash, with the children
   * listed under it. For a member, Delete leaves the thread instead: it
   * stays for everyone else. */
  removeTree: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .mutation(({ ctx, input }) => {
      const removed = repo(() => trees.remove(ctx.db, ctx.user.id, input.treeId));
      if (removed.departure) {
        // A member left: their queued follow-ups are gone and their running
        // questions stop, as for `sharing.leave`.
        afterDeparture(ctx, removed.departure);
      } else {
        // The members of every deleted tree, the children that went with
        // it included, were read before the delete took their access; the
        // other readers who had a deleted public thread open are told too.
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
