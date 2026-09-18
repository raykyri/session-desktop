// `system.health` and `system.runtimeConfig` (`03-api-and-events.md` §2).

import type { ModelInfo } from "@session/shared";
import { MODEL_REGISTRY, canUseModel, modelInfo, version } from "@session/shared";

import type { Config } from "../../config.js";
import { MAX_DOCUMENTS_PER_QUESTION, MAX_DOCUMENT_BYTES } from "../../uploads/limits.js";
import { publicProcedure, router } from "../base.js";

export interface RuntimeLimits {
  runsPerUser: number;
  runTimeoutSeconds: number;
  dailyTokens: number;
  dailyRuns: number;
  /** False while `SESSION_ENFORCE_LIMITS=0`: usage is recorded either way. */
  enforced: boolean;
  documentsPerQuestion: number;
  documentBytes: number;
}

export interface RuntimeFeatures {
  webSearch: boolean;
  searchVendor?: "parallel" | "tavily";
  /**
   * The origin the preview panel frames (`11-artifacts-and-browser.md` §3).
   * The client needs it to validate `event.origin` on the
   * `session-preview-scroll` bridge, and it is per-deployment rather than
   * per-build, so it travels with the rest of the runtime configuration
   * instead of a build-time constant or a `<meta>` the boot HTML would have
   * to be templated for.
   */
  artifactOrigin: string;
}

/** The search half of the features block; `runtimeConfigFor` adds the rest. */
export type RuntimeSearchFeatures = Omit<RuntimeFeatures, "artifactOrigin">;

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
export function searchFeatures(config: Config): RuntimeSearchFeatures {
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

export function runtimeConfigFor(config: Config, user: { isAdmin: boolean } | null): RuntimeConfig {
  const available = modelAvailability(config);
  return {
    version,
    // Gated models are omitted entirely for non-admins: a hidden model the
    // client never sees cannot be launched by a stale UI either, because the
    // server checks `canUseModel` again at launch.
    models: MODEL_REGISTRY.filter((model) => canUseModel(user, model.id)).map((model) =>
      modelInfo(model, available(model.provider)),
    ),
    limits: {
      runsPerUser: config.limits.perUser,
      runTimeoutSeconds: Math.round(config.limits.runTimeoutMs / 1000),
      dailyTokens: config.limits.dailyTokens,
      dailyRuns: config.limits.dailyRuns,
      enforced: config.limits.enforceDailyLimits,
      documentsPerQuestion: MAX_DOCUMENTS_PER_QUESTION,
      documentBytes: MAX_DOCUMENT_BYTES,
    },
    features: { ...searchFeatures(config), artifactOrigin: config.artifactOrigin },
  };
}

export const systemRouter = router({
  health: publicProcedure.query(() => ({ ok: true, version })),
  runtimeConfig: publicProcedure.query(({ ctx }) => runtimeConfigFor(ctx.config, ctx.user)),
});
