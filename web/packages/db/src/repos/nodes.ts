// Nodes: follow-up admission, the status machine, retry and resume, and boot
// reconciliation (`docs/02-domain-model-and-database.md` §5.3, §5.4, §5.7,
// `docs/05-run-lifecycle-and-streaming.md` §3, §7).

import type {
  NodeAnchor,
  ResearchBranchRemoval,
  ResearchNode,
  ResearchNodeStatus,
  UserMessage,
} from "@session/shared";
import {
  DEFAULT_MODEL_ID,
  findModel,
  sanitizeResearchTitle,
  validateHighlightAnchor,
} from "@session/shared";
import { postFormatOf } from "@session/shared/lib/researchNodeTypes";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import {
  parseJsonColumn,
  parseNullableJsonColumn,
  runOutcomeSchema,
  stringListSchema,
} from "../json.js";
import { followupQueue } from "../schema/followups.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { nodeMessages, runQueue, runTurns } from "../schema/runs.js";
import { responseSnapshots } from "../schema/snapshots.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import {
  assertMayChangeNode,
  assertMayEditText,
  assertMayRelaunch,
  nodeReadableBy,
  payerOf,
  rejectTrashed,
  requireNodeAccess,
  treeAccess,
  treeJoinedBy,
} from "./access.js";
import type { NodeAccess, TreeRole } from "./access.js";
import { upsertResearchRoot } from "./feedgen.js";
import { setRefs } from "./imageRefs.js";
import type { NodeRow, TreeRow } from "./mappers.js";
import { toResearchHighlight, toResearchNode } from "./mappers.js";
import { enqueue } from "./queue.js";
import { activeRun, deleteNodesInOrder, subtreeIdsDepthFirst } from "./subtrees.js";
import type { NodeAgentInput } from "./trees.js";
import { touchTree } from "./trees.js";

/** Terminal statuses that cannot be transitioned out of via `setStatus`.
 * Transitioning requires `resumeAttempt` or `resetForRetry`, which start a new attempt. */
const TERMINAL_STATUSES: readonly ResearchNodeStatus[] = [
  "complete",
  "failed",
  "cancelled",
  "interrupted",
];

function syncFeedItem(db: SessionDatabase, node: Pick<NodeRow, "id" | "parentNodeId">): void {
  if (node.parentNodeId === null) upsertResearchRoot(db, node.id);
}

