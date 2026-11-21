// Recorded provider usage and the per-member weekly allowance override
// (`docs/02-domain-model-and-database.md` §3.7, `docs/06-auth-and-users.md`
// §8). The ledger of provider calls is the server's `SqliteLedger` over
// `usage_events`.

import { eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { newId } from "../ids.js";
import { usageEvents } from "../schema/usage.js";
import { userLimits } from "../schema/users.js";
import { now } from "../time.js";

export interface UsageEventInput {
  nodeId?: string | null | undefined;
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

/** The member's weekly allowance override (`user_limits.weekly_tokens`,
 * plan `03` K3), or null for the deployment's `SESSION_WEEKLY_TOKENS`. */
export function weeklyAllowance(db: SessionDatabase, userId: string): number | null {
  const row = db
    .select({ weeklyTokens: userLimits.weeklyTokens })
    .from(userLimits)
    .where(eq(userLimits.userId, userId))
    .get();
  return row?.weeklyTokens ?? null;
}

/** Sets the member's weekly allowance override to `tokens` (a positive
 * integer), or clears it with null. */
export function setWeeklyAllowance(
  db: SessionDatabase,
  userId: string,
  tokens: number | null,
): void {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0))
    throw new RangeError("a weekly allowance is a positive whole number of tokens");
  const at = now();
  db.insert(userLimits)
    .values({ userId, weeklyTokens: tokens, updatedAt: at })
    .onConflictDoUpdate({ target: userLimits.userId, set: { weeklyTokens: tokens, updatedAt: at } })
    .run();
}
