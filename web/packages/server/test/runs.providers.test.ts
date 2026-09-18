// Provider construction and the options every request carries
// (`04-agent-runtime.md` §1, §11).

import { MODEL_REGISTRY, findModel } from "@session/shared";
import { generateText } from "ai";
import test from "ava";

import { DEFAULT_FIXTURE_SCENARIO, listFixtureScenarios } from "../src/runs/fixtureProvider.js";
import { createProviders, openRouterSettings, providerOptionsFor } from "../src/runs/providers.js";

import { testConfig } from "./helpers.js";

function productionConfig(overrides: Record<string, string> = {}) {
  return testConfig("/tmp/session-providers", {
    NODE_ENV: "development",
    SESSION_FIXTURE_PROVIDERS: "0",
    ...overrides,
  });
}

test("every model resolves when its provider has a credential, and none when it does not", (t) => {
  const providers = createProviders(productionConfig());
  for (const model of MODEL_REGISTRY) {
    t.truthy(providers.resolve(model.id), `${model.id} resolves`);
  }
  t.is(providers.resolve("no-such-model"), null);

  const withoutAnthropic = createProviders(productionConfig({ ANTHROPIC_API_KEY: "" }));
  t.is(withoutAnthropic.resolve("claude-fable"), null, "a missing key is an unavailable model");
  t.truthy(withoutAnthropic.resolve("gemini-flash"));
});

test("medium effort is spelled in each provider's own terms", (t) => {
  const gemini = findModel("gemini-flash");
  const luna = findModel("gpt-luna");
  const fable = findModel("claude-fable");
  t.truthy(gemini && luna && fable);
  if (!gemini || !luna || !fable) {
    return;
  }
  t.deepEqual(providerOptionsFor(gemini), {
    google: { thinkingConfig: { thinkingLevel: "medium" } },
  });
  t.deepEqual(providerOptionsFor(fable), { anthropic: { effort: "medium" } });
  t.deepEqual(providerOptionsFor(luna), {
    openrouter: {
      reasoning: { effort: "medium" },
      provider: { zdr: true, data_collection: "deny" },
    },
  });
});

test("the OpenRouter settings pin zero retention and no collection", (t) => {
  const settings = openRouterSettings({ reasoning: { effort: "medium" } });
  t.deepEqual(settings.provider, { zdr: true, data_collection: "deny" });
  t.deepEqual(settings.usage, { include: true });
  t.deepEqual((settings as Record<string, unknown>)["reasoning"], { effort: "medium" });
});

test("an OpenRouter request carries zdr and data_collection in its body", async (t) => {
  let body: Record<string, unknown> | null = null;
  const fetchImpl: typeof globalThis.fetch = (_input, init) => {
    body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    return Promise.resolve(
      Response.json({
        id: "gen-1",
        model: "deepseek/deepseek-v4.1-flash",
        object: "chat.completion",
        created: 0,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  };
  const providers = createProviders(productionConfig(), { fetch: fetchImpl, fixtures: false });
  const resolved = providers.resolve("deepseek-flash");
  t.truthy(resolved);
  if (!resolved) {
    return;
  }
  await generateText({
    model: resolved.model,
    prompt: "hello",
    providerOptions: resolved.providerOptions,
    maxRetries: 0,
  });
  const sent = body as Record<string, unknown> | null;
  t.truthy(sent);
  t.deepEqual(sent?.["provider"], { zdr: true, data_collection: "deny" });
  t.deepEqual(sent?.["reasoning"], { effort: "medium" });
  t.is(sent?.["model"], "deepseek/deepseek-v4.1-flash");
});

test("the Google-grounded entry adds the provider tool and the plain one does not", (t) => {
  const providers = createProviders(productionConfig());
  t.deepEqual(Object.keys(providers.resolve("gemini-flash")?.providerTools ?? {}), []);
  t.deepEqual(Object.keys(providers.resolve("gemini-flash-google")?.providerTools ?? {}), [
    "google_search",
  ]);
});

test("a test build always resolves to the fixture provider", (t) => {
  const providers = createProviders(testConfig("/tmp/session-providers"));
  t.true(providers.fixtures);
  const model = providers.resolve("claude-fable")?.model as
    { provider?: string; specificationVersion?: string } | undefined;
  t.is(model?.provider, "anthropic");
  t.is(
    model?.specificationVersion,
    "v4",
    "the fixture implements the specification version the real providers report",
  );
});

test("every scenario the runtime names has a fixture on disk", (t) => {
  const scenarios = listFixtureScenarios();
  for (const required of [
    "success",
    "success-with-tools",
    "refusal",
    "rate-limit",
    "context-too-long",
    "mid-stream-error",
    "abort",
    "slow-stream",
    "grounded",
  ]) {
    t.true(scenarios.includes(required), `${required} is recorded`);
  }
  t.true(scenarios.includes(DEFAULT_FIXTURE_SCENARIO));
});
