// Helpers the `research` procedure files share.

import { followups, trees } from "@session/db";
import type { ResearchNode, ResearchTreeDetail } from "@session/shared";

import type { FollowupDeps } from "../../../research/followups.js";
import { dispatchTree } from "../../../research/followups.js";
import type { AppContext } from "../../base.js";
import { publish } from "../../emit.js";
import { repo } from "../../errors.js";

/** Publishes `research.node.updated` for the node a mutation just changed,
 * with its queue position while it waits for admission. */
export function publishNode(
  ctx: Parameters<typeof publish>[0],
  node: ResearchNode,
  queuePosition?: number,
): void {
  publish(ctx, "research.node.updated", {
    node,
    ...(queuePosition === undefined ? {} : { queuePosition }),
  });
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
  userId: string,
  treeId: string,
): ResearchTreeDetail {
  const detail = repo(() => trees.detail(ctx.db, userId, treeId));
  const queues = repo(() => followups.listForTree(ctx.db, userId, treeId));
  return Object.keys(queues).length === 0 ? detail : { ...detail, queues };
}
