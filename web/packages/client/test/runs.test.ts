// Phase 2 review round 1, findings 5 and 7: the copy of a device answer's
// label, and of an answer that stopped for tokens (the mockup's tmStopWhy):
// the weekly included tokens with their reset day (Monday 00:00 UTC), or a
// key's monthly limit.

import test from "ava";

import { deviceLabel, tokensWhy, weekResetAt } from "../src/data/format.js";

const at = (iso: string) => Date.parse(iso);

test("the included tokens reset on the next Monday 00:00 UTC", (t) => {
  // a Monday morning: the next Monday
  t.is(weekResetAt(at("2026-11-16T10:00:00Z")), at("2026-11-23T00:00:00Z"));
  // Monday 00:00 itself: the week has just begun
  t.is(weekResetAt(at("2026-11-16T00:00:00Z")), at("2026-11-23T00:00:00Z"));
  // a Sunday night: the next day
  t.is(weekResetAt(at("2026-11-22T23:59:00Z")), at("2026-11-23T00:00:00Z"));
  t.is(weekResetAt(at("2026-11-19T12:00:00Z")), at("2026-11-23T00:00:00Z"));
});

test("an answer stopped for the included tokens names this week and the reset day", (t) => {
  const now = at("2026-11-16T10:00:00Z");
  t.is(
    tokensWhy("session", 30_000, now, null),
    "You’ve used this week’s included tokens. The agent stopped after 30k tokens and wrote nothing. They reset Nov 23.",
  );
  t.is(
    tokensWhy(null, 0, now, null),
    "You’ve used this week’s included tokens. The agent wrote nothing. They reset Nov 23.",
  );
});

test("an answer stopped for a key's limit names the key and its monthly limit", (t) => {
  const now = at("2026-11-16T10:00:00Z");
  t.is(
    tokensWhy("K1", 12_000, now, { name: "Work key", cap: 500_000 }),
    "Your Work key reached its monthly limit of 500k tokens. The agent stopped after 12k tokens and wrote nothing.",
  );
  // a key the reader does not hold (another person's)
  t.is(tokensWhy("K1", 0, now, null), "Nothing could pay for this ask. The agent wrote nothing.");
});

test("a device answer is labelled with its person's desktop and CLI", (t) => {
  t.is(deviceLabel({ u: "mira_k", cli: "claude" }), "Answered on mira_k’s desktop · Claude Code");
  t.is(deviceLabel({ u: "mira_k", cli: "codex" }), "Answered on mira_k’s desktop · Codex");
});
