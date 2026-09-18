// The durable answer, committed under the desktop's two-guard rule
// (`05-run-lifecycle-and-streaming.md` §5,
// `02-domain-model-and-database.md` §5.2).
//
// The repository owns the first guard — a snapshot must contain assistant
// text — because a snapshot without an answer is not a snapshot. The second
// guard is here, because only the runtime can read the live turns twice: the
// rule (`state.rs:8870`) is that two consecutive reads must agree before the
// answer is frozen, which is what stops a snapshot being taken of a buffer
// another write is still in the middle of.

import type { SessionDatabase } from "@session/db";
import { revisionOf, runs as runsRepo, snapshots as snapshotsRepo } from "@session/db";
import type { ResearchNodeStatus, Turn } from "@session/shared";

export interface CommitAnswerInput {
  db: SessionDatabase;
  userId: string;
  nodeId: string;
  status: ResearchNodeStatus;
  error?: string | null;
}

export interface CommitAnswerResult {
  committed: boolean;
  revision?: string;
  responseSnapshotAt?: number;
  turns: Turn[];
  /** Why the commit did not happen, for the node's `error` copy. */
  reason?: string;
}

/** Two reads of `run_turns` that hash to the same revision. A third read is
 * not attempted: if two consecutive reads disagree, something is still
 * writing, and the answer is not ready to be frozen. */
export function readStableTurns(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
): { turns: Turn[]; stable: boolean } {
  const first = runsRepo.liveWindow(db, userId, nodeId).turns;
  const second = runsRepo.liveWindow(db, userId, nodeId).turns;
  return { turns: second, stable: revisionOf(first) === revisionOf(second) };
}

const NO_ANSWER = "this research produced no readable response";

/**
 * Freezes the attempt's committed turns as the node's answer and settles the
 * node, or reports why it could not.
 *
 * A failure here is the one inconsistency this domain cannot repair — a run
 * that finished with nothing to show — so the caller turns a `false` into a
 * failed node carrying `reason` rather than leaving it `running`.
 */
export function commitAnswer(input: CommitAnswerInput): CommitAnswerResult {
  const { db, userId, nodeId } = input;
  const { turns, stable } = readStableTurns(db, userId, nodeId);
  if (!stable) {
    return { committed: false, turns, reason: "the response was still changing when it settled" };
  }
  const hasText = turns.some(
    (turn) =>
      turn.role !== "user" &&
      turn.blocks.some((block) => block.type === "text" && block.text.trim() !== ""),
  );
  if (!hasText) {
    return { committed: false, turns, reason: NO_ANSWER };
  }
  const result = snapshotsRepo.commit(db, userId, {
    nodeId,
    turns,
    outcome: { status: input.status, error: input.error ?? null },
  });
  return {
    committed: true,
    revision: result.revision,
    responseSnapshotAt: result.responseSnapshotAt,
    turns,
  };
}
