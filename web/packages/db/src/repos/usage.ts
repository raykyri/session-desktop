// Recorded provider usage, and the weekly allowance of included tokens
// (`docs/02-domain-model-and-database.md` §3.7, `docs/06-auth-and-users.md`
// §8, `docs/04-agent-runtime.md` §10).

import { and, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { newId } from "../ids.js";
import { usageEvents } from "../schema/usage.js";
import { now } from "../time.js";

import { getUserLimits } from "./auth.js";

export interface UsageEventInput {
  runId?: string | null | undefined;
  spaceId?: string | null | undefined;
  /** `session` or an API key id. */
  payer?: string | null | undefined;
  kind: "research" | "metadata" | "search" | "fetch" | "run";
  provider: string;
  model?: string | null | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cachedTokens?: number | undefined;
  costEstimateMicros?: number | undefined;
  at?: number | undefined;
}

export function record(db: SessionDatabase, userId: string, input: UsageEventInput): string {
  const id = newId();
  db.insert(usageEvents)
    .values({
      id,
      userId,
      runId: input.runId ?? null,
      spaceId: input.spaceId ?? null,
      payer: input.payer ?? null,
      kind: input.kind,
      provider: input.provider,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      reasoningTokens: input.reasoningTokens ?? 0,
      cachedTokens: input.cachedTokens ?? 0,
      costEstimateMicros: input.costEstimateMicros ?? 0,
      createdAt: input.at ?? now(),
    })
    .run();
  return id;
}

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costEstimateMicros: number;
  /** Number of runs started (attempts). */
  runs: number;
}

/** A person's usage between `start` and `end` (every payer). */
export function totalsBetween(
  db: SessionDatabase,
  userId: string,
  { start, end }: { start: number; end: number },
): Totals {
  const row = db
    .select({
      inputTokens: sql<number | null>`sum(${usageEvents.inputTokens})`,
      outputTokens: sql<number | null>`sum(${usageEvents.outputTokens})`,
      reasoningTokens: sql<number | null>`sum(${usageEvents.reasoningTokens})`,
      cachedTokens: sql<number | null>`sum(${usageEvents.cachedTokens})`,
      costEstimateMicros: sql<number | null>`sum(${usageEvents.costEstimateMicros})`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        gte(usageEvents.createdAt, start),
        lt(usageEvents.createdAt, end),
      ),
    )
    .get();
  // `run` usage events persist independently of the runs themselves
  const runs = db
    .select({ value: sql<number>`count(*)` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        eq(usageEvents.kind, "run"),
        gte(usageEvents.createdAt, start),
        lt(usageEvents.createdAt, end),
      ),
    )
    .get();
  return {
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    reasoningTokens: row?.reasoningTokens ?? 0,
    cachedTokens: row?.cachedTokens ?? 0,
    costEstimateMicros: row?.costEstimateMicros ?? 0,
    runs: runs?.value ?? 0,
  };
}

/** A person's usage this UTC week (Monday 00:00 UTC). */
export const weeklyTotals = (db: SessionDatabase, userId: string, at: number = now()) =>
  totalsBetween(db, userId, weekOf(at));

/** A person's weekly allowance of included tokens: their own, else
 * `fallback` (the deployment's `SESSION_INCLUDED_TOKENS`). */
export function weeklyAllowance(db: SessionDatabase, userId: string, fallback: number): number {
  return getUserLimits(db, userId)?.weeklyTokens ?? fallback;
}

/** The first instant of the UTC month of `at`, and of the next one. */
export function monthOf(at: number): { start: number; end: number } {
  const d = new Date(at);
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/** The UTC week of `at` (Monday 00:00 UTC to the next Monday): the period of
 * the included tokens' weekly allowance. */
export function weekOf(at: number): { start: number; end: number } {
  const d = new Date(at);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = day - ((d.getUTCDay() + 6) % 7) * 86_400_000;
  return { start, end: start + 7 * 86_400_000 };
}

/** Tokens this month by payer and space (`/api/me/usage`'s `by`): input
 * plus output tokens of every event with a payer. */
export function monthlyByPayer(
  db: SessionDatabase,
  userId: string,
  at: number = now(),
): Record<string, Record<string, number>> {
  return byPayerBetween(db, userId, monthOf(at));
}

/** Tokens one payer used this week (the included tokens' allowance). */
export function weeklyUsed(
  db: SessionDatabase,
  userId: string,
  payer: string,
  at: number = now(),
): number {
  const by = byPayerBetween(db, userId, weekOf(at))[payer] ?? {};
  return Object.values(by).reduce((a, b) => a + b, 0);
}

function byPayerBetween(
  db: SessionDatabase,
  userId: string,
  { start, end }: { start: number; end: number },
): Record<string, Record<string, number>> {
  const rows = db
    .select({
      payer: usageEvents.payer,
      spaceId: usageEvents.spaceId,
      tokens: sql<number>`sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens})`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        isNotNull(usageEvents.payer),
        ne(usageEvents.kind, "run"),
        gte(usageEvents.createdAt, start),
        lt(usageEvents.createdAt, end),
      ),
    )
    .groupBy(usageEvents.payer, usageEvents.spaceId)
    .all();
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (r.payer === null) continue;
    const by = (out[r.payer] ??= {});
    by[r.spaceId ?? ""] = (by[r.spaceId ?? ""] ?? 0) + (r.tokens ?? 0);
  }
  return out;
}

/** Tokens one payer used this month. */
export function monthlyUsed(
  db: SessionDatabase,
  userId: string,
  payer: string,
  at: number = now(),
): number {
  return Object.values(monthlyByPayer(db, userId, at)[payer] ?? {}).reduce((a, b) => a + b, 0);
}

/** Tokens each run used (its usage events), for the runs of `userId`. */
export function tokensOfRun(db: SessionDatabase, runId: string): number {
  const row = db
    .select({
      tokens: sql<number | null>`sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens})`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.runId, runId), ne(usageEvents.kind, "run")))
    .get();
  return row?.tokens ?? 0;
}
