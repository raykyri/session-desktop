// The run loop behind recorded provider streams, over an in-memory `RunStore`
// and an in-memory ledger (`12-testing-linting-ci.md` §3.3). The store
// records every call and keeps run records with their status, so a test
// asserts on what the loop and the dispatcher wrote rather than on tables.

import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { Turn } from "@session/shared";
import type { ExecutionContext } from "ava";

import type { Allowances } from "../src/runs/allowance.js";
import { configAllowances } from "../src/runs/allowance.js";
import {
  FIXTURE_PAGE_URL,
  fixturePageResponse,
  setFixtureScenario,
} from "../src/runs/fixtureProvider.js";
import type { Payer } from "../src/runs/ledger.js";
import { MemoryLedger } from "../src/runs/memoryLedger.js";
import type { Providers } from "../src/runs/providers.js";
import { createProviders } from "../src/runs/providers.js";
import type { AgentRunsService } from "../src/runs/service.js";
import { createRunsService } from "../src/runs/service.js";
import type {
  AttemptSummary,
  CompletedAnswer,
  InterruptedRun,
  QueuedRun,
  RunRequest,
  RunStep,
  RunStore,
} from "../src/runs/store.js";

import type { Harness, HarnessOptions } from "./helpers.js";
import { createHarness } from "./helpers.js";

/** The pages and vendor responses the tools see. Every request the fixtures
 * provoke is answered here, so no test touches the network. */
export interface FakeNetwork {
  fetch: typeof globalThis.fetch;
  calls: { url: string; method: string }[];
}

export function fakeNetwork(overrides: Record<string, () => Response> = {}): FakeNetwork {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    const override = overrides[url];
    if (override) {
      return Promise.resolve(override());
    }
    if (url.startsWith("https://api.parallel.ai/")) {
      return Promise.resolve(
        Response.json({
          results: [
            {
              url: FIXTURE_PAGE_URL,
              title: "Bloom filters explained",
              excerpts: ["A Bloom filter is a probabilistic set."],
              published_date: "2024-01-02",
            },
            {
              url: "https://example.org/hashing",
              title: "Hashing",
              excerpts: ["Hash functions map keys to buckets."],
            },
          ],
        }),
      );
    }
    if (url.startsWith(FIXTURE_PAGE_URL)) {
      return Promise.resolve(fixturePageResponse());
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetch: fetchImpl, calls };
}

/** One call the loop made on the store, in order. */
export type StoreCall =
  | { kind: "markRunning"; runId: string }
  | { kind: "step"; runId: string; step: RunStep }
  | { kind: "commitTurn"; runId: string; turn: Turn }
  | { kind: "checkpoint"; runId: string; turn: Turn }
  | { kind: "delta"; runId: string; turnId: string; text: string }
  | { kind: "thinking"; runId: string; active: boolean }
  | { kind: "title"; runId: string; text: string }
  | { kind: "summary"; runId: string; text: string }
  | { kind: "finish"; runId: string; summary: AttemptSummary; answer?: CompletedAnswer };

export type RunStatus = "queued" | "running" | "complete" | "failed" | "cancelled" | "interrupted";

/** A `run` record and what the store keeps of it. */
export interface MemoryRun {
  runId: string;
  attempt: number;
  userId: string;
  model: string;
  effort: string;
  payer: Payer;
  node: "ask" | "lookup";
  userText: string;
  finalSteps?: RunRequest["finalSteps"];
  status: RunStatus;
  queuedAt: number;
  resumes: number;
  /** The thread or node was removed: the fence fails (`03` E1). */
  removed: boolean;
  /** Turns committed per attempt. */
  turns: Map<number, Turn[]>;
  /** Successful compare-and-sets `queued` → `running`. */
  claims: number;
  last?: AttemptSummary;
}

export interface MemoryRunStore extends RunStore {
  readonly calls: StoreCall[];
  /** The current attempt of each run without a record; a request whose
   * attempt differs is superseded. Absent: the request's own attempt is
   * current. */
  readonly attempts: Map<string, number>;
  readonly cancelled: Set<string>;
  /** Turns an interrupted attempt committed, returned for a `resume`, for
   * runs without a record. */
  readonly committed: Map<string, Turn[]>;
  /** Run records, for the dispatcher tests. */
  readonly runs: Map<string, MemoryRun>;
  /** Writes a `queued` run record. */
  enqueue(run: Partial<MemoryRun> & Pick<MemoryRun, "runId" | "userId" | "userText">): MemoryRun;
  finishes(runId: string): Extract<StoreCall, { kind: "finish" }>[];
}

