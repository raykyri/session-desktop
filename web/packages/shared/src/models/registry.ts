// The model registry (`04-agent-runtime.md` §1). One table, read by the
// server (to construct providers and enforce access) and by the client (to
// render the model picker), so the two cannot disagree about which models
// exist, who may use them, or what they cost.
//
// Reasoning effort is fixed at medium for every model and is not exposed in
// the UI; `effortProviderOptions` returns the per-provider spelling of that.

import type { ModelInfo, ModelProvider, User } from "../types/account.js";

/** Reasoning effort. Only `medium` is used today (`04-agent-runtime.md` §1);
 * the type carries the whole range the providers accept — Anthropic's effort
 * scale for Fable 5.1 runs `low` through `max` — so raising it later is a call
 * site change rather than a type change. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/** Price per 1,000,000 tokens, in US dollars. */
export interface ModelPricing {
  input: number;
  output: number;
}

export interface ModelEntry {
  id: string;
  label: string;
  provider: ModelProvider;
  /** The provider-side model identifier: a Vertex model name, an OpenRouter
   * slug, or an Anthropic model id. */
  route: string;
  /** Tried first when the primary route is missing (OpenRouter aliases). */
  fallbackRoute?: string;
  adminOnly: boolean;
  supportsFiles: boolean;
  supportsImages: boolean;
  /** Search comes from the provider's own grounding rather than the app's
   * `web_search` tool. */
  nativeSearch: boolean;
  pricing: ModelPricing;
}

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    id: "gemini-flash",
    label: "Gemini 3.8 Flash",
    provider: "vertex",
    route: "gemini-3.8-flash",
    adminOnly: false,
    supportsFiles: true,
    supportsImages: true,
    nativeSearch: true,
    pricing: { input: 0.75, output: 3.75 },
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek V4.1 Flash",
    provider: "openrouter",
    route: "deepseek/deepseek-v4.1-flash",
    adminOnly: false,
    // Text is inlined from `document_text`; the provider takes no file parts.
    supportsFiles: false,
    supportsImages: false,
    nativeSearch: false,
    pricing: { input: 0.15, output: 0.6 },
  },
  {
    id: "gpt-luna",
    label: "GPT-5.6 Luna",
    provider: "openrouter",
    route: "~openai/gpt-luna-latest",
    fallbackRoute: "openai/gpt-5.6-luna",
    adminOnly: false,
    supportsFiles: true,
    supportsImages: true,
    nativeSearch: false,
    pricing: { input: 0.2, output: 1.2 },
  },
  {
    id: "claude-fable",
    label: "Claude Fable 5.1",
    provider: "anthropic",
    route: "claude-fable-5-1",
    adminOnly: true,
    supportsFiles: true,
    supportsImages: true,
    nativeSearch: false,
    pricing: { input: 10, output: 50 },
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

/** Whether `user` may launch on `modelId`. An unknown id is never usable, so
 * a stale client cannot launch on a model that has been withdrawn. */
export function canUseModel(user: Pick<User, "isAdmin"> | null, modelId: string): boolean {
  const model = BY_ID.get(modelId);
  if (!model) {
    return false;
  }
  return !model.adminOnly || Boolean(user?.isAdmin);
}

/** The registry entries `user` may launch on, in registry order. */
export function modelsFor(user: Pick<User, "isAdmin"> | null): ModelEntry[] {
  return MODEL_REGISTRY.filter((model) => canUseModel(user, model.id));
}

/** The registry as the client sees it. `available` comes from the server's
 * credential check; a model without a configured provider is listed but
 * cannot be launched. */
export function modelInfo(model: ModelEntry, available: boolean): ModelInfo {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    adminOnly: model.adminOnly,
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
