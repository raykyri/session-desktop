// The run loop's view of a member's settings over the stored keys and
// billing setting (`runs/allowance.ts`, `03-agents-and-research.md` K4, K7,
// K9). The weekly allowance is the configured one until the per-member
// override of K3 is stored.

import { billing as billingRepo } from "@session/db";

import type { Config } from "../config.js";
import type { Allowances } from "../runs/allowance.js";

import type { ApiKeysDeps } from "./apiKeys.js";
import { keyRejected, openValid } from "./apiKeys.js";

export function storedAllowances(
  deps: Pick<ApiKeysDeps, "db" | "box" | "logger" | "now"> & { config: Pick<Config, "limits"> },
): Allowances {
  return {
    weekly: () => deps.config.limits.weeklyTokens,
    billing: (userId) => billingRepo.get(deps.db, userId),
    anthropicKey: (userId) => openValid(deps, userId, "anthropic")?.apiKey ?? null,
    keyRejected: (userId, provider, apiKey) => {
      // Only the key the run used: a key saved since then stays valid.
      const stored = openValid(deps, userId, provider);
      if (stored?.apiKey === apiKey) {
        keyRejected(deps, userId, provider, stored);
      }
    },
  };
}
