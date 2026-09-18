import test from "ava";

import {
  DEFAULT_MODEL_ID,
  DEFAULT_REASONING_EFFORT,
  METADATA_MODEL_ID,
  MODEL_REGISTRY,
  OPENROUTER_PROVIDER_PREFERENCES,
  canUseModel,
  effortProviderOptions,
  estimateCostMicros,
  findModel,
  modelInfo,
  modelsFor,
} from "../src/models/registry.js";

const admin = { isAdmin: true };
const member = { isAdmin: false };

test("registers exactly the five models in 04-agent-runtime.md", (t) => {
  t.deepEqual(
    MODEL_REGISTRY.map((model) => model.id),
    ["gemini-flash", "gemini-flash-google", "deepseek-flash", "gpt-luna", "claude-fable"],
  );
});

test("the default and metadata models are registered", (t) => {
  t.is(DEFAULT_MODEL_ID, "gemini-flash");
  t.is(METADATA_MODEL_ID, "gemini-flash");
  t.not(findModel(DEFAULT_MODEL_ID), null);
  t.not(findModel(METADATA_MODEL_ID), null);
});

test("findModel returns null for an unregistered id", (t) => {
  t.is(findModel("gpt-astra"), null);
});

test("routes and providers match the registry table", (t) => {
  t.deepEqual(
    MODEL_REGISTRY.map((model) => [model.id, model.provider, model.route]),
    [
      ["gemini-flash", "vertex", "gemini-3.8-flash"],
      ["gemini-flash-google", "vertex", "gemini-3.8-flash"],
      ["deepseek-flash", "openrouter", "deepseek/deepseek-v4.1-flash"],
      ["gpt-luna", "openrouter", "~openai/gpt-luna-latest"],
      ["claude-fable", "anthropic", "claude-fable-5-1"],
    ],
  );
  t.is(findModel("gpt-luna")?.fallbackRoute, "openai/gpt-5.6-luna");
});

test("only the grounded Gemini entry uses native search", (t) => {
  t.deepEqual(
    MODEL_REGISTRY.filter((model) => model.nativeSearch).map((model) => model.id),
    ["gemini-flash-google"],
  );
});

test("claude-fable is the only admin-only model", (t) => {
  t.deepEqual(
    MODEL_REGISTRY.filter((model) => model.adminOnly).map((model) => model.id),
    ["claude-fable"],
  );
});

test("canUseModel gates admin-only models", (t) => {
  t.true(canUseModel(member, "gemini-flash"));
  t.false(canUseModel(member, "claude-fable"));
  t.true(canUseModel(admin, "claude-fable"));
});

test("canUseModel refuses an unknown id for everyone", (t) => {
  t.false(canUseModel(admin, "gpt-astra"));
  t.false(canUseModel(member, "gpt-astra"));
});

test("canUseModel treats a signed-out caller as a non-admin", (t) => {
  t.true(canUseModel(null, "gemini-flash"));
  t.false(canUseModel(null, "claude-fable"));
});

test("modelsFor hides admin-only models and preserves registry order", (t) => {
  t.deepEqual(
    modelsFor(member).map((model) => model.id),
    ["gemini-flash", "gemini-flash-google", "deepseek-flash", "gpt-luna"],
  );
  t.is(modelsFor(admin).length, MODEL_REGISTRY.length);
});

test("deepseek-flash takes no file or image parts", (t) => {
  const deepseek = findModel("deepseek-flash");
  t.false(deepseek?.supportsFiles);
  t.false(deepseek?.supportsImages);
  for (const id of ["gemini-flash", "gemini-flash-google", "gpt-luna", "claude-fable"]) {
    const model = findModel(id);
    t.true(model?.supportsFiles, `${id} supports files`);
    t.true(model?.supportsImages, `${id} supports images`);
  }
});

test("effort defaults to medium and maps to each provider's own option", (t) => {
  t.is(DEFAULT_REASONING_EFFORT, "medium");
  const vertex = findModel("gemini-flash");
  const openrouter = findModel("gpt-luna");
  const anthropic = findModel("claude-fable");
  t.deepEqual(effortProviderOptions(vertex!), {
    google: { thinkingConfig: { thinkingLevel: "medium" } },
  });
  t.deepEqual(effortProviderOptions(openrouter!), {
    openrouter: {
      reasoning: { effort: "medium" },
      provider: { zdr: true, data_collection: "deny" },
    },
  });
  t.deepEqual(effortProviderOptions(anthropic!), { anthropic: { effort: "medium" } });
});

test("effortProviderOptions carries a non-default effort through", (t) => {
  t.deepEqual(effortProviderOptions(findModel("claude-fable")!, "high"), {
    anthropic: { effort: "high" },
  });
});

test("both OpenRouter models request zero retention and no collection", (t) => {
  t.deepEqual(OPENROUTER_PROVIDER_PREFERENCES, { zdr: true, data_collection: "deny" });
  for (const model of MODEL_REGISTRY.filter((entry) => entry.provider === "openrouter")) {
    const options = effortProviderOptions(model).openrouter;
    t.deepEqual(options?.provider, { zdr: true, data_collection: "deny" });
  }
});

test("prices are the per-million-token figures from the plan", (t) => {
  t.deepEqual(
    MODEL_REGISTRY.map((model) => [model.id, model.pricing.input, model.pricing.output]),
    [
      ["gemini-flash", 0.75, 3.75],
      ["gemini-flash-google", 0.75, 3.75],
      ["deepseek-flash", 0.15, 0.6],
      ["gpt-luna", 0.2, 1.2],
      ["claude-fable", 10, 50],
    ],
  );
});

test("estimateCostMicros bills reasoning tokens at the output rate", (t) => {
  const fable = findModel("claude-fable")!;
  // 1M input at $10 plus 1M output at $50.
  t.is(estimateCostMicros(fable, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 60_000_000);
  t.is(
    estimateCostMicros(fable, { inputTokens: 0, outputTokens: 500_000, reasoningTokens: 500_000 }),
    estimateCostMicros(fable, { inputTokens: 0, outputTokens: 1_000_000 }),
  );
  t.is(estimateCostMicros(fable, {}), 0);
});

test("modelInfo projects the registry entry the client renders", (t) => {
  t.deepEqual(modelInfo(findModel("claude-fable")!, false), {
    id: "claude-fable",
    label: "Claude Fable 5.1",
    provider: "anthropic",
    adminOnly: true,
    available: false,
    supportsFiles: true,
    supportsImages: true,
  });
});
