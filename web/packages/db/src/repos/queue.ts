// Admission control (`docs/05-run-lifecycle-and-streaming.md` §8,
// `docs/04-agent-runtime.md` §10).
//
// Queue system implementing rate-limiting and admission control across users and providers.

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { nodes } from "../schema/nodes.js";
import { runQueue } from "../schema/runs.js";
import { nextUtcMidnight, now } from "../time.js";

import { nodeReadableBy } from "./access.js";

/**
 * Execution pool classification for admission control.
 *
 * Currently only `research` tasks are persisted to the database. Metadata operations
 * run via an in-memory queue. The `metadata` pool enum value is preserved for schema
 * compatibility and future persistence support.
 */
export type RunPool = "research" | "metadata";

export interface EnqueueInput {
  nodeId: string;
  pool?: RunPool | undefined;
  /** The provider the node's model routes to, for the per-provider cap. */
  provider: string;
  /** Enqueues at the front of the queue for resumed runs. */
  enqueuedAt?: number | undefined;
  notBefore?: number | null | undefined;
}

export function enqueue(db: SessionDatabase, userId: string, input: EnqueueInput): void {
  const at = input.enqueuedAt ?? now();
  const node = db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(nodeReadableBy(userId), eq(nodes.id, input.nodeId)))
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
 * Claims runnable queue items according to user and provider concurrency limits.
 *
 * Implements round-robin scheduling across users ordered by oldest enqueued item,
 * preventing starvation from high-volume single users. Items with a future `notBefore`
 * timestamp (such as backoff delays) are excluded from claims.
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
          // The current provider is saturated; advance cursor to check subsequent items.
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

/** Deletes a queue entry upon run completion, cancellation, or terminal failure. */
export function release(db: SessionDatabase, nodeId: string): boolean {
  const row = db
    .delete(runQueue)
    .where(eq(runQueue.nodeId, nodeId))
    .returning({ nodeId: runQueue.nodeId })
    .get();
  return row !== undefined;
}

/**
 * Removes a queue row conditionally if `attempt` matches the node's current attempt,
 * preventing a superseded run attempt from deleting a subsequent attempt's queue entry.
 */
export function releaseAttempt(db: SessionDatabase, nodeId: string, attempt: number): boolean {
  const row = db
    .delete(runQueue)
    .where(
      and(
        eq(runQueue.nodeId, nodeId),
        sql`(select ${nodes.attempt} from ${nodes} where ${nodes.id} = ${nodeId}) = ${attempt}`,
      ),
    )
    .returning({ nodeId: runQueue.nodeId })
    .get();
  return row !== undefined;
}

/**
 * Clears daily limit hold delays (`notBefore`) for `userId` when quota limits
 * are modified, returning the released node IDs.
 */
export function releaseDailyHolds(
  db: SessionDatabase,
  userId: string,
  at: number = now(),
): string[] {
  return db
    .update(runQueue)
    .set({ notBefore: null })
    .where(
      and(
        eq(runQueue.userId, userId),
        isNull(runQueue.claimedAt),
        sql`${runQueue.notBefore} >= ${nextUtcMidnight(at)}`,
      ),
    )
    .returning({ nodeId: runQueue.nodeId })
    .all()
    .map((row) => row.nodeId);
}

/** Makes an unclaimed row claimable now, clearing its `not_before`. */
export function clearBackoff(db: SessionDatabase, nodeId: string): boolean {
  const row = db
    .update(runQueue)
    .set({ notBefore: null })
    .where(and(eq(runQueue.nodeId, nodeId), isNull(runQueue.claimedAt)))
    .returning({ nodeId: runQueue.nodeId })
    .get();
  return row !== undefined;
}

/** Re-enqueues a claimed row with a backoff timestamp in `notBefore`. */
export function requeueWithBackoff(db: SessionDatabase, nodeId: string, notBefore: number): void {
  db.update(runQueue).set({ claimedAt: null, notBefore }).where(eq(runQueue.nodeId, nodeId)).run();
}

/** Clears `notBefore` delays for child nodes awaiting parent run completion. */
export function wakeChildrenOf(db: SessionDatabase, parentNodeId: string): number {
  return db
    .update(runQueue)
    .set({ notBefore: null })
    .where(
      and(
        isNull(runQueue.claimedAt),
        sql`${runQueue.notBefore} IS NOT NULL`,
        sql`${runQueue.nodeId} IN (select ${nodes.id} from ${nodes} where ${nodes.parentNodeId} = ${parentNodeId})`,
      ),
    )
    .returning({ nodeId: runQueue.nodeId })
    .all().length;
}

/**
 * Returns 1-based queue position among waiting rows in the specified pool,
 * or 0 if the row is already claimed or absent.
 */
export function position(
  db: SessionDatabase,
  /** The account paying for the run, or null to match any account (for readers
   * viewing queue position in shared threads). The caller verifies read permissions. */
  userId: string | null,
  nodeId: string,
  at: number = now(),
): number {
  const row = db
    .select()
    .from(runQueue)
    .where(
      and(userId === null ? undefined : eq(runQueue.userId, userId), eq(runQueue.nodeId, nodeId)),
    )
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
 * Returns the count of unclaimed queue entries currently enqueued for `userId`.
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

/** Returns queue positions for all waiting nodes of an account, for display in a list. */
export function positions(
  db: SessionDatabase,
  userId: string,
  at: number = now(),
): Map<string, number> {
  const waiting = db
    .select({ nodeId: runQueue.nodeId })
    .from(runQueue)
    .where(and(eq(runQueue.userId, userId), isNull(runQueue.claimedAt)))
    .all();
  return new Map(waiting.map((row) => [row.nodeId, position(db, userId, row.nodeId, at)]));
}
