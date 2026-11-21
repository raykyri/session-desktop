// The payer of a run decided when the server applies the write (`03` K8,
// `01` Y11): a client predicts an ask while included tokens are left; by the
// time the server applies it they have run out. With nothing to pay, the
// server refuses it (`out_of_tokens`, recorded) and the client rolls the
// prediction back to the server's answer and hands the input back for the
// composer. With the member's key paying, the server's run record (`pay`)
// replaces the predicted one.

import { MUTATORS, type PayerFacts, type StoredRecord } from "@session/mutators";
import { OUT_OF_TOKENS_TEXT } from "@session/shared";
import type { ExecutionContext } from "ava";
import test from "ava";

import { MemoryAdapter, SyncClient, type ClientEvent } from "../src/client/index.js";

import { MODEL, cast, type World } from "./world.js";

const LEFT: PayerFacts = { includedLeft: true, billing: "pause", keys: [] };

function setup(t: ExecutionContext) {
  const { w, open } = cast(t);
  const facts: Record<string, PayerFacts> = {};
  w.server.setPayerFacts((u) => facts[u] ?? LEFT);
  const mona = new SyncClient(w.transport("mona"), {
    user: "mona",
    clock: w.clock,
    random: w.random,
    mutators: MUTATORS,
    storage: new MemoryAdapter(),
  });
  const seen: ClientEvent[] = [];
  mona.onEvent((e) => seen.push(e));
  return { w, open, facts, mona, seen };
}

/** The thread and run records of `space`: as the replica shows them, and
 * as the server holds them. */
function views(w: World, mona: SyncClient, space: string) {
  const ofSpace = (records: Iterable<[string, StoredRecord]>) =>
    new Map(
      [...records].filter(
        ([k, r]) => (k.startsWith("thread:") || k.startsWith("run:")) && "s" in r && r.s === space,
      ),
    );
  return { shown: ofSpace(mona.view()), held: ofSpace(w.store.records) };
}

/** The run of thread `th` in `records`. */
const runIn = (records: Iterable<StoredRecord>, th: string) =>
  [...records].find((r) => r.kind === "run" && r.th === th);

test("K8: an ask queued with tokens left and applied after they ran out is refused, and the prediction rolls back", async (t) => {
  const { w, open, facts, mona, seen } = setup(t);
  await mona.sync(`space:${open}`);
  await mona.sync("user:mona");

  const id = w.id();
  const q = "What did the reviewers find?";
  const write = mona.queue("threads.create", { id, space: open, kind: "ask", q, ...MODEL });
  // predicted: the thread and its queued run, on included tokens
  t.is(mona.prediction(write.local), "applied");
  t.like(mona.get(`thread:${id}`), { q, running: true });
  t.like(runIn(mona.view().values(), id), { status: "queued", pay: "included" });
  t.is(runIn(w.store.records.values(), id), undefined, "not on the server yet");

  // another tab spends the rest of the week's tokens before this write is sent
  facts["mona"] = { includedLeft: false, billing: "pause", keys: [] };
  const [answer] = await mona.flush();
  t.like(answer, {
    ok: false,
    error: { code: "PRECONDITION_FAILED", reason: "out_of_tokens", message: OUT_OF_TOKENS_TEXT },
  });

  // rolled back to the server's answer: nothing of it shows, and the
  // composer gets its text back
  t.is(mona.get(`thread:${id}`), undefined);
  t.is(runIn(mona.view().values(), id), undefined);
  t.like(
    seen.find((e) => e.type === "refused"),
    { type: "refused", input: { q }, error: { reason: "out_of_tokens" } },
  );
  await mona.sync(`space:${open}`);
  const { shown, held } = views(w, mona, open);
  t.deepEqual(shown, held);
});

test("K8: an ask queued with tokens left and applied once the member's key pays converges on the server's payer", async (t) => {
  const { w, open, facts, mona } = setup(t);
  await mona.sync(`space:${open}`);
  await mona.sync("user:mona");

  const id = w.id();
  mona.queue("threads.create", { id, space: open, kind: "ask", q: "Paid by the key?", ...MODEL });
  t.like(runIn(mona.view().values(), id), { pay: "included" }, "the prediction's payer");

  facts["mona"] = { includedLeft: false, billing: "key", keys: ["anthropic"] };
  const [answer] = await mona.flush();
  t.true(answer?.ok);
  t.like(runIn(w.store.records.values(), id), { pay: "key:anthropic", status: "queued" });

  await mona.sync(`space:${open}`);
  t.like(runIn(mona.view().values(), id), { pay: "key:anthropic" });
  const { shown, held } = views(w, mona, open);
  t.deepEqual(shown, held);
});
