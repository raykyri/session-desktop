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
import { and, asc, eq, inArray, sql } from "drizzle-orm";

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
import type { NodeRow, TreeRow } from "./mappers.js";
import { toResearchHighlight, toResearchNode } from "./mappers.js";
import { enqueue } from "./queue.js";
import { activeRun, deleteNodesInOrder, subtreeIdsDepthFirst } from "./subtrees.js";
import type { NodeAgentInput } from "./trees.js";
import { touchTree } from "./trees.js";

/** Statuses a node cannot be moved out of by `setStatus`. `interrupted` is
 * one of them: it leaves only through `resumeAttempt` or `resetForRetry`,
 * which both open a new attempt. */
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

/** The run status of an exchange row. Posts and documents have no run, so a
 * status change on one is a caller error. */
function runStatus(node: NodeRow): ResearchNodeStatus {
  if (node.type !== "exchange" || node.status === null) {
    throw new Error(`research node ${node.id} is a ${node.type} and has no run`);
  }
  return node.status;
}

/** The registry model a row runs on or defaults its follow-ups to. */
function rowModel(node: Pick<NodeRow, "model">): string {
  return node.model ?? DEFAULT_MODEL_ID;
}

export interface AdmitChildInput {
  parentNodeId: string;
  /** `exchange` (the default) asks a question; `post` adds a follow-up note,
   * which only a post can take. */
  type?: "exchange" | "post" | undefined;
  message: UserMessage;
  /** Defaults to the parent's agent. The caller checks the user may use it. */
  agent?: NodeAgentInput | undefined;
  inline?: boolean | undefined;
  anchor?: NodeAnchor | null | undefined;
  nodeId?: string | undefined;
  /** Who asked, when it is not `userId`: the author of a queued follow-up
   * (`followups.ts`). */
  authorId?: string | undefined;
  /** A failed or stopped question this one replaces (an edited question,
   * the desktop's `create_research_child_replacing`). It must be a child of
   * the same parent with the same `inline`, settled without a pending resume,
   * and have no children. It is deleted in the same transaction, and the new
   * node takes its place in the chain's stored order. */
  replacesNodeId?: string | undefined;
}

export interface AdmittedChild {
  node: ResearchNode;
  /** The replaced question, deleted in the same transaction. */
  replacedNodeId: string | null;
  /** The chain head whose stored order now lists the new node in place of the
   * replaced one; null when nothing was reordered. */
  reorderedHead: ResearchNode | null;
  /** Whether follow-ups queued behind the replaced branch question moved to
   * the new one, which heads their chain now. */
  movedQueue: boolean;
}

type LoadedNode = NodeAccess;

/** A node and its thread, for a caller with at least `minimum` there. The
 * run pipeline acts as the run's asker, who can read the thread. */
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

/** The node, when `userId` (null: a guest) may read its thread. */
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

/** The message the desktop showed when the inline slot was taken. Mapped from
 * the partial unique index so the check is atomic rather than a read followed
 * by a write two requests can interleave. */
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
 * Creates a follow-up under `parentNodeId` (`docs/02` §5.4): an exchange, or
 * a follow-up note under a post.
 *
 * The parent must have finished — a follow-up's context is the parent's
 * answer — and the thread must be neither archived nor in the Trash. One
 * inline child per parent, whatever its status: a failed continuation stays
 * in the thread until it is deliberately removed, which reopens the slot.
 */
export function admitChild(
  db: SessionDatabase,
  userId: string,
  input: AdmitChildInput,
): ResearchNode {
  return admitChildDetailed(db, userId, input).node;
}

/** The node at the top of `node`'s inline chain: walk up while the node is
 * inline (`inlineChainFor` in the shared `researchChains`). */
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

/** The ids of the inline chain that starts at `headId`, oldest first: the
 * head, then each node's oldest inline child. */
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

/** Whether an exchange's run is settled and no longer the server's: any
 * terminal status except an `interrupted` run with a resume pending. */
function runSettled(node: NodeRow): boolean {
  if (node.status === null || !isTerminalStatus(node.status)) {
    return false;
  }
  return node.status !== "interrupted" || !node.resumePending;
}

