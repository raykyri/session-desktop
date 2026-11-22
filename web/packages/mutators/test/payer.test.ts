// Who pays for a run, decided in the `pre` stage of the write that queues it
// (`03` K8, K11): `included` while included tokens are left, the member's
// Anthropic key once they are spent and billing is `key`, the member's key
// for a key-only model. With nothing to pay the write still applies and its
// run is written `failed { why: "tokens" }`, so the ask is kept and can run
// again after the reset. Posts, replies and comments are never affected.

import test from "ava";

import { NO_KEY_TEXT, firstPayer, payerFor, type PayerFacts } from "../src/index.js";

import { MODEL, ask, cast, finish, ok, post, type World } from "./world.js";

const LEFT: PayerFacts = { includedLeft: true, billing: "pause", keys: [] };
const SPENT: PayerFacts = { includedLeft: false, billing: "pause", keys: [] };
const SPENT_KEY: PayerFacts = { includedLeft: false, billing: "key", keys: ["anthropic"] };

/** The model the registry lets only included tokens pay for. */
const INCLUDED_ONLY = { model: "gemini-flash", effort: "medium" } as const;

const TOKENS = { why: "tokens", at: null, cls: null } as const;

const runOf = (w: World, thread: string, node = "r") =>
  w.all("run").find((r) => r.th === thread && r.node === node);

test("K8: an ask with included tokens left is paid with included tokens", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: LEFT };
  const th = ask(t, w, "mel", open, false);
  t.like(runOf(w, th), { pay: "included", status: "queued", fail: null });
  t.like(w.get(`thread:${th}`), { running: true });
});

test("K8: with included tokens left, billing key and a valid Anthropic key still pay with included tokens", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: { ...SPENT_KEY, includedLeft: true } };
  const th = ask(t, w, "mel", open, false);
  t.like(runOf(w, th), { pay: "included", status: "queued", ...MODEL });
});

test("K8: once the allowance is spent, billing key and a valid Anthropic key pay for an Anthropic model", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: SPENT_KEY };
  const th = ask(t, w, "mel", open, false);
  t.like(runOf(w, th), { pay: "key:anthropic", status: "queued", ...MODEL });

  // a fork decides again, with the facts as they are then
  finish(w, th, "r");
  w.payers = { mel: LEFT };
  const id = w.id();
  ok(
    t,
    w.apply("mel", "research.forkNode", {
      id,
      thread: th,
      parent: "r",
      kind: "ask",
      q: "And?",
      ...MODEL,
    }),
  );
  t.like(runOf(w, th, id), { pay: "included", status: "queued" });
});

test("K8: with nothing to pay the ask still applies; its run is written failed tokens", (t) => {
  const { w, open } = cast(t);
  const cases: [string, PayerFacts, typeof MODEL | typeof INCLUDED_ONLY][] = [
    ["billing pause", SPENT, MODEL],
    ["billing key without a key", { ...SPENT_KEY, keys: [] }, MODEL],
    ["billing key with only an OpenAI key", { ...SPENT_KEY, keys: ["openai"] }, MODEL],
    ["a model the Anthropic key does not pay for", SPENT_KEY, INCLUDED_ONLY],
  ];
  for (const [name, facts, model] of cases) {
    w.payers = { mel: facts };
    const id = w.id();
    const r = ok(
      t,
      w.apply("mel", "threads.create", { id, space: open, kind: "ask", q: "Why?", ...model }),
    ) as { run: string };
    t.like(w.get(`thread:${id}`), { q: "Why?", running: false }, name);
    t.like(
      w.get(`run:${r.run}`),
      {
        pay: null,
        status: "failed",
        fail: TOKENS,
        attempt: 1,
        finishedAt: (w.get(`thread:${id}`) as { createdAt?: string } | undefined)?.createdAt,
      },
      name,
    );
  }
});

