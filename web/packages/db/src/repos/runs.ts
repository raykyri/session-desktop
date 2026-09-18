// The live output of an attempt and the per-attempt record
// (`docs/05-run-lifecycle-and-streaming.md` §5,
// `docs/02-domain-model-and-database.md` §3.3).

import type { Turn } from "@session/shared";
import { turnSchema } from "@session/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import type { AttemptUsage } from "../json.js";
import { parseJsonColumn } from "../json.js";
import { nodes } from "../schema/nodes.js";
import { runAttempts, runTurns } from "../schema/runs.js";
import { now } from "../time.js";

function requireNode(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
): typeof nodes.$inferSelect {
  const row = db
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .get();
  if (!row) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  return row;
}

/** Text of a turn's `text` blocks, which is what the live tail renders. */
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

/**
 * Persists a finished turn and bumps `run_seq` in the same transaction, so a
 * client that has seen sequence `n` has seen exactly the turns written up to
 * it (`docs/05` §5). Re-writing the same `turn_id` replaces the in-flight
 * checkpoint the turn was streaming into.
 */
export function commitTurn(db: SessionDatabase, userId: string, input: TurnWrite): TurnWriteResult {
  return writeTurn(db, userId, input, true);
}

/**
 * Writes the in-flight checkpoint: the assistant text produced since the last
 * committed turn, at most one second or 4 KiB stale. One uncommitted row per
 * attempt, replaced in place.
 */
export function checkpointInFlight(
  db: SessionDatabase,
  userId: string,
  input: TurnWrite,
): TurnWriteResult {
  return writeTurn(db, userId, input, false);
}

function writeTurn(
  db: SessionDatabase,
  userId: string,
  input: TurnWrite,
  committed: boolean,
): TurnWriteResult {
  return transact(db, (tx) => {
    const node = requireNode(tx, userId, input.nodeId);
    const attempt = input.attempt ?? node.attempt;
    if (!committed) {
      // One uncommitted row per attempt (`docs/05` §5). When the runtime moves
      // on to a new turn without committing the last checkpoint, the old row
      // would otherwise survive and `liveWindow` would read whichever of the
      // two happened to sort last.
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
    const seq = node.runSeq + 1;
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

/** The snapshot half of the streaming protocol for an active node
 * (`docs/05` §4). */
export function liveWindow(db: SessionDatabase, userId: string, nodeId: string): LiveWindow {
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
    const turn = parseJsonColumn(turnSchema, row.turnJson, "run_turns.turn_json");
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

/** Drops every live row for a node. The snapshot commit does this as part of
 * its transaction; this is for the paths that discard an attempt. */
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
  /** Defaults to the current time. `run_attempts.started_at` is what the daily
   * run limit counts, so a test pins it rather than the wall clock. */
  at?: number | undefined;
}

export function startAttempt(db: SessionDatabase, input: AttemptStart): void {
  const at = input.at ?? now();
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
 * Raises `nodes.run_seq` to at least `toAtLeast` and returns the value it
 * settled on.
 *
 * The runtime emits more run events than it writes rows: text deltas are
 * forwarded, not persisted, and every one of them consumes a sequence number
 * the client orders by (`docs/03-api-and-events.md` §3). The counter therefore
 * lives in the loop's memory between writes, and this call carries it back
 * into the row before the next write bumps it again — without which a
 * `getNodeContent` taken after a burst of deltas would report a sequence lower
 * than the client has already applied, and every further delta would look like
 * a replay.
 *
 * Monotonic: a value at or below the stored one leaves the row alone.
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
