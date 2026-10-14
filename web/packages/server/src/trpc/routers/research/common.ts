// Helpers the `research` procedure files share.

import { followups, sharing, trees } from "@session/db";
import type { ResearchNode, ResearchTree, ResearchTreeDetail } from "@session/shared";

import { sessionEvent } from "../../../events/bus.js";
import { sharedTree } from "../../../research/access.js";
import type { FollowupDeps } from "../../../research/followups.js";
import { dispatchTree } from "../../../research/followups.js";
import type { AppContext } from "../../base.js";
import { publish, publishToTree } from "../../emit.js";
import { repo } from "../../errors.js";

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
  publish(ctx, type, { tree });
  ctx.eventBus.emitToTree(
    tree.id,
    sessionEvent(type, { tree: sharedTree(tree) }),
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