/** As `admitChild`, also reporting what a replacement removed and
 * reordered. */
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
        // Editing a question is changing its text: its author's, while
        // nobody else has replied under it.
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
      // An inline question is deleted before the insert: the partial unique
      // index would refuse the new inline child while it exists. Both happen
      // in this transaction, so a refused insert keeps the replaced question.
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
    let movedQueue = false;
    if (replacedNodeId !== null && !inline) {
      // A branch question heads its own chain: follow-ups queued behind it
      // move to the question that replaces it.
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
      // The edited question takes the replaced one's place in its column's
      // stored order (`create_research_child_replacing` in `state.rs`).
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
 * Stores the display order of the messages column whose inline chain starts
 * at `headNodeId` (`set_research_chain_order` in `state.rs`). `nodeIds` must
 * list exactly the chain's current nodes; a chain that changed since the
 * caller read it is refused. The inline links are unchanged, so a follow-up
 * still continues the chain's last node. Returns the head and whether the
 * stored order changed.
 */
export function setChainOrder(
  db: SessionDatabase,
  userId: string,
  headNodeId: string,
  nodeIds: readonly string[],
  /** The display order the caller reordered from; another person's reorder
   * since is refused. Absent: not checked. */
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
      // The column as the caller saw it: the stored order, or oldest first.
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
   * The sequence number a run has already reached. Set by the agent loop,
   * which manages the counter for the duration of an attempt: a status write that
   * publishes no `seq`-carrying event must record that number rather than
   * allocate a fresh one, or the client sees its sequence jump and refetches
   * (`docs/03-api-and-events.md` §3, `docs/05` §5). Unset — every caller
   * outside a run — keeps the allocating bump.
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

/** A node as its thread shows it, read without an access check: for the
 * server's own changes (`stopRun`), made for a caller already checked or for
 * nobody in particular. */
function viewUnchecked(db: SessionDatabase, nodeId: string): ResearchNode | null {
  const row = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  const tree = row ? db.select().from(trees).where(eq(trees.id, row.treeId)).get() : undefined;
  return row && tree ? toResearchNode(row, relationsFor(db, row, tree)) : null;
}

/**
 * Stops a question's run for good while the server still owns it: `queued`,
 * `starting`, `running`, or `interrupted` with a resume pending. In one
 * transaction the status becomes `cancelled` (with `error`, when given), the
 * resume flag is cleared and the `run_queue` row is deleted, so neither the
 * claim loop nor the next boot picks it up again. `setStatus` refuses
 * `interrupted` → `cancelled`; this is the path that leaves it.
 *
 * No access check: the callers decide who may stop a run
 * (`research.cancelNode`) or stop it for the server (a member who left, whose
 * questions nobody can pay for any more). Returns null, changing nothing,
 * for a node that is not an exchange or whose run has already settled.
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
        error: error ?? node.error,
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

/** The queue row a node put back to `queued` needs, written in the same
 * transaction as the status change so a node is never `queued` with nothing to
 * admit it (`docs/02` §5.7). `enqueuedAt` 0 is the head of the queue, which is
 * where a resume goes; a retry takes its place at the back. */
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

/** Puts a settled exchange back to `queued` with nothing of its own left:
 * the snapshot, the recap, the live turns and the stored messages go, the
 * attempt number moves, and the node is re-queued at the back. Highlights
 * stay; the client re-anchors them by quote against the new answer. */
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
  // The question's author pays for every attempt of it.
  enqueueForRun(tx, tree ? payerOf(node, tree) : userId, node.id, model ?? rowModel(node), at);
  touchTree(tx, node.treeId, at);
  syncFeedItem(tx, node);
  return reload(tx, userId, node.id);
}

/**
 * A fresh attempt after a failure, a cancel, or an interruption: the node goes
 * back to `queued` with nothing of its own left, so the next run starts from
 * the parent's context (`docs/05` §7).
 *
 * The node is re-queued at the back: a retry is new work, and jumping the line
 * ahead of questions that have been waiting would be the wrong trade.
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

/** Whether an exchange's run is still the server's responsibility. */
function runActive(node: NodeRow): boolean {
  return node.type === "exchange" && node.status !== null && !runSettled(node);
}

/**
 * Reruns a settled exchange in place (`rerun_research_node`): as
 * `resetForRetry`, but a complete answer is accepted too and replaced. The
 * snapshot and the recap go; highlights stay and re-anchor by quote.
 *
 * The answer it follows must be complete. The exception is an inline
 * follow-up whose parent is still active (itself being rerun): the rerun is
 * admitted and waits in the run queue until the parent settles
 * (`runs/service.ts`), as the desktop's client-side retry queue waits.
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
 * Continues an interrupted attempt. The committed turns are real exchanges and
 * stay as context — carried onto the new attempt number so the live window
 * still shows them — while the in-flight checkpoint, which the model never
 * finished, is dropped.
 *
 * The node returns to the front of the queue so a server restart does not
 * penalize an active run.
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
 * Puts a rate-limited attempt back in the queue
 * (`docs/05-run-lifecycle-and-streaming.md` §8).
 *
 * The attempt number moves, which is what makes the 429 survive a restart:
 * `run_attempts` is keyed by `(node_id, attempt)`, so a re-queue that reused
 * the number would have the retry overwrite the `rate_limited` row the backoff
 * is counted from. The queue row itself is left to
 * `queue.requeueWithBackoff`, which keeps the node's place in the admission
 * order rather than sending it to the back.
 *
 * The partial output of the rate-limited attempt goes: the retry starts from
 * the parent's context, and rows left under the old attempt number would be
 * invisible to `liveWindow` and never collected.
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
        // Not reset to zero the way a retry does: a client watching this node
        // has already applied sequence numbers from the attempt that was
        // throttled, and rewinding the counter would make every event after
        // the backoff look like a replay.
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
 * Gives up on auto-resuming a node (`docs/05-run-lifecycle-and-streaming.md`
 * §3). The node keeps its `interrupted` status and its partial output, and the
 * user's Retry is what moves it from here; clearing the flag is what stops
 * every subsequent boot from re-queueing a node the runtime has already
 * decided not to resume.
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
  /** Nodes whose snapshot already carried a terminal outcome, adopted. */
  adoptedNodeIds: string[];
  /** `running` nodes with no outcome: a crash without a shutdown. */
  interruptedNodeIds: string[];
  /** Everything put back at the head of the queue. */
  requeuedNodeIds: string[];
  /** `queued` nodes that had no `run_queue` row, given one. */
  reenqueuedNodeIds: string[];
  /** Nodes whose payer can no longer read their thread (they left it or
   * were removed while it was interrupted): stopped with
   * `ASKER_GONE_ERROR` instead of re-queued. */
  stoppedNodeIds: string[];
  /** Nodes that could not be reconciled, left as they were. Each is handled
   * in a savepoint of its own, so one bad row does not stop the boot. */
  failures: { nodeId: string; message: string }[];
}

