// The follow-up queue (`followup_queue`): questions asked at the end of an
// inline chain while it could not take one, in the order they are sent. Who
// asked (`author_id`) is who the run is billed to. It replaces the desktop's
// client-side queue (`useResearchChainQueue`), and decides what to do with
// the desktop's own rules: `researchQueueAction` in the shared
// `researchBranchView`, over the tree's nodes as the client sees them.
//
// Asking sends at once when the chain can take a follow-up and nothing is
// queued ahead; otherwise it appends. Sending the head item later is two
// steps: `nextStep` says whether the head item can go, the server checks the
// author's limits, then `send` admits the node and removes the item in one
// transaction, re-checking that nothing changed in between.

import type { ResearchFollowupQueueItem, ResearchNode, UserMessage } from "@session/shared";
import { agentSpecFor, findModel, userMessageSchema } from "@session/shared";
import type { QueuedResearchFollowup } from "@session/shared/lib/researchBranchView";
import { researchQueueAction, researchQueueStep } from "@session/shared/lib/researchBranchView";
import { inlineChainFor } from "@session/shared/lib/researchChains";
import { nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { parseWireColumn } from "../json.js";
import { followupQueue } from "../schema/followups.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import {
  ACCESS_MESSAGES,
  TreeAccessError,
  nodeReadableBy,
  rejectTrashed,
  rejectTrashedNode,
  requireNodeAccess,
  requireTreeAccess,
  roleAtLeast,
  treeAccess,
  treeReadableBy,
} from "./access.js";
import { admitChild } from "./nodes.js";
import { enqueue } from "./queue.js";
import type { NodeAgentInput } from "./trees.js";
import { detail } from "./trees.js";

/** One queued follow-up, as the wire sends it. */
export type FollowupItem = ResearchFollowupQueueItem;

type FollowupRow = typeof followupQueue.$inferSelect;

function toItem(row: FollowupRow): FollowupItem {
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
    agent: agentSpecFor(row.model, row.effort),
    position: row.position,
    createdAt: row.createdAt,
    failedReason: row.failedReason,
  };
}

/** The shape the shared queue rules read. Only the first item's `failed`
 * matters to them. */
function asQueued(item: FollowupItem): QueuedResearchFollowup {
  return {
    id: item.id,
    prompt: item.message.text,
    createdAt: item.createdAt,
    ...(item.failedReason === null ? {} : { failed: item.failedReason }),
  };
}

function rowsForHead(db: SessionDatabase, headNodeId: string): FollowupRow[] {
  return db
    .select()
    .from(followupQueue)
    .where(eq(followupQueue.headNodeId, headNodeId))
    .orderBy(asc(followupQueue.position), asc(followupQueue.id))
    .all();
}

/** A tree's queues, keyed by chain head, each in send order. */
export function listForTree(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
): Record<string, FollowupItem[]> {
  const queues: Record<string, FollowupItem[]> = {};
  for (const row of db
    .select({ item: followupQueue })
    .from(followupQueue)
    .innerJoin(trees, eq(trees.id, followupQueue.treeId))
    .where(and(treeReadableBy(userId), eq(followupQueue.treeId, treeId)))
    .orderBy(asc(followupQueue.headNodeId), asc(followupQueue.position), asc(followupQueue.id))
    .all()) {
    const item = toItem(row.item);
    (queues[item.headNodeId] ??= []).push(item);
  }
  return queues;
}

/** One chain's queue in send order; empty when the caller cannot read the
 * thread or nothing is queued. */
export function listForHead(
  db: SessionDatabase,
  userId: string | null,
  headNodeId: string,
): FollowupItem[] {
  return db
    .select({ item: followupQueue })
    .from(followupQueue)
    .innerJoin(trees, eq(trees.id, followupQueue.treeId))
    .where(and(treeReadableBy(userId), eq(followupQueue.headNodeId, headNodeId)))
    .orderBy(asc(followupQueue.position), asc(followupQueue.id))
    .all()
    .map((row) => toItem(row.item));
}

/** How many follow-ups `authorId` has waiting across every queue. */
export function countByAuthor(db: SessionDatabase, authorId: string): number {
  return (
    db
      .select({ value: sql<number>`count(*)` })
      .from(followupQueue)
      .where(eq(followupQueue.authorId, authorId))
      .get()?.value ?? 0
  );
}

