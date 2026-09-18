// A language model that replays a recorded provider stream
// (`04-agent-runtime.md` §12, `12-testing-linting-ci.md` §3.3).
//
// The loop, the mapper, the tools, and the persistence rules are what Phase 4
// has to get right, and none of them needs a real provider to be exercised —
// only a source of `LanguageModelV4` stream parts in the shapes the real ones
// produce. The fixtures in `fixtures/*.json` are those shapes, one file per
// scenario, so a test names a scenario rather than hand-building a stream.
//
// It implements `LanguageModelV4` because that is the specification version
// every installed provider package reports (`@ai-sdk/anthropic`,
// `@ai-sdk/google-vertex`, `@openrouter/ai-sdk-provider` all say `v4`), and
// `ai@7` accepts V2, V3, and V4 models alike.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APICallError } from "@ai-sdk/provider";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/** The scenarios shipped in `fixtures/`. A test names one of these. */
export type FixtureScenario =
  | "success"
  | "success-with-tools"
  | "provider-tools"
  | "grounded"
  | "refusal"
  | "rate-limit"
  | "context-too-long"
  | "mid-stream-error"
  | "abort"
  | "timeout"
  | "slow-stream"
  /** `slow-stream` stretched to the seconds an end-to-end reload needs
   * (`12-testing-linting-ci.md` §3.6); the unit pacer's timing is asserted to
   * the millisecond and cannot be slowed. The name is all letters and dashes
   * because `PROMPT_MARKER` is how a run selects it. */
  | "paced-answer"
  /** An answer past `MIN_RECAP_CHARS`, so a run schedules a recap. */
  | "long-answer";

export const DEFAULT_FIXTURE_SCENARIO: FixtureScenario = "success-with-tools";

interface FixtureError {
  kind: "api" | "plain";
  statusCode?: number;
  message: string;
  isRetryable?: boolean;
}

interface FixtureStep {
  parts?: LanguageModelV4StreamPart[];
  /** Rejected before the first chunk, the way a 4xx arrives. */
  error?: FixtureError;
  /** Paced delivery, for the abort and coalescing tests. */
  delayMs?: number;
}

interface FixtureFile {
  scenario: string;
  description?: string;
  steps: FixtureStep[];
}

const FIXTURE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const cache = new Map<string, FixtureFile>();

export function loadFixture(scenario: string): FixtureFile {
  const cached = cache.get(scenario);
  if (cached) {
    return cached;
  }
  const raw = readFileSync(join(FIXTURE_DIRECTORY, `${scenario}.json`), "utf8");
  const parsed = JSON.parse(raw) as FixtureFile;
  cache.set(scenario, parsed);
  return parsed;
}