/** The error a question shows when it was stopped because the person who
 * asked it, who pays for it, can no longer read its thread. */
export const ASKER_GONE_ERROR =
  "Stopped: the person who asked no longer has access to this thread.";

/**
 * Reconciles what the last process left behind (`docs/02` §5.7).
 *
 * A node whose snapshot row already holds a terminal outcome adopts it — the
 * answer landed, only the node row did not. Whatever is still `running` was
 * cut mid-attempt and becomes `interrupted` with `resume_pending`. `queued`
 * nodes stay queued. Every `resume_pending` node, including ones marked by a
 * clean `SIGTERM`, is re-queued ahead of new work.
 *
 * Boot is also the only place that can repair a state no caller can reach
 * afterwards: a `queued` node with no queue row, which a crash between the
 * admission and enqueue transactions leaves behind.
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
    /** One node's step in a savepoint: a failure rolls back that node alone
     * and is reported, and the boot goes on. */
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
    /** Re-queues a node for its payer, or stops it when the payer can no
     * longer read the thread: nobody else may be billed for it, and
     * `queue.enqueue` refuses a payer who cannot read the node. */
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
    // A `queued` node with no `run_queue` row. The node row and its queue row
    // are separate transactions under `synchronous = NORMAL`
    // (`routers/research/trees.ts`, `createTree` then
    // `enqueueRun`), so a crash between them produces exactly this. Re-queued
    // at the back rather than the head: the node is new work, not a resume.
    const orphanedQueued = tx
      .select({
        id: nodes.id,
        treeId: nodes.treeId,
        // The asker pays (`access.payerOf`).
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
          sql`not exists (select 1 from ${runQueue} where ${runQueue.nodeId} = ${nodes.id})`,
        ),
      )
      .orderBy(asc(nodes.createdAt), asc(nodes.id))
      .all();
    for (const node of orphanedQueued) {
      requeue(node, node.createdAt, result.reenqueuedNodeIds);
    }

    // Every pending resume goes back to the head of the queue: `enqueued_at`
    // 0 sorts ahead of any real timestamp, and the ULID tie-break keeps the
    // original order among them.
    const pending = tx
      .select({
        id: nodes.id,
        treeId: nodes.treeId,
        userId: sql<string>`coalesce(${nodes.authorId}, ${trees.ownerId})`,
        model: nodes.model,
      })
      .from(nodes)
      .innerJoin(trees, eq(trees.id, nodes.treeId))
      .where(eq(nodes.resumePending, true))
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

/** Active nodes across the threads the account owns or is a member of, for
 * the activity rail. */
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

/** Removes a follow-up and everything under it. The root is not removable
 * this way: deleting a thread's root is `trees.remove`. */
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
