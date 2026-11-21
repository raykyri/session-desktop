// Payers, counted tokens, progress phases and look-up limits
// (`03-agents-and-research.md` K2, K9, E3, L2).

import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import test from "ava";
import type { ExecutionContext } from "ava";

import type { Allowances } from "../src/runs/allowance.js";
import { billLabel } from "../src/runs/allowance.js";
import { registerFixture } from "../src/runs/fixtureProvider.js";
import { KEY_STOPPED_MESSAGE } from "../src/runs/loop.js";
import type { Providers } from "../src/runs/providers.js";
import { createProviders } from "../src/runs/providers.js";

import { testConfig } from "./helpers.js";
import { createLoopHarness, fakeNetwork } from "./runsHelpers.js";

const MEMBER_KEY = { apiKey: "sk-ant-member-key-0000000000", sealed: "v1.member-key" };

/** Spent after the first call: billing `key` with a stored key. */
const keyBilling: Allowances = {
  weekly: () => 1,
  billing: () => "key",
  validKey: (_userId, provider) => (provider === "anthropic" ? MEMBER_KEY.sealed : null),
  anthropicKey: () => MEMBER_KEY,
  openaiKey: () => null,
};

test("an included run that crosses the allowance moves to the member's Anthropic key at the next step", async (t) => {
  const harness = createLoopHarness(t, { allowances: keyBilling });
  const user = harness.addUser("crosser");
  const request = harness.runRequest(user.id, "fixture:success-with-tools", {
    model: "claude-fable",
  });

  t.is((await harness.agent.run(request)).outcome, "complete");
  const rows = harness.ledger.rows({ runId: request.runId });
  // The key model is a fixture instance of its own, which replays the
  // scenario from its first step; a real provider continues the exchange.
  t.is(rows[0]?.payer, "included");
  t.true(rows.length >= 2);
  t.true(rows.slice(1).every((row) => row.payer === "key:anthropic"));
  const [finish] = harness.store.finishes(request.runId);
  t.is(finish?.summary.bill, "included+key:anthropic");
  t.is(finish?.summary.tok, harness.ledger.runTokens(request.runId));
  t.is(finish?.summary.note, undefined, "key-paid steps are not stopped by the overdraft limit");
});

test("with billing pause the run continues on overdraft", async (t) => {
  const harness = createLoopHarness(t, {
    allowances: { ...keyBilling, billing: () => "pause" },
  });
  const user = harness.addUser("overdrawn");
  const request = harness.runRequest(user.id, "fixture:success-with-tools", {
    model: "claude-fable",
  });

  t.is((await harness.agent.run(request)).outcome, "complete");
  t.true(harness.ledger.rows({ runId: request.runId }).every((row) => row.payer === "included"));
});

/** Fixture providers whose models fail every call made with a member's key:
 * by default with a 401, as Anthropic answers a revoked key. */
function rejectingKeyProviders(
  failure: { statusCode: number; message: string; responseBody?: string } = {
    statusCode: 401,
    message: "invalid x-api-key",
  },
): Providers {
  const base = createProviders(testConfig("/tmp/session-providers-unused"));
  const rejected = (model: LanguageModelV4): LanguageModelV4 => ({
    ...model,
    doGenerate: () => Promise.reject(new Error("unused")),
    doStream: () =>
      Promise.reject(
        new APICallError({
          message: failure.message,
          url: "https://api.anthropic.com/v1/messages",
          requestBodyValues: {},
          statusCode: failure.statusCode,
          ...(failure.responseBody === undefined ? {} : { responseBody: failure.responseBody }),
        }),
      ),
  });
  return {
    fixtures: true,
    resolve(modelId, effort, key) {
      const resolved = base.resolve(modelId, effort, key);
      return resolved && key ? { ...resolved, model: rejected(resolved.model) } : resolved;
    },
  };
}

