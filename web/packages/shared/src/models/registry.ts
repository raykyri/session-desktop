// The model registry (`04-agent-runtime.md` §1). One table, read by the
// server (to construct providers and enforce access) and by the client (to
// render the model picker), so the two cannot disagree about which models
// exist, who may use them, or what they cost.
//
// Each entry lists the reasoning efforts its provider accepts and the one a
// run uses when none was chosen; `effortProviderOptions` returns the
// per-provider spelling of an effort.

import type { ModelInfo, ModelProvider } from "../types/account.js";

/** Reasoning effort: the whole range the providers accept. Anthropic's effort
 * scale for Fable 5.1 runs `low` through `max`; the others stop at `high`. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/** Who may pay for a run on a model (`03-agents-and-research.md` K8, K11):
 * the member's included tokens, or one of the member's own keys. */
export type ModelPayer = "included" | "key:anthropic" | "key:openai";

/** The efforts a site admin may choose as the default effort (`03` K15): the
 * composer steps it down for a model that does not accept it (K12). */
export const SITE_EFFORTS = ["low", "medium", "high", "max"] as const;

export type SiteEffort = (typeof SITE_EFFORTS)[number];

export function isSiteEffort(value: unknown): value is SiteEffort {
  return (SITE_EFFORTS as readonly unknown[]).includes(value);
}

/** Price per 1,000,000 tokens, in US dollars. */
export interface ModelPricing {
  input: number;
  output: number;
}

export interface ModelEntry {
  id: string;
  label: string;
  /** The model family, stable across model versions. Sent as the wire
   * `AgentSpec.adapter`, where the desktop sends its agent adapter id
   * (`claude`, `codex`, `grok`). */
  adapter: string;
  provider: ModelProvider;
  /** The provider-side model identifier: a Vertex model name, an OpenRouter
   * slug, or an Anthropic model id. */
  route: string;
  /** Tried first when the primary route is missing (OpenRouter aliases). */
  fallbackRoute?: string;
  supportsFiles: boolean;
  supportsImages: boolean;
  /** Search comes from the provider's own grounding rather than the app's
   * `web_search` tool. */
  nativeSearch: boolean;
  /** The efforts the provider accepts for this model, lowest first. */
  efforts: readonly ReasoningEffort[];
  /** The effort a run uses when the node names none. */
  defaultEffort: ReasoningEffort;
  /** Who may pay for a run on this model (`03` K11). A model without
   * `included` runs only on the member's own key and cannot be the site's
   * default model (K15). */
  payers: readonly ModelPayer[];
  pricing: ModelPricing;
  /** How much a cached input token counts toward the allowance: the ratio
   * of the provider's cached-input price to its input price (`03` K2,
   * decision P12). Absent: cached input counts in full, which never
   * undercounts. */
  cachedInputRatio?: number;
}

const STANDARD_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

const INCLUDED: readonly ModelPayer[] = ["included"];

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    id: "gemini-flash",
    adapter: "gemini",
    label: "Gemini 3.8 Flash",
    provider: "vertex",
    route: "gemini-3.8-flash",
    supportsFiles: true,
    supportsImages: true,
    nativeSearch: true,
    efforts: STANDARD_EFFORTS,
    defaultEffort: "medium",
    payers: INCLUDED,
    pricing: { input: 0.75, output: 3.75 },
    cachedInputRatio: 0.1,
  },
  {
    id: "deepseek-flash",
    adapter: "deepseek",
    label: "DeepSeek V4.1 Flash",
    provider: "openrouter",
    route: "deepseek/deepseek-v4.1-flash",
    // Text is inlined from `document_text`; the provider takes no file parts.
    supportsFiles: false,
    supportsImages: false,
    nativeSearch: false,
    efforts: STANDARD_EFFORTS,
    defaultEffort: "medium",
    payers: INCLUDED,
    pricing: { input: 0.15, output: 0.6 },
  },
  {
    id: "gpt-luna",
    adapter: "openai",
    label: "GPT-5.6 Luna",
    provider: "openrouter",
    route: "~openai/gpt-luna-latest",
    fallbackRoute: "openai/gpt-5.6-luna",
    supportsFiles: true,
    supportsImages: true,
    nativeSearch: false,
    efforts: STANDARD_EFFORTS,
    defaultEffort: "medium",
    payers: INCLUDED,
    pricing: { input: 0.2, output: 1.2 },
  },
  {
    id: "claude-fable",
    adapter: "claude",
    label: "Claude Fable 5.1",
    provider: "anthropic",
    route: "claude-fable-5-1",
    supportsFiles: true,
    supportsImages: true,
    nativeSearch: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    payers: ["included", "key:anthropic"],
    pricing: { input: 10, output: 50 },
    cachedInputRatio: 0.1,
  },
];

