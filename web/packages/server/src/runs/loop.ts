// One attempt of one run (`04-agent-runtime.md` §3,
// `05-run-lifecycle-and-streaming.md` §4, §5).
//
// Assemble the context, open the provider stream, map its parts into turns,
// hand each turn to the store as it completes, and record how the attempt
// ended. The module is provider-neutral: all required provider configuration
// is contained in `ResolvedModel`. Everything the attempt reads or writes
// goes through `RunStore` (`store.ts`), which M5a implements over the run
// records; this module has no table of its own.
//
// In-flight text is checkpointed at most once per second or every 4 KiB to
// limit what a server restart loses.

import type { SessionDatabase } from "@session/db";
import type { Turn } from "@session/shared";
import type { ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

import type { ClassifiedError } from "./errors.js";
import { classifyRunError, refusalError, timeoutError } from "./errors.js";
import {
  createGroundingRedirectResolver,
  resolveGroundingRedirects,
} from "./groundingRedirects.js";
import { TurnMapper } from "./mapper.js";
import { buildMessages, messagesFromCommittedTurns } from "./messages.js";
import type { MetadataRunner } from "./metadata.js";
import { researchSystemPrompt } from "./prompts.js";
import type { Providers } from "./providers.js";
import type { AttemptOutcome, RunRequest, RunStore } from "./store.js";
import type { RunToolContext, ToolCaches } from "./tools/context.js";
import { ToolBudget } from "./tools/context.js";
import { buildTools } from "./tools/index.js";
import { attemptUsageOf, costOf, recordAttemptUsage, recordToolUsage } from "./usage.js";

/** `04-agent-runtime.md` §3. */
export const MAX_STEPS = 25;

/** `05-run-lifecycle-and-streaming.md` §4, §5. */
export const DELTA_INTERVAL_MS = 50;
export const CHECKPOINT_INTERVAL_MS = 1_000;
export const CHECKPOINT_BYTES = 4 * 1024;

export const NO_ANSWER = "The run finished without an answer.";

export interface AttemptResult {
  /** `superseded`: a newer attempt of the run started while this one was
   * running; this attempt recorded its usage and wrote nothing else. */
  outcome: AttemptOutcome | "superseded";
  error?: ClassifiedError;
}

export interface LoopDeps {
  config: Config;
  /** For the usage rows only (`usage_events`). */
  db: SessionDatabase;
  store: RunStore;
  providers: Providers;
  metadata: MetadataRunner;
  logger: Logger;
  caches: ToolCaches;
  fetch: typeof globalThis.fetch;
  /** Test hooks for the SSRF guard's resolver and the loopback fixture host. */
  toolOverrides?: Pick<RunToolContext, "lookup" | "allowHosts">;
}

export interface RunAttemptInput {
  request: RunRequest;
  /** Aborted by cancel or drain, distinguished by `isDraining`. */
  signal: AbortSignal;
  /** Set by drain so the attempt ends as `interrupted` rather than cancelled. */
  isDraining: () => boolean;
}

/** True when the turns hold assistant text: an attempt that produced none
 * has no answer to store. */
export function hasAnswerText(turns: readonly Turn[]): boolean {
  return turns.some(
    (turn) =>
      turn.role !== "user" &&
      turn.blocks.some((block) => block.type === "text" && block.text.trim() !== ""),
  );
}

/**
 * Runs one attempt to its end and records how it ended.
 *
 * Returns rather than throws: the caller (the dispatcher, M5a) reads the
 * outcome to decide between settling the run and queueing it again after a
 * `rate_limited` attempt.
 */
export async function runAttempt(deps: LoopDeps, input: RunAttemptInput): Promise<AttemptResult> {
  const { db, store, logger } = deps;
  const { request } = input;
  const { runId, userId } = request;

  /**
   * Whether this attempt is still the run's current attempt. A retry or
   * rerun starts a newer attempt, and an attempt whose stream is still
   * terminating then writes nothing further: no turns, no outcome. The
   * store's check is synchronous, so a check followed by a write with no
   * `await` between them cannot interleave with the newer attempt's start.
   */
  const owned = (): boolean => store.isCurrent(request);

  if (!owned()) {
    return { outcome: "superseded" };
  }

  const budget = new ToolBudget();
  const toolUsage = { search: 0, fetch: 0 };
  let usage = attemptUsageOf(undefined);
  let steps = 0;

  const resolved = deps.providers.resolve(request.model, request.effort);
  if (!resolved) {
    const error: ClassifiedError = {
      errorClass: "auth",
      message: `${request.model} is not configured on this deployment`,
      detail: "missing credential",
    };
    logger.warn({ runId, errorClass: error.errorClass }, "run failed");
    store.finish(request, {
      outcome: "failed",
      error,
      steps: 0,
      toolCalls: 0,
      usage,
      costEstimateMicros: 0,
    });
    return { outcome: "failed", error };
  }

  const recordUsage = (): void => {
    recordAttemptUsage({
      db,
      userId,
      nodeId: runId,
      entry: resolved.entry,
      kind: "research",
      usage,
    });
    recordToolUsage(db, userId, runId, "search", "search", toolUsage.search);
    recordToolUsage(db, userId, runId, "fetch", "fetch", toolUsage.fetch);
  };

  /** Records usage, then the outcome unless a newer attempt took over. Usage
   * is recorded either way: the provider billed it. */
  const settle = (
    outcome: AttemptOutcome,
    error?: ClassifiedError,
    answer?: { turns: Turn[]; messages: ModelMessage[] },
  ): AttemptResult => {
    recordUsage();
    if (!owned()) {
      return { outcome: "superseded" };
    }
    if (outcome === "failed" && error) {
      logger.warn({ runId, errorClass: error.errorClass, detail: error.detail }, "run failed");
    }
    store.finish(
      request,
      {
        outcome,
        error,
        steps,
        toolCalls: budget.searches + budget.fetches,
        usage,
        costEstimateMicros: costOf(resolved.entry, usage),
      },
      answer,
    );
    return error ? { outcome, error } : { outcome };
  };

  store.markRunning(request);

  // ── request assembly ────────────────────────────────────────────────────
  const toolContext: RunToolContext = {
    config: deps.config,
    userId,
    runId,
    logger,
    fetch: deps.fetch,
    budget,
    caches: deps.caches,
    recordUsage: (kind, count) => {
      toolUsage[kind] += count;
    },
    ...(deps.toolOverrides?.lookup ? { lookup: deps.toolOverrides.lookup } : {}),
    ...(deps.toolOverrides?.allowHosts ? { allowHosts: deps.toolOverrides.allowHosts } : {}),
  };

  const system = researchSystemPrompt(request.instruction);
  // A resumed attempt replays the committed turns of the one it continues (`05` §7).
  const priorTurns: Turn[] = request.kind === "resume" ? [...store.committedTurns(request)] : [];
  const priorMessages: ModelMessage[] = messagesFromCommittedTurns(priorTurns);

  let messages: ModelMessage[];
  try {
    const built = await buildMessages({
      history: request.history,
      model: request.model,
      userText: request.userText,
      priorMessages,
      summarize: ({ text, signal }) => deps.metadata.summarize({ text, userId, signal }),
      summaries: store.summaries,
      signal: input.signal,
    });
    messages = built.messages;
    logger.debug(
      {
        runId,
        estimatedTokens: built.estimatedTokens,
        elided: built.elidedToolResults,
        summarized: built.summarizedThrough,
      },
      "assembled run context",
    );
  } catch (error) {
    if (input.signal.aborted && !input.isDraining()) {
      return settle("cancelled");
    }
    return settle("failed", classifyRunError(error));
  }

  const tools = buildTools(toolContext, input.signal, {
    nativeSearch: resolved.entry.nativeSearch,
    providerTools: resolved.providerTools,
  });

  // ── streaming ───────────────────────────────────────────────────────────
  let pendingDelta = "";
  let pendingTurnId = "";
  let lastDeltaAt = 0;
  let lastCheckpointAt = Date.now();
  let checkpointedLength = 0;

  const flushDelta = (force: boolean): void => {
    if (pendingDelta === "") {
      return;
    }
    const now = Date.now();
    if (!force && now - lastDeltaAt < DELTA_INTERVAL_MS) {
      return;
    }
    lastDeltaAt = now;
    if (owned()) {
      store.delta(request, pendingTurnId, pendingDelta);
    }
    pendingDelta = "";
  };

  const mapper = new TurnMapper(
    {
      runId,
      agentId: runId,
      startStep: priorTurns.length,
      startSourceIndex: priorTurns.length,
    },
    {
      onTextDelta: (turnId, text) => {
        if (turnId !== pendingTurnId) {
          flushDelta(true);
          pendingTurnId = turnId;
        }
        pendingDelta += text;
        flushDelta(false);
      },
      onThinking: (active) => {
        if (owned()) store.thinking(request, active);
      },
      onGroundedSearch: (queries) => {
        toolUsage.search += queries;
      },
      onTurnCommitted: (turn) => {
        flushDelta(true);
        if (!owned()) return;
        store.commitTurn(request, turn);
        checkpointedLength = 0;
        lastCheckpointAt = Date.now();
      },
    },
  );

  const groundingRedirects = createGroundingRedirectResolver({
    fetch: deps.fetch,
    logger,
    signal: input.signal,
  });

  const checkpoint = (): void => {
    const turn = mapper.inFlightTurn();
    if (!turn) {
      return;
    }
    const length = mapper.inFlightText.length;
    const now = Date.now();
    const stale = now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS;
    const grown = length - checkpointedLength >= CHECKPOINT_BYTES;
    if ((!stale && !grown) || !owned()) {
      return;
    }
    store.checkpoint(request, turn);
    lastCheckpointAt = now;
    checkpointedLength = length;
  };

  const timeoutMs = deps.config.limits.runTimeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout]);

  let streamError: unknown = null;
  let finishReason: string | undefined;
  let rawFinishReason: string | undefined;
  let responseMessages: ModelMessage[] = [];

  try {
    const result = streamText({
      model: resolved.model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
      providerOptions: resolved.providerOptions,
      // The dispatcher implements retry policy: a 429 queues the run again
      // with backoff and keeps its place in the admission order, which a
      // transport-level retry cannot do.
      maxRetries: 0,
      onError: ({ error }) => {
        streamError = error;
      },
    });

    for await (const part of result.fullStream) {
      if (part.type === "error") {
        streamError = part.error;
        break;
      }
      if (part.type === "abort") {
        break;
      }
      // Grounded citations arrive as Google redirect links; the mapper commits
      // the step with the resolved target URLs (`groundingRedirects.ts`).
      mapper.handle(await resolveGroundingRedirects(part, groundingRedirects));
      if (part.type === "text-delta") {
        checkpoint();
      }
      if (part.type === "finish-step") {
        steps += 1;
      }
      if (part.type === "finish") {
        finishReason = part.finishReason;
        rawFinishReason = part.rawFinishReason;
      }
    }
    if (streamError === null) {
      usage = attemptUsageOf(await result.totalUsage);
      responseMessages = await result.responseMessages;
    }
  } catch (error) {
    streamError = error;
  }

  flushDelta(true);
  mapper.finish();
  flushDelta(true);

  // ── outcome ─────────────────────────────────────────────────────────────
  const aborted = input.signal.aborted;
  const timedOut = timeout.aborted && !aborted;
  const draining = input.isDraining();
  const cancelled = store.isCancelled(request);

  // `mapper.finish()` above committed the partial step, so an interrupted
  // attempt keeps its text as a turn the resume replays.
  if (draining && !cancelled) {
    return settle("interrupted");
  }
  // Outside a drain, an aborted signal is a cancellation.
  if (cancelled || aborted) {
    return settle("cancelled");
  }

  if (streamError !== null || timedOut) {
    const classified = timedOut
      ? timeoutError(Math.round(timeoutMs / 1000))
      : classifyRunError(streamError);
    return settle(classified.errorClass === "rate_limited" ? "rate_limited" : "failed", classified);
  }

  if (finishReason === "content-filter") {
    return settle("failed", refusalError(rawFinishReason));
  }

  // ── completion ──────────────────────────────────────────────────────────
  const turns = [...priorTurns, ...mapper.committedTurns];
  if (!hasAnswerText(turns)) {
    return settle("failed", { errorClass: "unknown", message: NO_ANSWER, detail: "no answer" });
  }
  // The question comes first because a follow-up replays this exchange as
  // context, and providers such as Anthropic require alternating user and
  // assistant turns.
  const asked: ModelMessage = { role: "user", content: request.userText };
  return settle("complete", undefined, {
    turns,
    messages: [asked, ...priorMessages, ...responseMessages],
  });
}
