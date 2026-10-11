import assert from "node:assert/strict";
import test from "node:test";
import {
  advancePendingFirstMessageTitle,
  FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT,
  firstMessageTitleConfig,
  firstMessageTitleSource,
  normalizedMessagePreview,
  openRouterEmptyTitleMessage,
  openRouterTitleFromPayload,
  openRouterTitlePayload,
  sanitizeGeneratedTitle,
  summarizeFirstMessageTitle,
  tabTitleProviderLabel,
  type OpenRouterCompletion,
} from "../src/lib/openRouterTitles";

const openRouter = {
  tabTitleProvider: "openRouter" as const,
  openRouterKey: "sk-or-v1-key",
  openRouterModel: " vendor/model ",
};

test("message previews collapse control characters and whitespace", () => {
  assert.equal(normalizedMessagePreview("  fix\tthe\n\nbuild\u0007 "), "fix the build");
  assert.equal(normalizedMessagePreview(" \n\t "), null);
});

test("title sources drop tagged instruction blocks", () => {
  assert.equal(firstMessageTitleSource("Summarize the plan"), "Summarize the plan");
  assert.equal(
    firstMessageTitleSource("<user_instructions>\nBe brief.\n</user_instructions>\nSummarize\n the plan"),
    "Summarize the plan",
  );
  assert.equal(firstMessageTitleSource("   "), null);
});

test("generated titles lose labels, quotes and a trailing period", () => {
  assert.equal(sanitizeGeneratedTitle('Title: "Launch plan blockers."'), "Launch plan blockers");
  assert.equal(sanitizeGeneratedTitle("`Quarterly review`"), "Quarterly review");
  assert.equal(sanitizeGeneratedTitle('""'), null);
  assert.equal(sanitizeGeneratedTitle("   "), null);
});

test("generated titles are cut to 80 characters with an ellipsis", () => {
  const title = sanitizeGeneratedTitle("word ".repeat(40));
  assert.ok(title);
  assert.equal(Array.from(title).length, 80);
  assert.ok(title.endsWith("…"));
});

test("a title config needs the OpenRouter provider, a key and a model", () => {
  assert.deepEqual(firstMessageTitleConfig(openRouter), { model: "vendor/model" });
  assert.equal(firstMessageTitleConfig({ ...openRouter, tabTitleProvider: "disabled" }), null);
  assert.equal(firstMessageTitleConfig({ ...openRouter, openRouterKey: "  " }), null);
  assert.equal(firstMessageTitleConfig({ ...openRouter, openRouterModel: "" }), null);
});

test("provider labels come from the provider options", () => {
  assert.equal(tabTitleProviderLabel("openRouter"), "OpenRouter");
});

test("a pending title waits through blank messages without counting them", () => {
  const pending = { paneId: "p1", checkedMessages: 0 };
  assert.deepEqual(advancePendingFirstMessageTitle(pending, "   ", { model: "m" }), {
    pending,
    sourceMessage: null,
  });
});

test("a pending title generates from the first usable message when configured", () => {
  const pending = { paneId: "p1", checkedMessages: 0 };
  assert.deepEqual(advancePendingFirstMessageTitle(pending, "Plan the launch", { model: "m" }), {
    pending: null,
    sourceMessage: "Plan the launch",
  });
  assert.deepEqual(advancePendingFirstMessageTitle(pending, "Plan the launch", null), {
    pending: null,
    sourceMessage: null,
  });
});

test("a pending title stops after the lookahead limit of unusable messages", () => {
  // A message that is only a tagged instruction block has no title source.
  const instructionOnly = "<user_instructions>\nBe brief.\n</user_instructions>";
  assert.equal(firstMessageTitleSource(instructionOnly), null);
  let pending: { paneId: string; checkedMessages: number } | null = {
    paneId: "p1",
    checkedMessages: 0,
  };
  for (let index = 1; index < FIRST_MESSAGE_TITLE_LOOKAHEAD_LIMIT; index += 1) {
    pending = advancePendingFirstMessageTitle(pending!, instructionOnly, { model: "m" }).pending;
    assert.deepEqual(pending, { paneId: "p1", checkedMessages: index });
  }
  assert.equal(advancePendingFirstMessageTitle(pending!, instructionOnly, { model: "m" }).pending, null);
});

