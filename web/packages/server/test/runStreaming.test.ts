// Streaming over the sync connection (`03-agents-and-research.md` T2-T4):
// deltas are ephemeral events sent only to readers who may read the run's
// text at send time; `GET /api/runs/:id/live` answers the attempt's
// committed turns and the turn still streaming under the same scope; and
// in-flight text adds no change-log rows.

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import test from "ava";

import { registerFixture } from "../src/runs/fixtureProvider.js";
import type { RunDelta, RunLive } from "../src/runs/recordStore.js";

import { runsWorld, waitFor } from "./recordRuns.js";
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
