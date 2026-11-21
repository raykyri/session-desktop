// Who pays for a run, decided in the `pre` stage of the write that queues it
// (`03` K8, K11): `included` while included tokens are left, the member's
// Anthropic key once they are spent and billing is `key`, the member's key
// for a key-only model, and a recorded refusal when nothing can pay. Posts,
// replies and comments are never refused for tokens.

import { spaces } from "@session/shared";
import test from "ava";

import { NO_KEY_TEXT, firstPayer, payerFor, type PayerFacts } from "../src/index.js";

import { MODEL, ask, cast, finish, ok, post, refused, type World } from "./world.js";

const LEFT: PayerFacts = { includedLeft: true, billing: "pause", keys: [] };
const SPENT: PayerFacts = { includedLeft: false, billing: "pause", keys: [] };
const SPENT_KEY: PayerFacts = { includedLeft: false, billing: "key", keys: ["anthropic"] };

/** The model the registry lets only included tokens pay for. */
const INCLUDED_ONLY = { model: "gemini-flash", effort: "medium" } as const;

const runOf = (w: World, thread: string) => w.all("run").find((r) => r.th === thread);

test("K8: an ask with included tokens left is paid with included tokens", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: LEFT };
  const th = ask(t, w, "mel", open, false);
  t.like(runOf(w, th), { pay: "included", status: "queued" });
});

test("K8: once the allowance is spent, billing key and a valid Anthropic key pay for an Anthropic model", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: SPENT_KEY };
  const th = ask(t, w, "mel", open, false);
  t.like(runOf(w, th), { pay: "key:anthropic", ...MODEL });

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
  t.like(
    w.all("run").find((r) => r.node === id),
    { pay: "included" },
  );
});

test("K8: with nothing to pay, the write is refused out_of_tokens and writes nothing", (t) => {
  const { w, open } = cast(t);
  const cases: [string, PayerFacts, typeof MODEL | typeof INCLUDED_ONLY][] = [
    ["billing pause", SPENT, MODEL],
    ["billing key without a key", { ...SPENT_KEY, keys: [] }, MODEL],
    ["billing key with only an OpenAI key", { ...SPENT_KEY, keys: ["openai"] }, MODEL],
    ["a model the Anthropic key does not pay for", SPENT_KEY, INCLUDED_ONLY],
  ];
  for (const [name, facts, model] of cases) {
    w.payers = { mel: facts };
    const threads = w.all("thread").length;
    const runs = w.all("run").length;
    const e = refused(
      t,
      w.apply("mel", "threads.create", {
        id: w.id(),
        space: open,
        kind: "ask",
        q: "Why?",
        ...model,
      }),
      "PRECONDITION_FAILED",
    );
    t.is(e?.reason, "out_of_tokens", name);
    t.is(e?.message, spaces.OUT_OF_TOKENS_TEXT, name);
    t.is(w.all("thread").length, threads, `${name}: no thread`);
    t.is(w.all("run").length, runs, `${name}: no run`);
  }
});

test("K8: Continue, Branch, Look up and Run again are refused the same way", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: LEFT };
  const th = ask(t, w, "mel", open);
  w.payers = { mel: SPENT };
  const fork = (input: Record<string, unknown>) =>
    refused(
      t,
      w.apply("mel", "research.forkNode", {
        id: w.id(),
        thread: th,
        parent: "r",
        ...MODEL,
        ...input,
      }),
      "PRECONDITION_FAILED",
    )?.reason;
  t.is(fork({ kind: "ask", q: "Continue" }), "out_of_tokens");
  t.is(fork({ kind: "lookup", look: "answer", quote: "An answer." }), "out_of_tokens");

  // a run that failed for tokens stays failed until the person runs it again
  const run = runOf(w, th);
  if (!run) throw new Error("no run");
  w.put({ ...run, status: "failed", fail: { why: "tokens", at: null, cls: null } });
  const retry = { thread: th, node: "r", ...MODEL, base: { attempt: 1 } };
  t.is(
    refused(t, w.apply("mel", "research.retryNode", retry), "PRECONDITION_FAILED")?.reason,
    "out_of_tokens",
  );
  t.like(runOf(w, th), { status: "failed", attempt: 1 });
  // after the reset, Run again is paid with included tokens
  w.payers = { mel: LEFT };
  ok(t, w.apply("mel", "research.retryNode", retry));
  t.like(runOf(w, th), { status: "queued", attempt: 2, pay: "included" });
});

test("K8, G4: posts, replies and comments are never refused for tokens", (t) => {
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
});

test("K8: without payer facts (a server with no ledger) a run is paid by its model's first payer", (t) => {
  const { w, open } = cast(t);
  const th = ask(t, w, "mel", open, false);
  t.like(runOf(w, th), { pay: "included" });
  t.is(firstPayer("claude-fable"), "included");
  t.is(firstPayer("no-such-model"), "included");
});

test("K8: a client's prediction writes the model's first payer, which the server's record replaces", (t) => {
  const { w, open } = cast(t);
  w.payers = { mel: SPENT_KEY };
  const id = w.id();
  const { prediction, tx } = w.predict("mel", "threads.create", {
    id,
    space: open,
    kind: "ask",
    q: "Why?",
    ...MODEL,
  });
  t.true("ok" in prediction && prediction.ok);
  const predicted = [...tx.staged.values()].find((r) => r?.kind === "run");
  t.like(predicted, { pay: "included" });
  ok(t, w.apply("mel", "threads.create", { id, space: open, kind: "ask", q: "Why?", ...MODEL }));
  t.like(runOf(w, id), { pay: "key:anthropic" });
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
  // a key-only model runs on its key whether or not included tokens are left
  t.is(payerFor(openaiOnly, { ...LEFT, keys: ["openai"] }), "key:openai");
  t.is(payerFor(openaiOnly, { ...SPENT, keys: ["openai"] }), "key:openai");
  t.is(payerFor(openaiOnly, { ...LEFT, keys: ["anthropic"] }), "no_key");
  t.is(payerFor(openaiOnly, SPENT_KEY), "no_key");
  t.is(NO_KEY_TEXT, "This model runs on your own API key. Add the key in Usage.");
});