export function isTerminalStatus(status: ResearchNodeStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Returns the run status of an exchange node. Throws if the node is not an exchange
 * or has no run. */
function runStatus(node: NodeRow): ResearchNodeStatus {
  if (node.type !== "exchange" || node.status === null) {
    throw new Error(`research node ${node.id} is a ${node.type} and has no run`);
  }
  return node.status;
}

/** Returns the model configured for a node, or the default model. */
function rowModel(node: Pick<NodeRow, "model">): string {
  return node.model ?? DEFAULT_MODEL_ID;
}

export interface AdmitChildInput {
  parentNodeId: string;
  /** `exchange` (the default) asks a question; `post` adds a follow-up note,
   * which is valid only under a post. */
  type?: "exchange" | "post" | undefined;
  message: UserMessage;
  /** Defaults to the parent's agent. The caller checks the user may use it. */
  agent?: NodeAgentInput | undefined;
  inline?: boolean | undefined;
  anchor?: NodeAnchor | null | undefined;
  nodeId?: string | undefined;
  /** Author ID when different from `userId` (such as the author of a queued follow-up in `followups.ts`). */
  authorId?: string | undefined;
  /** A failed or cancelled question replaced by this node (such as when editing a question via
   * `create_research_child_replacing`). The target must be a childless node under the same parent
   * with matching `inline` status, settled without a pending resume. It is deleted atomically
   * and the replacement inherits its position in chain ordering. */
  replacesNodeId?: string | undefined;
}

export interface AdmittedChild {
  node: ResearchNode;
  /** The replaced question ID, deleted in the same transaction. */
  replacedNodeId: string | null;
  /** The chain head whose stored order now lists the new node in place of the
   * replaced node; null when ordering is unchanged. */
  reorderedHead: ResearchNode | null;
  /** Whether queued follow-ups were transferred from the replaced branch node to
   * the new replacement node. */
  movedQueue: boolean;
}

type LoadedNode = NodeAccess;

/** Loads node access for a user with at least `minimum` role in the thread. */
function loadNode(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  minimum: TreeRole = "viewer",
): LoadedNode {
  return requireNodeAccess(db, userId, nodeId, minimum);
}

function relationsFor(db: SessionDatabase, node: NodeRow, tree: TreeRow) {
  return {
    workspaceId: tree.workspaceId,
    highlights: db
      .select()
      .from(highlights)
      .where(eq(highlights.nodeId, node.id))
      .orderBy(asc(highlights.createdAt), asc(highlights.id))
      .all()
      .map(toResearchHighlight),
  };
}

/** Retrieves a research node if `userId` (or null for public access) has read permissions. */
export function get(
  db: SessionDatabase,
  userId: string | null,
  nodeId: string,
): ResearchNode | null {
  const node = db
    .select()
    .from(nodes)
    .where(and(nodeReadableBy(userId), eq(nodes.id, nodeId)))
    .get();
  if (!node) {
    return null;
  }
  const tree = db.select().from(trees).where(eq(trees.id, node.treeId)).get();
  if (!tree) {
    return null;
  }
  return toResearchNode(node, relationsFor(db, node, tree));
}

function reload(db: SessionDatabase, userId: string, nodeId: string): ResearchNode {
  const node = get(db, userId, nodeId);
  if (!node) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  return node;
}

/** Error message returned when attempting to create a second inline follow-up under the same parent node. */
export const INLINE_SLOT_TAKEN =
  "Cannot create inline follow-up: an inline follow-up already exists for this answer.";

function isInlineSlotConflict(error: unknown): boolean {
  // SQLite names the indexed column rather than the index in the message, and
  // `nodes.parent_node_id` is unique only under `nodes_inline_child_uq`, so
  // the pair identifies that constraint unambiguously.
  return (
    error instanceof Error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message.includes("nodes.parent_node_id")
  );
}

/**
 * Creates a follow-up node under `parentNodeId` (`docs/02` §5.4): an exchange,
 * or a follow-up note under a post.
 *
 * The parent node must have completed execution, and the thread must not be
 * archived or trashed. Exactly one inline child is permitted per parent node
 * regardless of status; removing a failed continuation re-enables inline creation.
 */
export function admitChild(
  db: SessionDatabase,
  userId: string,
  input: AdmitChildInput,
): ResearchNode {
  return admitChildDetailed(db, userId, input).node;
}

/** Traverses inline parent links to find the root node of the inline chain containing `node`. */
function chainHeadRow(db: SessionDatabase, node: NodeRow): NodeRow {
  let current = node;
  const seen = new Set([current.id]);
  while (current.inline && current.parentNodeId !== null) {
    const parent = db.select().from(nodes).where(eq(nodes.id, current.parentNodeId)).get();
    if (!parent || seen.has(parent.id)) {
      break;
    }
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

/** Returns IDs in the inline chain starting at `headId` ordered from ancestor to descendant. */
export function chainIdsFrom(db: SessionDatabase, headId: string): string[] {
  const chain = [headId];
  const seen = new Set(chain);
  for (let current = headId; ;) {
    const next = db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.parentNodeId, current), eq(nodes.inline, true)))
      .orderBy(asc(nodes.createdAt), asc(nodes.id))
      .get();
    if (!next || seen.has(next.id)) {
      return chain;
    }
    seen.add(next.id);
    chain.push(next.id);
    current = next.id;
  }
}

/**
 * Retrieves all nodes belonging to the inline chain of `nodeId` (including inline
 * ancestors up to chain root and all inline descendants) via a single recursive CTE.
 * Highlight and thread relations are omitted. Caller is responsible for access validation.
 */
export function chainNodes(
  db: SessionDatabase,
  nodeId: string,
  workspaceId: string,
): ResearchNode[] {
  const chain = sql`
    with recursive
      up(id, parent_node_id, inline) as (
        select id, parent_node_id, inline from nodes where id = ${nodeId}
        union
        select parent.id, parent.parent_node_id, parent.inline
          from nodes as parent
          inner join up on parent.id = up.parent_node_id
         where up.inline = 1
      ),
      chain(id) as (
        select id from up
        union
        select child.id
          from nodes as child
          inner join chain on child.parent_node_id = chain.id
         where child.inline = 1
      )
    select id from chain
  `;
  return db
    .select()
    .from(nodes)
    .where(sql`${nodes.id} in (${chain})`)
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .all()
    .map((row) => toResearchNode(row, { workspaceId, highlights: [] }));
}

/** Whether an exchange node is in a settled state: any terminal status except
 * an interrupted run with resume pending. */
function runSettled(node: NodeRow): boolean {
  if (node.status === null || !isTerminalStatus(node.status)) {
    return false;
  }
  return node.status !== "interrupted" || !node.resumePending;
}

