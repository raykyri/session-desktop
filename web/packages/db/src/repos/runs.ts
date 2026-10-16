// The live output of an attempt and the per-attempt record
// (`docs/05-run-lifecycle-and-streaming.md` §5,
// `docs/02-domain-model-and-database.md` §3.3).

import type { Turn } from "@session/shared";
import { findModel, turnSchema } from "@session/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import type { AttemptUsage } from "../json.js";
import { parseWireColumn } from "../json.js";
import { nodes } from "../schema/nodes.js";
import { runAttempts, runTurns } from "../schema/runs.js";
import { trees } from "../schema/trees.js";
import { usageEvents } from "../schema/usage.js";
import { now } from "../time.js";

import { nodeReadableBy, payerOf } from "./access.js";

function requireNode(
  db: SessionDatabase,
  userId: string | null,
  nodeId: string,
): typeof nodes.$inferSelect {
  const row = db
    .select()
    .from(nodes)
    .where(and(nodeReadableBy(userId), eq(nodes.id, nodeId)))
    .get();
  if (!row) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  return row;
}

/** Extracts text content from text blocks within a turn for streaming tail display. */
function turnText(turn: Turn): string {
  return turn.blocks
    .filter(
      (block): block is Extract<Turn["blocks"][number], { type: "text" }> => block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function nextPosition(db: SessionDatabase, nodeId: string, attempt: number): number {
  const row = db
    .select({ value: sql<number | null>`max(${runTurns.position})` })
    .from(runTurns)
    .where(and(eq(runTurns.nodeId, nodeId), eq(runTurns.attempt, attempt)))
    .get();
  return (row?.value ?? -1) + 1;
}

export interface TurnWrite {
  nodeId: string;
  turn: Turn;
  /** Defaults to the node's current attempt. */
  attempt?: number | undefined;
  /** Defaults to one past the highest position of the attempt. */
  position?: number | undefined;
}

export interface TurnWriteResult {
  seq: number;
  position: number;
  attempt: number;
}

export interface CheckpointWrite extends TurnWrite {
  /**
   * Sequence number of the run reached at this checkpoint. Checkpoints do not
   * emit events, so this records the existing sequence counter without allocating a new
   * sequence number, maintaining contiguous sequence numbers for clients.
   */
  seq: number;
}

/**
 * Persists a committed turn and increments `run_seq` atomically.
 * Writing a committed turn replaces any existing uncommitted checkpoint with matching `turn_id`.
 */
export function commitTurn(db: SessionDatabase, userId: string, input: TurnWrite): TurnWriteResult {
  return writeTurn(db, userId, input, true);
}

/**
 * Writes an uncommitted streaming checkpoint for an attempt, replacing any
 * previous uncommitted checkpoint for that attempt in place.
 */
export function checkpointInFlight(
  db: SessionDatabase,
  userId: string,
  input: CheckpointWrite,
): TurnWriteResult {
  return writeTurn(db, userId, input, false, input.seq);
}

function writeTurn(
  db: SessionDatabase,
  userId: string,
  input: TurnWrite,
  committed: boolean,
  recordSeq?: number,
): TurnWriteResult {
  return transact(db, (tx) => {
    const node = requireNode(tx, userId, input.nodeId);
    const attempt = input.attempt ?? node.attempt;
    if (!committed) {
      // Maintain at most one uncommitted checkpoint row per attempt.
      tx.delete(runTurns)
        .where(
          and(
            eq(runTurns.nodeId, node.id),
            eq(runTurns.attempt, attempt),
            eq(runTurns.committed, false),
            ne(runTurns.turnId, input.turn.id),
          ),
        )
        .run();
    }
    const existing = tx
      .select({ position: runTurns.position })
      .from(runTurns)
      .where(
        and(
          eq(runTurns.nodeId, node.id),
          eq(runTurns.attempt, attempt),
          eq(runTurns.turnId, input.turn.id),
        ),
      )
      .get();
    const position = input.position ?? existing?.position ?? nextPosition(tx, node.id, attempt);
    // Use caller-provided sequence if specified; otherwise increment run sequence.
    const seq = recordSeq === undefined ? node.runSeq + 1 : Math.max(recordSeq, node.runSeq);
    const at = now();
    tx.update(nodes).set({ runSeq: seq }).where(eq(nodes.id, node.id)).run();
    tx.insert(runTurns)
      .values({
        nodeId: node.id,
        attempt,
        turnId: input.turn.id,
        position,
        turnJson: input.turn,
        committed,
        seq,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [runTurns.nodeId, runTurns.attempt, runTurns.turnId],
        set: { position, turnJson: input.turn, committed, seq, updatedAt: at },
      })
      .run();
    return { seq, position, attempt };
  });
}

export interface LiveWindow {
  /** Committed turns of the current attempt, in order. */
  turns: Turn[];
  /** Text streamed since the last committed turn, when a checkpoint exists. */
  inFlightText?: string;
  inFlightTurnId?: string;
  /** The node's sequence number these turns were read at. */
  seq: number;
  attempt: number;
}

/** Returns the snapshot state of the streaming protocol for an active node
 * (`docs/05` §4). */
export function liveWindow(db: SessionDatabase, userId: string | null, nodeId: string): LiveWindow {
  const node = requireNode(db, userId, nodeId);
  const rows = db
    .select()
    .from(runTurns)
    .where(and(eq(runTurns.nodeId, nodeId), eq(runTurns.attempt, node.attempt)))
    .orderBy(asc(runTurns.position))
    .all();
  const turns: Turn[] = [];
  let inFlight: { text: string; turnId: string } | undefined;
  for (const row of rows) {
    const turn = parseWireColumn<Turn>(turnSchema, row.turnJson, "run_turns.turn_json");
    if (row.committed) {
      turns.push(turn);
    } else {
      inFlight = { text: turnText(turn), turnId: turn.id };
    }
  }
  return {
    turns,
    ...(inFlight === undefined
      ? {}
      : { inFlightText: inFlight.text, inFlightTurnId: inFlight.turnId }),
    seq: node.runSeq,
    attempt: node.attempt,
  };
}

/** Deletes all turn records for `nodeId`, returning the count of deleted rows. */
export function clearRunTurns(db: SessionDatabase, nodeId: string): number {
  return db
    .delete(runTurns)
    .where(eq(runTurns.nodeId, nodeId))
    .returning({ seq: runTurns.seq })
    .all().length;
}

export interface AttemptStart {
  nodeId: string;
  attempt: number;
  kind: "fresh" | "resume";
  model: string;
  /** Timestamp recorded for daily run limit tracking; defaults to current time,
   * or a fixed timestamp in tests. */
  at?: number | undefined;
}

/** Generates a deterministic usage event ID for an attempt run. */
export function runUsageId(nodeId: string, attempt: number): string {
  return `run:${nodeId}:${attempt}`;
}

/**
 * Creates or updates the `run_attempts` record and logs a corresponding `run`
 * usage event for quota tracking. Usage records persist independently of node deletions.
 */
export function startAttempt(db: SessionDatabase, input: AttemptStart): void {
  const at = input.at ?? now();
  transact(db, (tx) => {
    const node = tx
      .select({ authorId: nodes.authorId, ownerId: trees.ownerId })
      .from(nodes)
      .innerJoin(trees, eq(trees.id, nodes.treeId))
      .where(eq(nodes.id, input.nodeId))
      .get();
    if (node) {
      tx.insert(usageEvents)
        .values({
          id: runUsageId(input.nodeId, input.attempt),
          userId: payerOf({ authorId: node.authorId }, { ownerId: node.ownerId }),
          nodeId: input.nodeId,
          kind: "run",
          provider: findModel(input.model)?.provider ?? input.model,
          model: input.model,
          createdAt: at,
        })
        .onConflictDoNothing()
        .run();
    }
    writeAttemptRow(tx, input, at);
  });
}

function writeAttemptRow(db: SessionDatabase, input: AttemptStart, at: number): void {
  db.insert(runAttempts)
    .values({
      nodeId: input.nodeId,
      attempt: input.attempt,
      kind: input.kind,
      model: input.model,
      startedAt: at,
      endedAt: null,
      outcome: null,
      errorClass: null,
      steps: 0,
      toolCalls: 0,
      usageJson: null,
      costEstimateMicros: null,
    })
    .onConflictDoUpdate({
      target: [runAttempts.nodeId, runAttempts.attempt],
      set: { kind: input.kind, model: input.model, startedAt: at, endedAt: null, outcome: null },
    })
    .run();
}

export interface AttemptEnd {
  nodeId: string;
  attempt: number;
  outcome: string;
  errorClass?: string | null | undefined;
  steps?: number | undefined;
  toolCalls?: number | undefined;
  usage?: AttemptUsage | null | undefined;
  costEstimateMicros?: number | null | undefined;
}

export function finishAttempt(db: SessionDatabase, input: AttemptEnd): void {
  db.update(runAttempts)
    .set({
      endedAt: now(),
      outcome: input.outcome,
      errorClass: input.errorClass ?? null,
      steps: input.steps ?? 0,
      toolCalls: input.toolCalls ?? 0,
      usageJson: input.usage ?? null,
      costEstimateMicros: input.costEstimateMicros ?? null,
    })
    .where(and(eq(runAttempts.nodeId, input.nodeId), eq(runAttempts.attempt, input.attempt)))
    .run();
}

export function listAttempts(
  db: SessionDatabase,
  nodeId: string,
): (typeof runAttempts.$inferSelect)[] {
  return db
    .select()
    .from(runAttempts)
    .where(eq(runAttempts.nodeId, nodeId))
    .orderBy(asc(runAttempts.attempt))
    .all();
}

/**
 * Monotonically advances `nodes.run_seq` to at least `toAtLeast`, returning the updated value.
 *
 * Synchronizes the persisted sequence counter with in-memory streaming event counters,
 * ensuring snapshot reads do not regress sequence numbers observed by clients.
 */
export function advanceSeq(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  toAtLeast: number,
): number {
  const node = requireNode(db, userId, nodeId);
  if (node.runSeq >= toAtLeast) {
    return node.runSeq;
  }
  db.update(nodes).set({ runSeq: toAtLeast }).where(eq(nodes.id, nodeId)).run();
  return toAtLeast;
}
