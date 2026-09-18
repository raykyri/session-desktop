// Recorded provider usage and the daily limits it feeds
// (`docs/02-domain-model-and-database.md` §3.7, `docs/06-auth-and-users.md`
// §8, `docs/04-agent-runtime.md` §10).

import type { UsageSummary } from "@session/shared";
import { and, eq, gte, lt, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { newId } from "../ids.js";
import { nodes } from "../schema/nodes.js";
import { runAttempts } from "../schema/runs.js";
import { usageEvents } from "../schema/usage.js";
import { now, startOfUtcDay } from "../time.js";

import { getUserLimits } from "./auth.js";

/** Deployment defaults, overridden per account in `user_limits`. */
export const DEFAULT_DAILY_TOKENS = 1_000_000;
export const DEFAULT_DAILY_RUNS = 10;

export interface UsageEventInput {
  nodeId?: string | null | undefined;
  kind: "research" | "metadata" | "search" | "fetch";
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
      nodeId: input.nodeId ?? null,
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

export interface DailyTotals {
  day: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costEstimateMicros: number;
  /** Research attempts started that day — what `daily_runs` counts. */
  runs: number;
}

/** Sums one UTC day for one account. The limits count input, output, and
 * reasoning tokens; cached tokens are reported but not charged, since the
 * account did not pay full price for them. */
export function dailyTotals(db: SessionDatabase, userId: string, at: number = now()): DailyTotals {
  const day = startOfUtcDay(at);
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
        gte(usageEvents.createdAt, day),
        lt(usageEvents.createdAt, day + 86_400_000),
      ),
    )
    .get();
  // One row per attempt, which is what `daily_runs` limits
  // (`06-auth-and-users.md` §8). Counting `usage_events` of kind `research`
  // instead would charge an attempt once per usage record it wrote.
  const runs = db
    .select({ value: sql<number>`count(*)` })
    .from(runAttempts)
    .innerJoin(nodes, eq(nodes.id, runAttempts.nodeId))
    .where(
      and(
        eq(nodes.userId, userId),
        gte(runAttempts.startedAt, day),
        lt(runAttempts.startedAt, day + 86_400_000),
      ),
    )
    .get();
  return {
    day,
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    reasoningTokens: row?.reasoningTokens ?? 0,
    cachedTokens: row?.cachedTokens ?? 0,
    costEstimateMicros: row?.costEstimateMicros ?? 0,
    runs: runs?.value ?? 0,
  };
}

export interface LimitDefaults {
  dailyTokens?: number | null | undefined;
  dailyRuns?: number | null | undefined;
}

/** The limits in force for one account: the per-account override when set,
 * otherwise the deployment default. */
export function effectiveLimits(
  db: SessionDatabase,
  userId: string,
  defaults: LimitDefaults = {},
): { dailyTokens: number | null; dailyRuns: number | null } {
  const override = getUserLimits(db, userId);
  return {
    dailyTokens: override?.dailyTokens ?? defaults.dailyTokens ?? DEFAULT_DAILY_TOKENS,
    dailyRuns: override?.dailyRuns ?? defaults.dailyRuns ?? DEFAULT_DAILY_RUNS,
  };
}

export function summary(
  db: SessionDatabase,
  userId: string,
  defaults: LimitDefaults = {},
  at: number = now(),
): UsageSummary {
  const totals = dailyTotals(db, userId, at);
  const limits = effectiveLimits(db, userId, defaults);
  return {
    day: totals.day,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    cachedTokens: totals.cachedTokens,
    costEstimateMicros: totals.costEstimateMicros,
    runs: totals.runs,
    dailyTokenLimit: limits.dailyTokens,
    dailyRunLimit: limits.dailyRuns,
  };
}

export interface AdmissionDecision {
  allowed: boolean;
  /** Null when the deployment has no limit configured. */
  remainingTokens: number | null;
  remainingRuns: number | null;
  reason?: "tokens" | "runs";
}

/**
 * Whether one more research attempt may start today.
 *
 * A node over the limit stays `queued` rather than failing
 * (`06-auth-and-users.md` §8): the day rolls over, or an operator raises the
 * limit, and the work resumes. Admins are exempt.
 */
export function admissionCheck(
  db: SessionDatabase,
  userId: string,
  options: { isAdmin?: boolean; defaults?: LimitDefaults; at?: number } = {},
): AdmissionDecision {
  if (options.isAdmin === true) {
    return { allowed: true, remainingTokens: null, remainingRuns: null };
  }
  const at = options.at ?? now();
  const totals = dailyTotals(db, userId, at);
  const limits = effectiveLimits(db, userId, options.defaults ?? {});
  const spentTokens = totals.inputTokens + totals.outputTokens + totals.reasoningTokens;
  const remainingTokens =
    limits.dailyTokens === null ? null : Math.max(0, limits.dailyTokens - spentTokens);
  const remainingRuns =
    limits.dailyRuns === null ? null : Math.max(0, limits.dailyRuns - totals.runs);
  if (remainingRuns !== null && remainingRuns <= 0) {
    return { allowed: false, remainingTokens, remainingRuns, reason: "runs" };
  }
  if (remainingTokens !== null && remainingTokens <= 0) {
    return { allowed: false, remainingTokens, remainingRuns, reason: "tokens" };
  }
  return { allowed: true, remainingTokens, remainingRuns };
}