export function memoryRunStore(): MemoryRunStore {
  const calls: StoreCall[] = [];
  const attempts = new Map<string, number>();
  const cancelled = new Set<string>();
  const committed = new Map<string, Turn[]>();
  const summaries = new Map<string, string>();
  const runs = new Map<string, MemoryRun>();
  let clock = 0;

  const recordOf = (request: Pick<RunRequest, "runId" | "attempt">): MemoryRun | null => {
    const run = runs.get(request.runId);
    return run && run.attempt === request.attempt ? run : null;
  };

  const requestOf = (run: MemoryRun): RunRequest => ({
    runId: run.runId,
    userId: run.userId,
    model: run.model,
    effort: run.effort,
    attempt: run.attempt,
    kind: (run.turns.get(run.attempt)?.length ?? 0) > 0 ? "resume" : "fresh",
    node: run.node,
    payer: run.payer,
    instruction: null,
    userText: run.userText,
    history: [],
    finalSteps: run.finalSteps,
  });

  return {
    calls,
    attempts,
    cancelled,
    committed,
    runs,
    enqueue(partial) {
      clock += 1;
      const run: MemoryRun = {
        attempt: 1,
        model: "gemini-flash",
        effort: "medium",
        payer: "included",
        node: "ask",
        status: "queued",
        queuedAt: clock,
        resumes: 0,
        removed: false,
        turns: new Map(),
        claims: 0,
        ...partial,
      };
      runs.set(run.runId, run);
      return run;
    },
    finishes: (runId) =>
      calls.filter(
        (call): call is Extract<StoreCall, { kind: "finish" }> =>
          call.kind === "finish" && call.runId === runId,
      ),
    isCurrent: (request) => {
      const run = runs.get(request.runId);
      if (run) {
        return run.attempt === request.attempt && !run.removed;
      }
      return (attempts.get(request.runId) ?? request.attempt) === request.attempt;
    },
    isCancelled: (request) => cancelled.has(request.runId),
    committedTurns: (request) =>
      recordOf(request)?.turns.get(request.attempt) ?? committed.get(request.runId) ?? [],
    markRunning: (request) => {
      calls.push({ kind: "markRunning", runId: request.runId });
    },
    step: (request, step) => {
      calls.push({ kind: "step", runId: request.runId, step });
    },
    commitTurn: (request, turn) => {
      calls.push({ kind: "commitTurn", runId: request.runId, turn });
      const run = recordOf(request);
      if (run) {
        run.turns.set(request.attempt, [...(run.turns.get(request.attempt) ?? []), turn]);
      }
    },
    checkpoint: (request, turn) => {
      calls.push({ kind: "checkpoint", runId: request.runId, turn });
    },
    delta: (request, turnId, text) => {
      calls.push({ kind: "delta", runId: request.runId, turnId, text });
    },
    thinking: (request, active) => {
      calls.push({ kind: "thinking", runId: request.runId, active });
    },
    writeTitle: (request, text) => {
      calls.push({ kind: "title", runId: request.runId, text });
    },
    writeSummary: (request, text) => {
      calls.push({ kind: "summary", runId: request.runId, text });
    },
    finish: (request, summary, answer) => {
      calls.push({
        kind: "finish",
        runId: request.runId,
        summary,
        ...(answer ? { answer } : {}),
      });
      const run = recordOf(request);
      if (run) {
        run.status = summary.outcome;
        run.last = summary;
      }
    },
    summaries: {
      read: (nodeId) => summaries.get(nodeId) ?? null,
      write: (nodeId, summary) => {
        summaries.set(nodeId, summary);
      },
    },

    queued: (): QueuedRun[] =>
      [...runs.values()]
        .filter((run) => run.status === "queued")
        .sort((a, b) => a.queuedAt - b.queuedAt)
        .map((run) => ({
          runId: run.runId,
          attempt: run.attempt,
          userId: run.userId,
          model: run.model,
          effort: run.effort,
          payer: run.payer,
          queuedAt: run.queuedAt,
        })),
    claim: (queued) => {
      const run = runs.get(queued.runId);
      if (!run || run.status !== "queued" || run.attempt !== queued.attempt) {
        return null;
      }
      run.status = "running";
      run.claims += 1;
      return requestOf(run);
    },
    settleQueued: (queued, summary) => {
      const run = runs.get(queued.runId);
      if (!run || run.status !== "queued" || run.attempt !== queued.attempt) {
        return false;
      }
      run.status = summary.outcome;
      run.last = summary;
      calls.push({ kind: "finish", runId: run.runId, summary });
      return true;
    },
    requeue: (request) => {
      const run = recordOf(request);
      if (!run || run.status !== "running") {
        return false;
      }
      run.status = "queued";
      return true;
    },
    interruptRunning: () => {
      let count = 0;
      for (const run of runs.values()) {
        if (run.status === "running") {
          run.status = "interrupted";
          count += 1;
        }
      }
      return count;
    },
    interrupted: (): InterruptedRun[] =>
      [...runs.values()]
        .filter((run) => run.status === "interrupted")
        .map((run) => ({
          runId: run.runId,
          attempt: run.attempt,
          userId: run.userId,
          resumes: run.resumes,
        })),
    resume: (interrupted) => {
      const run = runs.get(interrupted.runId);
      if (
        !run ||
        run.status !== "interrupted" ||
        run.attempt !== interrupted.attempt ||
        run.resumes !== interrupted.resumes
      ) {
        return false;
      }
      run.status = "queued";
      run.resumes += 1;
      return true;
    },
  };
}

