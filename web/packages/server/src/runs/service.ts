// The attempts this process is running (`04-agent-runtime.md` §2,
// `05-run-lifecycle-and-streaming.md` §7).
//
// It starts an attempt of a run the caller hands it, aborts one on cancel,
// and on `SIGTERM` aborts every attempt so each records itself `interrupted`.
//
// What it no longer does: claim from `run_queue` under the per-user and
// per-provider caps, gate a follow-up on its parent's run, hold runs for the
// daily limits, queue a rate-limited attempt again with backoff, resume
// interrupted attempts at boot, run the title and recap pool, and dispatch
// queued follow-ups. All of that read the research tables, which were
// removed with the research API (plan `01` A2). M5a replaces it with the
// dispatcher of `03` E2, which claims the oldest admissible `queued` run
// record with a compare-and-set and calls `run`.

import type { SessionDatabase } from "@session/db";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";

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
  const metadata = deps.metadata ?? createMetadataRunner({ db: deps.db, providers, logger });
  const loopDeps: LoopDeps = {
    config: deps.config,
    db: deps.db,
    store: deps.store,
    providers,
    metadata,
    logger,
    caches: createToolCaches(),
    fetch: deps.fetch ?? globalThis.fetch,
    ...(deps.toolOverrides ? { toolOverrides: deps.toolOverrides } : {}),
  };

  const active = new Map<string, ActiveRun>();
  let draining = false;

  return {
    providers,
    metadata,

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
        .catch((error: unknown): AttemptResult => {
          // The loop settles every expected failure itself; this is a write
          // that threw (a store call). The dispatcher (M5a) marks the run
          // failed so it does not stay `running` until the next boot.
          logger.error({ runId: request.runId, error }, "run attempt threw");
          return {
            outcome: "failed",
            error: {
              errorClass: "unknown",
              message: "The run stopped unexpectedly. Try again.",
              detail: String(error),
            },
          };
        })
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
