// One attempt of one run (`04-agent-runtime.md` §3,
// `05-run-lifecycle-and-streaming.md` §4, §5, `03-agents-and-research.md`
// E1-E5, K1, K9, L1, L2).
//
// Assemble the context, open the provider stream, map its parts into turns,
// hand each turn to the store as it completes, and record how the attempt
// ended. The module is provider-neutral: all required provider configuration
// is contained in `ResolvedModel`. Record writes go through `RunStore`
// (`store.ts`) behind the attempt fence; token usage goes to the ledger
// through the meter (`meter.ts`), one row per provider call, unfenced.
//
// In-flight text is checkpointed to the store at most once per second or
// every 4 KiB to limit what a server restart loses; the ledger checkpoints a
// call's output at most every `LEDGER_CHECKPOINT_MS`, and the overdraft limit
// and the run's token cap are checked at each ledger checkpoint and at each
// step boundary.

import type { SessionDatabase } from "@session/db";
import type { Turn } from "@session/shared";
import type { ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

import type { Allowances, StopReason } from "./allowance.js";
import { RunBudget, billLabel, stopNote } from "./allowance.js";
import type { ClassifiedError } from "./errors.js";
import { classifyRunError, refusalError, timeoutError } from "./errors.js";
import {
  createGroundingRedirectResolver,
  resolveGroundingRedirects,
} from "./groundingRedirects.js";
import type { CallEnding, Ledger, Payer } from "./ledger.js";
import { TurnMapper } from "./mapper.js";
import { buildMessages, messagesFromCommittedTurns } from "./messages.js";
import type { MetadataRunner, ModelWrap } from "./metadata.js";
import { AttemptMeter } from "./meter.js";
import { researchSystemPrompt } from "./prompts.js";
import type { Providers, ResolvedModel } from "./providers.js";
import type {
  AttemptOutcome,
  AttemptSummary,
  CompletedAnswer,
  RunFailure,
  RunRequest,
  RunStep,
  RunStore,
} from "./store.js";
import type { RunToolContext, ToolCaches } from "./tools/context.js";
import { MAX_FETCHES_PER_RUN, MAX_SEARCHES_PER_RUN, ToolBudget } from "./tools/context.js";
import { buildTools } from "./tools/index.js";
import { costOf, recordToolUsage } from "./usage.js";

/** `04-agent-runtime.md` §3. */
export const MAX_STEPS = 25;

/** `05-run-lifecycle-and-streaming.md` §4, §5. */
export const DELTA_INTERVAL_MS = 50;
export const CHECKPOINT_INTERVAL_MS = 1_000;
export const CHECKPOINT_BYTES = 4 * 1024;

export const NO_ANSWER = "The run finished without an answer.";

/** Text a step writes before any tool call, past which the run counts as
 * writing its answer (`03` E3). Shorter text before a tool call is the
 * preamble most models write ("I'll search for …"). */
export const WRITING_TEXT_CHARS = 280;

/** The limits one attempt runs under (`03` L1, L2). */
export interface AttemptLimits {
  maxSteps: number;
  maxSearches: number;
  maxFetches: number;
  timeoutMs: number;
  /** Per provider call; absent, the model's own. */
  maxOutputTokens?: number;
}

/** `03` L2: a look-up asks for two or three sentences with a source. */
export const LOOKUP_LIMITS: AttemptLimits = {
  maxSteps: 4,
  maxSearches: 2,
  maxFetches: 2,
  timeoutMs: 120_000,
  maxOutputTokens: 1_000,
};

export function limitsFor(request: Pick<RunRequest, "node">, config: Config): AttemptLimits {
  if (request.node === "lookup") {
    return {
      ...LOOKUP_LIMITS,
      timeoutMs: Math.min(LOOKUP_LIMITS.timeoutMs, config.limits.runTimeoutMs),
    };
  }
  return {
    maxSteps: MAX_STEPS,
    maxSearches: MAX_SEARCHES_PER_RUN,
    maxFetches: MAX_FETCHES_PER_RUN,
    timeoutMs: config.limits.runTimeoutMs,
  };
}

export interface AttemptResult {
  /** `superseded`: the attempt fence stopped this attempt (a newer attempt
   * started, or the thread or node was removed); it closed its ledger rows
   * and wrote nothing else. `rate_limited`: a 429; nothing was written, and
   * the dispatcher re-queues the run or fails it. */
  outcome: AttemptOutcome | "superseded" | "rate_limited";
  error?: ClassifiedError;
}

export interface LoopDeps {
  config: Config;
  /** For the per-call tool usage rows only (`usage_events`). */
  db: SessionDatabase;
  store: RunStore;
  ledger: Ledger;
  allowances: Allowances;
  providers: Providers;
  metadata: MetadataRunner;
  logger: Logger;
  caches: ToolCaches;
  fetch: typeof globalThis.fetch;
  now: () => number;
  /** `LEDGER_CHECKPOINT_MS` outside tests. */
  ledgerCheckpointMs: number;
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

/** The assistant text of `turns`, for the title and summary steps. */
export function answerText(turns: readonly Turn[]): string {
  return turns
    .filter((turn) => turn.role !== "user")
    .flatMap((turn) => turn.blocks)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim();
}

function failureOf(error: ClassifiedError): RunFailure {
  return error.errorClass === "rate_limited"
    ? { why: "error", cls: "unknown" }
    : { why: "error", cls: error.errorClass };
}

/**
 * Runs one attempt to its end and records how it ended.
 *
 * Returns rather than throws: the caller (the dispatcher) reads the outcome
 * to decide between leaving the run settled and queueing it again after a
 * `rate_limited` attempt. Every ledger row the attempt opened is closed
 * before it returns or throws.
 */
export async function runAttempt(deps: LoopDeps, input: RunAttemptInput): Promise<AttemptResult> {
  const { db, store, logger, ledger } = deps;
  const { request } = input;
  const { runId, userId } = request;
  const limits = limitsFor(request, deps.config);

  // ── stopping ────────────────────────────────────────────────────────────
  /** Aborted by the attempt itself: the fence, the overdraft limit, the
   * run's token cap. Cancel and drain abort `input.signal`. */
  const stopController = new AbortController();
  let superseded = false;
  let stopReason: StopReason | null = null;
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout, stopController.signal]);

  /**
   * Whether this attempt may still write (`03` E1): it is the run's current
   * attempt and its thread and node are not removed. Once false, the
   * provider stream is aborted and nothing further is written: no turns, no
   * outcome. The store's check is synchronous, so a check followed by a
   * write with no `await` between them cannot interleave with a newer
   * attempt's start.
   */
  const owned = (): boolean => {
    if (!superseded && !store.isCurrent(request)) {
      superseded = true;
      stopController.abort();
    }
    return !superseded;
  };

  const stop = (reason: StopReason): void => {
    if (stopReason === null) {
      stopReason = reason;
      stopController.abort();
    }
  };

  /** Why a provider call whose signal fired ended (`03` E5). */
  const abortEnding = (): CallEnding => {
    if (superseded) return "superseded";
    if (stopReason !== null) return stopReason;
    if (input.isDraining()) return "drain";
    if (timeout.aborted && !input.signal.aborted) return "timeout";
    return "cancel";
  };

  if (!owned()) {
    return { outcome: "superseded" };
  }

  const budget = new RunBudget(
    { ledger, allowances: deps.allowances, limits: deps.config.limits, now: deps.now },
    { userId, runId, attempt: request.attempt },
  );
  const meter = new AttemptMeter(
    { ledger, now: deps.now, checkpointMs: deps.ledgerCheckpointMs },
    { runId, attempt: request.attempt, userId },
    {
      abortEnding,
      onCheckpoint: (payer) => {
        const reason = budget.stopReason(payer);
        if (reason !== null) {
          stop(reason);
        }
      },
    },
  );

  try {
    return await attempt();
  } finally {
    // Every path closes its calls itself; this is for a write that threw.
    meter.closeOpen(signal.aborted ? abortEnding() : "error");
  }

  async function attempt(): Promise<AttemptResult> {
    const toolBudget = new ToolBudget(limits.maxSearches, limits.maxFetches);
    const toolUsage = { search: 0, fetch: 0 };
    let steps = 0;

    /** The model of the next step and who pays for it. */
    let current: { payer: Payer; resolved: ResolvedModel } | null = null;

    interface Settled {
      fail?: RunFailure;
      error?: ClassifiedError;
      note?: string;
      answer?: CompletedAnswer;
    }

    /** Closes the attempt's ledger rows, then records the outcome unless the
     * fence stopped the attempt. Usage is closed either way: the provider
     * billed it. */
    const settle = (outcome: AttemptOutcome, settled: Settled = {}): AttemptResult => {
      meter.closeOpen(signal.aborted ? abortEnding() : "error");
      recordToolUsage(db, userId, runId, "search", "search", toolUsage.search);
      recordToolUsage(db, userId, runId, "fetch", "fetch", toolUsage.fetch);
      toolUsage.search = 0;
      toolUsage.fetch = 0;
      if (!owned()) {
        return { outcome: "superseded" };
      }
      if (outcome === "failed" && settled.error) {
        logger.warn(
          { runId, errorClass: settled.error.errorClass, detail: settled.error.detail },
          "run failed",
        );
      }
      const totals = meter.totals;
      const usage = {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        reasoningTokens: totals.reasoningTokens,
        cachedTokens: totals.cachedTokens,
      };
      const summary: AttemptSummary = {
        outcome,
        fail: settled.fail ?? (outcome === "cancelled" ? { why: "stopped" } : undefined),
        error: settled.error,
        note: settled.note,
        tok: ledger.runTokens(runId),
        bill: billLabel(meter.payers),
        steps,
        toolCalls: toolBudget.searches + toolBudget.fetches,
        usage,
        costEstimateMicros: current ? costOf(current.resolved.entry, usage) : 0,
      };
      store.finish(request, summary, settled.answer);
      return settled.error ? { outcome, error: settled.error } : { outcome };
    };

    /** A 429: nothing is written; the dispatcher decides (`03` E5). */
    const rateLimited = (error: ClassifiedError): AttemptResult => {
      meter.closeOpen("rate_limited");
      if (!owned()) {
        return { outcome: "superseded" };
      }
      return { outcome: "rate_limited", error };
    };

    /** The ending of an attempt that stopped early, or null. */
    const interruption = (): AttemptResult | null => {
      if (!owned()) {
        meter.closeOpen("superseded");
        return { outcome: "superseded" };
      }
      const cancelled = store.isCancelled(request);
      if (input.isDraining() && !cancelled) {
        return settle("interrupted", { fail: { why: "interrupted" } });
      }
      if (cancelled || input.signal.aborted) {
        return settle("cancelled", { fail: { why: "stopped" } });
      }
      return null;
    };

    // ── model and payer ─────────────────────────────────────────────────────
    const resolveFor = (payer: Payer): ResolvedModel | null => {
      if (payer === "included") {
        return deps.providers.resolve(request.model, request.effort);
      }
      const key = payer === "key:anthropic" ? deps.allowances.anthropicKey(userId) : null;
      return key === null
        ? null
        : deps.providers.resolve(request.model, request.effort, {
            provider: "anthropic",
            apiKey: key,
          });
    };
    const resolved = resolveFor(request.payer);
    if (!resolved) {
      if (request.payer !== "included") {
        return settle("failed", {
          fail: { why: "key" },
          error: {
            errorClass: "auth",
            message: "The API key for this run is missing or no longer valid.",
            detail: `no ${request.payer} key`,
          },
        });
      }
      const error: ClassifiedError = {
        errorClass: "auth",
        message: `${request.model} is not configured on this deployment`,
        detail: "missing credential",
      };
      return settle("failed", { fail: failureOf(error), error });
    }
    current = { payer: request.payer, resolved };

    const wrapped = new Map<Payer, ReturnType<AttemptMeter["wrap"]>>();
    const modelFor = (payer: Payer, model: ResolvedModel): ReturnType<AttemptMeter["wrap"]> => {
      const existing = wrapped.get(payer);
      if (existing) return existing;
      const next = meter.wrap(model.model, { entry: model.entry, payer, kind: "research" });
      wrapped.set(payer, next);
      return next;
    };
    /** Metadata calls bill the asker's included tokens (`03` K2). */
    const wrapMetadata: ModelWrap = (model, entry, kind) =>
      meter.wrap(model, { entry, payer: "included", kind });

    /** `03` K9: once the allowance is spent, the next step of an included
     * run moves to the asker's Anthropic key when billing is `key`. */
    const payForNextStep = (): void => {
      if (current?.payer !== "included") return;
      const key = budget.keyForNextStep(current.resolved.entry);
      if (key === null) return;
      const keyed = deps.providers.resolve(request.model, request.effort, {
        provider: "anthropic",
        apiKey: key,
      });
      if (keyed) {
        current = { payer: "key:anthropic", resolved: keyed };
      }
    };

    // ── progress ────────────────────────────────────────────────────────────
    let phase: RunStep = 0;
    const advance = (next: RunStep): void => {
      if (next > phase && owned()) {
        phase = next;
        store.step(request, next);
      }
    };

    store.markRunning(request);

    // ── request assembly ────────────────────────────────────────────────────
    const toolContext: RunToolContext = {
      config: deps.config,
      userId,
      runId,
      logger,
      fetch: deps.fetch,
      budget: toolBudget,
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
        summarize: ({ text, signal: summarySignal }) =>
          deps.metadata.summarize({ text, userId, signal: summarySignal, wrap: wrapMetadata }),
        summaries: store.summaries,
        signal,
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
      const classified = classifyRunError(error);
      return interruption() ?? settle("failed", { fail: failureOf(classified), error: classified });
    }

    const tools = buildTools(toolContext, signal, {
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
          advance(2);
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
      signal,
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

    let streamError: unknown = null;
    let finishReason: string | undefined;
    let rawFinishReason: string | undefined;
    let responseMessages: ModelMessage[] = [];
    let stepText = 0;
    let stepUsedTools = false;

    try {
      const result = streamText({
        model: modelFor(current.payer, current.resolved),
        system,
        messages,
        tools,
        // The step boundary: the overdraft limit and the token cap stop the
        // run before its next provider call (`03` K9, L1).
        stopWhen: [
          stepCountIs(limits.maxSteps),
          () => {
            const reason = budget.stopReason(current?.payer ?? request.payer);
            if (reason !== null) stopReason ??= reason;
            return reason !== null;
          },
        ],
        prepareStep: () => {
          payForNextStep();
          return current ? { model: modelFor(current.payer, current.resolved) } : {};
        },
        abortSignal: signal,
        providerOptions: resolved.providerOptions,
        ...(limits.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: limits.maxOutputTokens }),
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
        switch (part.type) {
          case "start-step":
            stepText = 0;
            stepUsedTools = false;
            break;
          case "text-delta":
            stepText += part.text.length;
            if (!stepUsedTools && stepText >= WRITING_TEXT_CHARS) advance(3);
            checkpoint();
            break;
          case "tool-call":
            stepUsedTools = true;
            if (part.toolName === "web_search" || part.toolName === "google_search") advance(1);
            if (part.toolName === "web_fetch") advance(2);
            break;
          case "source":
            advance(2);
            break;
          case "finish-step":
            steps += 1;
            if (part.finishReason !== "tool-calls") advance(3);
            break;
          case "finish":
            finishReason = part.finishReason;
            rawFinishReason = part.rawFinishReason;
            break;
          default:
            break;
        }
      }
      if (streamError === null && !signal.aborted) {
        responseMessages = await result.responseMessages;
      }
    } catch (error) {
      streamError = error;
    }

    flushDelta(true);
    // Commits the partial step, so an interrupted attempt keeps its text as
    // a turn the resume replays, and a stopped one keeps it as its last turn.
    mapper.finish();
    flushDelta(true);

    // ── outcome ─────────────────────────────────────────────────────────────
    const early = interruption();
    if (early) {
      return early;
    }

    const turns = [...priorTurns, ...mapper.committedTurns];
    const asked: ModelMessage = { role: "user", content: request.userText };

    // `03` E5: a token limit ends the run `complete` with what it wrote.
    if (stopReason !== null) {
      // A stream aborted mid-call has no response messages; its committed
      // turns stand in for them.
      const replies =
        responseMessages.length > 0
          ? responseMessages
          : messagesFromCommittedTurns(mapper.committedTurns);
      return settle("complete", {
        note: stopNote(stopReason),
        answer: { turns, messages: [asked, ...priorMessages, ...replies] },
      });
    }

    const timedOut = timeout.aborted;
    if (streamError !== null || timedOut) {
      const classified = timedOut
        ? timeoutError(Math.round(limits.timeoutMs / 1000))
        : classifyRunError(streamError);
      if (classified.errorClass === "rate_limited") {
        return rateLimited(classified);
      }
      // `03` K9, E5: the asker's key was rejected after the switch.
      if (classified.errorClass === "auth" && current.payer !== "included") {
        return settle("failed", { fail: { why: "key" }, error: classified });
      }
      return settle("failed", { fail: failureOf(classified), error: classified });
    }

    if (finishReason === "content-filter") {
      const refused = refusalError(rawFinishReason);
      return settle("failed", { fail: failureOf(refused), error: refused });
    }

    // ── completion ──────────────────────────────────────────────────────────
    if (!hasAnswerText(turns)) {
      const error: ClassifiedError = {
        errorClass: "unknown",
        message: NO_ANSWER,
        detail: "no answer",
      };
      return settle("failed", { fail: failureOf(error), error });
    }

    // `03` E2: a new thread's title and the root's summary line are the
    // run's final steps, billed like the others and fenced like every write.
    const text = answerText(turns);
    if (request.finalSteps?.title && owned() && !signal.aborted) {
      const title = await deps.metadata.generateTitle({
        userId,
        runId,
        question: request.userText,
        opening: text.slice(0, 2_000),
        wrap: wrapMetadata,
        signal,
      });
      if (title !== null && owned()) {
        store.writeTitle(request, title);
      }
    }
    if (request.finalSteps?.summary && owned() && !signal.aborted) {
      const line = await deps.metadata.generateSummaryLine({
        userId,
        runId,
        question: request.userText,
        answer: text,
        wrap: wrapMetadata,
        signal,
      });
      if (line !== null && owned()) {
        store.writeSummary(request, line);
      }
    }
    const late = interruption();
    if (late) {
      return late;
    }

    // The question comes first because a follow-up replays this exchange as
    // context, and providers such as Anthropic require alternating user and
    // assistant turns.
    return settle("complete", {
      answer: { turns, messages: [asked, ...priorMessages, ...responseMessages] },
    });
  }
}