/** Variant of `admitChild` that returns details on replaced and reordered nodes. */
export function admitChildDetailed(
  db: SessionDatabase,
  userId: string,
  input: AdmitChildInput,
): AdmittedChild {
  const text = input.message.text.trim();
  if (text === "") {
    throw new Error("research prompt cannot be empty");
  }
  if (input.anchor) {
    validateHighlightAnchor(input.anchor.anchor);
  }
  const type = input.type ?? "exchange";
  const inline = input.inline === true;
  const message: UserMessage = {
    text,
    ...(input.message.attachments && input.message.attachments.length > 0
      ? { attachments: input.message.attachments }
      : {}),
  };
  return transact(db, (tx) => {
    const access = loadNode(tx, userId, input.parentNodeId, "commenter");
    const { node: parent, tree } = access;
    if (tree.archivedAt !== null) {
      throw new Error(
        "Cannot create follow-up on archived research: restore the research thread first.",
      );
    }
    if (tree.trashedAt !== null) {
      throw new Error(
        "Cannot create follow-up on research in the Trash: restore the research thread first.",
      );
    }
    if (type === "post" && parent.type !== "post") {
      throw new Error("Cannot add a follow-up note: only notes take follow-up notes.");
    }
    if (parent.type === "exchange" && parent.status !== "complete") {
      throw new Error("Cannot create follow-up: the parent research run has not completed.");
    }
    let replacedNodeId: string | null = null;
    if (input.replacesNodeId !== undefined) {
      const replaced = tx.select().from(nodes).where(eq(nodes.id, input.replacesNodeId)).get();
      const childless =
        replaced !== undefined &&
        tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentNodeId, replaced.id)).get() ===
          undefined;
      if (replaced) {
        // Text edits are restricted to the author and require that no child nodes exist.
        assertMayEditText(tx, { ...access, node: replaced }, userId);
      }
      if (
        !replaced ||
        replaced.parentNodeId !== parent.id ||
        replaced.inline !== inline ||
        replaced.type !== "exchange" ||
        replaced.status === "complete" ||
        !runSettled(replaced) ||
        !childless
      ) {
        throw new Error("Only a failed or stopped question with no follow-ups can be edited.");
      }
      // Delete the existing inline question prior to insertion to avoid violating
      // the partial unique index. Both operations occur within the transaction.
      if (inline) {
        deleteNodesInOrder(tx, [replaced.id]);
      }
      replacedNodeId = replaced.id;
    }
    const nodeId = input.nodeId ?? newId();
    const at = now();
    try {
      tx.insert(nodes)
        .values({
          id: nodeId,
          treeId: parent.treeId,
          parentNodeId: parent.id,
          authorId: input.authorId ?? userId,
          inline,
          type,
          messageJson: message,
          anchorJson: input.anchor ?? null,
          format: type === "post" ? postFormatOf(text) : null,
          source: null,
          model: input.agent?.model ?? rowModel(parent),
          effort: input.agent === undefined ? parent.effort : (input.agent.effort ?? null),
          title: null,
          responsePreview: null,
          status: type === "exchange" ? "queued" : null,
          error: null,
          attempt: 1,
          runSeq: 0,
          resumePending: false,
          responseSnapshotAt: null,
          createdAt: at,
          startedAt: null,
          completedAt: null,
          recapJson: null,
        })
        .run();
    } catch (error) {
      if (isInlineSlotConflict(error)) {
        throw new Error(INLINE_SLOT_TAKEN);
      }
      throw error;
    }
    setRefs(tx, { kind: "node", id: nodeId, treeId: parent.treeId }, message.attachments, at);
    let movedQueue = false;
    if (replacedNodeId !== null && !inline) {
      // A branch question heads its own chain; transfer queued follow-ups to the replacement node.
      movedQueue =
        tx
          .update(followupQueue)
          .set({ headNodeId: nodeId })
          .where(eq(followupQueue.headNodeId, replacedNodeId))
          .run().changes > 0;
      deleteNodesInOrder(tx, [replacedNodeId]);
    }
    let reorderedHead: ResearchNode | null = null;
    if (replacedNodeId !== null && inline) {
      // Replace the target node ID with the new node ID in the chain ordering.
      const head = chainHeadRow(tx, parent);
      const order = storedChainOrder(head);
      const slot = order?.indexOf(replacedNodeId) ?? -1;
      if (order && slot >= 0) {
        order[slot] = nodeId;
        tx.update(nodes).set({ chainOrderJson: order }).where(eq(nodes.id, head.id)).run();
        reorderedHead = reload(tx, userId, head.id);
      }
    }
    touchTree(tx, parent.treeId, at);
    return { node: reload(tx, userId, nodeId), replacedNodeId, reorderedHead, movedQueue };
  });
}

function storedChainOrder(node: NodeRow): string[] | null {
  return node.chainOrderJson === null
    ? null
    : [...parseJsonColumn(stringListSchema, node.chainOrderJson, "nodes.chain_order_json")];
}

