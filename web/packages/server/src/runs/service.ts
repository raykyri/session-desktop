// The attempts this process is running (`04-agent-runtime.md` §2,
// `05-run-lifecycle-and-streaming.md` §7).
//
// It starts an attempt of a run the caller hands it, aborts one on cancel,
// and on `SIGTERM` aborts every attempt so each records itself `interrupted`
// and closes the ledger row of the call it was making (`01` S5). Which run
// starts when is the dispatcher's decision (`dispatcher.ts`, `03` E2).

import type { SessionDatabase } from "@session/db";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";

import type { Allowances } from "./allowance.js";
import { configAllowances } from "./allowance.js";
import type { ClassifiedError } from "./errors.js";
import type { Ledger } from "./ledger.js";
import { LEDGER_CHECKPOINT_MS, ZERO_COUNTS } from "./ledger.js";
import type { AttemptResult, LoopDeps } from "./loop.js";
import { runAttempt } from "./loop.js";
import type { MetadataRunner } from "./metadata.js";
import { createMetadataRunner } from "./metadata.js";
import type { Providers } from "./providers.js";
import { createProviders } from "./providers.js";
import type { RunRequest, RunStore } from "./store.js";
import type { RunToolContext } from "./tools/context.js";
import { createToolCaches } from "./tools/context.js";

export interface RunsService {
  /** Aborts the run's attempt if one is running here. The store already
   * records the run as cancelled. */
  cancel(runId: string): void;
  /** `SIGTERM`: stop starting attempts, abort the running ones so each
   * checkpoints and records itself `interrupted`. Resolves when it is safe to
   * exit. */
  drain(): Promise<void>;
}

export interface NoopRunsService extends RunsService {
  readonly cancelled: string[];
  readonly drained: boolean;
}

/** Records the calls and does nothing else. */
export function createNoopRunsService(): NoopRunsService {
  const cancelled: string[] = [];
  let drained = false;
  return {
    cancelled,
    get drained() {
      return drained;
    },
    cancel(runId) {
      cancelled.push(runId);
    },
    drain() {
      drained = true;
      return Promise.resolve();
    },
  };
}

export interface RunsServiceDeps {
  config: Config;
  db: SessionDatabase;
  store: RunStore;
  ledger: Ledger;
  /** The configured allowance for everyone when absent. */
  allowances?: Allowances;
  now?: () => number;
  /** `LEDGER_CHECKPOINT_MS` when absent; tests shorten it. */
  ledgerCheckpointMs?: number;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
  /** Constructed from the config when absent. */
  providers?: Providers;
  metadata?: MetadataRunner;
  toolOverrides?: Pick<RunToolContext, "lookup" | "allowHosts">;
}

export interface AgentRunsService extends RunsService {
  /** Runs one attempt of `request` to its end. An attempt of a run that is
   * already running here, or any attempt once the drain began, is not
   * started and answers `superseded`. */
  run(request: RunRequest): Promise<AttemptResult>;
  /** True once `drain` began: nothing more starts. */
  readonly draining: boolean;
  /** Resolves when every attempt started so far has settled. */
  idle(): Promise<void>;
  readonly providers: Providers;
  readonly metadata: MetadataRunner;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<AttemptResult>;
}

export function createRunsService(deps: RunsServiceDeps): AgentRunsService {
  const logger = deps.logger ?? createLogger({ level: "info" });
  const providers = deps.providers ?? createProviders(deps.config);
  const metadata = deps.metadata ?? createMetadataRunner({ providers, logger });
  const loopDeps: LoopDeps = {
    config: deps.config,
    db: deps.db,
    store: deps.store,
    ledger: deps.ledger,
    allowances: deps.allowances ?? configAllowances(deps.config),
    now: deps.now ?? Date.now,
    ledgerCheckpointMs: deps.ledgerCheckpointMs ?? LEDGER_CHECKPOINT_MS,
    providers,
    metadata,
    logger,
    caches: createToolCaches(),
    fetch: deps.fetch ?? globalThis.fetch,
    ...(deps.toolOverrides ? { toolOverrides: deps.toolOverrides } : {}),
  };

  const active = new Map<string, ActiveRun>();
  let draining = false;

  /** The loop settles every expected failure itself and has closed its
   * ledger rows; this is a write that threw (a store call). The run is
   * marked failed so it does not stay `running` until the next boot. */
  const recordThrow = (request: RunRequest, error: unknown): AttemptResult => {
    logger.error({ runId: request.runId, error }, "run attempt threw");
    const classified: ClassifiedError = {
      errorClass: "unknown",
      message: "The run stopped unexpectedly. Try again.",
      detail: String(error),
    };
    try {
      if (deps.store.isCurrent(request)) {
        deps.store.finish(request, {
          outcome: "failed",
          fail: { why: "error", cls: "unknown" },
          error: classified,
          tok: deps.ledger.runTokens(request.runId),
          bill: null,
          steps: 0,
          toolCalls: 0,
          usage: { ...ZERO_COUNTS },
          costEstimateMicros: 0,
        });
      }
    } catch (finishError) {
      logger.error({ runId: request.runId, error: finishError }, "could not record the failure");
    }
    return { outcome: "failed", error: classified };
  };

  return {
    providers,
    metadata,
    get draining() {
      return draining;
    },

    run(request) {
      if (draining || active.has(request.runId)) {
        return Promise.resolve({ outcome: "superseded" });
      }
      const controller = new AbortController();
      const done = runAttempt(loopDeps, {
        request,
        signal: controller.signal,
        isDraining: () => draining,
      })
        .catch((error: unknown) => recordThrow(request, error))
        .finally(() => {
          active.delete(request.runId);
        });
      active.set(request.runId, { controller, done });
      return done;
    },

    cancel(runId) {
      active.get(runId)?.controller.abort();
    },

    async idle() {
      while (active.size > 0) {
        await Promise.all([...active.values()].map((run) => run.done));
      }
    },

    async drain() {
      draining = true;
      const open = [...active.values()];
      for (const run of open) {
        run.controller.abort();
      }
      await Promise.all(open.map((run) => run.done));
    },
  };
}
