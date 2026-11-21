// Streaming over the sync connection (`03-agents-and-research.md` T2-T4):
// deltas are ephemeral events sent only to readers who may read the run's
// text at send time; `GET /api/runs/:id/live` answers the attempt's
// committed turns and the turn still streaming under the same scope; and
// in-flight text adds no change-log rows.

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { RunTables } from "@session/db";
import test from "ava";

import { RUN_LIVE_READS } from "../src/app.js";
import { registerFixture } from "../src/runs/fixtureProvider.js";
import { weekOf } from "../src/runs/ledger.js";
import { RESUME_SEQ_GAP, RecordRunStore } from "../src/runs/recordStore.js";
import type { RunDelta, RunLive } from "../src/runs/recordStore.js";

import { CHUNK, MODEL, runsWorld, streamedOutput, waitFor } from "./recordRuns.js";
import type { EventReader, Person, SseEvent } from "./syncHttp.js";
import { newId, Person as SyncPerson } from "./syncHttp.js";

/** Every event a stream delivers, read in the background. */
function collect(reader: EventReader) {
  const events: SseEvent[] = [];
  let stopped = false;
  // one read at a time, never abandoned: a read that timed out would lose
  // the chunk it later receives
  const done = (async () => {
    while (!stopped) {
      const e = await reader.next(120_000);
      if (e) events.push(e);
      else break;
    }
  })();
  return {
    events,
    deltas: () =>
      events.filter((e) => e.event === "run.delta").map((e) => JSON.parse(e.data) as RunDelta),
    async stop() {
      stopped = true;
      await reader.close();
      await done;
    },
  };
}

/** `p`'s event stream over the space log `log`, from a fresh snapshot. */
async function stream(p: Person, log: string) {
  if (!p.clientId) await p.register();
  const { cursor } = await p.snapshot(log);
  const reader = await p.events({ [log]: cursor });
  const c = collect(reader);
  await waitFor(() => c.events.some((e) => e.event === "ready"), "ready");
  return c;
}

async function live(p: Person | null, h: { request: Person["h"]["request"] }, run: string) {
  const res = await h.request(`/api/runs/${run}/live`, p ? { cookie: p.cookie } : {});
  return { status: res.status, body: (await res.json()) as RunLive };
}

test.serial(
  "T2: a private channel's deltas reach its members only: not a non-member holding a cursor of its log, not a member removed mid-run (within the coalesce window too), not a signed-out reader",
  async (t) => {
    const w = await runsWorld(t);
    const log = `space:${w.closed}`;
    // otto joins #lab to be removed while the run streams
    const otto = new SyncPerson(w, w.addUser("otto"));
    const link = (await w.olga.ok("invites.create", { id: newId(), space: w.closed, days: 7 })) as {
      code: string;
    };
    await otto.ok("spaces.join", { space: w.closed, invite: link.code });

    const member = await stream(w.mel, log);
    const removed = await stream(otto, log);
    // mona is not a member: the snapshot of the private log gives her a
    // valid cursor and no records
    const outsider = await stream(w.mona, log);

    const { run } = await w.ask(w.olga, w.closed, "fixture:paced-answer");
    await waitFor(() => removed.deltas().length >= 2, "otto's first deltas");
    await w.olga.ok("members.remove", {
      space: w.closed,
      user: otto.handle,
      base: { adm: (w.rec(`member:${w.closed}:${otto.handle}`) as { adm: string }).adm },
    });
    // the seq of the last delta sent before the removal committed
    const atRemoval = w.rt.store.live(run, w.mel.handle)?.live?.seq ?? 0;
    await waitFor(() => member.deltas().some((d) => d.seq > atRemoval + 3), "deltas after");
    await w.olga.ok("research.cancelNode", { thread: w.run(run).th, node: "r" });
    await w.settled(run);
    for (const c of [member, removed, outsider]) await c.stop();

    const seqs = member.deltas().map((d) => d.seq);
    t.true(seqs.length > 5);
    t.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      "in order",
    );
    t.true(member.deltas().every((d) => d.run === run && d.attempt === 1 && d.n === 0));
    t.true(removed.deltas().length >= 2, "otto read deltas while a member");
    t.true(
      removed.deltas().every((d) => d.seq <= atRemoval),
      "no delta after the removal, within the coalesce window included",
    );
    t.deepEqual(outsider.deltas(), [], "a non-member gets no delta");
    t.false(
      outsider.events.some((e) => e.data.includes("Consistent")),
      "nothing of the text in any event",
    );

    // a signed-out reader has no stream, and no live text
    const res = await w.request(`/api/sync/events?clientId=x`, {
      headers: { "Session-Cursors": JSON.stringify({ [log]: "" }) },
    });
    t.is(res.status, 401);
    t.is((await live(null, w, run)).status, 404);
  },
);