/**
 * Sets the explicit display order of the inline chain starting at `headNodeId`.
 * `nodeIds` must match the complete set of current chain nodes; concurrent modifications
 * are rejected. Inline parent/child relationships remain unchanged. Returns the head node
 * and whether ordering was modified.
 */
export function setChainOrder(
  db: SessionDatabase,
  userId: string,
  headNodeId: string,
  nodeIds: readonly string[],
  /** Expected previous display order for optimistic concurrency control. */
  expectedOrder?: readonly string[],
): { node: ResearchNode; changed: boolean } {
  return transact(db, (tx) => {
    const { node: head, tree } = loadNode(tx, userId, headNodeId, "owner");
    if (chainHeadRow(tx, head).id !== head.id) {
      throw new Error(`Research node ${headNodeId} does not start a conversation.`);
    }
    rejectTrashed(tree);
    if (tree.archivedAt !== null) {
      throw new Error("Restore archived research before reordering it.");
    }
    const chain = chainIdsFrom(tx, head.id);
    const listed = new Set(nodeIds);
    if (
      nodeIds.length !== chain.length ||
      listed.size !== chain.length ||
      chain.some((id) => !listed.has(id))
    ) {
      throw new Error("The conversation changed; refresh before reordering its messages.");
    }
    const current = storedChainOrder(head);
    if (expectedOrder !== undefined) {
      // The display order as observed by the caller: explicit stored order, or creation order.
      const shown = current ?? chain;
      if (
        shown.length !== expectedOrder.length ||
        shown.some((id, index) => id !== expectedOrder[index])
      ) {
        throw new Error("The conversation changed; refresh before reordering its messages.");
      }
    }
    const changed =
      current === null ||
      current.length !== nodeIds.length ||
      current.some((id, index) => id !== nodeIds[index]);
    if (changed) {
      tx.update(nodes)
        .set({ chainOrderJson: [...nodeIds] })
        .where(eq(nodes.id, head.id))
        .run();
      touchTree(tx, tree.id);
    }
    return { node: reload(tx, userId, head.id), changed };
  });
}

export interface StatusPatch {
  error?: string | null | undefined;
  startedAt?: number | null | undefined;
  completedAt?: number | null | undefined;
  responsePreview?: string | null | undefined;
  /**
   * Sequence number already reached by the run. Managed by the agent loop
   * during an attempt: status updates without sequence-bearing events must
   * record this value rather than allocating a new sequence number, avoiding
   * sequence gaps that trigger client refetches (`docs/03-api-and-events.md` §3,
   * `docs/05` §5). When omitted outside an active run attempt, the sequence
   * number is incremented.
   */
  seq?: number | undefined;
}

/**
 * Moves a node's status, bumping `run_seq` and touching the thread in the same
 * transaction (`docs/02` §5.3). Rejects changes from a terminal status.
 */
export function setStatus(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  status: ResearchNodeStatus,
  patch: StatusPatch = {},
): ResearchNode {
  return transact(db, (tx) => {
    const { node } = loadNode(tx, userId, nodeId);
    const current = runStatus(node);
    if (isTerminalStatus(current) && current !== status) {
      throw new Error(
        `Research node ${nodeId} already has terminal status '${current}' and cannot transition to '${status}'.`,
      );
    }
    const at = now();
    tx.update(nodes)
      .set({
        status,
        error: patch.error === undefined ? node.error : patch.error,
        startedAt: patch.startedAt === undefined ? node.startedAt : patch.startedAt,
        completedAt:
          patch.completedAt === undefined
            ? isTerminalStatus(status) && node.completedAt === null
              ? at
              : node.completedAt
            : patch.completedAt,
        responsePreview:
          patch.responsePreview === undefined ? node.responsePreview : patch.responsePreview,
        runSeq:
          patch.seq === undefined
            ? sql`${nodes.runSeq} + 1`
            : sql`max(${nodes.runSeq}, ${patch.seq})`,
      })
      .where(eq(nodes.id, nodeId))
      .run();
    touchTree(tx, node.treeId, at);
    syncFeedItem(tx, node);
    return reload(tx, userId, nodeId);
  });
}

/** Returns a node and its relations without access checks; for internal server operations
 * where access was verified previously. */
function viewUnchecked(db: SessionDatabase, nodeId: string): ResearchNode | null {
  const row = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  const tree = row ? db.select().from(trees).where(eq(trees.id, row.treeId)).get() : undefined;
  return row && tree ? toResearchNode(row, relationsFor(db, row, tree)) : null;
}