/** The composer's preselected model, and the model every metadata run (title,
 * recap, context summary) uses regardless of the thread's own model. */
export const DEFAULT_MODEL_ID = "gemini-flash";

/** Metadata runs always use `gemini-flash` (`04-agent-runtime.md` §9). */
export const METADATA_MODEL_ID = "gemini-flash";

const BY_ID = new Map(MODEL_REGISTRY.map((model) => [model.id, model]));

/** Withdrawn ids that stored threads still carry, and the entry that serves
 * them now. `gemini-flash-google` was Gemini 3.8 Flash with Google Search
 * grounding; grounding is now on the plain entry. */
const LEGACY_MODEL_IDS: Readonly<Record<string, string>> = {
  "gemini-flash-google": "gemini-flash",
};

export function findModel(id: string): ModelEntry | null {
  return BY_ID.get(LEGACY_MODEL_IDS[id] ?? id) ?? null;
}

/** Whether a run on `model` may be paid with included tokens: the condition
 * for being the site's default model (`03` K15). */
export function payableWithIncluded(model: Pick<ModelEntry, "payers">): boolean {
  return model.payers.includes("included");
}

/** Whether a run may launch on `modelId`: every registry entry is open to
 * every member (ADR-23, `03` K11; the weekly allowance replaced ADR-16's
 * admin gate). An unknown id is never usable, so a stale client cannot
 * launch on a model that has been withdrawn. */
export function canUseModel(modelId: string): boolean {
  return BY_ID.has(modelId);
}

/** The client-facing model registry. `available` comes from the server's
 * credential check; a model without a configured provider is listed but
 * cannot be launched. */
export function modelInfo(model: ModelEntry, available: boolean): ModelInfo {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    available,
    supportsFiles: model.supportsFiles,
    supportsImages: model.supportsImages,
  };
}

/** OpenRouter routing preferences sent on every request: zero data retention
 * and no collection, so a request with no eligible provider fails rather than
 * routing to one that logs. Mirrored as account-wide settings. */
export const OPENROUTER_PROVIDER_PREFERENCES = {
  zdr: true,
  data_collection: "deny",
} as const;

/** The effort a run on `model` uses: `requested` when the model accepts it,
 * otherwise the model's default. A stored effort the model no longer offers
 * falls back rather than failing the run. */
export function resolveEffort(
  model: ModelEntry,
  requested: string | null | undefined,
): ReasoningEffort {
  const match = model.efforts.find((effort) => effort === requested);
  return match ?? model.defaultEffort;
}

/** The AI SDK `providerOptions` that request `effort` from a model's own
 * provider. Gemini takes a thinking level, OpenRouter a reasoning effort, and
 * Anthropic an effort (thinking is always on for Fable 5.1 and is controlled
 * only by effort). */
export function effortProviderOptions(
  model: ModelEntry,
  effort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): Record<string, Record<string, unknown>> {
  switch (model.provider) {
    case "vertex":
      return { google: { thinkingConfig: { thinkingLevel: effort } } };
    case "openrouter":
      return {
        openrouter: {
          reasoning: { effort },
          provider: { ...OPENROUTER_PROVIDER_PREFERENCES },
        },
      };
    case "anthropic":
      return { anthropic: { effort } };
    case "openai":
      return { openai: { reasoningEffort: effort } };
  }
}

/** Estimated cost of one attempt in micro-dollars, from the registry price
 * table. Cached input is billed at the input rate; the registry carries no
 * separate cache price because none of the five models is used with explicit
 * caching yet. */
export function estimateCostMicros(
  model: ModelEntry,
  usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number },
): number {
  const input = usage.inputTokens ?? 0;
  const output = (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0);
  const dollars = (input * model.pricing.input + output * model.pricing.output) / 1_000_000;
  return Math.round(dollars * 1_000_000);
}
