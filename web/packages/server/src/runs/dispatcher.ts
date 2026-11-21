// The run dispatcher (`03-agents-and-research.md` E2, K10, L1; `01` S5).
//
// A `run` record in status `queued` is the queue; there is no job table.
// The dispatcher claims the oldest admissible queued run with a
// compare-and-set (`RunStore.claim`: `queued` → `running` where id, attempt
// and status still match), so at most one runner holds an attempt even when
// two dispatchers read the same queue. Admissible means:
//
// - fewer than `SESSION_RUNS_PER_USER` of the asker's runs running here;
// - fewer than the model provider's cap running here (`SESSION_RUNS_GEMINI`,
//   `SESSION_RUNS_OPENROUTER`, `SESSION_RUNS_ANTHROPIC`);
// - not waiting out a 429 backoff;
// - payable: the payer re-check of K10. A run whose payer is now `none` ends
//   `failed { why: "tokens" }` without a provider call.
//
// A 429 re-queues the run with backoff 5 s, 20 s, 60 s; the next 429 fails it
// `rate` with `at` 60 s ahead (`03` E5). The backoff is kept in memory: after
// a restart a re-queued run is admitted at once.
//
// Boot: close the ledger rows a crash left open with their last checkpoint,
// mark runs still `running` `interrupted`, and queue every interrupted run
// again that has had fewer than two automatic resumes (`03` E2, K1).

import { OUT_OF_TOKENS_TEXT, findModel } from "@session/shared";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

import type { Allowances } from "./allowance.js";
import { payerAtStart } from "./allowance.js";
import type { ClassifiedError } from "./errors.js";
import { RATE_LIMIT_BACKOFF_MS } from "./errors.js";
import type { Ledger } from "./ledger.js";
import { ZERO_COUNTS } from "./ledger.js";
import type { AttemptResult } from "./loop.js";
import type { AttemptSummary, QueuedRun, RunFailure, RunRequest, RunStore } from "./store.js";

/** `03` E2: automatic resumes per attempt, then the run stays `interrupted`
 * with Run again. */
export const MAX_AUTO_RESUMES = 2;

/** How far ahead `fail.at` is set when the 429 retries are spent. */
export const RATE_RETRY_AFTER_MS = 60_000;

export const OUT_OF_TOKENS_MESSAGE = OUT_OF_TOKENS_TEXT;

export interface DispatcherDeps {
  config: Pick<Config, "limits">;
  store: RunStore;
  ledger: Ledger;
  allowances: Allowances;
  /** Starts an attempt (`AgentRunsService.run`). */
  runner: { run(request: RunRequest): Promise<AttemptResult> };
  logger: Logger;
  now?: () => number;
  /** `RATE_LIMIT_BACKOFF_MS` when absent. */
  backoffMs?: readonly number[];
  /** How often the queue is read without a wake, in ms. */
  pollMs?: number;
}

export interface BootReport {
  /** Ledger rows closed with their last checkpoint. */
  closedRows: number;
  /** Runs found `running`, now `interrupted`. */
  interrupted: number;
  /** Interrupted runs queued again as a `resume`. */
  resumed: number;
}

export interface Dispatcher {
  /** `01` S5, in order: ledger rows, `running` runs, resumes. Call once,
   * before `start`. */
  boot(): BootReport;
  /** Reads the queue now and then every `pollMs`. */
  start(): void;
  /** Stops reading the queue; running attempts are the service's to drain. */
  stop(): void;
  /** A run was queued: read the queue soon. */
  wake(): void;
  /** Claims and starts every admissible run, returns how many started. */
  tick(): number;
  /** Resolves when no attempt started here is running. */
  idle(): Promise<void>;
}

interface Backoff {
  attempt: number;
  /** 429s so far for this attempt. */
  retries: number;
  notBefore: number;
}