/**
 * Cancels an active or interrupted question run (`queued`, `starting`, `running`,
 * or `interrupted` with `resumePending`). Updates status to `cancelled`, clears
 * `resumePending`, and removes the corresponding `run_queue` entry.
 *
 * Performs no access check; callers are responsible for authorization. Returns null
 * if the node is not an exchange or has already settled.
 */
export function stopRun(
  db: SessionDatabase,
  nodeId: string,
  error: string | null = null,
): ResearchNode | null {
  return transact(db, (tx) => {
    const node = tx.select().from(nodes).where(eq(nodes.id, nodeId)).get();
    if (!node || node.type !== "exchange" || node.status === null) {
      return null;
    }
    const active =
      node.status === "queued" ||
      node.status === "starting" ||
      node.status === "running" ||
      (node.status === "interrupted" && node.resumePending);
    if (!active) {
      return null;
    }
    const at = now();
    tx.update(nodes)
      .set({
        status: "cancelled",
        // Clear wait reasons (`noteQueuedWait`) on queued nodes when cancelling.
        error: error ?? (node.status === "queued" ? null : node.error),
        resumePending: false,
        completedAt: node.completedAt ?? at,
        runSeq: sql`${nodes.runSeq} + 1`,
      })
      .where(eq(nodes.id, nodeId))
      .run();
    tx.delete(runQueue).where(eq(runQueue.nodeId, nodeId)).run();
    touchTree(tx, node.treeId, at);
    syncFeedItem(tx, node);
    return viewUnchecked(tx, nodeId);
  });
}

/** Inserts a run queue row when moving a node to `queued`. `enqueuedAt` 0 places
 * resumed runs at the front of the queue; new retries use current timestamp. */
function enqueueForRun(
  tx: SessionDatabase,
  userId: string,
  nodeId: string,
  model: string,
  enqueuedAt: number,
): void {
  enqueue(tx, userId, {
    nodeId,
    pool: "research",
    // `run_queue.provider` keys the per-provider cap, so it is the model's
    // provider rather than the model id.
    provider: findModel(model)?.provider ?? model,
    enqueuedAt,
    notBefore: null,
  });
}

/** Resets an exchange to `queued` for a new attempt. Clears existing snapshots,
 * recaps, turns, and messages, increments the attempt counter, and enqueues the node. */
function relaunch(
  tx: SessionDatabase,
  userId: string,
  node: NodeRow,
  model: string | undefined,
): ResearchNode {
  tx.delete(runTurns).where(eq(runTurns.nodeId, node.id)).run();
  tx.delete(nodeMessages).where(eq(nodeMessages.nodeId, node.id)).run();
  tx.delete(responseSnapshots).where(eq(responseSnapshots.nodeId, node.id)).run();
  const at = now();
  const tree = tx.select().from(trees).where(eq(trees.id, node.treeId)).get();
  tx.update(nodes)
    .set({
      status: "queued",
      attempt: node.attempt + 1,
      error: null,
      startedAt: null,
      completedAt: null,
      runSeq: 0,
      resumePending: false,
      responseSnapshotAt: null,
      responsePreview: null,
      recapJson: null,
      ...(model === undefined ? {} : { model }),
    })
    .where(eq(nodes.id, node.id))
    .run();
  // Attribute the run attempt to the node's author or thread payer.
  enqueueForRun(tx, tree ? payerOf(node, tree) : userId, node.id, model ?? rowModel(node), at);
  touchTree(tx, node.treeId, at);
  syncFeedItem(tx, node);
  return reload(tx, userId, node.id);
}

/**
 * Resets a failed, cancelled, or interrupted node to `queued` status for a new attempt.
 * Retries are enqueued at the end of the queue.
 */
export function resetForRetry(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  model?: string,
): ResearchNode {
  return transact(db, (tx) => {
    const access = loadNode(tx, userId, nodeId, "commenter");
    const { node, tree } = access;
    rejectTrashed(tree);
    assertMayRelaunch(access, userId);
    const status = runStatus(node);
    if (status !== "failed" && status !== "cancelled" && status !== "interrupted") {
      throw new Error(
        "Cannot retry run: only runs with status 'failed', 'cancelled', or 'interrupted' can be retried.",
      );
    }
    return relaunch(tx, userId, node, model);
  });
}

/** Whether an exchange's run is still active. */
function runActive(node: NodeRow): boolean {
  return node.type === "exchange" && node.status !== null && !runSettled(node);
}

/**
 * Reruns a settled exchange in place (`rerun_research_node`), allowing replacement
 * of complete answers. Parent node must be complete unless it is an active inline rerun.
 */
