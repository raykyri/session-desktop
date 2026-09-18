// Nodes: follow-up admission, the status machine, retry and resume, and boot
// reconciliation (`docs/02-domain-model-and-database.md` §5.3, §5.4, §5.7,
// `docs/05-run-lifecycle-and-streaming.md` §3, §7).

import type {
  ResearchBranchRemoval,
  ResearchHighlightAnchor,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchNodeStatus,
} from "@session/shared";
import { findModel, sanitizeResearchTitle, validateHighlightAnchor } from "@session/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { parseNullableJsonColumn, runOutcomeSchema } from "../json.js";
import { nodeDocuments } from "../schema/documents.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { nodeMessages, runQueue, runTurns } from "../schema/runs.js";
import { responseSnapshots } from "../schema/snapshots.js";
import { trees } from "../schema/trees.js";
import { now } from "../time.js";

import { attachWithin } from "./documents.js";
import type { NodeRow, TreeRow } from "./mappers.js";
import { toResearchHighlight, toResearchNode } from "./mappers.js";
import { enqueue } from "./queue.js";
import { subtreeIdsDepthFirst, deleteNodesInOrder } from "./subtrees.js";
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

export function isTerminalStatus(status: ResearchNodeStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface AdmitChildInput {
  parentNodeId: string;
  prompt: string;
  /** Defaults to the parent's model. The caller checks the user may use it. */
  model?: string | undefined;
  inline?: boolean | undefined;
  queryAnchor?: ResearchHighlightAnchor | null | undefined;
  attachments?: ResearchMessageAttachment[] | undefined;
  documentIds?: string[] | undefined;
  nodeId?: string | undefined;
}

interface LoadedNode {
  node: NodeRow;
  tree: TreeRow;
}

function loadNode(db: SessionDatabase, userId: string, nodeId: string): LoadedNode {
  const node = db
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .get();
  if (!node) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  const tree = db.select().from(trees).where(eq(trees.id, node.treeId)).get();
  if (!tree) {
    throw new Error(`research tree ${node.treeId} was not found`);
  }
  return { node, tree };
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
    documentIds: db
      .select({ documentId: nodeDocuments.documentId })
      .from(nodeDocuments)
      .where(eq(nodeDocuments.nodeId, node.id))
      .orderBy(asc(nodeDocuments.position))
      .all()
      .map((row) => row.documentId),
  };
}

