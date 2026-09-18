// A whole server with the real agent loop behind recorded provider streams
// (`12-testing-linting-ci.md` §3.3).

import type { SessionEvent } from "@session/shared";
import type { ExecutionContext } from "ava";

import type { ServerDeps } from "../src/deps.js";
import { setFixtureScenario } from "../src/runs/fixtureProvider.js";
import type { AgentRunsService } from "../src/runs/service.js";
import { createRunsService } from "../src/runs/service.js";

import type { Harness, HarnessOptions } from "./helpers.js";
import { createHarness } from "./helpers.js";

export interface AgentHarness extends Harness {
  agent: AgentRunsService;
  /** Runs one claim round and waits for everything it started. */
  settle(): Promise<void>;
}

/** The pages and vendor responses the tools see. Every request the fixtures
 * provoke is answered here, so no test touches the network. */
export interface FakeNetwork {
  fetch: typeof globalThis.fetch;
  calls: { url: string; method: string }[];
}

export const FIXTURE_PAGE_URL = "https://example.com/bloom-filters";

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
      return Promise.resolve(
        new Response(
          "<html><head><title>Bloom filters explained</title></head><body><article>" +
            "<p>A Bloom filter answers set membership with a tunable false-positive rate.</p>" +
            "<p>It never reports a false negative, which is what makes it useful as a pre-filter.</p>" +
            "</article></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetch: fetchImpl, calls };
}

export interface AgentHarnessOptions extends HarnessOptions {
  network?: FakeNetwork;
  /** Hosts the SSRF guard lets through without a resolver. */
  allowHosts?: string[];
}

/** Every public name resolves to one public address; no DNS in tests. */
const publicLookup = (): Promise<{ address: string; family: number }[]> =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

export function createAgentHarness(
  t: ExecutionContext,
  options: AgentHarnessOptions = {},
): AgentHarness {
  const network = options.network ?? fakeNetwork();
  let agent: AgentRunsService | undefined;
  const harness = createHarness(t, {
    ...options,
    fetch: network.fetch,
    createRuns: (deps: Omit<ServerDeps, "runs">) => {
      agent = createRunsService({
        config: deps.config,
        db: deps.db,
        eventBus: deps.eventBus,
        ...(deps.logger ? { logger: deps.logger } : {}),
        fetch: network.fetch,
        toolOverrides: {
          lookup: publicLookup,
          ...(options.allowHosts ? { allowHosts: options.allowHosts } : {}),
        },
        // The tests call `settle()`; a background interval would race them.
        autoStart: false,
      });
      return agent;
    },
  });
  if (!agent) {
    throw new Error("the agent service was not constructed");
  }
  const service = agent;
  // Registered after the harness's own teardown and therefore run before it:
  // a claim round must not outlive the database it reads.
  t.teardown(async () => {
    setFixtureScenario(null);
    await service.drain();
  });

  return {
    ...harness,
    agent: service,
    async settle() {
      await service.tick();
      await service.idle();
    },
  };
}

/**
 * A second agent service over the same database — what the next process builds
 * after a deploy. The one the harness made is finished once it has drained.
 */
export function nextProcessAgent(harness: AgentHarness): AgentHarness {
  const network = fakeNetwork();
  const service = createRunsService({
    config: harness.config,
    db: harness.db,
    eventBus: harness.eventBus,
    logger: harness.logger,
    fetch: network.fetch,
    toolOverrides: { lookup: publicLookup },
    autoStart: false,
  });
  return {
    ...harness,
    agent: service,
    async settle() {
      await service.tick();
      await service.idle();
    },
  };
}

/** Subscribes before the run starts and declares interest in `nodeIds`, which
 * is what `research.turn.*` delivery requires (`03-api-and-events.md` §3). */
export function collectEvents(
  t: ExecutionContext,
  harness: Harness,
  userId: string,
  nodeIds: readonly string[],
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const connectionId = `test-${Math.random().toString(36).slice(2)}`;
  const subscription = harness.eventBus.subscribe(userId, connectionId);
  harness.eventBus.setInterest(userId, connectionId, nodeIds);
  void (async () => {
    for await (const event of subscription.events) {
      events.push(event);
    }
  })();
  t.teardown(() => subscription.close());
  return events;
}
