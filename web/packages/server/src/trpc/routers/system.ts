// `system.health` and `system.runtimeConfig` (`03-api-and-events.md` §2).

import type { ModelInfo } from "@session/shared";
import { MODEL_REGISTRY, modelInfo, version } from "@session/shared";

import type { Config } from "../../config.js";
import { publicProcedure, router } from "../base.js";

export interface RuntimeLimits {
  runsPerUser: number;
  runTimeoutSeconds: number;
  /** Included tokens per member per week (`03` K3), before any member's
   * own allowance. */
  weeklyTokens: number;
}

export interface RuntimeFeatures {
  webSearch: boolean;
  searchVendor?: "parallel" | "tavily";
}

export interface RuntimeConfig {
  version: string;
  models: ModelInfo[];
  limits: RuntimeLimits;
  features: RuntimeFeatures;
}

/** A model is launchable when its provider has a credential
 * (`04-agent-runtime.md` §11). Fixture providers make every model available
 * without one. */
export function modelAvailability(config: Config): (provider: ModelInfo["provider"]) => boolean {
  return (provider) => config.credentials[provider];
}

/** The vendor `web_search` uses: the configured one when its key is set,
 * otherwise whichever key exists (`web/.env.example`). */
export function searchFeatures(config: Config): RuntimeFeatures {
  const keys: Record<"parallel" | "tavily", boolean> = {
    parallel: config.search.parallelApiKey !== null,
    tavily: config.search.tavilyApiKey !== null,
  };
  if (!keys.parallel && !keys.tavily) {
    return { webSearch: false };
  }
  const vendor = keys[config.search.vendor]
    ? config.search.vendor
    : keys.parallel
      ? "parallel"
      : "tavily";
  return { webSearch: true, searchVendor: vendor };
}

export function runtimeConfigFor(config: Config): RuntimeConfig {
  const available = modelAvailability(config);
  return {
    version,
    // Every registry entry is open to every member (ADR-23, `03` K11).
    models: MODEL_REGISTRY.map((model) => modelInfo(model, available(model.provider))),
    limits: {
      runsPerUser: config.limits.perUser,
      runTimeoutSeconds: Math.round(config.limits.runTimeoutMs / 1000),
      weeklyTokens: config.limits.weeklyTokens,
    },
    features: searchFeatures(config),
  };
}

export const systemRouter = router({
  health: publicProcedure.query(() => ({ ok: true, version })),
  runtimeConfig: publicProcedure.query(({ ctx }) => runtimeConfigFor(ctx.config)),
});