/** Every scenario on disk, for the test that asserts the set is complete. */
export function listFixtureScenarios(): string[] {
  return readdirSync(FIXTURE_DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/**
 * Which scenario the next request replays.
 *
 * A function rather than a string so one test can drive a sequence — the
 * rate-limit test wants a 429 on the first attempt and an answer on the
 * re-queued one — and a module-level variable rather than a constructor
 * argument because the loop constructs its own model and the test only holds
 * the server.
 */
export type FixtureSelector = (options: LanguageModelV4CallOptions, modelId: string) => string;

let selector: FixtureSelector | null = null;

export function setFixtureScenario(next: FixtureScenario | FixtureSelector | null): void {
  selector = next === null ? null : typeof next === "function" ? next : () => next;
}

/** A one-shot scenario: replayed once, then the default returns. */
export function setFixtureScenarioOnce(scenario: FixtureScenario): void {
  let spent = false;
  setFixtureScenario(() => {
    if (spent) {
      return DEFAULT_FIXTURE_SCENARIO;
    }
    spent = true;
    return scenario;
  });
}

const PROMPT_MARKER = /fixture:([a-z-]+)/;

/** The text of the request's messages, where a `fixture:<scenario>` marker in
 * a prompt is read from. This is what makes a manual run against
 * `SESSION_FIXTURE_PROVIDERS=1` able to choose a scenario by typing it. */
function promptText(options: LanguageModelV4CallOptions): string {
  const parts: string[] = [];
  for (const message of options.prompt) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

function scenarioFor(options: LanguageModelV4CallOptions, modelId: string): string {
  if (selector) {
    return selector(options, modelId);
  }
  const marker = PROMPT_MARKER.exec(promptText(options));
  return marker?.[1] ?? DEFAULT_FIXTURE_SCENARIO;
}

const EMPTY_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function fixtureErrorOf(error: FixtureError): Error {
  if (error.kind === "plain") {
    return new Error(error.message);
  }
  return new APICallError({
    message: error.message,
    url: "https://fixture.invalid/v1/messages",
    requestBodyValues: {},
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    isRetryable: error.isRetryable ?? false,
  });
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The JSON a metadata run's `Output.object` schema asks for. Keyed by the
 * schema's single property so `{title}`, `{recap}`, and `{page}` are told
 * apart without the caller passing a scenario (`04-agent-runtime.md` §9). */
function metadataOutput(options: LanguageModelV4CallOptions): string | null {
  const format = options.responseFormat;
  if (format?.type !== "json" || !format.schema) {
    return null;
  }
  const properties = (format.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const text = promptText(options);
  if ("title" in properties) {
    const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "Research";
    return JSON.stringify({ title: firstLine.trim().slice(0, 60) });
  }
  if ("recap" in properties) {
    return JSON.stringify({
      recap:
        "The answer defines the structure, gives its space and error trade-off, and names the " +
        "cases where it is the wrong choice.",
    });
  }
  if ("page" in properties) {
    return JSON.stringify({
      page:
        "# Bloom filter\n\nA space-efficient probabilistic set, introduced by " +
        "[[Burton Howard Bloom]] and used in [[LSM tree]] storage engines to skip " +
        "lookups that cannot hit.",
    });
  }
  return null;
}

export interface FixtureModelOptions {
  provider?: string;
  modelId?: string;
}

/**
 * One model instance replaying one scenario. The step cursor is per instance,
 * and the loop constructs a model per attempt, so a multi-step scenario
 * advances exactly once per provider round trip.
 */
export class FixtureLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  /** Every `doStream`/`doGenerate` call, for the tests that assert on what the
   * loop sent: the system prompt, the message history, the tool set, and the
   * provider options. */
  readonly calls: LanguageModelV4CallOptions[] = [];

  #step = 0;

  constructor(options: FixtureModelOptions = {}) {
    this.provider = options.provider ?? "fixture";
    this.modelId = options.modelId ?? "fixture-model";
  }

  #nextStep(options: LanguageModelV4CallOptions): FixtureStep {
    const fixture = loadFixture(scenarioFor(options, this.modelId));
    const step = fixture.steps[Math.min(this.#step, fixture.steps.length - 1)];
    this.#step += 1;
    return step ?? { parts: [] };
  }

  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4GenerateResult> {
    this.calls.push(options);
    const metadata = metadataOutput(options);
    if (metadata !== null) {
      return Promise.resolve({
        content: [{ type: "text", text: metadata }] satisfies LanguageModelV4Content[],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 400, noCache: 400, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 50, text: 50, reasoning: 0 },
        },
        warnings: [],
      });
    }
    const step = this.#nextStep(options);
    if (step.error) {
      return Promise.reject(fixtureErrorOf(step.error));
    }
    const content: LanguageModelV4Content[] = [];
    let usage = EMPTY_USAGE;
    let finishReason: LanguageModelV4GenerateResult["finishReason"] = {
      unified: "stop",
      raw: "stop",
    };
    let text = "";
    for (const part of step.parts ?? []) {
      if (part.type === "text-delta") {
        text += part.delta;
      } else if (part.type === "tool-call") {
        content.push(part);
      } else if (part.type === "finish") {
        usage = part.usage;
        finishReason = part.finishReason;
      }
    }
    if (text !== "") {
      content.unshift({ type: "text", text });
    }
    return Promise.resolve({ content, finishReason, usage, warnings: [] });
  }

  doStream(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4StreamResult> {
    this.calls.push(options);
    const step = this.#nextStep(options);
    if (step.error) {
      return Promise.reject(fixtureErrorOf(step.error));
    }
    const parts = step.parts ?? [];
    const pace = step.delayMs ?? 0;
    const signal = options.abortSignal;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        try {
          for (const part of parts) {
            if (signal?.aborted) {
              break;
            }
            await delay(pace, signal);
            controller.enqueue(part);
          }
        } catch {
          // An abort during the pacing delay: end the stream where it stopped,
          // which is what a cancelled HTTP response looks like downstream.
        }
        controller.close();
      },
    });
    return Promise.resolve({ stream });
  }
}

/* -------------------------------------------------------------------------
 * The network the fixture tools see
 *
 * `success-with-tools` has the model call `web_fetch`, and everything the tool
 * does around the request — the per-run budget, the page cache, the address
 * policy, Readability, the usage record — is worth exercising under
 * `SESSION_FIXTURE_PROVIDERS`. Reaching the host named in the fixture is not:
 * it makes an end-to-end run depend on a network CI may not have and on a page
 * nobody here controls, and it was an outbound request per run. So the fixture
 * answers the request in process. The URL the model asked for still goes
 * through `tools/ssrf.ts` in full; only the DNS record and the response body
 * come from here.
 * ---------------------------------------------------------------------- */

/** The page `success-with-tools` fetches. */
export const FIXTURE_PAGE_URL = "https://example.com/bloom-filters";

export const FIXTURE_PAGE_HTML =
  "<html><head><title>Bloom filters explained</title></head><body><article>" +
  "<p>A Bloom filter answers set membership with a tunable false-positive rate.</p>" +
  "<p>It never reports a false negative, which is what makes it useful as a pre-filter.</p>" +
  "</article></body></html>";

export function fixturePageResponse(): Response {
  return new Response(FIXTURE_PAGE_HTML, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Every name resolves to one public address, so the guard in `tools/ssrf.ts`
 * runs its whole policy without a DNS query leaving the machine.
 */
export const fixtureLookup = (): Promise<{ address: string; family: number }[]> =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

/**
 * What `RunToolContext.fetch` is under fixture providers: the fixture page for
 * the URL the fixtures name, and a 404 for anything else — a scenario that
 * reaches for a page nobody recorded should read as a dead link rather than
 * silently succeed.
 */
export const fixturePageFetch: typeof globalThis.fetch = (input) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(FIXTURE_PAGE_URL)) {
    return Promise.resolve(fixturePageResponse());
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
};