test("K8: Continue, Branch, Look up and Run again apply the same way", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: LEFT };
  const th = ask(t, w, "mel", open);
  w.payers = { mel: SPENT };
  const fork = (input: Record<string, unknown>) => {
    const id = w.id();
    ok(t, w.apply("mel", "research.forkNode", { id, thread: th, parent: "r", ...MODEL, ...input }));
    t.like(w.get(`node:${id}`), { th });
    return runOf(w, th, id);
  };
  t.like(fork({ kind: "ask", q: "Continue" }), { status: "failed", fail: TOKENS, pay: null });
  t.like(fork({ kind: "lookup", look: "answer", quote: "An answer." }), {
    status: "failed",
    fail: TOKENS,
  });

  // Run again with nothing to pay: a new attempt, failed tokens at once
  const run = runOf(w, th);
  if (!run) throw new Error("no run");
  w.put({ ...run, status: "failed", fail: TOKENS });
  ok(
    t,
    w.apply("mel", "research.retryNode", { thread: th, node: "r", ...MODEL, base: { attempt: 1 } }),
  );
  t.like(runOf(w, th), { status: "failed", fail: TOKENS, attempt: 2, pay: null });
  t.like(w.get(`thread:${th}`), { running: false });
  // after the reset, Run again is paid with included tokens
  w.payers = { mel: LEFT };
  ok(
    t,
    w.apply("mel", "research.retryNode", { thread: th, node: "r", ...MODEL, base: { attempt: 2 } }),
  );
  t.like(runOf(w, th), {
    status: "queued",
    attempt: 3,
    pay: "included",
    fail: null,
    finishedAt: null,
  });
  t.like(w.get(`thread:${th}`), { running: true });
});

test("K8, G4: posts, replies and comments are not affected by the allowance", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: LEFT };
  const th = ask(t, w, "mel", open);
  w.payers = { mel: SPENT };
  const p = post(t, w, "mel", open);
  ok(t, w.apply("mel", "research.createPostFollowUp", { id: w.id(), thread: p, t: "A reply" }));
  ok(t, w.apply("mel", "comments.create", { id: w.id(), thread: th, node: "r", t: "A comment" }));
  t.like(w.get(`thread:${p}`), { k: "post" });
  t.is(w.all("reply").length, 1);
  t.is(w.all("comment").length, 1);
  t.is(w.all("run").length, 1, "no run for any of them");
});

test("K8: without payer facts (a server with no ledger) a run is paid by its model's first payer", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open, false);
  t.like(runOf(w, th), { pay: "included", status: "queued" });
  t.is(firstPayer("claude-fable"), "included");
  t.is(firstPayer("no-such-model"), "included");
});

test("K8: a client's prediction writes a queued run on the model's first payer, which the server's record replaces", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: SPENT };
  const id = w.id();
  const input = { id, space: open, kind: "ask", q: "Why?", ...MODEL };
  const { prediction, tx } = w.predict("mel", "threads.create", input);
  t.true("ok" in prediction && prediction.ok);
  const predicted = [...tx.staged.values()].find((r) => r?.kind === "run");
  t.like(predicted, { pay: "included", status: "queued" });
  ok(t, w.apply("mel", "threads.create", input));
  t.like(runOf(w, id), { pay: null, status: "failed", fail: TOKENS });
});

test("K8, K11: the payer rule for each kind of model", (t) => {
  const included = ["included"] as const;
  const anthropic = ["included", "key:anthropic"] as const;
  const openaiOnly = ["key:openai"] as const;
  t.is(payerFor(included, LEFT), "included");
  t.is(payerFor(anthropic, LEFT), "included");
  t.is(payerFor(anthropic, SPENT_KEY), "key:anthropic");
  t.is(payerFor(anthropic, SPENT), "out_of_tokens");
  t.is(payerFor(included, SPENT_KEY), "out_of_tokens");
  // a key-only model runs on its key whether or not included tokens are
  // left; without the key the dispatcher ends the run `failed key` (E5)
  t.is(payerFor(openaiOnly, { ...LEFT, keys: ["openai"] }), "key:openai");
  t.is(payerFor(openaiOnly, { ...SPENT, keys: ["openai"] }), "key:openai");
  t.is(payerFor(openaiOnly, { ...LEFT, keys: ["anthropic"] }), "no_key");
  t.is(payerFor(openaiOnly, SPENT_KEY), "no_key");
  t.is(NO_KEY_TEXT, "This model requires your own API key. Add one in Usage.");
});
