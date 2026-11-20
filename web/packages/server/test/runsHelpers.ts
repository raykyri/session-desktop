// The run loop behind recorded provider streams, over an in-memory `RunStore`
// (`12-testing-linting-ci.md` §3.3). The store records every call, so a test
// asserts on what the loop wrote rather than on tables.

import type { Turn } from "@session/shared";
import type { ExecutionContext } from "ava";

import {
  FIXTURE_PAGE_URL,
  fixturePageResponse,
  setFixtureScenario,
} from "../src/runs/fixtureProvider.js";
import type { Providers } from "../src/runs/providers.js";
import type { AgentRunsService } from "../src/runs/service.js";
import { createRunsService } from "../src/runs/service.js";
import type { AttemptSummary, CompletedAnswer, RunRequest, RunStore } from "../src/runs/store.js";

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
  | { kind: "commitTurn"; runId: string; turn: Turn }
  | { kind: "checkpoint"; runId: string; turn: Turn }
  | { kind: "delta"; runId: string; turnId: string; text: string }
  | { kind: "thinking"; runId: string; active: boolean }
  | { kind: "finish"; runId: string; summary: AttemptSummary; answer?: CompletedAnswer };

export interface MemoryRunStore extends RunStore {
  readonly calls: StoreCall[];
  /** The current attempt of each run; a request whose attempt differs is
   * superseded. Absent: the request's own attempt is current. */
  readonly attempts: Map<string, number>;
  readonly cancelled: Set<string>;
  /** Turns an interrupted attempt committed, returned for a `resume`. */
  readonly committed: Map<string, Turn[]>;
  finishes(runId: string): Extract<StoreCall, { kind: "finish" }>[];
}

export function memoryRunStore(): MemoryRunStore {
  const calls: StoreCall[] = [];
  const attempts = new Map<string, number>();
  const cancelled = new Set<string>();
  const committed = new Map<string, Turn[]>();
  const summaries = new Map<string, string>();
  return {
    calls,
    attempts,
    cancelled,
    committed,
    finishes: (runId) =>
      calls.filter(
        (call): call is Extract<StoreCall, { kind: "finish" }> =>
          call.kind === "finish" && call.runId === runId,
      ),
    isCurrent: (request) => (attempts.get(request.runId) ?? request.attempt) === request.attempt,
    isCancelled: (request) => cancelled.has(request.runId),
    committedTurns: (request) => committed.get(request.runId) ?? [],
    markRunning: (request) => {
      calls.push({ kind: "markRunning", runId: request.runId });
    },
    commitTurn: (request, turn) => {
      calls.push({ kind: "commitTurn", runId: request.runId, turn });
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
    finish: (request, summary, answer) => {
      calls.push({
        kind: "finish",
        runId: request.runId,
        summary,
        ...(answer ? { answer } : {}),
      });
    },
    summaries: {
      read: (nodeId) => summaries.get(nodeId) ?? null,
      write: (nodeId, summary) => {
        summaries.set(nodeId, summary);
      },
    },
  };
}

export interface LoopHarness extends Harness {
  agent: AgentRunsService;
  store: MemoryRunStore;
  /** A first attempt of a new run by `userId`. `userText` may carry a
   * `fixture:<scenario>` marker to choose the recorded stream. */
  runRequest(userId: string, userText: string, overrides?: Partial<RunRequest>): RunRequest;
}

export interface LoopHarnessOptions extends HarnessOptions {
  network?: FakeNetwork;
  /** Replaces the registry-backed providers, for the tests that need a model
   * to be unresolvable. */
  providers?: Providers;
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
  const store = memoryRunStore();
  const agent = createRunsService({
    config: harness.config,
    db: harness.db,
    store,
    logger: harness.logger,
    fetch: network.fetch,
    ...(options.providers ? { providers: options.providers } : {}),
    toolOverrides: { lookup: publicLookup },
  });
  // Registered after the harness's own teardown and therefore run before it:
  // an attempt must not outlive the database its usage rows go to.
  t.teardown(async () => {
    setFixtureScenario(null);
    await agent.drain();
  });
  return {
    ...harness,
    agent,
    store,
    runRequest: (userId, userText, overrides = {}) => {
      runCounter += 1;
      return {
        runId: `run-${runCounter}`,
        userId,
        model: "gemini-flash",
        attempt: 1,
        kind: "fresh",
        instruction: null,
        userText,
        history: [],
        ...overrides,
      };
    },
  };
}
