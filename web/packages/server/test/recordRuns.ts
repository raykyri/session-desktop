// Owned runs over the run records (`03-agents-and-research.md` E1-E5, K1,
// T1-T4): a whole server over a temp database, its sync core, the SQLite
// ledger and the run runtime (`runs/runtime.ts`) behind fixture providers,
// with olga's open #lounge (mona, mel) and private #lab (mel). Writes go
// through the sync routes as the client sends them; the dispatcher claims
// what they queue.

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { RunRec, StoredRecord, ThreadRec, TurnRec } from "@session/mutators";
import { estimateTokenCount } from "@session/shared";
import type { ExecutionContext } from "ava";

import { configAllowances, type Allowances } from "../src/runs/allowance.js";
import { registerFixture, setFixtureScenario } from "../src/runs/fixtureProvider.js";
import { createProviders } from "../src/runs/providers.js";
import type { RunsRuntime } from "../src/runs/runtime.js";
import { createRunsRuntime } from "../src/runs/runtime.js";
import { SqliteLedger } from "../src/runs/sqliteLedger.js";

import type { Harness, HarnessOptions } from "./helpers.js";
import { createHarness } from "./helpers.js";
import type { FakeNetwork, StreamedCall } from "./runsHelpers.js";
import { fakeNetwork, recordingProviders, until } from "./runsHelpers.js";
import type { Person } from "./syncHttp.js";
import { MODEL, channels, newId } from "./syncHttp.js";

export { MODEL, newId, until };

/** 40 ASCII characters: 10 tokens by `estimateTokenCount`. */
export const CHUNK = "Tokens are counted while the call runs. ";

/** A one-step answer of `parts` deltas, one every `delayMs`. Long enough that
 * a test stops it before it finishes. */
export function registerEndless(scenario: string, parts = 3_000, delayMs = 5): void {
  const deltas: LanguageModelV4StreamPart[] = Array.from({ length: parts }, () => ({
    type: "text-delta",
    id: "t0",
    delta: CHUNK,
  }));
  registerFixture({
    scenario,
    steps: [
      {
        delayMs,
        parts: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t0" },
          ...deltas,
          { type: "text-end", id: "t0" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: {
              inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: parts * 10, text: parts * 10, reasoning: 0 },
            },
          },
        ],
      },
    ],
  });
}

registerEndless("endless-answer");

// A tool call, then a long answer: a crash, a removal or a `/live` read in
// the second step finds the first step committed.
registerFixture({
  scenario: "fetch-then-endless",
  steps: [
    {
      parts: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "Reading the page." },
        { type: "text-end", id: "t0" },
        {
          type: "tool-call",
          toolCallId: "call-fetch-1",
          toolName: "web_fetch",
          input: '{"url":"https://example.com/bloom-filters"}',
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: {
            inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
        },
      ],
    },
    {
      delayMs: 5,
      parts: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        ...Array.from({ length: 3_000 }, () => ({
          type: "text-delta" as const,
          id: "t1",
          delta: CHUNK,
        })),
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: {
            inputTokens: { total: 1_400, noCache: 1_400, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 30_000, text: 30_000, reasoning: 0 },
          },
        },
      ],
    },
  ],
});

// A step that writes 4.8 KiB of text (a checkpoint by size) and calls a
// tool, then a 429.
registerFixture({
  scenario: "written-step-then-throttle",
  steps: [
    {
      parts: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: CHUNK.repeat(120) },
        { type: "text-end", id: "t0" },
        {
          type: "tool-call",
          toolCallId: "call-search-1",
          toolName: "web_search",
          input: '{"query":"bloom filters"}',
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: {
            inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1_200, text: 1_200, reasoning: 0 },
          },
        },
      ],
    },
    { error: { kind: "api", statusCode: 429, message: "rate limit exceeded", isRetryable: true } },
  ],
});

/** One `usage_events` row of the ledger, as stored. */
export interface LedgerRow {
  id: string;
  attempt: number;
  kind: string;
  state: "open" | "closed";
  ending: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  counted: number;
  payer: string;
  updated_at: number;
}

export interface RunsWorld extends Harness {
  rt: RunsRuntime;
  ledger: SqliteLedger;
  /** The labels `session_run_failures_total` was counted with. */
  failures: string[];
  /** Every stream the providers handed to the meter. */
  streamed: StreamedCall[];
  /** The requests the tools made. */
  network: FakeNetwork;
  olga: Person;
  mona: Person;
  mel: Person;
  open: string;
  closed: string;
  /** A record as stored. */
  rec<R extends StoredRecord = StoredRecord>(key: string): R | undefined;
  run(id: string): RunRec;
  thread(id: string): ThreadRec;
  /** The committed turns of a run's attempt, by number. */
  turns(run: string, attempt?: number): TurnRec[];
  /** The ledger rows of a run. */
  rows(run: string): LedgerRow[];
  /** `p` asks in `space`; resolves with the thread and its run. */
  ask(p: Person, space: string, q: string): Promise<{ thread: string; run: string }>;
  /** `p` asks under `parent` in `thread` (Continue, Branch, Branch here). */
  fork(
    p: Person,
    thread: string,
    parent: string,
    q: string,
    extra?: { quote?: string; b?: number },
  ): Promise<{ node: string; run: string }>;
  /** Resolves when the run reaches one of `statuses` (any ended status by
   * default) and no attempt is running here. */
  settled(run: string, statuses?: RunRec["status"][]): Promise<RunRec>;
}