test.serial("T2: a hidden ask's deltas reach its author and the space's owner only", async (t) => {
  const w = await runsWorld(t);
  const log = `space:${w.open}`;
  const author = await stream(w.mona, log);
  const owner = await stream(w.olga, log);
  const reader = await stream(w.mel, log);
  const { thread, run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
  await waitFor(() => reader.deltas().length >= 2, "the reader's first deltas");
  await w.olga.ok("moderation.decide", { item: `a:${thread}`, decision: "hidden" });
  const atHide = w.rt.store.live(run, "mona")?.live?.seq ?? 0;
  await waitFor(() => author.deltas().some((d) => d.seq > atHide + 3), "deltas after");
  await w.mona.ok("research.cancelNode", { thread, node: "r" });
  await w.settled(run);
  for (const c of [author, owner, reader]) await c.stop();
  t.true(reader.deltas().every((d) => d.seq <= atHide));
  t.true(author.deltas().some((d) => d.seq > atHide));
  t.true(owner.deltas().some((d) => d.seq > atHide));
  // and `/live` answers the same way
  t.is((await live(w.mel, w, run)).status, 404);
  t.is((await live(w.mona, w, run)).status, 200);
});

test.serial(
  "T3: /live answers the committed turns and the turn still streaming with its seq; a non-member gets NOT_FOUND",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mel, w.closed, "fixture:paced-answer");
    await waitFor(() => (w.rt.store.live(run, "mel")?.live?.seq ?? 0) > 3, "a few deltas");
    const mid = await live(w.mel, w, run);
    t.is(mid.status, 200);
    t.like(mid.body, { run, attempt: 1, turns: [] });
    t.truthy(mid.body.live);
    t.true(mid.body.live!.text.startsWith("Consistent "));
    t.true(mid.body.live!.seq > 3);
    t.is(mid.body.live!.n, 0);
    const outsider = await live(w.mona, w, run);
    t.is(outsider.status, 404);
    t.like(outsider.body, { code: "NOT_FOUND" });
    t.is((await live(null, w, run)).status, 404);
    t.is((await live(w.mel, w, newId())).status, 404, "as for a run that does not exist");
    await w.mel.ok("research.cancelNode", { thread, node: "r" });
    await w.settled(run);
    const after = await live(w.mel, w, run);
    t.is(after.body.live, null);
    t.deepEqual(
      after.body.turns.map((x) => x.key),
      [`turn:${run}:1:0`],
    );
  },
);

// 24 tool steps and an answer: the run's step limit
const STEPS = 25;
registerFixture({
  scenario: "twenty-five-steps",
  steps: Array.from({ length: STEPS }, (_, k) => {
    const parts: LanguageModelV4StreamPart[] =
      k < STEPS - 1
        ? [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: `t${k}` },
            { type: "text-delta", id: `t${k}`, delta: `Step ${k} reads a page. `.repeat(20) },
            { type: "text-end", id: `t${k}` },
            {
              type: "tool-call",
              toolCallId: `call-${k}`,
              toolName: "web_fetch",
              input: '{"url":"https://example.com/bloom-filters"}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 120, text: 120, reasoning: 0 },
              },
            },
          ]
        : [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "tz" },
            { type: "text-delta", id: "tz", delta: "The answer. ".repeat(50) },
            { type: "text-end", id: "tz" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 150, text: 150, reasoning: 0 },
              },
            },
          ];
    return { parts };
  }),
});

test.serial(
  "T4: a 25-step run adds at most 25 turn rows and a constant number of run-record writes to the change log",
  async (t) => {
    const w = await runsWorld(t);
    let runWrites = 0;
    let runId = "";
    const stop = w.sync.onRecords((keys) => {
      if (runId && keys.has(`run:${runId}`)) runWrites += 1;
    });
    const log = `space:${w.open}` as const;
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:twenty-five-steps");
    runId = run;
    const head = w.sync.store.head();
    const done = await w.settled(run);
    stop();
    t.is(done.status, "complete");
    const rows = w.sync.store.logRows(log, 0).filter((r) => r.key.startsWith(`turn:${run}:`));
    t.is(w.turns(run).length, STEPS);
    t.true(rows.length <= STEPS, `${rows.length} turn rows`);
    // the claim, at most four phase changes and the finish: no write per delta
    t.true(runWrites <= 6, `${runWrites} run-record writes`);
    // every commit of the run since the claim: turns (a step's record and its
    // tool results), the run record, the title and summary, the answer
    const commits = w.sync.store.head() - head;
    t.true(commits <= 2 * STEPS + 8, `${commits} commits`);
    t.truthy(w.rec(`answer:${thread}`));
  },
);

