// Who pays for a run, over the run records and the SQLite ledger
// (`03-agents-and-research.md` K3, K8, K10): the `pre` stage of the write
// that queues a run decides its payer from the ledger (open rows counted),
// the billing setting and the member's keys, and the run record carries it;
// the dispatcher decides it again when it claims the run; the week resets
// on Friday 00:00 UTC, read through an injected clock.

import { OUT_OF_TOKENS_TEXT } from "@session/shared";
import type { ApplyResult } from "@session/sync/server";
import type { ExecutionContext } from "ava";
import test from "ava";

import type { Allowances } from "../src/runs/allowance.js";
import { OVERDRAFT_STOP_NOTE, RunBudget, configAllowances } from "../src/runs/allowance.js";
import type { Payer } from "../src/runs/ledger.js";
import { ZERO_COUNTS, weekOf } from "../src/runs/ledger.js";
import { MemoryLedger } from "../src/runs/memoryLedger.js";

import { testConfig } from "./helpers.js";
import type { RunsWorld } from "./recordRuns.js";
import { MODEL, newId, runsWorld } from "./recordRuns.js";

const HOUR = 3_600_000;
/** The last millisecond of the week of Friday 2026-11-20. */
const BEFORE_RESET = Date.UTC(2026, 10, 26, 23, 59, 59, 999);
/** Friday 2026-11-27 00:00 UTC: the reset. */
const RESET = Date.UTC(2026, 10, 27);

const MEMBER_KEY = { apiKey: "sk-ant-member-key-0000000000", sealed: "v1.member-key" };

/** A weekly allowance of `weekly`, billing `key` with a valid Anthropic key. */
function keyBilling(weekly: number): Allowances {
  return {
    weekly: () => weekly,
    billing: () => "key",
    validKey: (_userId, provider) => (provider === "anthropic" ? MEMBER_KEY.sealed : null),
    anthropicKey: () => MEMBER_KEY,
    openaiKey: () => null,
  };
}

/** A clock a test moves. */
function clock(at: number) {
  const c = { at, now: () => c.at };
  return c;
}

/** A closed ledger row of `tokens` input tokens paid by `payer`, opened at
 * `at`: what an earlier run of the member spent. */
function spend(
  w: RunsWorld,
  userId: string,
  tokens: number,
  at: number,
  payer: Payer = "included",
) {
  const id = w.ledger.open({
    runId: `earlier-${newId()}`,
    attempt: 1,
    userId,
    payer,
    week: weekOf(at),
    kind: "research",
    provider: "vertex",
    model: "gemini-flash",
    cachedInputRatio: 0.1,
    counts: { ...ZERO_COUNTS, inputTokens: tokens },
    openedAt: at,
  });
  w.ledger.close(id, { ...ZERO_COUNTS, inputTokens: tokens }, "finish", at + 1);
}

const askInput = (space: string, q = "fixture:success what pays for this") => ({
  id: newId(),
  space,
  kind: "ask",
  q,
  ...MODEL,
});

function refusedForTokens(t: ExecutionContext, answer: ApplyResult | undefined) {
  t.false(answer?.ok);
  if (answer && !answer.ok) {
    t.is(answer.error.code, "PRECONDITION_FAILED");
    t.is(answer.error.reason, "out_of_tokens");
    t.is(answer.error.message, OUT_OF_TOKENS_TEXT);
  }
}

test.serial(
  "K8: an ask while the allowance is spent is refused out_of_tokens, recorded, and writes nothing",
  async (t) => {
    const w = await runsWorld(t, { env: { SESSION_WEEKLY_TOKENS: "1000" }, start: false });
    spend(w, w.mona.user.id, 1_000, Date.now());
    await w.mona.register();
    const input = askInput(w.open);
    const envelope = w.mona.envelope("threads.create", input);
    const { answers } = await w.mona.send([envelope]);
    refusedForTokens(t, answers[0]);
    t.is(w.rec(`thread:${input.id}`), undefined, "no thread");
    t.is(w.rt.store.queued().length, 0, "no run");
    // recorded: the same envelope gets the same answer, and the next seq
    // follows it
    const again = await w.mona.send([envelope]);
    t.like(again.answers[0], { ok: false, replay: true });
    refusedForTokens(t, again.answers[0]);
    // a post still sends
    t.true(
      (
        await w.mona.write("threads.create", {
          id: newId(),
          space: w.open,
          kind: "post",
          q: "Still here",
        })
      ).ok,
    );
  },
);

test.serial(
  "K8: once the allowance is spent, billing key and a valid Anthropic key pay; the run record says so",
  async (t) => {
    const w = await runsWorld(t, { allowances: keyBilling(1_000), start: false });
    spend(w, w.mona.user.id, 1_000, Date.now());
    const { run } = await w.ask(w.mona, w.open, "fixture:success the key pays");
    t.like(w.run(run), { status: "queued", pay: "key:anthropic" });

    w.rt.dispatcher.start();
    // the research calls bill the key; the new thread's title and summary
    // steps count toward the allowance (`03` K2)
    t.like(await w.settled(run), { status: "complete", pay: "key:anthropic" });
    const rows = w.rows(run).filter((r) => r.kind === "research");
    t.true(rows.length > 0);
    for (const r of rows) t.is(r.payer, "key:anthropic");
    t.true(["key:anthropic", "included+key:anthropic"].includes(w.run(run).bill ?? ""));
  },
);

test.serial("K8: with included tokens left the run record says included", async (t) => {
  const w = await runsWorld(t, { allowances: keyBilling(1_000_000), start: false });
  const { run } = await w.ask(w.mona, w.open, "fixture:success included");
  t.like(w.run(run), { status: "queued", pay: "included" });
});