export function resetForRerun(db: SessionDatabase, userId: string, nodeId: string): ResearchNode {
  return transact(db, (tx) => {
    const access = loadNode(tx, userId, nodeId, "commenter");
    const { node, tree } = access;
    rejectTrashed(tree);
    assertMayRelaunch(access, userId);
    if (tree.archivedAt !== null) {
      throw new Error("Restore archived research before rerunning a question.");
    }
    if (node.type !== "exchange") {
      throw new Error("Only questions answered by an agent can be rerun.");
    }
    if (!runSettled(node)) {
      throw new Error("A queued or running question cannot be rerun.");
    }
    if (node.parentNodeId !== null) {
      const parent = tx.select().from(nodes).where(eq(nodes.id, node.parentNodeId)).get();
      if (parent?.type === "exchange" && parent.status !== "complete") {
        if (!runActive(parent)) {
          throw new Error("The answer this question follows did not complete.");
        }
        if (!node.inline) {
          throw new Error("Wait for the answer this question follows to finish.");
        }
      }
    }
    return relaunch(tx, userId, node, undefined);
  });
}

/**
 * Resumes an interrupted attempt. Committed turns are retained under the new
 * attempt number, uncommitted in-flight checkpoints are discarded, and the run
 * is prioritized at the front of the queue.
 */
export function resumeAttempt(db: SessionDatabase, userId: string, nodeId: string): ResearchNode {
  return transact(db, (tx) => {
    const { node, tree } = loadNode(tx, userId, nodeId);
    if (runStatus(node) !== "interrupted") {
      throw new Error("Cannot resume run: only runs with status 'interrupted' can be resumed.");
    }
    const attempt = node.attempt + 1;
    tx.delete(runTurns)
      .where(and(eq(runTurns.nodeId, nodeId), eq(runTurns.committed, false)))
      .run();
    tx.update(runTurns)
      .set({ attempt })
      .where(and(eq(runTurns.nodeId, nodeId), eq(runTurns.attempt, node.attempt)))
      .run();
    const at = now();
    tx.update(nodes)
      .set({
        status: "queued",
        attempt,
        error: null,
        completedAt: null,
        resumePending: false,
        runSeq: sql`${nodes.runSeq} + 1`,
      })
      .where(eq(nodes.id, nodeId))
      .run();
    enqueueForRun(tx, payerOf(node, tree), node.id, rowModel(node), 0);
    touchTree(tx, node.treeId, at);
    syncFeedItem(tx, node);
    return reload(tx, userId, nodeId);
  });
}

/**
 * Re-queues a rate-limited attempt with an incremented attempt counter.
 * Discards uncommitted turns so the subsequent attempt starts cleanly from parent context.
 */
export function requeueAfterRateLimit(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
): ResearchNode {
  return transact(db, (tx) => {
    const { node } = loadNode(tx, userId, nodeId);
    const status = runStatus(node);
    if (isTerminalStatus(status)) {
      throw new Error(
        `research node ${nodeId} already finished as ${status} and cannot be re-queued`,
      );
    }
    tx.delete(runTurns).where(eq(runTurns.nodeId, nodeId)).run();
    tx.update(nodes)
      .set({
        status: "queued",
        attempt: node.attempt + 1,
        error: null,
        startedAt: null,
        // Sequence numbers are preserved rather than reset to zero: clients observing this node
        // have already applied sequence numbers from the throttled attempt, and
        // rewinding the counter would cause subsequent events after backoff to appear as replays.
        runSeq: sql`${nodes.runSeq} + 1`,
      })
      .where(eq(nodes.id, nodeId))
      .run();
    touchTree(tx, node.treeId);
    syncFeedItem(tx, node);
    return reload(tx, userId, nodeId);
  });
}

/**
 * Updates or clears the wait reason stored in `error` for a queued exchange.
 * Used when a run is deferred due to rate or quota limits. Returns the updated node,
 * or null if unchanged. Performs no access check.
 */
export function noteQueuedWait(
  db: SessionDatabase,
  nodeId: string,
  note: string | null,
): ResearchNode | null {
  return transact(db, (tx) => {
    const row = tx.select().from(nodes).where(eq(nodes.id, nodeId)).get();
    if (!row || row.type !== "exchange" || row.status !== "queued" || row.error === note) {
      return null;
    }
    tx.update(nodes).set({ error: note }).where(eq(nodes.id, nodeId)).run();
    return viewUnchecked(tx, nodeId);
  });
}

/**
 * Returns the current attempt number for `nodeId`, or null if the node does not exist.
 * Used by the agent loop to avoid writing into superseded attempts. Performs no access check.
 */
export function attemptOf(db: SessionDatabase, nodeId: string): number | null {
  const row = db.select({ attempt: nodes.attempt }).from(nodes).where(eq(nodes.id, nodeId)).get();
  return row?.attempt ?? null;
}

/**
 * Clears `resumePending` on an interrupted node and removes it from the run queue,
 * preventing automatic resumption across restarts.
 */
