// Recorded provider usage and the per-member overrides in `user_limits`: the
// weekly allowance and the extra account invites
// (`docs/02-domain-model-and-database.md` §3.7, `docs/06-auth-and-users.md`
// §8; plan `04` I2). The ledger of provider calls is the server's
// `SqliteLedger` over `usage_events`.

import { eq, sql } from "drizzle-orm";

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

/** A member's `user_limits` row, with the deployment's defaults where there
 * is none: `weeklyTokens` null means `SESSION_WEEKLY_TOKENS` (plan `03` K3),
 * `extraInvites` 0 means `SESSION_INVITES_PER_MEMBER` alone (plan `04`
 * I2). */
export interface MemberLimits {
  weeklyTokens: number | null;
  extraInvites: number;
}

/** The one read of `user_limits`. */
export function memberLimits(db: SessionDatabase, userId: string): MemberLimits {
  const row = db
    .select({ weeklyTokens: userLimits.weeklyTokens, extraInvites: userLimits.extraInvites })
    .from(userLimits)
    .where(eq(userLimits.userId, userId))
    .get();
  return { weeklyTokens: row?.weeklyTokens ?? null, extraInvites: row?.extraInvites ?? 0 };
}

/** The member's weekly allowance override (`user_limits.weekly_tokens`,
 * plan `03` K3), or null for the deployment's `SESSION_WEEKLY_TOKENS`. */
export function weeklyAllowance(db: SessionDatabase, userId: string): number | null {
  return memberLimits(db, userId).weeklyTokens;
}

/** Adds `count` (a positive integer) to the member's `extra_invites`, the
 * account invites site admins gave them (plan `04` I2), and answers the new
 * value. `weekly_tokens` is left as it is. */
export function addExtraInvites(db: SessionDatabase, userId: string, count: number): number {
  if (!Number.isSafeInteger(count) || count <= 0)
    throw new RangeError("extra invites are a positive whole number");
  const at = now();
  const row = db
    .insert(userLimits)
    .values({ userId, extraInvites: count, updatedAt: at })
    .onConflictDoUpdate({
      target: userLimits.userId,
      set: { extraInvites: sql`${userLimits.extraInvites} + ${count}`, updatedAt: at },
    })
    .returning({ extraInvites: userLimits.extraInvites })
    .get();
  if (!row) throw new Error("user_limits upsert returned no row");
  return row.extraInvites;
}

/** Sets the member's weekly allowance override to `tokens` (a positive
 * integer), or clears it with null. `extra_invites` is left as it is. */
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
