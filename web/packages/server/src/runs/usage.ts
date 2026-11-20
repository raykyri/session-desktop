// Estimated cost and per-call tool usage (`04-agent-runtime.md` §10,
// `02-domain-model-and-database.md` §3.7).
//
// Tokens are not recorded here: every provider call has its own ledger row,
// written as the call spends (`ledger.ts`, `meter.ts`; `03` K1). Search and
// fetch calls are billed by their vendors per call, not per token, and keep
// their own `usage_events` rows.

import type { SessionDatabase } from "@session/db";
import { usage as usageRepo } from "@session/db";
import type { ModelEntry } from "@session/shared";
import { estimateCostMicros } from "@session/shared";

import type { AttemptUsage } from "./store.js";

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
