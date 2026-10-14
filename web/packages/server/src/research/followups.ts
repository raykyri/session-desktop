// Dispatch of the follow-up queue (`followup_queue`, `repos/followups.ts`):
// sending a chain's first queued follow-up once the chain can take it.
//
// Dispatch runs for a whole thread after anything that can free a chain: a
// run settling (`runs/service.ts`), a branch removal, a chain-order change, a
// thread leaving the archive or the Trash, a queued item being cancelled or
// retried; and for every thread on boot. Archived threads and threads in the
// Trash are skipped; their queues wait until the thread is restored.
//
// The send is checked against the item's author, not the thread's owner: the
// author pays for the run. A refused send (a daily limit, a model the author
// can no longer use, a full run queue) records `failed_reason` on the item,
// and the chain's queue waits on it until the item is retried or cancelled,
// as the desktop's client-side queue does.

import type { SessionDatabase } from "@session/db";
import { feedItems, followups, users } from "@session/db";
import type { ResearchNode } from "@session/shared";
import { DEFAULT_MODEL_ID } from "@session/shared";

import type { Config } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { sessionEvent } from "../events/bus.js";
import { emitFeedItemUpsertedForNode } from "../events/feed.js";
import type { Logger } from "../logger.js";
import type { RunsService } from "../runs/service.js";

import { launchRefusal, queuePositionOf } from "./admission.js";

export interface FollowupDeps {
  config: Config;
  db: SessionDatabase;
  eventBus: EventBus;
  logger?: Logger | undefined;
  runs: Pick<RunsService, "start">;
}

/** The message stored when the account that queued an item is gone. */
export const AUTHOR_MISSING = "The account that asked this follow-up no longer exists.";

/** `research.queue.changed` with the chain's whole queue after a change. */
export function publishQueue(
  deps: Pick<FollowupDeps, "db" | "eventBus">,
  ownerId: string,
  treeId: string,
  headNodeId: string,
): void {
  deps.eventBus.emit(
    ownerId,
    sessionEvent("research.queue.changed", {
      treeId,
      headNodeId,
      items: followups.listForHead(deps.db, ownerId, headNodeId),
    }),
  );
}

/** The events a follow-up admitted from the queue (or sent at once by
 * `followups.ask`) publishes, the same ones `research.forkNode` does. */
export function publishAdmittedFollowup(
  deps: Pick<FollowupDeps, "db" | "eventBus">,
  ownerId: string,
  node: ResearchNode,
): void {
  deps.eventBus.emit(ownerId, sessionEvent("research.node.created", { node }));
  const queuePosition = queuePositionOf({ db: deps.db, user: { id: ownerId } }, node.id);
  deps.eventBus.emit(
    ownerId,
    sessionEvent("research.node.updated", {
      node,
      ...(queuePosition === undefined ? {} : { queuePosition }),
    }),
  );
  const feedItem = feedItems.forTree(deps.db, node.treeId);
  if (feedItem) emitFeedItemUpsertedForNode(deps, feedItem.id);
}

/**
 * Sends the chain's first queued follow-up if the chain can take it now.
 * Returns the admitted node, or null when the chain waits (or the send was
 * refused and recorded on the item).
 */
export function dispatchChain(
  deps: FollowupDeps,
  chain: followups.PendingChain,
): ResearchNode | null {
  const { db } = deps;
  const step = followups.nextStep(db, chain.ownerId, chain.headNodeId);
  if (step.kind === "clear") {
    if (followups.clear(db, chain.headNodeId) > 0) {
      publishQueue(deps, chain.ownerId, chain.treeId, chain.headNodeId);
    }
    return null;
  }
  if (step.kind === "wait") {
    return null;
  }
  const { item, tailId } = step;
  const author = users.findById(db, item.authorId);
  const refusal =
    author === null
      ? { message: AUTHOR_MISSING }
      : launchRefusal(
          { config: deps.config, db, user: author },
          item.agent.model ?? DEFAULT_MODEL_ID,
        );
  if (refusal !== null) {
    followups.markFailed(db, item.id, refusal.message);
    publishQueue(deps, chain.ownerId, chain.treeId, chain.headNodeId);
    return null;
  }
  let node: ResearchNode;
  try {
    node = followups.send(db, chain.ownerId, item.id, tailId).node;
  } catch (error) {
    // `send` refuses when the chain moved since `nextStep` read it; the next
    // trigger reads it again. An error that is not that would refuse every
    // later attempt too, so it is recorded on the item instead of retried.
    const again = followups.nextStep(db, chain.ownerId, chain.headNodeId);
    if (again.kind === "send" && again.item.id === item.id && again.tailId === tailId) {
      const message = error instanceof Error ? error.message : String(error);
      followups.markFailed(db, item.id, message);
      publishQueue(deps, chain.ownerId, chain.treeId, chain.headNodeId);
    } else {
      deps.logger?.info({ itemId: item.id, error }, "queued follow-up not sent: chain changed");
    }
    return null;
  }
  publishAdmittedFollowup(deps, chain.ownerId, node);
  publishQueue(deps, chain.ownerId, chain.treeId, chain.headNodeId);
  deps.runs.start(node.id);
  return node;
}

/** Dispatches every chain with a queue in one thread. */
export function dispatchTree(deps: FollowupDeps, treeId: string): ResearchNode[] {
  return dispatchChains(deps, followups.pendingChains(deps.db, { treeId }));
}

/** Dispatches every chain with a queue: on boot, after reconciliation. */
export function dispatchAll(deps: FollowupDeps): ResearchNode[] {
  return dispatchChains(deps, followups.pendingChains(deps.db));
}

function dispatchChains(
  deps: FollowupDeps,
  chains: readonly followups.PendingChain[],
): ResearchNode[] {
  const sent: ResearchNode[] = [];
  for (const chain of chains) {
    try {
      const node = dispatchChain(deps, chain);
      if (node) sent.push(node);
    } catch (error) {
      // One chain's failure must not stop the others, nor the caller (a run
      // settling, a procedure that already committed).
      deps.logger?.error({ headNodeId: chain.headNodeId, error }, "follow-up dispatch failed");
    }
  }
  return sent;
}
