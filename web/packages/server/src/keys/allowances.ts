// A member's settings over the stored allowance override, keys and billing
// setting (`runs/allowance.ts`, `03-agents-and-research.md` K3, K4, K7, K9),
// as `usage.get`, the `pre` stage, the dispatcher and the run loop read
// them.

import type { SessionDatabase } from "@session/db";
import { billing as billingRepo, usage as usageRepo } from "@session/db";

import type { Config } from "../config.js";
import type { Allowances } from "../runs/allowance.js";

import type { ApiKeysDeps } from "./apiKeys.js";
import { keyRejected, openValid, validSealed } from "./apiKeys.js";

/** A member's weekly allowance of included tokens (`03` K3): their
 * `user_limits.weekly_tokens` override, else `SESSION_WEEKLY_TOKENS`. The one
 * reading of it: `Allowances.weekly` is this, and `usage.get`, `pre`, the
 * dispatcher and the loop read it through `Allowances`. */
export function weeklyAllowance(
  deps: { db: SessionDatabase; config: Pick<Config, "limits"> },
  userId: string,
): number {
  return usageRepo.weeklyAllowance(deps.db, userId) ?? deps.config.limits.weeklyTokens;
}

export function storedAllowances(
  deps: Pick<ApiKeysDeps, "db" | "box" | "logger" | "now"> & { config: Pick<Config, "limits"> },
): Allowances {
  return {
    weekly: (userId) => weeklyAllowance(deps, userId),
    billing: (userId) => billingRepo.get(deps.db, userId),
    validKey: (userId, provider) => validSealed(deps, userId, provider),
    anthropicKey: (userId) => openValid(deps, userId, "anthropic"),
    openaiKey: (userId) => openValid(deps, userId, "openai"),
    // Only the key the run used, compared by its sealed value: a key saved
    // since then stays valid (`markInvalid` matches `sealed`).
    keyRejected: (userId, provider, sealed) => {
      keyRejected(deps, userId, provider, { sealed });
    },
  };
}