export function clearResumePending(db: SessionDatabase, userId: string, nodeId: string): void {
  transact(db, (tx) => {
    const { node } = loadNode(tx, userId, nodeId);
    tx.update(nodes).set({ resumePending: false }).where(eq(nodes.id, node.id)).run();
    tx.delete(runQueue).where(eq(runQueue.nodeId, node.id)).run();
  });
}

/** Marks a running node interrupted and flags it for auto-resume. Called by
 * the `SIGTERM` handler after the last checkpoint is persisted. */
export function markInterrupted(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  /** The run's current sequence number; see `StatusPatch.seq`. */
  seq?: number,
): ResearchNode {
  return transact(db, (tx) => {
    const { node } = loadNode(tx, userId, nodeId);
    if (node.type !== "exchange" || node.status !== "running") {
      return reload(tx, userId, nodeId);
    }
    const at = now();
    tx.update(nodes)
      .set({
        status: "interrupted",
        resumePending: true,
        runSeq: seq === undefined ? sql`${nodes.runSeq} + 1` : sql`max(${nodes.runSeq}, ${seq})`,
      })
      .where(eq(nodes.id, nodeId))
      .run();
    touchTree(tx, node.treeId, at);
    syncFeedItem(tx, node);
    return reload(tx, userId, nodeId);
  });
}

export interface BootReconciliation {
  /** Node IDs transitioned to a terminal state matching their snapshot outcome. */
  adoptedNodeIds: string[];
  /** Node IDs transitioned from running to interrupted due to ungraceful shutdown. */
  interruptedNodeIds: string[];
  /** Interrupted node IDs re-enqueued at the front of the queue with resumePending. */
  requeuedNodeIds: string[];
  /** Queued node IDs missing run_queue entries that were re-enqueued. */
  reenqueuedNodeIds: string[];
  /** Interrupted node IDs cancelled because the author lost thread access. */
  stoppedNodeIds: string[];
  /** Unhandled reconciliation failures isolated by savepoints. */
  failures: { nodeId: string; message: string }[];
}

/** Error message assigned when cancelling a run whose author no longer has thread access. */
export const ASKER_GONE_ERROR =
  "Stopped: the person who asked no longer has access to this thread.";

/**
 * Reconciles node and run queue state during server startup (`docs/02` §5.7).
 *
 * Synchronizes terminal outcomes from response snapshots, transitions orphaned
 * `running` nodes to `interrupted` with `resumePending = true`, re-enqueues
 * pending resumes at queue priority, and repairs queued nodes lacking `run_queue` records.
 */
