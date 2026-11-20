// One attempt of a server job's run (`04-agent-runtime.md` §3; phase 2a):
// the owned agent loop ("included tokens") on a space thread's ask.
//
// The job has started the run in the sync store (`RunJobs.start`), which
// gave the question, the branch's earlier exchanges as the asker reads them
// and the ask's skill. The loop builds the prompt from those, streams the
// provider, maps the stream into turns (`TurnMapper`), and writes back
// through the sync server only:
// - each committed turn is a `turn` record (`RunJobs.turn`), replicated like
//   any record;
// - in-flight text goes to the readers of the run's node as SSE `run` events
//   (`RunJobs.delta`, at most every DELTA_INTERVAL_MS), numbered within the
//   attempt from `seqStart`;
// - the answer and the run's end are `RunJobs.finish` / `fail`.
// When a write answers that the job no longer holds the run (it was
// cancelled, a later run of the ask replaced it, the person lost access), the
// attempt stops. Usage is recorded by run, payer and space as each step
// finishes, so an attempt that is stopped, times out, is drained or fails
// still records the steps it finished. After each step the payer's
// allowance (the weekly included tokens, or a key's monthly cap) is checked
// again (`payerLeft`): a payer with nothing left ends the run `tokens`, and
// a key that is no longer valid ends it `key`.

import type { AttemptUsage, SessionDatabase } from "@session/db";
import { runs as runsRepo } from "@session/db";
import type { RunEnd } from "@session/mutators";
import type { Turn } from "@session/shared";
import type { JobStart, SyncServer } from "@session/sync/server";
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
import { researchSystemPrompt, runMessages } from "./prompts.js";
import type { ResolvedModel } from "./providers.js";
import type { RunToolContext, ToolCaches } from "./tools/context.js";
import { ToolBudget } from "./tools/context.js";
import { buildTools } from "./tools/index.js";
import {
  addUsage,
  attemptUsageOf,
  costOf,
  recordAttemptUsage,
  recordToolUsage,
} from "./usage.js";

/** `04-agent-runtime.md` §3. */
export const MAX_STEPS = 25;
export const DELTA_INTERVAL_MS = 50;
/** How often the attempt's event number is written to `run_queue`, so a
 * resumed attempt numbers its events past it. */
export const SEQ_PERSIST_EVERY = 50;

export type AttemptOutcome =
  "complete" | "failed" | "cancelled" | "interrupted" | "rate_limited" | "superseded";

export interface AttemptResult {
  outcome: AttemptOutcome;
  error?: ClassifiedError;
  /** The run's end when it ended without an answer. */
  end?: RunEnd;
}

export interface LoopDeps {
  config: Config;
  db: SessionDatabase;
  sync: SyncServer;
  logger: Logger;
  caches: ToolCaches;
  fetch: typeof globalThis.fetch;
  toolOverrides?: Pick<RunToolContext, "lookup" | "allowHosts">;
}

export interface RunAttemptInput {
  job: JobStart;
  userId: string;
  resolved: ResolvedModel;
  /** Who pays (`session` or an API key id), for the usage records. */
  payer: string;
  /** True when a user's API key pays: an auth error ends the run `key`. */
  paidByKey: boolean;
  /** The research instruction of the asker's settings. */
  instruction: string | null;
  /** The number of this attempt in `run_attempts`. */
  n: number;
  /** The last in-flight event number used before this attempt. */
  seqStart: number;
  signal: AbortSignal;
  isDraining: () => boolean;
  /** What the payer has left now, the attempt's recorded steps counted: a
   * number of tokens, or "key" when the key that pays is no longer valid.
   * Checked after each step. */
  payerLeft?: () => number | "key";
}