test.serial(
  "T3: a committed step moves /live to the next turn: its number goes up and its text starts empty",
  async (t) => {
    const w = await runsWorld(t);
    const { run } = await w.ask(w.mona, w.open, "fixture:fetch-then-endless");
    await waitFor(() => streamedOutput(w.streamed[1]) > 20, "text of the second step");
    await waitFor(
      () => (w.rt.store.live(run, "mel")?.live?.text.length ?? 0) > CHUNK.length,
      "deltas of the second step",
    );
    const mid = await live(w.mel, w, run);
    t.is(mid.status, 200);
    t.deepEqual(
      mid.body.turns.map((x) => x.key),
      [`turn:${run}:1:0`],
    );
    t.is(mid.body.live?.n, 1, "the turn the second step's record will have");
    t.true(mid.body.live?.text.startsWith(CHUNK) ?? false, "the first step's text is not in it");
    t.false(mid.body.live?.text.includes("Reading the page.") ?? true);
    await w.mona.ok("research.cancelNode", { thread: w.run(run).th, node: "r" });
    await w.settled(run);
  },
);

test.serial(
  "T3: /live answers from the stored checkpoint when this process holds no text of the attempt",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const { run } = await w.ask(w.mona, w.open, "fixture:success");
    const request = w.rt.store.claim(w.rt.store.queued()[0]!);
    if (!request) return t.fail("no claim");
    w.rt.store.delta(request, "t0", "Checkpointed text. ");
    w.rt.store.checkpoint(request);
    // another process's view of the same database
    const other = new RecordRunStore({ sync: w.sync, db: w.db });
    t.teardown(() => other.close());
    t.deepEqual(other.live(run, "mel")?.live, { n: 0, text: "Checkpointed text. ", seq: 1 });
  },
);

test.serial(
  "T3: a claim of an attempt claimed before jumps its delta sequence and starts /live empty; /live has no text while the run is queued",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const sent: RunDelta[] = [];
    const hub = w.sync.hub;
    const ephemeral = hub.ephemeral.bind(hub);
    hub.ephemeral = (log, event, data, audience) => {
      sent.push(data as RunDelta);
      ephemeral(log, event, data, audience);
    };
    const { run } = await w.ask(w.mona, w.open, "fixture:success");
    let store = w.rt.store;
    let request = store.claim(store.queued()[0]!)!;
    store.delta(request, "t0", "A1 ");
    store.delta(request, "t0", "A2 ");
    store.checkpoint(request);
    store.delta(request, "t0", "A3 ");
    // a new process resumes the attempt
    w.rt.store.close();
    store = new RecordRunStore({ sync: w.sync, db: w.db });
    t.teardown(() => store.close());
    t.is(store.interruptRunning(), 1);
    t.true(store.resume(store.interrupted()[0]!));
    t.is(store.live(run, "mona")?.live, null, "nothing streams while queued");
    request = store.claim(store.queued()[0]!)!;
    t.deepEqual(store.live(run, "mona")?.live, { n: 0, text: "", seq: 2 + RESUME_SEQ_GAP });
    store.delta(request, "t0", "B1 ");
    t.is(sent.at(-1)?.seq, 2 + RESUME_SEQ_GAP + 1, "past any delta the crashed one sent");
    // a 429 re-queue in this process, then its claim
    t.true(store.requeue(request));
    request = store.claim(store.queued()[0]!)!;
    const seq = 2 + 2 * RESUME_SEQ_GAP + 1;
    t.deepEqual(store.live(run, "mona")?.live, { n: 0, text: "", seq });
    t.like(
      w.db.$client.prepare("SELECT md, seq FROM run_live WHERE run_id = ?").get(run),
      { md: "", seq },
      "the checkpoint is the empty turn",
    );
    store.delta(request, "t0", "C1 ");
    t.like(sent.at(-1), { seq: seq + 1, text: "C1 " });
    t.is(store.live(run, "mona")?.live?.text, "C1 ");
  },
);