export function reconcileOnBoot(db: SessionDatabase): BootReconciliation {
  return transact(db, (tx) => {
    const result: BootReconciliation = {
      adoptedNodeIds: [],
      interruptedNodeIds: [],
      requeuedNodeIds: [],
      reenqueuedNodeIds: [],
      stoppedNodeIds: [],
      failures: [],
    };
    /** Executes a reconciliation step inside a savepoint so individual errors do not abort startup. */
    const each = (nodeId: string, step: (sp: SessionDatabase) => void): void => {
      try {
        transact(tx, step);
      } catch (error) {
        result.failures.push({
          nodeId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const active = tx
      .select()
      .from(nodes)
      .where(inArray(nodes.status, ["queued", "running"]))
      .all();
    for (const node of active) {
      each(node.id, (sp) => {
        const snapshot = sp
          .select()
          .from(responseSnapshots)
          .where(eq(responseSnapshots.nodeId, node.id))
          .get();
        const outcome = parseNullableJsonColumn(
          runOutcomeSchema,
          snapshot?.outcomeJson,
          "response_snapshots.outcome_json",
        );
        if (outcome && isTerminalStatus(outcome.status)) {
          sp.update(nodes)
            .set({
              status: outcome.status,
              error: outcome.error ?? null,
              completedAt: outcome.completedAt,
              responseSnapshotAt: node.responseSnapshotAt ?? outcome.completedAt,
              resumePending: false,
              runSeq: sql`${nodes.runSeq} + 1`,
            })
            .where(eq(nodes.id, node.id))
            .run();
          sp.delete(runQueue).where(eq(runQueue.nodeId, node.id)).run();
          upsertResearchRoot(sp, node.id);
          result.adoptedNodeIds.push(node.id);
          return;
        }
        if (node.status === "running") {
          sp.update(nodes)
            .set({ status: "interrupted", resumePending: true, runSeq: sql`${nodes.runSeq} + 1` })
            .where(eq(nodes.id, node.id))
            .run();
          upsertResearchRoot(sp, node.id);
          result.interruptedNodeIds.push(node.id);
        }
      });
    }
    /** Re-enqueues a node for its payer, or cancels it if the payer lost thread access. */
    const requeue = (
      node: { id: string; treeId: string; userId: string; model: string | null },
      enqueuedAt: number,
      into: string[],
    ): void => {
      each(node.id, (sp) => {
        if (treeAccess(sp, node.userId, node.treeId) === null) {
          if (stopRun(sp, node.id, ASKER_GONE_ERROR) !== null) {
            result.stoppedNodeIds.push(node.id);
          }
          return;
        }
        enqueueForRun(sp, node.userId, node.id, rowModel(node), enqueuedAt);
        into.push(node.id);
      });
    };
    // Re-enqueue queued nodes lacking run_queue rows (created if a process terminated
    // between node creation and queue insertion transactions).
    const orphanedQueued = tx
      .select({
        id: nodes.id,
        treeId: nodes.treeId,
        // Attribute usage to the question author or thread owner (`access.payerOf`).
        userId: sql<string>`coalesce(${nodes.authorId}, ${trees.ownerId})`,
        model: nodes.model,
        createdAt: nodes.createdAt,
      })
      .from(nodes)
      .innerJoin(trees, eq(trees.id, nodes.treeId))
      .where(
        and(
          eq(nodes.status, "queued"),
          eq(nodes.resumePending, false),
          isNull(trees.deletedAt),
          sql`not exists (select 1 from ${runQueue} where ${runQueue.nodeId} = ${nodes.id})`,
        ),
      )
      .orderBy(asc(nodes.createdAt), asc(nodes.id))
      .all();
    for (const node of orphanedQueued) {
      requeue(node, node.createdAt, result.reenqueuedNodeIds);
    }

    // Prioritize pending resumes by setting `enqueuedAt` to 0.
    const pending = tx
      .select({
        id: nodes.id,
        treeId: nodes.treeId,
        userId: sql<string>`coalesce(${nodes.authorId}, ${trees.ownerId})`,
        model: nodes.model,
      })
      .from(nodes)
      .innerJoin(trees, eq(trees.id, nodes.treeId))
      .where(and(eq(nodes.resumePending, true), isNull(trees.deletedAt)))
      .orderBy(asc(nodes.id))
      .all();
    for (const node of pending) {
      requeue(node, 0, result.requeuedNodeIds);
    }
    // Reset claims previously acquired by terminated server instances.
    tx.update(runQueue).set({ claimedAt: null }).run();
    return result;
  });
}

export function rename(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  title: string,
): ResearchNode {
  const clean = sanitizeResearchTitle(title);
  if (clean === undefined) {
    throw new Error("Research node title is required.");
  }
  return transact(db, (tx) => {
    const access = loadNode(tx, userId, nodeId, "commenter");
    const { node, tree } = access;
    rejectTrashed(tree);
    assertMayChangeNode(tx, access, userId);
    tx.update(nodes).set({ title: clean }).where(eq(nodes.id, nodeId)).run();
    touchTree(tx, node.treeId);
    syncFeedItem(tx, node);
    return reload(tx, userId, nodeId);
  });
}

/** Returns active nodes across threads owned by or shared with the account, for
 * display in the activity rail. */
export function listActive(db: SessionDatabase, userId: string): ResearchNode[] {
  const rows = db
    .select()
    .from(nodes)
    .where(
      and(
        sql`exists (select 1 from ${trees} where ${trees.id} = ${nodes.treeId} and ${treeJoinedBy(userId)})`,
        inArray(nodes.status, ["queued", "running", "interrupted"]),
      ),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .all();
  return rows.flatMap((row) => {
    const node = get(db, userId, row.id);
    return node ? [node] : [];
  });
}

/** Removes a subtree starting at `nodeId`. Deleting a thread root requires `trees.remove`. */
export function removeBranch(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
): ResearchBranchRemoval {
  return transact(db, (tx) => {
    const access = loadNode(tx, userId, nodeId, "commenter");
    const { node, tree } = access;
    rejectTrashed(tree);
    assertMayChangeNode(tx, access, userId);
    if (node.parentNodeId === null) {
      throw new Error(
        "Cannot delete root node individually: delete the entire research thread instead.",
      );
    }
    const ordered = subtreeIdsDepthFirst(tx, nodeId);
    const active = tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(inArray(nodes.id, ordered), activeRun()))
      .get();
    if (active) {
      throw new Error("Cannot delete research node with an active run: cancel the run first.");
    }
    deleteNodesInOrder(tx, ordered);
    touchTree(tx, tree.id);
    return {
      treeId: tree.id,
      parentNodeId: node.parentNodeId,
      removedNodeIds: ordered,
      removedBy: userId,
    };
  });
}
