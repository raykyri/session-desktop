// The payer of a run decided when the server applies the write (`03` K8,
// `01` Y11): a client predicts an ask while included tokens are left, as a
// queued run; by the time the server applies it they have run out. The write
// still applies: the thread exists and its run is `failed { why: "tokens" }`,
// and the client's view converges on the server's records. With the
// member's key paying, the server's payer (`pay`) replaces the predicted one.

import { MUTATORS, type PayerFacts, type StoredRecord } from "@session/mutators";
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

test("K8: an ask queued with tokens left and applied after they ran out is kept; its run is failed tokens", async (t) => {
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
  t.true(answer?.ok, "applied");
  t.false(
    seen.some((e) => e.type === "refused"),
    "nothing refused: the composer keeps nothing",
  );
  t.like(runIn(w.store.records.values(), id), {
    status: "failed",
    fail: { why: "tokens", at: null, cls: null },
    pay: null,
  });

  // the prediction gives way to the server's records
  await mona.sync(`space:${open}`);
  t.like(mona.get(`thread:${id}`), { q, running: false });
  t.like(runIn(mona.view().values(), id), { status: "failed", fail: { why: "tokens" } });
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