/** The desktop's ask-box notes for a chain whose last answer stopped
 * (`researchChainComposerState`). */
export const STALLED_TAIL_MESSAGES = {
  failed: "The last answer stopped with an error. Retry it or edit its question to continue.",
  stopped: "The last answer was stopped. Run it again to continue.",
} as const;

/** Why a follow-up cannot be asked at the end of the chain `headNodeId`
 * heads: its last answer stopped (`researchQueueStep` "stalled"), or was
 * interrupted and will not resume (web only: the server gave up resuming
 * it). Null when it can be asked or queued. */
function stalledTailMessage(treeNodes: readonly ResearchNode[], headNodeId: string): string | null {
  const chain = inlineChainFor([...treeNodes], headNodeId);
  const tailId = chain[chain.length - 1];
  const tail = treeNodes.find((node) => node.id === tailId) ?? null;
  if (!tail) {
    return null;
  }
  const status = nodeStatus(tail);
  if (status === "interrupted") {
    return tail.type === "exchange" && tail.run.resumePending !== true
      ? STALLED_TAIL_MESSAGES.failed
      : null;
  }
  if (researchQueueStep(tail) !== "stalled") {
    return null;
  }
  return status === "failed" ? STALLED_TAIL_MESSAGES.failed : STALLED_TAIL_MESSAGES.stopped;
}

/** Whether the author of a queued item may still ask in its thread: they
 * read it as its owner or a commenter. A member made a viewer may not; their
 * items are dropped then (`sharing.setRole`), and dispatch checks again. */
export function authorMayAsk(
  db: SessionDatabase,
  item: Pick<FollowupItem, "authorId" | "treeId">,
): boolean {
  const access = treeAccess(db, item.authorId, item.treeId);
  return access !== null && roleAtLeast(access.role, "commenter");
}

/** A chain's head as the client computes it, from any node in the chain. */
function headOf(treeNodes: readonly ResearchNode[], nodeId: string): string {
  return inlineChainFor(treeNodes, nodeId)[0] ?? nodeId;
}

interface ThreadState {
  ownerId: string;
  treeId: string;
  headNodeId: string;
  archived: boolean;
  trashedAt: number | null;
  treeNodes: ResearchNode[];
}

function threadState(db: SessionDatabase, userId: string, nodeId: string): ThreadState {
  const row = db
    .select({
      treeId: nodes.treeId,
      ownerId: trees.ownerId,
      archivedAt: trees.archivedAt,
      trashedAt: trees.trashedAt,
    })
    .from(nodes)
    .innerJoin(trees, eq(trees.id, nodes.treeId))
    .where(and(nodeReadableBy(userId), eq(nodes.id, nodeId)))
    .get();
  if (!row) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  const treeNodes = detail(db, userId, row.treeId).nodes;
  return {
    ownerId: row.ownerId,
    treeId: row.treeId,
    headNodeId: headOf(treeNodes, nodeId),
    archived: row.archivedAt !== null,
    trashedAt: row.trashedAt,
    treeNodes,
  };
}

/** Admits the follow-up as the chain tail's inline child and puts its run in
 * the run queue, inside the caller's transaction. */
function admitInline(
  tx: SessionDatabase,
  userId: string,
  input: { tailId: string; authorId: string; message: UserMessage; agent: NodeAgentInput },
): ResearchNode {
  const node = admitChild(tx, userId, {
    parentNodeId: input.tailId,
    message: input.message,
    agent: input.agent,
    inline: true,
    authorId: input.authorId,
  });
  // The run is billed to whoever asked (`run_queue.user_id`).
  enqueue(tx, input.authorId, {
    nodeId: node.id,
    pool: "research",
    // `run_queue.provider` keys the per-provider cap.
    provider: findModel(input.agent.model)?.provider ?? input.agent.model,
  });
  return node;
}

export interface AskInput {
  /** Any node of the chain; the queue is kept under the chain's head. */
  headNodeId: string;
  message: UserMessage;
  agent: NodeAgentInput;
  /** Refuses to queue when the asker already has this many follow-ups
   * waiting. Sending at once is not limited by it. */
  maxQueued?: number | undefined;
}

export type AskResult =
  | { kind: "sent"; node: ResearchNode; headNodeId: string }
  | { kind: "queued"; item: FollowupItem; headNodeId: string };