test.serial(
  "T4: in-flight text stays off the change log: a checkpoint adds no log row and no record holds its text",
  async (t) => {
    const w = await runsWorld(t);
    const { run } = await w.ask(w.mona, w.open, "fixture:endless-answer");
    await waitFor(
      () =>
        (
          w.db.$client.prepare("SELECT length(md) AS n FROM run_live WHERE run_id = ?").get(run) as
            { n: number } | undefined
        )?.n !== undefined,
      "a checkpoint",
    );
    const head = w.sync.store.head();
    const firstCheckpoint = (
      w.db.$client.prepare("SELECT md FROM run_live WHERE run_id = ?").get(run) as { md: string }
    ).md;
    await waitFor(
      () =>
        (
          w.db.$client.prepare("SELECT md FROM run_live WHERE run_id = ?").get(run) as {
            md: string;
          }
        ).md.length > firstCheckpoint.length,
      "a later checkpoint",
    );
    t.is(w.sync.store.head(), head, "no commit while the step streams");
    t.is(
      (
        w.db.$client
          .prepare("SELECT count(*) AS n FROM records WHERE body LIKE ?")
          .get(`%${CHUNK.trim()}%`) as { n: number }
      ).n,
      0,
      "no record holds the streaming text",
    );
    await w.mona.ok("research.cancelNode", { thread: w.run(run).th, node: "r" });
    await w.settled(run);
  },
);

test.serial(
  "T3: /live is a plain read, limited per reader; a waiting account gets NOT_FOUND",
  async (t) => {
    // the bucket does not refill while the test reads
    const w = await runsWorld(t, { start: false, limiterNow: () => 1_000_000 });
    const { run } = await w.ask(w.mel, w.closed, "fixture:success");
    const apply = w.sync.server.serverApply.bind(w.sync.server);
    let applies = 0;
    w.sync.server.serverApply = ((...a: Parameters<typeof apply>) => {
      applies += 1;
      return apply(...a);
    }) as typeof apply;
    t.is((await live(w.mel, w, run)).status, 200);
    t.is(applies, 0, "no transaction for a read");
    // a member whose account is waiting again reads nothing
    w.db.$client.prepare("UPDATE users SET status = 'waiting' WHERE id = ?").run(w.mel.user.id);
    t.is((await live(w.mel, w, run)).status, 404);
    w.db.$client.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(w.mel.user.id);
    let last = 200;
    for (let k = 2; k < RUN_LIVE_READS.limit; k += 1) last = (await live(w.mel, w, run)).status;
    t.is(last, 200);
    const refused = await w.request(`/api/runs/${run}/live`, { cookie: w.mel.cookie });
    t.is(refused.status, 429);
    t.truthy(refused.headers.get("Retry-After"));
    // another reader has their own allowance
    t.is((await live(w.olga, w, run)).status, 200);
  },
);

test.serial(
  "T2: an ask hidden while its run streams keeps its answer hidden: redacted for a reader, whole for its author and the owner",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
    await waitFor(() => w.run(run).status === "running", "the claim");
    await w.olga.ok("moderation.decide", { item: `a:${thread}`, decision: "hidden" });
    t.is((await w.settled(run)).status, "complete");
    const answer = w.rec(`answer:${thread}`);
    t.like(answer, { kind: "answer", mod: "hidden" });
    const served = async (p: Person) =>
      (await p.snapshot(`space:${w.open}`)).records.find((r) => r.key === `answer:${thread}`)
        ?.record as { md: string } | undefined;
    t.is((await served(w.mel))?.md, "");
    const md = answer?.kind === "answer" ? answer.md : "";
    t.true(md.length > 0);
    t.is((await served(w.mona))?.md, md);
    t.is((await served(w.olga))?.md, md);
  },
);

/** The `run_live` rows, every run. */
const liveRows = (w: Awaited<ReturnType<typeof runsWorld>>) =>
  w.db.$client.prepare("SELECT run_id, attempt FROM run_live ORDER BY run_id, attempt").all();

/** A claim, a delta and a checkpoint of `run`'s current attempt, then the
 * process dies: the run is interrupted with its checkpoint in `run_live`. */
function crashedWithText(w: Awaited<ReturnType<typeof runsWorld>>): void {
  const request = w.rt.store.claim(w.rt.store.queued()[0]!);
  if (!request) throw new Error("no claim");
  w.rt.store.delta(request, "t0", "In-flight text. ");
  w.rt.store.checkpoint(request);
  w.rt.store.interruptRunning();
}

