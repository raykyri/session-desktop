// A run's messages (`runMessages`): earlier exchanges with their turns
// within the size budget, clipped tool results, and a run's own turns.

import test from "ava";

import {
  HISTORY_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
  endsWithAnswer,
  parseTurns,
  runMessages,
} from "../src/runs/prompts.js";

const turn = (n: number, role: string, blocks: unknown[]) => ({
  id: `t${n}`,
  agentId: "a",
  role,
  blocks,
  sourceIndex: n,
});

const exchange = (q: string, a: string, result: unknown) => ({
  q,
  a,
  turns: [
    turn(0, "assistant", [{ type: "toolUse", id: `c-${q}`, name: "web_fetch", input: { q } }]),
    turn(1, "user", [{ type: "toolResult", toolUseId: `c-${q}`, content: result, isError: false }]),
    turn(2, "assistant", [{ type: "text", text: a }]),
  ],
});

const tools = new Set(["web_fetch"]);

test("an exchange's turns go with it; one whose turns hold another answer, or no turns, is its question and answer", (t) => {
  const m = runMessages(
    [
      exchange("one", "A1", { text: "R1" }),
      { ...exchange("two", "A2", "R2"), a: "an edited answer" },
      { q: "three", a: "A3", turns: ["device text"] },
    ],
    "now?",
    [],
    tools,
  );
  t.deepEqual(
    m.map((x) => x.role),
    ["user", "assistant", "tool", "assistant", "user", "assistant", "user", "assistant", "user"],
  );
  t.deepEqual(m[5], { role: "assistant", content: "an edited answer" });
  t.deepEqual(m[7], { role: "assistant", content: "A3" });
  t.deepEqual(m[8], { role: "user", content: "now?" });
});

test("a long tool result is clipped; an exchange over the budget with its turns is given without them", (t) => {
  const long = "x".repeat(TOOL_RESULT_MAX_CHARS + 50);
  const m = runMessages([exchange("one", "A1", long)], "q", [], tools);
  const out = JSON.stringify(m[2]);
  t.true(out.includes(" [clipped]"));
  t.true(out.length < TOOL_RESULT_MAX_CHARS + 500);
  // many exchanges: the newest fit, with their turns while they fit, the
  // rest as question and answer, and the oldest are left out
  const big = "y".repeat(TOOL_RESULT_MAX_CHARS);
  const many = Array.from({ length: 40 }, (_, k) => exchange(`q${k}`, `a${k}`, big));
  const h = runMessages(many, "q", [], tools);
  t.true(JSON.stringify(h).length <= HISTORY_MAX_CHARS + 1000);
  t.is(h[h.length - 1]?.role, "user");
  t.true(JSON.stringify(h).includes('"q39"'));
  t.true(h.some((x) => x.role === "tool"));
  const huge = "z".repeat(HISTORY_MAX_CHARS);
  const one = runMessages([{ q: "old", a: huge, turns: [] }, exchange("new", "A", "r")], "q", [], tools);
  t.false(JSON.stringify(one).includes('"old"'), "an exchange over the budget is left out");
  t.true(JSON.stringify(one).includes('"new"'));
});

test("a run's own turns follow its question; an unanswered call and a trailing turn without results are left out", (t) => {
  const own = parseTurns([
    turn(0, "assistant", [
      { type: "text", text: "Looking." },
      { type: "toolUse", id: "c1", name: "web_fetch", input: {} },
    ]),
    turn(1, "user", [{ type: "toolResult", toolUseId: "c1", content: "R", isError: true }]),
    turn(2, "assistant", [
      { type: "text", text: "More." },
      { type: "toolUse", id: "c2", name: "web_fetch", input: {} },
    ]),
  ]);
  if (!own) return t.fail();
  const m = runMessages([], "q", own, tools);
  t.deepEqual(
    m.map((x) => x.role),
    ["user", "assistant", "tool"],
  );
  t.like(m[2], { content: [{ type: "tool-result", output: { type: "error-text", value: "R" } }] });
  t.false(endsWithAnswer(own));
  t.true(endsWithAnswer([turn(0, "assistant", [{ type: "text", text: "done" }]) as never]));
  t.false(endsWithAnswer([turn(0, "assistant", [{ type: "text", text: " " }]) as never]));
  t.false(endsWithAnswer([turn(0, "user", [{ type: "text", text: "x" }]) as never]));
  t.is(parseTurns(["text", turn(0, "assistant", [])]), null);
});