/** One provider call as the fixture delivered it to the meter. */
export interface StreamedCall {
  modelId: string;
  /** Text, reasoning and tool input, in the order streamed: what the meter
   * estimates output from. */
  output: string;
  /** The provider's counts, when the call reached its `finish`. */
  finish: LanguageModelV4Usage | null;
}

/** The deployment's providers with every model recording the parts it
 * hands on, read as the consumer pulls them, so a test knows what each call
 * streamed before it was aborted. */
export function recordingProviders(base: Providers): Providers & { streamed: StreamedCall[] } {
  const streamed: StreamedCall[] = [];
  const record = (model: LanguageModelV4): LanguageModelV4 => ({
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => model.doGenerate(options),
    doStream: async (options) => {
      const result = await model.doStream(options);
      const call: StreamedCall = { modelId: model.modelId, output: "", finish: null };
      streamed.push(call);
      const reader = result.stream.getReader();
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          const part = next.value;
          if (
            part.type === "text-delta" ||
            part.type === "reasoning-delta" ||
            part.type === "tool-input-delta"
          ) {
            call.output += part.delta;
          } else if (part.type === "finish") {
            call.finish = part.usage;
          }
          controller.enqueue(part);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return { ...result, stream };
    },
  });
  return {
    streamed,
    fixtures: base.fixtures,
    resolve(modelId, effort, key) {
      const resolved = base.resolve(modelId, effort, key);
      return resolved ? { ...resolved, model: record(resolved.model) } : null;
    },
  };
}

export interface LoopHarness extends Harness {
  agent: AgentRunsService;
  store: MemoryRunStore;
  ledger: MemoryLedger;
  /** Every stream the providers handed to the meter. */
  streamed: StreamedCall[];
  /** A first attempt of a new run by `userId`. `userText` may carry a
   * `fixture:<scenario>` marker to choose the recorded stream. */
  runRequest(userId: string, userText: string, overrides?: Partial<RunRequest>): RunRequest;
}

export interface LoopHarnessOptions extends HarnessOptions {
  network?: FakeNetwork;
  /** Replaces the registry-backed providers, for the tests that need a model
   * to be unresolvable. */
  providers?: Providers;
  allowances?: Allowances;
  /** The ledger checkpoint interval; 2 s unless a test shortens it. */
  ledgerCheckpointMs?: number;
  ledger?: MemoryLedger;
  store?: MemoryRunStore;
}

/** Every public name resolves to one public address; no DNS in tests. */
const publicLookup = (): Promise<{ address: string; family: number }[]> =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

let runCounter = 0;

export function createLoopHarness(
  t: ExecutionContext,
  options: LoopHarnessOptions = {},
): LoopHarness {
  const network = options.network ?? fakeNetwork();
  const harness = createHarness(t, { ...options, fetch: network.fetch });
  const store = options.store ?? memoryRunStore();
  const ledger = options.ledger ?? new MemoryLedger();
  const providers = recordingProviders(options.providers ?? createProviders(harness.config));
  const agent = createRunsService({
    config: harness.config,
    db: harness.db,
    store,
    ledger,
    allowances: options.allowances ?? configAllowances(harness.config),
    ...(options.ledgerCheckpointMs === undefined
      ? {}
      : { ledgerCheckpointMs: options.ledgerCheckpointMs }),
    logger: harness.logger,
    fetch: network.fetch,
    providers,
    toolOverrides: { lookup: publicLookup },
  });
  // Registered after the harness's own teardown and therefore run before it:
  // an attempt must not outlive the database its tool usage rows go to.
  t.teardown(async () => {
    setFixtureScenario(null);
    await agent.drain();
  });
  return {
    ...harness,
    agent,
    store,
    ledger,
    streamed: providers.streamed,
    runRequest: (userId, userText, overrides = {}) => {
      runCounter += 1;
      return {
        runId: `run-${runCounter}`,
        userId,
        model: "gemini-flash",
        effort: "medium",
        attempt: 1,
        kind: "fresh",
        node: "ask",
        payer: "included",
        instruction: null,
        userText,
        history: [],
        ...overrides,
      };
    },
  };
}

/** Resolves once `ready()` is true, polling every 5 ms for up to 5 s. */
export async function until(ready: () => boolean, what = "condition"): Promise<void> {
  for (let tries = 0; tries < 1_000; tries += 1) {
    if (ready()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