export function get(db: SessionDatabase, userId: string, nodeId: string): ResearchNode | null {
  const node = db
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
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
export const INLINE_SLOT_TAKEN = "this answer already has an inline follow-up";

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
 * Creates a follow-up under `parentNodeId` (`docs/02` §5.4).
 *
 * The parent must have finished — a follow-up's context is the parent's
 * answer — and the thread must not be archived. One inline child per parent,
 * whatever its status: a failed continuation stays in the thread until it is
 * deliberately removed, which reopens the slot.
 */
export function admitChild(
  db: SessionDatabase,
  userId: string,
  input: AdmitChildInput,
): ResearchNode {
  const prompt = input.prompt.trim();
  if (prompt === "") {
    throw new Error("research prompt cannot be empty");
  }
  if (input.queryAnchor) {
    validateHighlightAnchor(input.queryAnchor);
  }
  return transact(db, (tx) => {
    const { node: parent, tree } = loadNode(tx, userId, input.parentNodeId);
    if (tree.archivedAt !== null) {
      throw new Error("restore archived research before creating a follow-up");
    }
    if (parent.status !== "complete") {
      throw new Error("research follow-ups require a completed parent response");
    }
    const nodeId = input.nodeId ?? newId();
    const at = now();
    try {
      tx.insert(nodes)
        .values({
          id: nodeId,
          userId,
          treeId: parent.treeId,
          parentNodeId: parent.id,
          inline: input.inline === true,
          prompt,
          queryAnchorJson: input.queryAnchor ?? null,
          attachmentsJson: input.attachments ?? [],
          title: null,
          responsePreview: null,
          model: input.model ?? parent.model,
          kind: "run",
          origin: null,
          status: "queued",
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
    // Through the checked path: an id the caller supplied is not an id the
    // caller owns, and an unchecked insert here lets one account attach
    // another's document — permanently, because `documents.remove` refuses a
    // document a node references (`06-auth-and-users.md` §4).
    attachWithin(tx, userId, nodeId, input.documentIds ?? []);
    touchTree(tx, parent.treeId, at);
    return reload(tx, userId, nodeId);
  });
}

export interface StatusPatch {
  error?: string | null | undefined;
  startedAt?: number | null | undefined;
  completedAt?: number | null | undefined;
  responsePreview?: string | null | undefined;
  /**
   * The sequence number a run has already reached. Set by the agent loop,
   * which owns the counter for the duration of an attempt: a status write that
   * publishes no `seq`-carrying event must record that number rather than
   * allocate a fresh one, or the client sees its sequence jump and refetches
   * (`docs/03-api-and-events.md` §3, `docs/05` §5). Unset — every caller
   * outside a run — keeps the allocating bump.
   */
  seq?: number | undefined;
}

/**
 * Moves a node's status, bumping `run_seq` and touching the thread in the same
 * transaction (`docs/02` §5.3). Refuses to leave a terminal status.
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
    if (isTerminalStatus(node.status) && node.status !== status) {
      throw new Error(
        `research node ${nodeId} already finished as ${node.status} and cannot become ${status}`,
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
    return reload(tx, userId, nodeId);
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
    const { node } = loadNode(tx, userId, nodeId);
    if (node.status !== "failed" && node.status !== "cancelled" && node.status !== "interrupted") {
      throw new Error("only a failed, cancelled, or interrupted run can be retried");
    }
    tx.delete(runTurns).where(eq(runTurns.nodeId, nodeId)).run();
    tx.delete(nodeMessages).where(eq(nodeMessages.nodeId, nodeId)).run();
    tx.delete(responseSnapshots).where(eq(responseSnapshots.nodeId, nodeId)).run();
    const at = now();
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
      .where(eq(nodes.id, nodeId))
      .run();
    enqueueForRun(tx, userId, node.id, model ?? node.model, at);
    touchTree(tx, node.treeId, at);
    return reload(tx, userId, nodeId);
  });
}

/**
 * Continues an interrupted attempt. The committed turns are real exchanges and
 * stay as context — carried onto the new attempt number so the live window
 * still shows them — while the in-flight checkpoint, which the model never
 * finished, is dropped.
 *
 * The node goes back to the head of the queue: it was already running once, and
 * making a deploy cost it its place would punish the user for the restart.
 */
export function resumeAttempt(db: SessionDatabase, userId: string, nodeId: string): ResearchNode {
  return transact(db, (tx) => {
    const { node } = loadNode(tx, userId, nodeId);
    if (node.status !== "interrupted") {
      throw new Error("only an interrupted run can be resumed");
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
    enqueueForRun(tx, userId, node.id, node.model, 0);
    touchTree(tx, node.treeId, at);
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
    if (isTerminalStatus(node.status)) {
      throw new Error(
        `research node ${nodeId} already finished as ${node.status} and cannot be re-queued`,
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
    if (node.status !== "running") {
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
  /** `complete` documents with no content, failed so they can be acted on. */
  emptyDocumentNodeIds: string[];
}

/**
 * Settles what the last process left behind (`docs/02` §5.7).
 *
 * A node whose snapshot row already holds a terminal outcome adopts it — the
 * answer landed, only the node row did not. Whatever is still `running` was
 * cut mid-attempt and becomes `interrupted` with `resume_pending`. `queued`
 * nodes stay queued. Every `resume_pending` node, including ones marked by a
 * clean `SIGTERM`, is re-queued ahead of new work.
 *
 * Boot is also the only place that can repair the two states no caller can
 * reach afterwards, both of which are a crash between two transactions that a
 * single one would have made impossible: a `queued` node with no queue row,
 * and a `complete` document with no snapshot.
 */
export function reconcileOnBoot(db: SessionDatabase): BootReconciliation {
  return transact(db, (tx) => {
    const result: BootReconciliation = {
      adoptedNodeIds: [],
      interruptedNodeIds: [],
      requeuedNodeIds: [],
      reenqueuedNodeIds: [],
      emptyDocumentNodeIds: [],
    };
    const active = tx
      .select()
      .from(nodes)
      .where(inArray(nodes.status, ["queued", "running"]))
      .all();
    for (const node of active) {
      const snapshot = tx
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
        tx.update(nodes)
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
        tx.delete(runQueue).where(eq(runQueue.nodeId, node.id)).run();
        result.adoptedNodeIds.push(node.id);
        continue;
      }
      if (node.status === "running") {
        tx.update(nodes)
          .set({ status: "interrupted", resumePending: true, runSeq: sql`${nodes.runSeq} + 1` })
          .where(eq(nodes.id, node.id))
          .run();
        result.interruptedNodeIds.push(node.id);
      }
    }
    // A `queued` node with no `run_queue` row is nothing's work: the claim
    // loop reads the queue, so it waits forever, and Retry is offered only on
    // `failed`, `cancelled` and `interrupted` — the user has no way out of it
    // at all. The node row and its queue row are separate transactions under
    // `synchronous = NORMAL` (`routers/research.ts`, `createTree` then
    // `enqueueRun`), so a crash between them produces exactly this. Re-queued
    // at the back rather than the head: the node is new work, not a resume.
    const orphanedQueued = tx
      .select({
        id: nodes.id,
        userId: nodes.userId,
        model: nodes.model,
        createdAt: nodes.createdAt,
      })
      .from(nodes)
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
      enqueueForRun(tx, node.userId, node.id, node.model, node.createdAt);
      result.reenqueuedNodeIds.push(node.id);
    }

    // An imported document whose row landed `complete` but whose markdown did
    // not (`routers/research.ts:importReport` writes them in two
    // transactions). `getNodeContent` reports "this research produced no
    // readable response", and both `updateDocument` and `retryNode` refuse it,
    // so the thread is unreadable and undeletable-by-retry forever. Failing it
    // is the smallest repair that gives the user something to act on.
    const emptyDocuments = tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.status, "complete"),
          eq(nodes.kind, "document"),
          sql`not exists (select 1 from ${responseSnapshots} where ${responseSnapshots.nodeId} = ${nodes.id})`,
        ),
      )
      .orderBy(asc(nodes.id))
      .all();
    for (const node of emptyDocuments) {
      tx.update(nodes)
        .set({
          status: "failed",
          error: "this document was not saved completely; import it again",
          runSeq: sql`${nodes.runSeq} + 1`,
        })
        .where(eq(nodes.id, node.id))
        .run();
      result.emptyDocumentNodeIds.push(node.id);
    }

    // Every pending resume goes back to the head of the queue: `enqueued_at`
    // 0 sorts ahead of any real timestamp, and the ULID tie-break keeps the
    // original order among them.
    const pending = tx
      .select({ id: nodes.id, userId: nodes.userId, model: nodes.model })
      .from(nodes)
      .where(eq(nodes.resumePending, true))
      .orderBy(asc(nodes.id))
      .all();
    for (const node of pending) {
      enqueueForRun(tx, node.userId, node.id, node.model, 0);
      result.requeuedNodeIds.push(node.id);
    }
    // Every claim belongs to the process that just died; nothing is running.
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
    throw new Error("a research node needs a title");
  }
  return transact(db, (tx) => {
    const { node } = loadNode(tx, userId, nodeId);
    tx.update(nodes).set({ title: clean }).where(eq(nodes.id, nodeId)).run();
    touchTree(tx, node.treeId);
    return reload(tx, userId, nodeId);
  });
}

/** Active nodes across the account, for the activity rail. */
export function listActive(db: SessionDatabase, userId: string): ResearchNode[] {
  const rows = db
    .select()
    .from(nodes)
    .where(
      and(eq(nodes.userId, userId), inArray(nodes.status, ["queued", "running", "interrupted"])),
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
    const { node, tree } = loadNode(tx, userId, nodeId);
    if (node.parentNodeId === null) {
      throw new Error("remove the whole thread instead of its root question");
    }
    const ordered = subtreeIdsDepthFirst(tx, nodeId);
    const active = tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(inArray(nodes.id, ordered), inArray(nodes.status, ["queued", "running"])))
      .get();
    if (active) {
      throw new Error("cancel this research before removing it");
    }
    deleteNodesInOrder(tx, ordered);
    touchTree(tx, tree.id);
    return {
      treeId: tree.id,
      parentNodeId: node.parentNodeId,
      removedNodeIds: ordered,
    };
  });
}
