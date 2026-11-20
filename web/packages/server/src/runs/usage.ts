// Token usage and its estimated cost (`04-agent-runtime.md` §10,
// `02-domain-model-and-database.md` §3.7).
//
// Recorded for every attempt whether or not daily limits are enforced, because
// the limits are turned on later against history that has to already exist.

import type { AttemptUsage, SessionDatabase } from "@session/db";
import { usage as usageRepo } from "@session/db";
import type { ModelEntry } from "@session/shared";
import { estimateCostMicros } from "@session/shared";
import type { LanguageModelUsage } from "ai";

/** The SDK's nested usage flattened into the four numbers `usage_events` and
 * `run_attempts.usage_json` carry. */
export function attemptUsageOf(usage: LanguageModelUsage | undefined): AttemptUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    cachedTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}

/**
 * Cost in micro-dollars from the registry's price table.
 *
 * `outputTokens` already includes reasoning tokens in the SDK's accounting, so
 * the reasoning count is not added again — passing it to
 * `estimateCostMicros`, which sums the two, would bill thinking twice.
 */
export function costOf(entry: ModelEntry, usage: AttemptUsage): number {
  return estimateCostMicros(entry, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
}

export interface RecordAttemptUsageInput {
  db: SessionDatabase;
  userId: string;
  nodeId: string | null;
  entry: ModelEntry;
  kind: "research" | "metadata";
  usage: AttemptUsage;
}

export function recordAttemptUsage(input: RecordAttemptUsageInput): number {
  const cost = costOf(input.entry, input.usage);
  usageRepo.record(input.db, input.userId, {
    nodeId: input.nodeId,
    kind: input.kind,
    provider: input.entry.provider,
    model: input.entry.id,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    reasoningTokens: input.usage.reasoningTokens,
    cachedTokens: input.usage.cachedTokens,
    costEstimateMicros: cost,
  });
  return cost;
}

/** Tool calls are billed by the vendor per call, not per token, so they are
 * their own usage rows with no token counts (`04` §6.2 for grounding). */
export function recordToolUsage(
  db: SessionDatabase,
  userId: string,
  nodeId: string | null,
  kind: "search" | "fetch",
  provider: string,
  count: number,
): void {
  if (count <= 0) {
    return;
  }
  for (let index = 0; index < count; index += 1) {
    usageRepo.record(db, userId, { nodeId, kind, provider });
  }
}