test.serial("K8: with billing pause a valid Anthropic key does not pay", async (t) => {
  const w = await runsWorld(t, {
    allowances: { ...keyBilling(1_000), billing: () => "pause" },
    start: false,
  });
  spend(w, w.mona.user.id, 1_000, Date.now());
  await w.mona.register();
  refusedForTokens(t, await w.mona.write("threads.create", askInput(w.open)));
});

test.serial(
  "K10: a run queued while tokens were left and claimed after they ran out ends tokens without a provider call",
  async (t) => {
    const w = await runsWorld(t, { env: { SESSION_WEEKLY_TOKENS: "1000" }, start: false });
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:success queued in time");
    t.like(w.run(run), { status: "queued", pay: "included" });
    spend(w, w.mona.user.id, 1_000, Date.now());

    t.is(w.rt.dispatcher.tick(), 0);
    t.like(w.run(run), { status: "failed", fail: { why: "tokens" } });
    t.false(w.thread(thread).running);
    t.deepEqual(w.streamed, [], "no provider call");
    t.deepEqual(w.rows(run), []);
  },
);

test.serial("K10: the claim decides the payer again and writes it to the run record", async (t) => {
  const w = await runsWorld(t, { allowances: keyBilling(1_000), start: false });
  const { run } = await w.ask(w.mona, w.open, "fixture:success queued on included");
  t.like(w.run(run), { pay: "included" });
  spend(w, w.mona.user.id, 1_000, Date.now());

  w.rt.dispatcher.start();
  t.like(await w.settled(run), { status: "complete", pay: "key:anthropic" });
  for (const r of w.rows(run).filter((x) => x.kind === "research")) t.is(r.payer, "key:anthropic");
});

test.serial(
  "K3, K10: at the reset a failed tokens run stays failed; a new ask and Run again are paid with included tokens",
  async (t) => {
    const c = clock(BEFORE_RESET - HOUR);
    const w = await runsWorld(t, {
      env: { SESSION_WEEKLY_TOKENS: "1000" },
      start: false,
      now: c.now,
    });
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:success before the reset");
    spend(w, w.mona.user.id, 1_000, c.at);
    w.rt.dispatcher.tick();
    t.like(w.run(run), { status: "failed", fail: { why: "tokens" } });

    // the last millisecond of the week: still spent
    c.at = BEFORE_RESET;
    await w.mona.register();
    refusedForTokens(t, await w.mona.write("threads.create", askInput(w.open)));

    // the reset: nothing runs again by itself
    c.at = RESET;
    t.is(w.rt.dispatcher.tick(), 0);
    t.like(w.run(run), { status: "failed", attempt: 1 });
    t.deepEqual(w.streamed, []);

    // a new ask and Run again apply, on included tokens
    const fresh = await w.ask(w.mona, w.open, "fixture:success after the reset");
    t.like(w.run(fresh.run), { status: "queued", pay: "included" });
    await w.mona.ok("research.retryNode", {
      thread,
      node: "r",
      ...MODEL,
      base: { attempt: 1 },
    });
    t.like(w.run(run), { status: "queued", attempt: 2, pay: "included" });
    w.rt.dispatcher.start();
    t.like(await w.settled(run), { status: "complete", attempt: 2 });
    for (const r of w.rows(run)) t.is(r.payer, "included");
  },
);

test.serial(
  "K3, K10: a run queued on the member's key before the reset is claimed on included tokens after it",
  async (t) => {
    const c = clock(BEFORE_RESET);
    const w = await runsWorld(t, { allowances: keyBilling(1_000), start: false, now: c.now });
    spend(w, w.mona.user.id, 1_000, BEFORE_RESET - HOUR);
    const { run } = await w.ask(w.mona, w.open, "fixture:success across the reset");
    t.like(w.run(run), { pay: "key:anthropic" });

    c.at = RESET;
    w.rt.dispatcher.start();
    t.like(await w.settled(run), { status: "complete", pay: "included", bill: "included" });
    for (const r of w.rows(run)) t.is(r.payer, "included");
  },
);

test("K3, K9: the overdraft counts in the week it happened and does not carry over", (t) => {
  const ledger = new MemoryLedger();
  const config = testConfig("/tmp/session-billing-unused", {
    SESSION_WEEKLY_TOKENS: "1000",
    SESSION_OVERDRAFT_TOKENS: "500",
  });
  const c = clock(BEFORE_RESET);
  const deps = {
    ledger,
    allowances: configAllowances(config),
    limits: config.limits,
    now: c.now,
  };
  const id = ledger.open({
    runId: "spent",
    attempt: 1,
    userId: "u1",
    payer: "included",
    week: weekOf(BEFORE_RESET - HOUR),
    kind: "research",
    provider: "vertex",
    model: "gemini-flash",
    cachedInputRatio: 0.1,
    counts: { ...ZERO_COUNTS, inputTokens: 1_500 },
    openedAt: BEFORE_RESET - HOUR,
  });
  ledger.close(id, { ...ZERO_COUNTS, inputTokens: 1_500 }, "finish", BEFORE_RESET - HOUR);
  const budget = new RunBudget(deps, { userId: "u1", runId: "next", attempt: 1 });
  t.true(budget.allowanceSpent());
  t.is(budget.stopReason("included"), "overdraft");
  t.is(OVERDRAFT_STOP_NOTE, "Stopped: this week's included tokens ran out.");
  c.at = RESET;
  t.false(budget.allowanceSpent(), "a new week");
  t.is(budget.stopReason("included"), null);
});
