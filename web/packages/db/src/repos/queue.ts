// Admission control (`docs/05-run-lifecycle-and-streaming.md` §8,
// `docs/04-agent-runtime.md` §10).
//
// Queue system implementing rate-limiting and admission control across users and providers.

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { nodes } from "../schema/nodes.js";
import { runQueue } from "../schema/runs.js";
import { now } from "../time.js";

/**
 * Which cap a queued row is admitted under.
 *
 * Only `research` is ever written today: the metadata pool of four
 * (`docs/04-agent-runtime.md` §10) is an in-memory queue in
 * `RunsService`, because a title or a recap that a restart loses is
 * regenerated from the answer it summarizes and never worth a durable row.
 * The arm stays because `run_queue.pool` is declared with both values and
 * dropping one is a migration; it is the seam a metadata run would use if it
 * ever had to survive a deploy.
 */
export type RunPool = "research" | "metadata";

export interface EnqueueInput {
  nodeId: string;
  pool?: RunPool | undefined;
  /** The provider the node's model routes to, for the per-provider cap. */
  provider: string;
  /** Head-of-queue insertion for a resume. */
  enqueuedAt?: number | undefined;
  notBefore?: number | null | undefined;
}

export function enqueue(db: SessionDatabase, userId: string, input: EnqueueInput): void {
  const at = input.enqueuedAt ?? now();
  const node = db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, input.nodeId)))
    .get();
  if (!node) {
    throw new Error(`research node ${input.nodeId} was not found`);
  }
  db.insert(runQueue)
    .values({
      nodeId: input.nodeId,
      userId,
      pool: input.pool ?? "research",
      provider: input.provider,
      enqueuedAt: at,
      claimedAt: null,
      notBefore: input.notBefore ?? null,
    })
    .onConflictDoUpdate({
      target: runQueue.nodeId,
      set: {
        pool: input.pool ?? "research",
        provider: input.provider,
        enqueuedAt: at,
        claimedAt: null,
        notBefore: input.notBefore ?? null,
      },
    })
    .run();
}

export interface ClaimLimits {
  pool?: RunPool | undefined;
  /** Maximum claims returned by this call. */
  limit?: number | undefined;
  /** Concurrent runs per user (2 for research). */
  perUser?: number | undefined;
  /** Concurrent runs per provider, by provider name. */
  perProvider?: Readonly<Record<string, number>> | undefined;
  /** Default cap for a provider not named in `perProvider`. */
  providerDefault?: number | undefined;
  at?: number | undefined;
}

export interface ClaimedRun {
  nodeId: string;
  userId: string;
  provider: string;
  pool: RunPool;
  enqueuedAt: number;
}

/**
 * Claims runnable rows.
 *
 * Fair rather than strictly first-come: candidates are grouped by user, each
 * user's own rows stay in `enqueued_at` order, and the claim round-robins
 * across users ordered by their oldest waiting row. One account submitting
 * twenty questions therefore cannot push everyone else behind them, which is
 * what "nobody's run is starved silently" asks for. A row held back by
 * `not_before` (a 429 backoff) is invisible until its time comes.
 */