function summaryOf(
  ledger: Ledger,
  runId: string,
  fail: RunFailure,
  error: ClassifiedError,
): AttemptSummary {
  return {
    outcome: "failed",
    fail,
    error,
    tok: ledger.runTokens(runId),
    bill: null,
    steps: 0,
    toolCalls: 0,
    usage: { ...ZERO_COUNTS },
    costEstimateMicros: 0,
  };
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const now = deps.now ?? Date.now;
  const backoffMs = deps.backoffMs ?? RATE_LIMIT_BACKOFF_MS;
  const pollMs = deps.pollMs ?? 1_000;
  const { store, ledger, logger } = deps;
  const limits = deps.config.limits;

  const perUser = new Map<string, number>();
  const perProvider = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  const backoffs = new Map<string, Backoff>();
  let poll: ReturnType<typeof setInterval> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  const providerCap = (provider: string): number => {
    switch (provider) {
      case "vertex":
        return limits.vertex;
      case "openrouter":
        return limits.openrouter;
      case "anthropic":
        return limits.anthropic;
      default:
        return Number.POSITIVE_INFINITY;
    }
  };

  const bump = (map: Map<string, number>, key: string, by: number): void => {
    const next = (map.get(key) ?? 0) + by;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  const scheduleWake = (delayMs: number): void => {
    if (stopped) return;
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      tick();
    }, delayMs);
    wakeTimer.unref?.();
  };

  const budgetDeps = {
    ledger,
    allowances: deps.allowances,
    limits,
    now,
  };

  /** `03` E5: a 429 re-queues with backoff, then fails `rate`. */
  const rateLimited = (request: RunRequest, error: ClassifiedError | undefined): void => {
    const previous = backoffs.get(request.runId);
    const retries = previous?.attempt === request.attempt ? previous.retries : 0;
    const wait = backoffMs[retries];
    if (wait !== undefined) {
      if (store.requeue(request)) {
        backoffs.set(request.runId, {
          attempt: request.attempt,
          retries: retries + 1,
          notBefore: now() + wait,
        });
        scheduleWake(wait);
      }
      return;
    }
    backoffs.delete(request.runId);
    if (!store.isCurrent(request)) return;
    store.finish(
      request,
      summaryOf(
        ledger,
        request.runId,
        { why: "rate", at: now() + RATE_RETRY_AFTER_MS },
        error ?? {
          errorClass: "rate_limited",
          message: "The model provider is rate limiting this deployment.",
          detail: "429",
        },
      ),
    );
  };

  const start = (request: RunRequest, provider: string | null): void => {
    bump(perUser, request.userId, 1);
    if (provider) bump(perProvider, provider, 1);
    const done = deps.runner
      .run(request)
      .then((result) => {
        if (result.outcome === "rate_limited") {
          rateLimited(request, result.error);
        } else if (result.outcome !== "superseded") {
          backoffs.delete(request.runId);
        }
      })
      .catch((error: unknown) => {
        logger.error({ runId: request.runId, error }, "dispatched run threw");
      })
      .finally(() => {
        bump(perUser, request.userId, -1);
        if (provider) bump(perProvider, provider, -1);
        running.delete(`${request.runId}:${request.attempt}`);
        scheduleWake(0);
      });
    running.set(`${request.runId}:${request.attempt}`, done);
  };

  const admit = (run: QueuedRun, at: number): boolean => {
    const backoff = backoffs.get(run.runId);
    if (backoff?.attempt === run.attempt && backoff.notBefore > at) return false;
    if ((perUser.get(run.userId) ?? 0) >= limits.perUser) return false;
    const provider = findModel(run.model)?.provider;
    return provider === undefined || (perProvider.get(provider) ?? 0) < providerCap(provider);
  };

  const tick = (): number => {
    let started = 0;
    const at = now();
    const busy = new Set([...running.keys()].map((key) => key.slice(0, key.lastIndexOf(":"))));
    for (const run of store.queued()) {
      // an older attempt of the run still settling here (a cancel, then Run
      // again at once, `03` E4): the new one starts once it has
      if (busy.has(run.runId) || !admit(run, at)) continue;
      const entry = findModel(run.model);
      // `03` K10: the payer is checked again before the attempt starts.
      const payer = entry ? payerAtStart(budgetDeps, run.userId, entry, run.payer) : run.payer;
      if (payer === "none") {
        store.settleQueued(
          run,
          summaryOf(
            ledger,
            run.runId,
            { why: "tokens" },
            { errorClass: "unknown", message: OUT_OF_TOKENS_MESSAGE, detail: "no payer" },
          ),
        );
        continue;
      }
      const request = store.claim(run);
      if (request === null) continue;
      start({ ...request, payer }, entry?.provider ?? null);
      started += 1;
    }
    return started;
  };

  return {
    boot() {
      const at = now();
      const closedRows = ledger.closeOpen(at);
      const interrupted = store.interruptRunning();
      let resumed = 0;
      for (const run of store.interrupted()) {
        if (run.resumes < MAX_AUTO_RESUMES && store.resume(run)) {
          resumed += 1;
        }
      }
      logger.info({ closedRows, interrupted, resumed }, "runs booted");
      return { closedRows, interrupted, resumed };
    },

    start() {
      if (!stopped) return;
      stopped = false;
      tick();
      poll = setInterval(() => tick(), pollMs);
      poll.unref?.();
    },

    stop() {
      stopped = true;
      if (poll !== null) clearInterval(poll);
      if (wakeTimer !== null) clearTimeout(wakeTimer);
      poll = null;
      wakeTimer = null;
    },

    wake() {
      scheduleWake(0);
    },

    tick,

    async idle() {
      while (running.size > 0) {
        await Promise.all([...running.values()]);
      }
    },
  };
}