/**
 * Asks a follow-up at the end of a chain, in one transaction: when nothing is
 * queued for the chain and its last node can take a follow-up
 * (`researchQueueAction`), the follow-up is admitted as that node's inline
 * child at once; otherwise it is appended to the chain's queue.
 */
export function ask(db: SessionDatabase, userId: string, input: AskInput): AskResult {
  const text = input.message.text.trim();
  if (text === "") {
    throw new Error("research prompt cannot be empty");
  }
  const message: UserMessage = {
    text,
    ...(input.message.attachments && input.message.attachments.length > 0
      ? { attachments: input.message.attachments }
      : {}),
  };
  return transact(db, (tx) => {
    requireNodeAccess(tx, userId, input.headNodeId, "commenter");
    const state = threadState(tx, userId, input.headNodeId);
    if (state.archived) {
      throw new Error(
        "Cannot create follow-up on archived research: restore the research thread first.",
      );
    }
    rejectTrashed(state);
    const queued = rowsForHead(tx, state.headNodeId);
    if (queued.length === 0) {
      const probe: QueuedResearchFollowup = { id: "", prompt: text, createdAt: 0 };
      const action = researchQueueAction(state.treeNodes, state.headNodeId, [probe], undefined);
      if (action.kind === "send") {
        const node = admitInline(tx, userId, {
          tailId: action.tailId,
          authorId: userId,
          message,
          agent: input.agent,
        });
        return { kind: "sent", node, headNodeId: state.headNodeId };
      }
      // A question would wait behind an answer that stopped and will not
      // complete on its own; the desktop's ask box refuses it with these
      // words (`researchChainComposerState`). Behind queued items it is
      // queued, as there.
      const stalled = stalledTailMessage(state.treeNodes, state.headNodeId);
      if (stalled !== null) {
        throw new Error(stalled);
      }
    }
    if (input.maxQueued !== undefined && countByAuthor(tx, userId) >= input.maxQueued) {
      throw new Error(
        `You already have ${input.maxQueued} follow-ups queued. Wait for them to be sent before queueing more.`,
      );
    }
    const last = queued[queued.length - 1];
    const row = tx
      .insert(followupQueue)
      .values({
        id: newId(),
        treeId: state.treeId,
        headNodeId: state.headNodeId,
        authorId: userId,
        messageJson: message,
        model: input.agent.model,
        effort: input.agent.effort ?? null,
        position: last === undefined ? 0 : last.position + 1,
        createdAt: now(),
        failedReason: null,
      })
      .returning()
      .get();
    return { kind: "queued", item: toItem(row), headNodeId: state.headNodeId };
  });
}

/** A chain with something queued, and who owns its thread. */
export interface PendingChain {
  headNodeId: string;
  treeId: string;
  ownerId: string;
}

/**
 * The chains with queued follow-ups whose thread is neither archived nor in
 * the Trash, oldest first; all of them, or one tree's. Dispatch walks these.
 */
export function pendingChains(
  db: SessionDatabase,
  filter: { treeId?: string | undefined } = {},
): PendingChain[] {
  return db
    .selectDistinct({
      headNodeId: followupQueue.headNodeId,
      treeId: followupQueue.treeId,
      ownerId: trees.ownerId,
    })
    .from(followupQueue)
    .innerJoin(trees, eq(trees.id, followupQueue.treeId))
    .where(
      and(
        isNull(trees.archivedAt),
        isNull(trees.trashedAt),
        filter.treeId === undefined ? undefined : eq(followupQueue.treeId, filter.treeId),
      ),
    )
    .orderBy(asc(followupQueue.headNodeId))
    .all();
}

export type NextStep =
  { kind: "wait" } | { kind: "clear" } | { kind: "send"; item: FollowupItem; tailId: string };

/** What a chain's queue does next (`researchQueueAction`): send its first
 * item as the tail's inline follow-up, wait, or clear (its head is gone). A
 * failed first item, an archived or trashed thread, and a tail that cannot
 * take a follow-up all wait. */
