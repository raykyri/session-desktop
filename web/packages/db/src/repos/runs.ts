// The run queue and attempts of server jobs (phase 2a). The run record
// (status, answer, turns) is in `@session/sync`'s store; these rows are the
// job runner's own state, keyed by the run's id.

import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import type { AttemptUsage } from "../json.js";
import { runAttempts, runQueue } from "../schema/runs.js";
import { now } from "../time.js";

export type QueueRow = typeof runQueue.$inferSelect;
export type AttemptRow = typeof runAttempts.$inferSelect;

/** Put run `runId` in the queue; a run queued already keeps its row (the
 * effect worker starts a job at least once). Answers whether it was new. */
export function enqueue(
  db: SessionDatabase,
  input: { runId: string; userId: string; provider: string; at?: number },
): boolean {
  const r = db
    .insert(runQueue)
    .values({
      runId: input.runId,
      userId: input.userId,
      provider: input.provider,
      enqueuedAt: input.at ?? now(),
    })
    .onConflictDoNothing()
    .run();
  return r.changes > 0;
}

export function get(db: SessionDatabase, runId: string): QueueRow | null {
  return db.select().from(runQueue).where(eq(runQueue.runId, runId)).get() ?? null;
}

/** The unclaimed rows that may start at `at`, oldest first. */
export function waiting(db: SessionDatabase, at: number = now()): QueueRow[] {
  return db
    .select()
    .from(runQueue)
    .where(
      and(isNull(runQueue.claimedAt), or(isNull(runQueue.notBefore), lte(runQueue.notBefore, at))),
    )
    .orderBy(asc(runQueue.enqueuedAt), asc(runQueue.runId))
    .all();
}

/** The claimed rows (attempts running, or running when the process stopped). */
export function claimed(db: SessionDatabase): QueueRow[] {
  return db
    .select()
    .from(runQueue)
    .where(isNotNull(runQueue.claimedAt))
    .orderBy(asc(runQueue.claimedAt))
    .all();
}

/** Running attempts by user and by provider, for the concurrency caps. */
export function runningCounts(db: SessionDatabase): {
  byUser: Map<string, number>;
  byProvider: Map<string, number>;
} {
  const byUser = new Map<string, number>();
  const byProvider = new Map<string, number>();
  for (const r of claimed(db)) {
    byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + 1);
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1);
  }
  return { byUser, byProvider };
}

/** Queued rows of a user, claimed or not. */
export function countOfUser(db: SessionDatabase, userId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(runQueue)
      .where(eq(runQueue.userId, userId))
      .get()?.n ?? 0
  );
}

export function claim(db: SessionDatabase, runId: string, at: number = now()): boolean {
  const r = db
    .update(runQueue)
    .set({ claimedAt: at, notBefore: null })
    .where(and(eq(runQueue.runId, runId), isNull(runQueue.claimedAt)))
    .run();
  return r.changes > 0;
}

/** Put a claimed row back, to start again at `notBefore` (a 429), or now. */
export function requeue(db: SessionDatabase, runId: string, notBefore: number | null): void {
  db.update(runQueue).set({ claimedAt: null, notBefore }).where(eq(runQueue.runId, runId)).run();
}

/** Count one automatic resume of a run after a restart; answers how many. */
export function noteResume(db: SessionDatabase, runId: string): number {
  const row = db
    .update(runQueue)
    .set({ resumes: sql`${runQueue.resumes} + 1`, claimedAt: null })
    .where(eq(runQueue.runId, runId))
    .returning({ resumes: runQueue.resumes })
    .get();
  return row?.resumes ?? 0;
}

export function setSeq(db: SessionDatabase, runId: string, seq: number): void {
  db.update(runQueue).set({ seq }).where(eq(runQueue.runId, runId)).run();
}

export function release(db: SessionDatabase, runId: string): void {
  db.delete(runQueue).where(eq(runQueue.runId, runId)).run();
}

// ---- attempts ----

export function startAttempt(
  db: SessionDatabase,
  input: {
    runId: string;
    kind: "fresh" | "resume";
    model: string;
    payer: string | null;
    at?: number;
  },
): number {
  const last = db
    .select({ n: sql<number | null>`max(${runAttempts.n})` })
    .from(runAttempts)
    .where(eq(runAttempts.runId, input.runId))
    .get();
  const n = (last?.n ?? 0) + 1;
  db.insert(runAttempts)
    .values({
      runId: input.runId,
      n,
      kind: input.kind,
      model: input.model,
      payer: input.payer,
      startedAt: input.at ?? now(),
    })
    .run();
  return n;
}

export function finishAttempt(
  db: SessionDatabase,
  input: {
    runId: string;
    n: number;
    outcome: string;
    errorClass?: string | null;
    steps?: number;
    toolCalls?: number;
    usage?: AttemptUsage | null;
    costEstimateMicros?: number | null;
    at?: number;
  },
): void {
  db.update(runAttempts)
    .set({
      endedAt: input.at ?? now(),
      outcome: input.outcome,
      errorClass: input.errorClass ?? null,
      steps: input.steps ?? 0,
      toolCalls: input.toolCalls ?? 0,
      usageJson: input.usage ?? null,
      costEstimateMicros: input.costEstimateMicros ?? null,
    })
    .where(and(eq(runAttempts.runId, input.runId), eq(runAttempts.n, input.n)))
    .run();
}

export function attempts(db: SessionDatabase, runId: string): AttemptRow[] {
  return db
    .select()
    .from(runAttempts)
    .where(eq(runAttempts.runId, runId))
    .orderBy(asc(runAttempts.n))
    .all();
}