test("a key rejected after the switch ends the run failed key with its earlier turns kept", async (t) => {
  const rejectedKeys: [string, string, string][] = [];
  const harness = createLoopHarness(t, {
    allowances: {
      ...keyBilling,
      keyRejected: (userId, provider, sealed) => rejectedKeys.push([userId, provider, sealed]),
    },
    providers: rejectingKeyProviders(),
  });
  const user = harness.addUser("revoked");
  const request = harness.runRequest(user.id, "fixture:success-with-tools", {
    model: "claude-fable",
  });

  t.is((await harness.agent.run(request)).outcome, "failed");
  const [finish] = harness.store.finishes(request.runId);
  t.deepEqual(finish?.summary.fail, { why: "key" });
  // `03` K4: the loop reports the key the provider rejected, once, by its
  // sealed value.
  t.deepEqual(rejectedKeys, [[user.id, "anthropic", MEMBER_KEY.sealed]]);
  t.true(
    harness.store.calls.some((call) => call.kind === "commitTurn" && call.runId === request.runId),
    "the first step's turns stay",
  );
  const rows = harness.ledger.rows({ runId: request.runId });
  t.deepEqual(
    rows.map((row) => [row.payer, row.ending, row.counted === 0]),
    [
      ["included", "finish", false],
      ["key:anthropic", "error", true],
    ],
  );
});

test("a 403 fails the run with the provider's message and leaves the key valid", async (t) => {
  const rejectedKeys: string[] = [];
  const harness = createLoopHarness(t, {
    allowances: { ...keyBilling, keyRejected: (_u, _p, sealed) => rejectedKeys.push(sealed) },
    providers: rejectingKeyProviders({
      statusCode: 403,
      message: "permission_error: this key may not use claude-fable-5-1",
    }),
  });
  const user = harness.addUser("forbidden");
  const request = harness.runRequest(user.id, "fixture:success", {
    model: "claude-fable",
    payer: "key:anthropic",
  });
  t.is((await harness.agent.run(request)).outcome, "failed");
  const [finish] = harness.store.finishes(request.runId);
  t.deepEqual(finish?.summary.fail, { why: "key" });
  t.regex(finish?.summary.error?.detail ?? "", /permission_error: this key may not use/);
  t.deepEqual(rejectedKeys, [], "a 403 does not mark the key invalid");
});

test("a 401 with the provider's authentication_error marks the key invalid", async (t) => {
  const rejectedKeys: string[] = [];
  const harness = createLoopHarness(t, {
    allowances: { ...keyBilling, keyRejected: (_u, _p, sealed) => rejectedKeys.push(sealed) },
    providers: rejectingKeyProviders({
      statusCode: 401,
      message: "bad key",
      responseBody: '{"type":"error","error":{"type":"authentication_error"}}',
    }),
  });
  const user = harness.addUser("unauthenticated");
  const request = harness.runRequest(user.id, "fixture:success", {
    model: "claude-fable",
    payer: "key:anthropic",
  });
  t.is((await harness.agent.run(request)).outcome, "failed");
  t.deepEqual(rejectedKeys, [MEMBER_KEY.sealed]);
});

/** A key-paid run's per-step check (`03` K4, K7): the attempt opens the key
 * when it starts (`anthropicKey`); from then on the stored key or billing
 * reads as `change` says, so the first check, after the first step, sees
 * the change. */
async function runWithChange(
  t: ExecutionContext,
  change: "none" | "removed" | "replaced" | "invalid" | "billing",
) {
  const harness = createLoopHarness(t, {
    allowances: {
      ...keyBilling,
      billing: () => (change === "billing" ? "pause" : "key"),
      validKey: (_userId, provider) => {
        if (provider !== "anthropic") return null;
        if (change === "removed" || change === "invalid") return null;
        if (change === "replaced") return "v1.a-new-key";
        return MEMBER_KEY.sealed;
      },
    },
  });
  const user = harness.addUser(`change-${change}`);
  const request = harness.runRequest(user.id, "fixture:success-with-tools", {
    model: "claude-fable",
    payer: "key:anthropic",
  });
  const result = await harness.agent.run(request);
  return { harness, request, result };
}

