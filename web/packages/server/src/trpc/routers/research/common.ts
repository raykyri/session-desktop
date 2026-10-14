// Helpers the `research` procedure files share.

import { followups, nodes, queue, sharing, trees } from "@session/db";
import type { ResearchNode, ResearchTree, ResearchTreeDetail } from "@session/shared";

import { sessionEvent } from "../../../events/bus.js";
import { sharedTree } from "../../../research/access.js";
import type { FollowupDeps } from "../../../research/followups.js";
import { dispatchTree, publishQueue } from "../../../research/followups.js";
import type { AppContext } from "../../base.js";
import type { EmitterContext } from "../../emit.js";
import { publish, publishToTree } from "../../emit.js";
import { repo } from "../../errors.js";

/** The error a departed member's stopped question shows. */
export const DEPARTED_ASKER_STOPPED =
  "Stopped: the person who asked no longer has access to this thread.";

/**
 * After a member's queued follow-ups were deleted (`sharing.setRole` to
 * viewer, and every departure): the changed queues are announced, and the
 * thread's queues dispatch again, since a deleted item may have been the
 * one a chain waited on.
 */
export function afterQueuedFollowupsDropped(
  ctx: EmitterContext,
  treeId: string,
  dropped: sharing.QueuedFollowupsDropped,
): void {
  for (const headNodeId of dropped.changedHeadNodeIds) {
    publishQueue(ctx, ctx.user.id, treeId, headNodeId);
  }
  if (dropped.changedHeadNodeIds.length > 0) {
    dispatchFollowups(ctx, treeId);
  }
}

/**
 * After a member leaves or is removed (`sharing.leave`, `removeMember`, and
 * a member's Delete or Empty Trash): their queued follow-ups are gone (the
 * queues are announced and dispatch again) and their running questions are
 * stopped, since they can no longer read the thread. They are told the
 * thread is gone, and the rest of the audience that its members changed.
 */
export function afterDeparture(ctx: EmitterContext, departure: sharing.Departure): void {
  const { treeId, memberId } = departure;
  const ownerId = treeAudienceIds(ctx, treeId)[0];
  for (const nodeId of departure.activeNodeIds) {
    if (ownerId === undefined) break;
    try {
      const node = nodes.setStatus(ctx.db, ownerId, nodeId, "cancelled", {
        error: DEPARTED_ASKER_STOPPED,
      });
      queue.release(ctx.db, nodeId);
      queue.wakeChildrenOf(ctx.db, nodeId);
      ctx.runs.cancel(nodeId);
      publishToTree(ctx, treeId, "research.node.updated", { node });
    } catch (error) {
      ctx.logger.warn({ nodeId, error }, "could not stop a departed member's run");
    }
  }
  for (const headNodeId of departure.changedHeadNodeIds) {
    publishQueue(ctx, ctx.user.id, treeId, headNodeId);
  }
  // After the stops, so each chain is read as it is now.
  dispatchFollowups(ctx, treeId);
  ctx.eventBus.emitToUsers(
    [memberId],
    sessionEvent("research.tree.removed", { treeId, removedBy: ctx.user.id }),
  );
  publishSharingChanged(ctx, treeId, [memberId, ...treeAudienceIds(ctx, treeId)]);
}

/** Publishes `research.node.updated` for the node a mutation just changed,
 * with its queue position while it waits for admission. */
export function publishNode(
  ctx: Parameters<typeof publish>[0],
  node: ResearchNode,
  queuePosition?: number,
): void {
  publishToTree(ctx, node.treeId, "research.node.updated", {
    node,
    ...(queuePosition === undefined ? {} : { queuePosition }),
  });
}

/**
 * A thread-level tree event (`research.tree.updated`, `archived`,
 * `restored`): the caller's own view to the caller, and the tree without
 * per-person fields to the rest of the audience.
 */
export function publishTree(
  ctx: Parameters<typeof publish>[0],
  type: string,
  tree: ResearchTree,
): void {
  publishTreeEvent(ctx, type, { tree });
}

/**
 * A thread event whose payload carries the tree as the caller read it (the
 * tree events, `research.document.updated`): the payload as it is to the
 * caller, and with `sharedTree(tree)` to the rest of the audience.
 */
export function publishTreeEvent(
  ctx: Parameters<typeof publish>[0],
  type: string,
  payload: Record<string, unknown> & { tree: ResearchTree },
): void {
  publish(ctx, type, payload);
  ctx.eventBus.emitToTree(
    payload.tree.id,
    sessionEvent(type, { ...payload, tree: sharedTree(payload.tree) }),
    [],
    [ctx.user.id],
  );
}

/** The owner and members of a thread, read before a change that may take it
 * away from them (a delete, the owner's Trash), so they can be told after. */
export function treeAudienceIds(ctx: { db: AppContext["db"] }, treeId: string): string[] {
  const audience = sharing.audience(ctx.db, treeId);
  return audience ? [audience.ownerId, ...audience.memberIds] : [];
}

/** Tells people their access to a thread changed (`research.sharing.changed`,
 * web only): they refetch their lists and the thread. */
export function publishSharingChanged(
  ctx: { eventBus: AppContext["eventBus"] },
  treeId: string,
  userIds: readonly string[],
): void {
  ctx.eventBus.emitToUsers(userIds, sessionEvent("research.sharing.changed", { treeId }));
}

/** What the follow-up queue's dispatch needs from a procedure's context. */
export function followupDeps(ctx: AppContext): FollowupDeps {
  return {
    config: ctx.config,
    db: ctx.db,
    eventBus: ctx.eventBus,
    logger: ctx.logger,
    runs: ctx.runs,
  };
}

/** Sends what the thread's follow-up queues can send after a mutation that
 * may have freed a chain. Called after the mutation's own events. */
export function dispatchFollowups(ctx: AppContext, treeId: string): void {
  dispatchTree(followupDeps(ctx), treeId);
}

/** A thread's detail with its follow-up queues (`ResearchTreeDetail.queues`). */
export function detailWithQueues(
  ctx: { db: AppContext["db"] },
  userId: string | null,
  treeId: string,
): ResearchTreeDetail {
  const detail = repo(() => trees.detail(ctx.db, userId, treeId));
  const queues = repo(() => followups.listForTree(ctx.db, userId, treeId));
  return Object.keys(queues).length === 0 ? detail : { ...detail, queues };
}
