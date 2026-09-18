// Turning a registry id into a language model (`04-agent-runtime.md` §1, §11).
//
// Everything provider-specific lives here: how a provider is constructed from
// the deployment's credentials, which provider-executed tools a model entry
// adds, and the `providerOptions` that ask each provider for medium reasoning
// effort and — on OpenRouter — for zero-retention, no-collection routing. The
// loop below this module is provider-neutral and only ever sees a
// `ResolvedModel`.

import { join } from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ModelEntry } from "@session/shared";
import {
  OPENROUTER_PROVIDER_PREFERENCES,
  appName,
  effortProviderOptions,
  findModel,
} from "@session/shared";
import type { LanguageModel, ToolSet } from "ai";

import type { Config } from "../config.js";

import { FixtureLanguageModel } from "./fixtureProvider.js";

export {
  FixtureLanguageModel,
  setFixtureScenario,
  setFixtureScenarioOnce,
} from "./fixtureProvider.js";

/** A model ready to be handed to `streamText`, with the request-level options
 * and provider-executed tools that belong to it. */
export interface ResolvedModel {
  entry: ModelEntry;
  model: LanguageModel;
  providerOptions: ProviderOptions;
  /** Merged into the owned tool set. Empty except for `gemini-flash-google`. */
  providerTools: ToolSet;
}

export interface Providers {
  /** `null` when the model is unknown or its provider has no credential —
   * the same answer `system.runtimeConfig` gives as `available: false`. */
  resolve(modelId: string): ResolvedModel | null;
  /** True when every model is a recorded fixture. */
  readonly fixtures: boolean;
}

export interface CreateProvidersOptions {
  /** Injected so a test can intercept the outbound request body. */
  fetch?: typeof globalThis.fetch;
  /** Overrides the config's `SESSION_FIXTURE_PROVIDERS`. */
  fixtures?: boolean;
}

/**
 * The OpenRouter settings sent with every request for `entry`.
 *
 * `zdr` and `data_collection` are the whole point: with them a request that
 * has no zero-retention endpoint fails instead of silently routing to a
 * provider that logs it (`04-agent-runtime.md` §1). They are also set
 * account-wide, so this is the second of two locks rather than the only one.
 */
export function openRouterSettings(effortOptions: Record<string, unknown>) {
  return {
    ...effortOptions,
    provider: { ...OPENROUTER_PROVIDER_PREFERENCES },
    // Token counts and the upstream provider's own cost, which is what makes
    // `usage_events.cost_estimate_micros` better than a price-table guess.
    usage: { include: true },
  };
}

/** The provider options for one model: medium effort in each provider's own
 * spelling, plus OpenRouter's routing preferences. */
export function providerOptionsFor(entry: ModelEntry): ProviderOptions {
  return effortProviderOptions(entry) as ProviderOptions;
}

function vertexKeyFile(config: Config): string | null {
  return config.vertex.credentialsJson === null
    ? null
    : join(config.tmpDir, "vertex-credentials.json");
}

/**
 * Constructs the provider clients the deployment has credentials for, once,
 * and resolves registry ids against them.
 *
 * Providers are built lazily: a deployment with no Anthropic key never
 * constructs the Anthropic client, so a missing credential is an unavailable
 * model rather than a boot failure.
 */
export function createProviders(config: Config, options: CreateProvidersOptions = {}): Providers {
  // Always in tests: the suite drives the loop through recorded streams, and a
  // test that reached a real provider would be a credential leak and a bill.
  const fixtures = options.fixtures ?? (config.fixtureProviders || config.env === "test");
  const fetchImpl = options.fetch;

  let vertex: ReturnType<typeof createVertex> | null = null;
  const vertexProvider = (): ReturnType<typeof createVertex> => {
    if (!vertex) {
      const keyFile = vertexKeyFile(config);
      vertex = createVertex({
        ...(config.vertex.project === null ? {} : { project: config.vertex.project }),
        location: config.vertex.location,
        ...(keyFile === null ? {} : { googleAuthOptions: { keyFile } }),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    }
    return vertex;
  };

  let openrouter: ReturnType<typeof createOpenRouter> | null = null;
  const openRouterProvider = (): ReturnType<typeof createOpenRouter> => {
    if (!openrouter) {
      openrouter = createOpenRouter({
        apiKey: config.openrouterApiKey ?? "",
        compatibility: "strict",
        // OpenRouter attributes traffic by these two headers; the origin is
        // the deployment's own, which is why it is validated at boot.
        headers: { "HTTP-Referer": config.publicOrigin, "X-Title": appName },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    }
    return openrouter;
  };

  let anthropic: ReturnType<typeof createAnthropic> | null = null;
  const anthropicProvider = (): ReturnType<typeof createAnthropic> => {
    if (!anthropic) {
      anthropic = createAnthropic({
        apiKey: config.anthropicApiKey ?? "",
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    }
    return anthropic;
  };

  return {
    fixtures,
    resolve(modelId: string): ResolvedModel | null {
      const entry = findModel(modelId);
      if (!entry || !config.credentials[entry.provider]) {
        return null;
      }
      const providerOptions = providerOptionsFor(entry);
      if (fixtures) {
        return {
          entry,
          model: new FixtureLanguageModel({ provider: entry.provider, modelId: entry.route }),
          providerOptions,
          providerTools: {},
        };
      }
      switch (entry.provider) {
        case "vertex": {
          const provider = vertexProvider();
          return {
            entry,
            model: provider.languageModel(entry.route),
            providerOptions,
            // Grounding replaces the owned `web_search` for this entry
            // (`04-agent-runtime.md` §6.2); the key is the name the mapper and
            // the Sources footer render.
            providerTools: entry.nativeSearch
              ? { google_search: provider.tools.googleSearch({}) }
              : {},
          };
        }
        case "openrouter": {
          const provider = openRouterProvider();
          const effort = (providerOptions["openrouter"] ?? {}) as Record<string, unknown>;
          return {
            entry,
            model: provider.chat(entry.route, openRouterSettings(effort)),
            providerOptions,
            providerTools: {},
          };
        }
        case "anthropic":
          return {
            entry,
            model: anthropicProvider()(entry.route),
            providerOptions,
            providerTools: {},
          };
      }
    },
  };
}