test("a key-paid run keeps going while its key and billing stay as they were", async (t) => {
  const { result } = await runWithChange(t, "none");
  t.is(result.outcome, "complete");
});

for (const change of ["removed", "replaced", "invalid", "billing"] as const) {
  test(`a key ${change === "billing" ? "whose billing left key" : change} stops the run at its next step`, async (t) => {
    const { harness, request, result } = await runWithChange(t, change);
    t.is(result.outcome, "failed");
    const [finish] = harness.store.finishes(request.runId);
    t.deepEqual(finish?.summary.fail, { why: "key" });
    t.is(finish?.summary.error?.message, KEY_STOPPED_MESSAGE);
    // One provider call: the next step was never made.
    t.is(harness.ledger.rows({ runId: request.runId }).length, 1);
    t.true(
      harness.store.calls.some(
        (call) => call.kind === "commitTurn" && call.runId === request.runId,
      ),
      "the first step's turns stay",
    );
  });
}

test("cached input counts at the model's ratio", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("cached");
  const request = harness.runRequest(user.id, "fixture:success-with-tools", {
    model: "claude-fable",
  });

  t.is((await harness.agent.run(request)).outcome, "complete");
  const last = harness.ledger.rows({ runId: request.runId }).at(-1);
  // 2,100 input of which 100 cached, at Anthropic's 0.1, and 120 output.
  t.like(last?.counts, { inputTokens: 2_100, cachedTokens: 100, outputTokens: 120 });
  t.is(last?.counted, 2_000 + 10 + 120);
});

test("the bill label names every payer the run used", (t) => {
  t.is(billLabel(new Set()), null);
  t.is(billLabel(new Set(["included"])), "included");
  t.is(billLabel(new Set(["included", "key:anthropic"])), "included+key:anthropic");
  t.is(billLabel(new Set(["key:anthropic"])), "key:anthropic");
  t.is(billLabel(new Set(["key:openai"])), "key:openai");
});

test("progress: a tool-using run moves through searching and reading to writing", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("stepper");
  const request = harness.runRequest(user.id, "fixture:success-with-tools", {
    model: "claude-fable",
  });

  t.is((await harness.agent.run(request)).outcome, "complete");
  t.deepEqual(
    harness.store.calls.flatMap((call) => (call.kind === "step" ? [call.step] : [])),
    [1, 2, 3],
  );
});

test("progress: a tool-free run jumps from planning to writing", async (t) => {
  const harness = createLoopHarness(t);
  const user = harness.addUser("writer");
  const request = harness.runRequest(user.id, "fixture:success");

  t.is((await harness.agent.run(request)).outcome, "complete");
  t.deepEqual(
    harness.store.calls.flatMap((call) => (call.kind === "step" ? [call.step] : [])),
    [3],
  );
});

const searchStep = (index: number): { parts: LanguageModelV4StreamPart[] } => ({
  parts: [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call-search-${index}`,
      toolName: "web_search",
      input: JSON.stringify({ query: `query ${index}` }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
    },
  ],
});

registerFixture({
  scenario: "search-forever",
  steps: Array.from({ length: 10 }, (_, index) => searchStep(index)),
});

test("a look-up stops at 2 searches and 4 steps", async (t) => {
  const network = fakeNetwork();
  const harness = createLoopHarness(t, { network });
  const user = harness.addUser("looker");
  const request = harness.runRequest(user.id, "fixture:search-forever", {
    model: "claude-fable",
    node: "lookup",
  });

  await harness.agent.run(request);
  t.is(
    network.calls.filter((call) => call.url.startsWith("https://api.parallel.ai/")).length,
    2,
    "the third search is refused by the budget",
  );
  t.is(harness.ledger.rows({ runId: request.runId }).length, 4, "4 steps, 4 provider calls");
});
