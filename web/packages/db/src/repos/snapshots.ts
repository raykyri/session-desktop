// The durable answer (`docs/02-domain-model-and-database.md` §5.2,
// `docs/05-run-lifecycle-and-streaming.md` §5).

import type { ResearchNode, ResearchNodeStatus, Turn } from "@session/shared";
import { MAX_RESPONSE_SNAPSHOT_BYTES, responsePreview, turnSchema } from "@session/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { SessionDatabase } from "../connection.js";
import { withFullSync } from "../connection.js";
import type { RunOutcome } from "../json.js";
import { parseJsonColumn, parseNullableJsonColumn, runOutcomeSchema } from "../json.js";
import { revisionOf, snapshotByteSize } from "../revision.js";
import { nodes } from "../schema/nodes.js";
import { runTurns } from "../schema/runs.js";
import { responseSnapshots } from "../schema/snapshots.js";
import { trees } from "../schema/trees.js";
import { now, strictlyAfter } from "../time.js";

import { upsertResearchRoot } from "./feedgen.js";
import { get as getNode, isTerminalStatus } from "./nodes.js";
import { touchTree } from "./trees.js";

const turnListSchema = z.array(turnSchema);

/** The desktop's copy for a response that could not be persisted, kept
 * verbatim because users have seen it. */
export const SNAPSHOT_TOO_LARGE =
  "Research run completed, but the response exceeded the maximum snapshot storage limit and could not be saved.";

export interface CommitInput {
  nodeId: string;
  turns: readonly Turn[];
  /** The attempt's terminal outcome. `completedAt` defaults to now. */
  outcome: { status: ResearchNodeStatus; error?: string | null; completedAt?: number };
  /** The run's current sequence number, when a run owns the counter. The
   * commit publishes no `seq`-carrying event of its own — the loop's
   * `research.run.finished` is the next one — so it records the number rather
   * than allocating one the client would then see as a hole
   * (`nodes.StatusPatch.seq`). Unset, as on the import path, keeps the bump. */
  seq?: number | undefined;
}

export interface CommitResult {
  node: ResearchNode;
  revision: string;
  responseSnapshotAt: number;
  byteSize: number;
}

export interface StoredSnapshot {
  nodeId: string;
  revision: string;
  turns: Turn[];
  outcome: RunOutcome | null;
  byteSize: number;
  updatedAt: number;
}

function assistantTextExists(turns: readonly Turn[]): boolean {
  return turns.some(
    (turn) =>
      turn.role !== "user" &&
      turn.blocks.some((block) => block.type === "text" && block.text.trim() !== ""),
  );
}

/**
 * Writes the answer and settles the node.
 *
 * The two-guard rule — an assistant text turn exists, and two consecutive
 * reads of the live turns agreed — is split: the second guard is the
 * runtime's, because only it can read the same buffer twice; the first is
 * here, because a snapshot without an answer is not a snapshot.
 *
 * Everything lands in one transaction committed under `synchronous = FULL`
 * (`docs/00-plan.md` §6): the snapshot, the terminal status, the timestamps,
 * the thread's `updated_at`, and the removal of the live turns the snapshot
 * replaces. A crash between any two of those would show a finished run with
 * no answer, which is the one inconsistency this domain cannot repair.
 */
export function commit(db: SessionDatabase, userId: string, input: CommitInput): CommitResult {
  const turns = [...input.turns];
  if (!assistantTextExists(turns)) {
    throw new Error("Invalid snapshot: research response must contain assistant output text.");
  }
  const byteSize = snapshotByteSize(turns);
  if (byteSize > MAX_RESPONSE_SNAPSHOT_BYTES) {
    throw new Error(SNAPSHOT_TOO_LARGE);
  }
  const revision = revisionOf(turns);
  return withFullSync(db, (tx) => {
    const node = tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, input.nodeId)))
      .get();
    if (!node) {
      throw new Error(`research node ${input.nodeId} was not found`);
    }
    // The monotonicity `nodes.setStatus` enforces, narrowed to what this path
    // can tell apart: a node that is terminal *and* already has its answer has
    // settled, and settling it twice would replace a revision that highlights
    // and document edits are anchored to. A terminal node without a snapshot
    // is the import path — the content arrives after the row — and is allowed.
    // Retry deletes the snapshot; resume leaves the node `queued`.
    const existing = tx
      .select({ nodeId: responseSnapshots.nodeId })
      .from(responseSnapshots)
      .where(eq(responseSnapshots.nodeId, node.id))
      .get();
    if (existing && isTerminalStatus(node.status)) {
      throw new Error(
        `research node ${node.id} already finished as ${node.status} and cannot be committed again`,
      );
    }
    const at = now();
    const completedAt = input.outcome.completedAt ?? at;
    const outcome: RunOutcome = {
      status: input.outcome.status,
      error: input.outcome.error ?? null,
      completedAt,
    };
    const responseSnapshotAt = strictlyAfter(node.responseSnapshotAt, at);
    tx.insert(responseSnapshots)
      .values({
        nodeId: node.id,
        revision,
        turnsJson: turns,
        outcomeJson: outcome,
        byteSize,
        version: 1,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: responseSnapshots.nodeId,
        set: { revision, turnsJson: turns, outcomeJson: outcome, byteSize, updatedAt: at },
      })
      .run();
    tx.update(nodes)
      .set({
        status: input.outcome.status,
        error: input.outcome.error ?? null,
        completedAt,
        responseSnapshotAt,
        responsePreview: responsePreview(turns) ?? null,
        resumePending: false,
        runSeq:
          input.seq === undefined
            ? sql`${nodes.runSeq} + 1`
            : sql`max(${nodes.runSeq}, ${input.seq})`,
      })
      .where(eq(nodes.id, node.id))
      .run();
    tx.delete(runTurns).where(eq(runTurns.nodeId, node.id)).run();
    touchTree(tx, node.treeId, at);
    upsertResearchRoot(tx, node.id);
    const updated = getNode(tx, userId, node.id);
    if (!updated) {
      throw new Error(`research node ${node.id} was not found`);
    }
    return { node: updated, revision, responseSnapshotAt, byteSize };
  });
}