test("title payloads cap the source text and set the reasoning effort", () => {
  const payload = openRouterTitlePayload("x".repeat(5000), { model: "m" }, "none");
  const messages = payload.messages as Array<{ role: string; content: string }>;
  assert.equal(payload.model, "m");
  assert.equal(messages[1].content.length, 4000);
  assert.deepEqual(payload.reasoning, { effort: "none", exclude: true });
  assert.equal("reasoning" in openRouterTitlePayload("x", { model: "m" }, null), false);
});

test("titles are read from message content, content parts, or choice text", () => {
  assert.equal(
    openRouterTitleFromPayload({ choices: [{ message: { content: "Launch plan" } }] }),
    "Launch plan",
  );
  assert.equal(
    openRouterTitleFromPayload({
      choices: [{ message: { content: [{ text: "Launch " }, { content: "plan" }, 3] } }],
    }),
    "Launch plan",
  );
  assert.equal(openRouterTitleFromPayload({ choices: [{ text: "Launch plan" }] }), "Launch plan");
  assert.equal(openRouterTitleFromPayload({ choices: [] }), null);
});

test("an empty reply explains the choice error or finish details", () => {
  assert.equal(
    openRouterEmptyTitleMessage({ choices: [{ error: { code: 502, message: "upstream" } }] }),
    "OpenRouter generation failed: choice error 502: upstream",
  );
  assert.equal(
    openRouterEmptyTitleMessage({
      choices: [{ finish_reason: "length", native_finish_reason: "max_tokens" }],
      usage: { completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 990 } },
    }),
    "OpenRouter returned no title (finish_reason=length, native_finish_reason=max_tokens, completion_tokens=1000, reasoning_tokens=990).",
  );
  assert.equal(openRouterEmptyTitleMessage({}), "OpenRouter returned no title.");
});

function completions(...responses: Array<{ status: number; body: string }>) {
  const payloads: unknown[] = [];
  const complete: OpenRouterCompletion = async (payload) => {
    payloads.push(payload);
    const response = responses.shift();
    assert.ok(response, "unexpected request");
    return response;
  };
  return { complete, payloads };
}

const reply = (content: string) => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content } }] }),
});

test("summarizing returns the sanitized title of the first reply", async () => {
  const { complete, payloads } = completions(reply('"Launch plan blockers."'));
  assert.equal(
    await summarizeFirstMessageTitle("Plan", { model: "m" }, complete),
    "Launch plan blockers",
  );
  assert.equal(payloads.length, 1);
});

test("summarizing retries reasoning settings a model rejects", async () => {
  const rejected = { status: 400, body: JSON.stringify({ error: { message: "reasoning effort is not supported" } }) };
  const { complete, payloads } = completions(rejected, rejected, reply("Launch plan"));
  assert.equal(await summarizeFirstMessageTitle("Plan", { model: "m" }, complete), "Launch plan");
  assert.deepEqual(
    payloads.map((payload) => (payload as { reasoning?: { effort: string } }).reasoning?.effort ?? null),
    ["none", "minimal", null],
  );
});

test("summarizing reports other HTTP errors, error payloads and invalid JSON", async () => {
  await assert.rejects(
    summarizeFirstMessageTitle("Plan", { model: "m" }, completions({ status: 401, body: "bad key" }).complete),
    /OpenRouter request failed \(401\): bad key/,
  );
  await assert.rejects(
    summarizeFirstMessageTitle(
      "Plan",
      { model: "m" },
      completions({ status: 200, body: JSON.stringify({ error: "rate limited" }) }).complete,
    ),
    /OpenRouter returned an error: rate limited/,
  );
  await assert.rejects(
    summarizeFirstMessageTitle("Plan", { model: "m" }, completions({ status: 200, body: "{" }).complete),
    /OpenRouter returned invalid JSON\./,
  );
  await assert.rejects(
    summarizeFirstMessageTitle("Plan", { model: "m" }, completions(reply("  ")).complete),
    /OpenRouter returned no title\./,
  );
});