export interface RunsWorldOptions extends HarnessOptions {
  ledgerCheckpointMs?: number;
  allowances?: Allowances;
  backoffMs?: readonly number[];
  /** Start the dispatcher (default true). */
  start?: boolean;
}

const ENDED: RunRec["status"][] = ["complete", "failed", "cancelled", "interrupted"];

export async function runsWorld(
  t: ExecutionContext,
  options: RunsWorldOptions = {},
): Promise<RunsWorld> {
  const network = fakeNetwork();
  let rt: RunsRuntime | null = null;
  const h = createHarness(t, {
    ...options,
    fetch: network.fetch,
    deps: { ...options.deps, runLive: (id, u) => rt?.store.live(id, u) ?? null },
  });
  const ledger = new SqliteLedger(h.db);
  const failures: string[] = [];
  const providers = recordingProviders(createProviders(h.config));
  const runtime = createRunsRuntime({
    config: h.config,
    db: h.db,
    sync: h.sync,
    ledger,
    allowances: options.allowances ?? configAllowances(h.config),
    logger: h.logger,
    fetch: network.fetch,
    providers,
    pollMs: 20,
    onFailure: (cls) => failures.push(cls),
    ...(options.ledgerCheckpointMs === undefined
      ? {}
      : { ledgerCheckpointMs: options.ledgerCheckpointMs }),
    ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
    toolOverrides: {
      lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
    },
  });
  rt = runtime;
  t.teardown(async () => {
    setFixtureScenario(null);
    await runtime.close();
  });
  const { olga, mona, mel, open, closed } = await channels(h);
  if (options.start !== false) runtime.dispatcher.start();
  const rec = <R extends StoredRecord = StoredRecord>(key: string) =>
    h.sync.store.byKey(key) as R | undefined;
  const world: RunsWorld = {
    ...h,
    rt: runtime,
    ledger,
    failures,
    streamed: providers.streamed,
    network,
    olga,
    mona,
    mel,
    open,
    closed,
    rec,
    run: (id) => {
      const r = rec<RunRec>(`run:${id}`);
      if (r?.kind !== "run") throw new Error(`no run ${id}`);
      return r;
    },
    thread: (id) => {
      const r = rec<ThreadRec>(`thread:${id}`);
      if (r?.kind !== "thread") throw new Error(`no thread ${id}`);
      return r;
    },
    turns: (run, attempt) => {
      const r = rec<RunRec>(`run:${run}`);
      const th = r?.th ?? "";
      return h.sync.store.sqlite
        .prepare<[string], { body: string }>(
          "SELECT body FROM records WHERE kind = 'turn' AND th = ? ORDER BY key",
        )
        .all(th)
        .map((x) => JSON.parse(x.body) as TurnRec)
        .filter((x) => x.run === run && x.attempt === (attempt ?? r?.attempt))
        .sort((a, b) => a.n - b.n);
    },
    rows: (run) =>
      h.db.$client
        .prepare<[string], LedgerRow>(
          "SELECT * FROM usage_events WHERE run_id = ? ORDER BY created_at, rowid",
        )
        .all(run),
    ask: async (p, space, q) => {
      const thread = newId();
      const r = (await p.ok("threads.create", { id: thread, space, kind: "ask", q, ...MODEL })) as {
        run: string;
      };
      return { thread, run: r.run };
    },
    fork: async (p, thread, parent, q, extra = {}) => {
      const node = newId();
      const r = (await p.ok("research.forkNode", {
        id: node,
        thread,
        parent,
        kind: "ask",
        q,
        ...extra,
        ...MODEL,
      })) as { run: string };
      return { node, run: r.run };
    },
    settled: async (run, statuses = ENDED) => {
      await waitFor(() => statuses.includes(world.run(run).status), `run ${run} settled`);
      await runtime.dispatcher.idle();
      return world.run(run);
    },
  };
  return world;
}

/** Resolves once `ready()` is true, polling every 10 ms for up to `ms`. */
export async function waitFor(ready: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The output the meter estimates from what a call streamed. */
export function streamedOutput(call: StreamedCall | undefined): number {
  return call === undefined || call.output === "" ? 0 : estimateTokenCount(call.output);
}

/** The text of a turn's text blocks. */
export function turnText(turn: TurnRec): string {
  return turn.blocks
    .flatMap((b) => {
      const text = (b as { text?: unknown }).text;
      return b["type"] === "text" && typeof text === "string" ? [text] : [];
    })
    .join("");
}