export function nextStep(db: SessionDatabase, userId: string, headNodeId: string): NextStep {
  const items = listForHead(db, userId, headNodeId);
  if (items.length === 0) {
    return { kind: "wait" };
  }
  let state: ThreadState;
  try {
    state = threadState(db, userId, headNodeId);
  } catch {
    return { kind: "clear" };
  }
  if (state.archived || state.trashedAt !== null) {
    return { kind: "wait" };
  }
  const action = researchQueueAction(state.treeNodes, headNodeId, items.map(asQueued), undefined);
  if (action.kind !== "send") {
    return action;
  }
  const item = items[0];
  return item ? { kind: "send", item, tailId: action.tailId } : { kind: "wait" };
}

/** Removes every item of a chain whose head is gone. The foreign key does
 * this when the head is deleted; this covers a head the caller can no longer
 * see. */
export function clear(db: SessionDatabase, headNodeId: string): number {
  return db
    .delete(followupQueue)
    .where(eq(followupQueue.headNodeId, headNodeId))
    .returning({ id: followupQueue.id })
    .all().length;
}

/**
 * Sends a chain's first item: admits it as `tailId`'s inline child, puts the
 * run in the run queue, and removes the item, in one transaction. Refuses
 * when the decision `nextStep` made no longer holds (another item is first,
 * the item failed, or the chain's tail moved); the caller re-reads the
 * chain rather than treating that as the item's failure.
 */
export function send(
  db: SessionDatabase,
  userId: string,
  itemId: string,
  tailId: string,
): { node: ResearchNode; item: FollowupItem } {
  return transact(db, (tx) => {
    const row = tx.select().from(followupQueue).where(eq(followupQueue.id, itemId)).get();
    if (!row) {
      throw new Error(`queued follow-up ${itemId} was not found`);
    }
    const step = nextStep(tx, userId, row.headNodeId);
    if (step.kind !== "send" || step.item.id !== itemId || step.tailId !== tailId) {
      throw new Error("The conversation changed before the queued follow-up was sent.");
    }
    const node = admitInline(tx, userId, {
      tailId,
      authorId: row.authorId,
      message: step.item.message,
      agent: { model: row.model, effort: row.effort },
    });
    tx.delete(followupQueue).where(eq(followupQueue.id, itemId)).run();
    return { node, item: step.item };
  });
}

/** Records why a send was refused. The chain's queue waits on the item until
 * it is retried or cancelled. */
export function markFailed(db: SessionDatabase, itemId: string, reason: string): FollowupItem {
  const row = db
    .update(followupQueue)
    .set({ failedReason: reason })
    .where(eq(followupQueue.id, itemId))
    .returning()
    .get();
  if (!row) {
    throw new Error(`queued follow-up ${itemId} was not found`);
  }
  return toItem(row);
}

/**
 * A queued item the caller may change: its author's, or for a cancel also
 * the thread owner's. Retry is the author's alone, because the author pays
 * for the run it sends. An item in a thread the caller cannot read is not
 * found.
 */
function itemRow(
  db: SessionDatabase,
  userId: string,
  itemId: string,
  action: "cancel" | "retry",
): FollowupRow {
  const row = db.select().from(followupQueue).where(eq(followupQueue.id, itemId)).get();
  const access = row ? treeAccess(db, userId, row.treeId) : null;
  if (!row || !access) {
    throw new Error(`queued follow-up ${itemId} was not found`);
  }
  if (row.authorId !== userId && !(action === "cancel" && access.role === "owner")) {
    throw new TreeAccessError(ACCESS_MESSAGES.ownFollowup);
  }
  return row;
}

/** Removes a queued follow-up; the ones after it move up. */
export function cancel(db: SessionDatabase, userId: string, itemId: string): FollowupItem {
  return transact(db, (tx) => {
    const row = itemRow(tx, userId, itemId, "cancel");
    tx.delete(followupQueue).where(eq(followupQueue.id, row.id)).run();
    return toItem(row);
  });
}

/** Clears a refused item's reason so the queue tries to send it again.
 * Refused while the thread is in the Trash, and when the author may no
 * longer ask there (a viewer). */
export function retry(db: SessionDatabase, userId: string, itemId: string): FollowupItem {
  return transact(db, (tx) => {
    const row = itemRow(tx, userId, itemId, "retry");
    requireTreeAccess(tx, userId, row.treeId, "commenter");
    rejectTrashedNode(tx, row.headNodeId);

    const updated = tx
      .update(followupQueue)
      .set({ failedReason: null })
      .where(eq(followupQueue.id, row.id))
      .returning()
      .get();
    return toItem(updated ?? row);
  });
}