export function claim(db: SessionDatabase, limits: ClaimLimits = {}): ClaimedRun[] {
  const pool = limits.pool ?? "research";
  const at = limits.at ?? now();
  const perUser = limits.perUser ?? 2;
  const providerDefault = limits.providerDefault ?? 8;
  const limit = limits.limit ?? Number.MAX_SAFE_INTEGER;
  return transact(db, (tx) => {
    const inFlight = tx
      .select({ userId: runQueue.userId, provider: runQueue.provider })
      .from(runQueue)
      .where(and(eq(runQueue.pool, pool), sql`${runQueue.claimedAt} IS NOT NULL`))
      .all();
    const perUserCount = new Map<string, number>();
    const perProviderCount = new Map<string, number>();
    for (const row of inFlight) {
      perUserCount.set(row.userId, (perUserCount.get(row.userId) ?? 0) + 1);
      perProviderCount.set(row.provider, (perProviderCount.get(row.provider) ?? 0) + 1);
    }
    const waiting = tx
      .select()
      .from(runQueue)
      .where(
        and(
          eq(runQueue.pool, pool),
          isNull(runQueue.claimedAt),
          or(isNull(runQueue.notBefore), sql`${runQueue.notBefore} <= ${at}`),
        ),
      )
      .orderBy(asc(runQueue.enqueuedAt), asc(runQueue.nodeId))
      .all();
    const byUser = new Map<string, (typeof waiting)[number][]>();
    for (const row of waiting) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    // Users in the order their oldest waiting row arrived.
    const userOrder = [...byUser.keys()].sort((left, right) => {
      const leftRow = byUser.get(left)?.[0];
      const rightRow = byUser.get(right)?.[0];
      const leftAt = leftRow?.enqueuedAt ?? 0;
      const rightAt = rightRow?.enqueuedAt ?? 0;
      return leftAt - rightAt || left.localeCompare(right);
    });
    const cursor = new Map<string, number>();
    const claimed: ClaimedRun[] = [];
    let progressed = true;
    while (claimed.length < limit && progressed) {
      progressed = false;
      for (const userId of userOrder) {
        if (claimed.length >= limit) {
          break;
        }
        const rows = byUser.get(userId) ?? [];
        const index = cursor.get(userId) ?? 0;
        if (index >= rows.length) {
          continue;
        }
        if ((perUserCount.get(userId) ?? 0) >= perUser) {
          continue;
        }
        const row = rows[index];
        if (!row) {
          continue;
        }
        const providerCap = limits.perProvider?.[row.provider] ?? providerDefault;
        if ((perProviderCount.get(row.provider) ?? 0) >= providerCap) {
          // The whole user is not blocked, but this row is; move past it so a
          // later row on a free provider is still reachable.
          cursor.set(userId, index + 1);
          progressed = true;
          continue;
        }
        cursor.set(userId, index + 1);
        perUserCount.set(userId, (perUserCount.get(userId) ?? 0) + 1);
        perProviderCount.set(row.provider, (perProviderCount.get(row.provider) ?? 0) + 1);
        tx.update(runQueue).set({ claimedAt: at }).where(eq(runQueue.nodeId, row.nodeId)).run();
        claimed.push({
          nodeId: row.nodeId,
          userId: row.userId,
          provider: row.provider,
          pool,
          enqueuedAt: row.enqueuedAt,
        });
        progressed = true;
      }
    }
    return claimed;
  });
}

/** Removes the row: the run finished, was cancelled, or failed for good. */
export function release(db: SessionDatabase, nodeId: string): boolean {
  const row = db
    .delete(runQueue)
    .where(eq(runQueue.nodeId, nodeId))
    .returning({ nodeId: runQueue.nodeId })
    .get();
  return row !== undefined;
}

/** Puts a claimed row back with a delay — the 429 path (5 s, 20 s, 60 s). */
export function requeueWithBackoff(db: SessionDatabase, nodeId: string, notBefore: number): void {
  db.update(runQueue).set({ claimedAt: null, notBefore }).where(eq(runQueue.nodeId, nodeId)).run();
}

/**
 * 1-based position among the rows still waiting in the same pool, or 0 once
 * the run is claimed — the number `research.node.updated` carries while a node
 * is `queued`.
 */
export function position(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  at: number = now(),
): number {
  const row = db
    .select()
    .from(runQueue)
    .where(and(eq(runQueue.userId, userId), eq(runQueue.nodeId, nodeId)))
    .get();
  if (!row || row.claimedAt !== null) {
    return 0;
  }
  const ahead = db
    .select({ value: sql<number>`count(*)` })
    .from(runQueue)
    .where(
      and(
        eq(runQueue.pool, row.pool),
        isNull(runQueue.claimedAt),
        // Rows backed off due to HTTP 429 are excluded from active claim counts to avoid overstating queue wait depth.
        or(isNull(runQueue.notBefore), sql`${runQueue.notBefore} <= ${at}`),
        sql`(${runQueue.enqueuedAt}, ${runQueue.nodeId}) < (${row.enqueuedAt}, ${row.nodeId})`,
      ),
    )
    .get();
  return (ahead?.value ?? 0) + 1;
}

/**
 * Number of rows queued for this account. The per-user concurrency cap bounds
 * what *runs*; this is what bounds what has been admitted, which is the number
 * that decides the bill — a queue is spend already committed to
 * (`docs/06-auth-and-users.md` §8).
 */
export function queuedCount(
  db: SessionDatabase,
  userId: string,
  pool: RunPool = "research",
): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(runQueue)
    .where(and(eq(runQueue.userId, userId), eq(runQueue.pool, pool), isNull(runQueue.claimedAt)))
    .get();
  return row?.value ?? 0;
}

/** Positions for every waiting node of one account, for a list render. */
export function positions(
  db: SessionDatabase,
  userId: string,
  at: number = now(),
): Map<string, number> {
  const mine = db
    .select({ nodeId: runQueue.nodeId })
    .from(runQueue)
    .where(and(eq(runQueue.userId, userId), isNull(runQueue.claimedAt)))
    .all();
  return new Map(mine.map((row) => [row.nodeId, position(db, userId, row.nodeId, at)]));
}