test.serial(
  "D4: the checkpoint of a run no process is streaming goes with its run record, its attempt and its claim refused",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    // removed while interrupted
    const removed = await w.ask(w.mona, w.open, "fixture:success");
    crashedWithText(w);
    t.is(liveRows(w).length, 1);
    await w.olga.ok("moderation.decide", { item: `a:${removed.thread}`, decision: "removed" });
    t.deepEqual(liveRows(w), [], "the run record went, and its checkpoint with it");

    // Run again on an interrupted attempt: the old attempt's checkpoint goes
    const retried = await w.ask(w.mona, w.open, "fixture:success");
    crashedWithText(w);
    await w.mona.ok("research.retryNode", {
      thread: retried.thread,
      node: "r",
      base: { attempt: 1 },
      ...MODEL,
    });
    t.deepEqual(liveRows(w), [], "no checkpoint of attempt 1 stays");
    await w.mona.ok("research.cancelNode", { thread: retried.thread, node: "r" });

    // a resume refused at its claim: the asker left the private channel
    const refused = await w.ask(w.mel, w.closed, "fixture:success");
    crashedWithText(w);
    t.like(w.rt.dispatcher.boot(), { resumed: 1 });
    await w.olga.ok("members.remove", {
      space: w.closed,
      user: "mel",
      base: { adm: (w.rec(`member:${w.closed}:mel`) as { adm: string }).adm },
    });
    t.is(w.rt.store.claim(w.rt.store.queued()[0]!), null);
    t.like(w.run(refused.run), { status: "failed", fail: { why: "access" } });
    t.deepEqual(liveRows(w), [], "the refused claim drops the attempt's checkpoint");
  },
);

test.serial(
  "D4: a re-queued run that ends at the payer re-check drops its checkpoint",
  async (t) => {
    const allowances = {
      weekly: () => 1_000,
      billing: () => "pause" as const,
      validKey: () => null,
      anthropicKey: () => null,
      openaiKey: () => null,
    };
    const clock = { at: Date.now() };
    const w = await runsWorld(t, {
      allowances,
      env: { SESSION_OVERDRAFT_TOKENS: "100000" },
      backoffMs: [60_000],
      now: () => clock.at,
    });
    const { run } = await w.ask(w.mona, w.open, "fixture:written-step-then-throttle");
    await waitFor(() => w.run(run).status === "queued" && w.rows(run).length >= 2, "the re-queue");
    t.is(liveRows(w).length, 1);
    // another run spends past the allowance plus overdraft during the
    // backoff, so the next claim finds nothing to pay, even for an attempt
    // that ran (`03` K10)
    const counts = { inputTokens: 200_000, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
    const id = w.ledger.open({
      runId: "another-run",
      attempt: 1,
      userId: w.mona.user.id,
      payer: "included",
      week: weekOf(clock.at),
      kind: "research",
      provider: "anthropic",
      model: "claude-fable",
      cachedInputRatio: 1,
      counts,
      openedAt: clock.at,
    });
    w.ledger.close(id, counts, "finish", clock.at);
    clock.at += 60_000;
    t.like(await w.settled(run), { status: "failed", fail: { why: "tokens" } });
    t.deepEqual(liveRows(w), []);
  },
);

test.serial("D4: boot deletes the checkpoints no run continues", async (t) => {
  const w = await runsWorld(t, { start: false });
  const { run } = await w.ask(w.mona, w.open, "fixture:success");
  crashedWithText(w);
  const tables = new RunTables(w.db);
  const row = { turnId: "", n: 0, md: "Orphaned text.", seq: 1, updatedAt: Date.now() };
  tables.putLive({ ...row, runId: newId(), attempt: 1 });
  tables.putLive({ ...row, runId: run, attempt: 7 });
  t.is(liveRows(w).length, 3);
  // the resume's write drops the other attempt's row; the sweep, the row of
  // the run that is gone
  t.like(w.rt.dispatcher.boot(), { resumed: 1, sweptLive: 1 });
  t.deepEqual(liveRows(w), [{ run_id: run, attempt: 1 }], "the resumed attempt keeps its own");
});

test.serial(
  "E1: the fence fails for a thread written removed, gone or deleted, whatever its run record says",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const { thread } = await w.ask(w.mona, w.open, "fixture:success");
    const request = w.rt.store.claim(w.rt.store.queued()[0]!);
    if (!request) return t.fail("no claim");
    t.true(w.rt.store.isCurrent(request));
    const write = (fields: Record<string, unknown>) =>
      w.sync.server.serverApply({ me: "", mutationId: "" }, (tx) => {
        const th = tx.byKey(`thread:${thread}`);
        if (th?.kind === "thread") tx.put({ ...th, ...fields });
      });
    for (const fields of [{ mod: "removed" }, { gone: true }, { del: true }]) {
      write(fields);
      t.false(w.rt.store.isCurrent(request), JSON.stringify(fields));
      write({ mod: null, gone: false, del: false });
      t.true(w.rt.store.isCurrent(request));
    }
  },
);