export function read(db: SessionDatabase, userId: string, nodeId: string): StoredSnapshot | null {
  const row = db
    .select({ snapshot: responseSnapshots })
    .from(responseSnapshots)
    .innerJoin(nodes, eq(nodes.id, responseSnapshots.nodeId))
    .where(and(eq(nodes.userId, userId), eq(responseSnapshots.nodeId, nodeId)))
    .get();
  if (!row) {
    return null;
  }
  const snapshot = row.snapshot;
  return {
    nodeId: snapshot.nodeId,
    revision: snapshot.revision,
    turns: parseJsonColumn(turnListSchema, snapshot.turnsJson, "response_snapshots.turns_json"),
    outcome: parseNullableJsonColumn(
      runOutcomeSchema,
      snapshot.outcomeJson,
      "response_snapshots.outcome_json",
    ),
    byteSize: snapshot.byteSize,
    updatedAt: snapshot.updatedAt,
  };
}

/** The revision alone, for the guards that only compare it. */
export function revision(db: SessionDatabase, userId: string, nodeId: string): string | null {
  const row = db
    .select({ revision: responseSnapshots.revision })
    .from(responseSnapshots)
    .innerJoin(nodes, eq(nodes.id, responseSnapshots.nodeId))
    .where(and(eq(nodes.userId, userId), eq(responseSnapshots.nodeId, nodeId)))
    .get();
  return row?.revision ?? null;
}

/**
 * Replaces a node's snapshot without touching its status — the path a root
 * document's markdown edit takes, where the node was already `complete` and
 * only its content changes. The thread's `updated_at` and the node's
 * `response_snapshot_at` are both forced strictly forward so a client polling
 * either one sees the change.
 */
export interface ReplaceResult {
  revision: string;
  responseSnapshotAt: number;
  byteSize: number;
}

/**
 * Replaces a node's snapshot without touching its status — the path a root
 * document's markdown edit takes, where the node was already `complete` and
 * only its content changes. The node's `response_snapshot_at` and the thread's
 * `updated_at` are both forced strictly forward so a client polling either one
 * sees the change (`state.rs:5074`).
 *
 * Takes a handle rather than opening its own transaction so the document
 * update can put this and its other writes under one `synchronous = FULL`
 * commit; {@link replaceTurns} is the standalone form.
 */
export function applyReplacedTurns(
  tx: SessionDatabase,
  userId: string,
  nodeId: string,
  turns: readonly Turn[],
): ReplaceResult {
  const list = [...turns];
  const byteSize = snapshotByteSize(list);
  if (byteSize > MAX_RESPONSE_SNAPSHOT_BYTES) {
    throw new Error(SNAPSHOT_TOO_LARGE);
  }
  const rev = revisionOf(list);
  const node = tx
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .get();
  if (!node) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  const at = now();
  const responseSnapshotAt = strictlyAfter(node.responseSnapshotAt, at);
  tx.insert(responseSnapshots)
    .values({
      nodeId,
      revision: rev,
      turnsJson: list,
      // A node that never had a snapshot has no attempt to record an outcome
      // for; the update below deliberately leaves an existing one alone,
      // because replacing a document's markdown does not re-settle the run
      // that produced it, and boot reconciliation still needs that outcome.
      outcomeJson: null,
      byteSize,
      version: 1,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: responseSnapshots.nodeId,
      set: { revision: rev, turnsJson: list, byteSize, updatedAt: at },
    })
    .run();
  tx.update(nodes)
    .set({ responseSnapshotAt, responsePreview: responsePreview(list) ?? null })
    .where(eq(nodes.id, nodeId))
    .run();
  tx.update(trees)
    .set({ updatedAt: sql`max(${at}, ${trees.updatedAt} + 1)` })
    .where(eq(trees.id, node.treeId))
    .run();
  upsertResearchRoot(tx, node.id);
  return { revision: rev, responseSnapshotAt, byteSize };
}

/** {@link applyReplacedTurns} under its own durable transaction. */
export function replaceTurns(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  turns: readonly Turn[],
): ReplaceResult {
  return withFullSync(db, (tx) => applyReplacedTurns(tx, userId, nodeId, turns));
}

export function remove(db: SessionDatabase, userId: string, nodeId: string): boolean {
  const node = db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .get();
  if (!node) {
    return false;
  }
  const row = db
    .delete(responseSnapshots)
    .where(eq(responseSnapshots.nodeId, nodeId))
    .returning({ nodeId: responseSnapshots.nodeId })
    .get();
  return row !== undefined;
}