/** The answer of a run: the text of its last assistant turn that has text. */
export function answerOf(turns: readonly Turn[]): string {
  for (let k = turns.length - 1; k >= 0; k--) {
    const t = turns[k];
    if (t?.role !== "assistant") continue;
    const text = t.blocks
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n\n")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

/** The run's end for a classified provider error. */
function endOf(error: ClassifiedError, paidByKey: boolean): RunEnd {
  if (error.errorClass === "rate_limited") return "rate";
  if (error.errorClass === "auth" && paidByKey) return "key";
  return "interrupted";
}

export async function runAttempt(deps: LoopDeps, input: RunAttemptInput): Promise<AttemptResult> {
  const { db, sync, logger } = deps;
  const { job, resolved } = input;
  const run = job.run;
  const jobs = sync.runJobs;
  const attempt = run.attempt;
  const held = () => jobs.holds(run.id, attempt);

  let seq = input.seqStart;
  const nextSeq = () => {
    seq += 1;
    if (seq % SEQ_PERSIST_EVERY === 0) runsRepo.setSeq(db, run.id, seq);
    return seq;
  };

  const budget = new ToolBudget();
  const toolUsage = { search: 0, fetch: 0 };
  const toolContext: RunToolContext = {
    config: deps.config,
    db,
    userId: input.userId,
    runId: run.id,
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

  let usage = attemptUsageOf(undefined);
  let steps = 0;
  const finishAttempt = (outcome: string, error?: ClassifiedError): void => {
    runsRepo.finishAttempt(db, {
      runId: run.id,
      n: input.n,
      outcome,
      errorClass: error?.errorClass ?? null,
      steps,
      toolCalls: budget.searches + budget.fetches,
      usage,
      costEstimateMicros: costOf(resolved.entry, usage),
    });
    runsRepo.setSeq(db, run.id, seq);
  };
  /** One finished step's tokens, recorded as the step finishes. */
  const recordStep = (step: AttemptUsage): void => {
    usage = addUsage(usage, step);
    if (step.inputTokens + step.outputTokens === 0) return;
    recordAttemptUsage({
      db,
      userId: input.userId,
      runId: run.id,
      spaceId: run.s,
      payer: input.payer,
      entry: resolved.entry,
      kind: "research",
      usage: step,
    });
  };
  const recordUsage = (): void => {
    recordToolUsage(db, input.userId, run.id, "search", "search", toolUsage.search);
    recordToolUsage(db, input.userId, run.id, "fetch", "fetch", toolUsage.fetch);
  };
  const tokens = () => usage.inputTokens + usage.outputTokens;

  // the attempt's own abort: the caller's (a cancel, the drain), and a write
  // the sync server refused because the job no longer holds the run
  const lost = new AbortController();
  // the payer had nothing left after a step: how the run ends
  let spent: "tokens" | "key" | null = null;
  const outOfTokens = new AbortController();
  const timeoutMs = deps.config.limits.runTimeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout, lost.signal, outOfTokens.signal]);

  const system = researchSystemPrompt(input.instruction, job.skill);
  const messages: ModelMessage[] = runMessages(job.history, job.q);
  const tools = buildTools(toolContext, signal, {
    nativeSearch: resolved.entry.nativeSearch,
    providerTools: resolved.providerTools,
  });

  let pending = "";
  let lastDeltaAt = 0;
  const flushDelta = (force: boolean): void => {
    if (pending === "") return;
    const now = Date.now();
    if (!force && now - lastDeltaAt < DELTA_INTERVAL_MS) return;
    lastDeltaAt = now;
    const text = pending;
    pending = "";
    if (!jobs.delta(run.id, attempt, nextSeq(), text)) lost.abort();
  };

  const mapper = new TurnMapper(
    {
      runId: run.id,
      agentId: run.id,
      // a resumed run continues past the turns stored before
      startStep: job.turns.length,
      startSourceIndex: job.turns.length,
    },
    {
      onTextDelta: (_turnId, text) => {
        pending += text;
        flushDelta(false);
      },
      onGroundedSearch: (queries) => {
        toolUsage.search += queries;
      },
      onTurnCommitted: (turn) => {
        flushDelta(true);
        if (jobs.turn(run.id, attempt, turn) === null) lost.abort();
      },
    },
  );

  const groundingRedirects = createGroundingRedirectResolver({
    fetch: deps.fetch,
    logger,
    signal,
  });

  let streamError: unknown = null;
  let finishReason: string | undefined;
  let rawFinishReason: string | undefined;
  try {
    const result = streamText({
      model: resolved.model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
      providerOptions: resolved.providerOptions,
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
      if (part.type === "abort") break;
      mapper.handle(await resolveGroundingRedirects(part, groundingRedirects));
      if (part.type === "finish-step") {
        steps += 1;
        recordStep(attemptUsageOf(part.usage));
        const left = input.payerLeft?.();
        const more = part.finishReason === "tool-calls";
        if (more && (left === "key" || (left !== undefined && left <= 0))) {
          spent = left === "key" ? "key" : "tokens";
          outOfTokens.abort();
          break;
        }
      }
      if (part.type === "finish") {
        finishReason = part.finishReason;
        rawFinishReason = part.rawFinishReason;
      }
    }
  } catch (error) {
    streamError = error;
  }
  flushDelta(true);
  mapper.finish();
  flushDelta(true);

  // ---- outcome ----
  if (input.isDraining() && !lost.signal.aborted && held()) {
    // the next process resumes it (`recover`); nothing ends the run
    finishAttempt("interrupted");
    recordUsage();
    return { outcome: "interrupted" };
  }
  if (lost.signal.aborted || !held()) {
    finishAttempt("cancelled");
    recordUsage();
    return { outcome: lost.signal.aborted ? "superseded" : "cancelled" };
  }
  if (spent !== null) {
    // the payer ran out while the agent worked: the run ends, and the
    // thread keeps the tokens it used (the mock's `tokens` end)
    finishAttempt("failed");
    recordUsage();
    jobs.fail(run.id, attempt, spent, tokens());
    return { outcome: "failed", end: spent };
  }
  if (input.signal.aborted) {
    // a cancel: `research.cancelNode` ended the run already
    finishAttempt("cancelled");
    recordUsage();
    return { outcome: "cancelled" };
  }
  const timedOut = timeout.aborted;
  if (streamError !== null || timedOut) {
    const classified = timedOut
      ? timeoutError(Math.round(timeoutMs / 1000))
      : classifyRunError(streamError);
    finishAttempt(classified.errorClass === "rate_limited" ? "rate_limited" : "failed", classified);
    recordUsage();
    if (classified.errorClass === "rate_limited")
      return { outcome: "rate_limited", error: classified };
    logger.warn(
      { runId: run.id, errorClass: classified.errorClass, detail: classified.detail },
      "run failed",
    );
    const end = endOf(classified, input.paidByKey);
    jobs.fail(run.id, attempt, end);
    return { outcome: "failed", error: classified, end };
  }
  if (finishReason === "content-filter") {
    const classified = refusalError(rawFinishReason);
    finishAttempt("failed", classified);
    recordUsage();
    jobs.fail(run.id, attempt, "interrupted");
    return { outcome: "failed", error: classified, end: "interrupted" };
  }
  const answer = answerOf(mapper.committedTurns);
  finishAttempt(answer === "" ? "failed" : "complete");
  recordUsage();
  if (answer === "") {
    jobs.fail(run.id, attempt, "interrupted");
    return { outcome: "failed", end: "interrupted" };
  }
  if (!jobs.finish(run.id, attempt, answer, tokens())) return { outcome: "cancelled" };
  return { outcome: "complete" };
}
