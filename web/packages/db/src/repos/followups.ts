// The follow-up queue (`followup_queue`): questions asked at the end of an
// inline chain while it could not take one, in the order they are sent. Who
// asked (`author_id`) is who the run is billed to.
//
// The read side is here; step 2.7 of the desktop-parity plan adds asking
// (send now or append, in one transaction), cancel, retry, and the dispatch
// that sends the head item when a chain frees up.

import type { UserMessage } from "@session/shared";
import { userMessageSchema } from "@session/shared";
import { and, asc, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { parseWireColumn } from "../json.js";
import { followupQueue } from "../schema/followups.js";
import { trees } from "../schema/trees.js";

/** One queued follow-up. */
export interface FollowupItem {
  id: string;
  treeId: string;
  headNodeId: string;
  authorId: string;
  message: UserMessage;
  model: string;
  effort: string | null;
  position: number;
  createdAt: number;
  /** Why the last send was refused; the queue waits on this item. */
  failedReason: string | null;
}

function toItem(row: typeof followupQueue.$inferSelect): FollowupItem {
  return {
    id: row.id,
    treeId: row.treeId,
    headNodeId: row.headNodeId,
    authorId: row.authorId,
    message: parseWireColumn<UserMessage>(
      userMessageSchema,
      row.messageJson,
      "followup_queue.message_json",
    ),
    model: row.model,
    effort: row.effort,
    position: row.position,
    createdAt: row.createdAt,
    failedReason: row.failedReason,
  };
}

/** A tree's queues, keyed by chain head, each in send order. */
export function listForTree(
  db: SessionDatabase,
  userId: string,
  treeId: string,
): Record<string, FollowupItem[]> {
  const queues: Record<string, FollowupItem[]> = {};
  for (const row of db
    .select({ item: followupQueue })
    .from(followupQueue)
    .innerJoin(trees, eq(trees.id, followupQueue.treeId))
    .where(and(eq(trees.ownerId, userId), eq(followupQueue.treeId, treeId)))
    .orderBy(asc(followupQueue.headNodeId), asc(followupQueue.position), asc(followupQueue.id))
    .all()) {
    const item = toItem(row.item);
    (queues[item.headNodeId] ??= []).push(item);
  }
  return queues;
}
