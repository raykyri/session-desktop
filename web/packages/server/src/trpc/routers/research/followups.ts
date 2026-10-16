// The follow-up queue (`followups.*`): follow-up questions submitted at the end
// of a conversation chain. Questions execute immediately if the chain is idle or
// are queued on the server and processed sequentially as preceding runs complete
// (`research/followups.ts`).

import type { SessionDatabase } from "@session/db";
import { followups, trees } from "@session/db";
import type { ResearchFollowupQueueItem, ResearchNode } from "@session/shared";
import { nodeEffort, nodeModelId } from "@session/shared";
import { z } from "zod";

import { resolveMessageAttachments } from "../../../journal/attachments.js";
import { requireNodeRole } from "../../../research/access.js";
import {
  admitWithinLimits,
  assertEffortAccepted,
  assertModelUsable,
  assertQueueHasRoom,
  assertWithinDailyLimits,
} from "../../../research/admission.js";
import { publishAdmittedFollowup, publishQueue } from "../../../research/followups.js";
import { assertModelReadsImages, resolveImageAttachments } from "../../../research/images.js";
import { protectedProcedure } from "../../base.js";
import { repo, required } from "../../errors.js";

import { dispatchFollowups } from "./common.js";

export type AskFollowupResult =
  { kind: "sent"; node: ResearchNode } | { kind: "queued"; item: ResearchFollowupQueueItem };

/** The terminal node of the chain containing `nodeId`, which a new follow-up
 * continues and from which unspecified agent settings are inherited. Queries
 * only the chain (`followups.chainTail`) rather than full thread detail. */
function chainTail(ctx: { db: SessionDatabase }, userId: string, nodeId: string): ResearchNode {
  return required(
    repo(() => followups.chainTail(ctx.db, userId, nodeId)),
    `research node ${nodeId} was not found`,
  );
}

export const followupProcedures = {
  /**
   * Submits a follow-up question at the end of the chain identified by
   * `headNodeId`. Executes immediately if the queue is empty and the preceding
   * answer is complete; queued otherwise. Inherits the preceding node's agent
   * settings when omitted.
   */
  ask: protectedProcedure
    .input(
      z.object({
        headNodeId: z.string(),
        prompt: z.string().min(1),
        model: z.string().optional(),
        effort: z.string().nullish(),
        /** Ids from `POST /api/images`, resolved now and stored on the queued
         * item's message. */
        images: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<AskFollowupResult> => {
      // Viewers cannot submit follow-ups; rejected before resolving attachments or verifying limits.
      requireNodeRole(ctx, input.headNodeId, "commenter");
      const tail = chainTail(ctx, ctx.user.id, input.headNodeId);
      const model = input.model ?? nodeModelId(tail);
      const effort =
        input.effort !== undefined
          ? input.effort
          : model === nodeModelId(tail)
            ? nodeEffort(tail)
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
      // were admitted while attachments resolved.
      const result = admitWithinLimits(ctx, (db) =>
        repo(() =>
          followups.ask(db, ctx.user.id, {
            headNodeId: input.headNodeId,
            message: {
              text: input.prompt,
              ...(attachments.length === 0 ? {} : { attachments }),
            },
            agent: { model, effort },
            ...(ctx.user.isAdmin ? {} : { maxQueued: ctx.config.limits.queuedPerUser }),
          }),
        ),
      );
      if (result.kind === "sent") {
        publishAdmittedFollowup(ctx, ctx.user.id, result.node);
        ctx.runs.start(result.node.id);
        return { kind: "sent", node: result.node };
      }
      publishQueue(ctx, ctx.user.id, result.item.treeId, result.headNodeId);
      return { kind: "queued", item: result.item };
    }),

  /** Removes a queued follow-up and returns the updated chain queue. */
  cancel: protectedProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(({ ctx, input }): ResearchFollowupQueueItem[] => {
      const item = repo(() => followups.cancel(ctx.db, ctx.user.id, input.itemId));
      publishQueue(ctx, ctx.user.id, item.treeId, item.headNodeId);
      // The cancelled item may have been blocking subsequent queued follow-ups.
      dispatchFollowups(ctx, item.treeId);
      return repo(() => followups.listForHead(ctx.db, ctx.user.id, item.headNodeId));
    }),

  /** Clears a rejected follow-up's error state and retries queue processing.
   * Returns the updated chain queue. */
  retry: protectedProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(({ ctx, input }): ResearchFollowupQueueItem[] => {
      const item = repo(() => followups.retry(ctx.db, ctx.user.id, input.itemId));
      publishQueue(ctx, ctx.user.id, item.treeId, item.headNodeId);
      dispatchFollowups(ctx, item.treeId);
      return repo(() => followups.listForHead(ctx.db, ctx.user.id, item.headNodeId));
    }),

  /** Returns queued follow-ups for a thread, grouped by chain head in execution order. */
  list: protectedProcedure
    .input(z.object({ treeId: z.string() }))
    .query(({ ctx, input }): Record<string, ResearchFollowupQueueItem[]> => {
      required(
        repo(() => trees.get(ctx.db, ctx.user.id, input.treeId)),
        `research tree ${input.treeId} was not found`,
      );
      return repo(() => followups.listForTree(ctx.db, ctx.user.id, input.treeId));
    }),
};
