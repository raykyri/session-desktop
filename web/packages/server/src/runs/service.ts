// The seam between the API and the agent loop.
//
// The API admits a node: it writes the row, enqueues it in `run_queue`, and
// emits the events. Everything after that is this module — claiming the queue
// under the concurrency caps, opening the provider stream, re-queueing a
// rate-limited attempt, draining on `SIGTERM` — and the metadata pool that
// titles, recaps, and encyclopedia pages run in
// (`04-agent-runtime.md` §2, §9, `05-run-lifecycle-and-streaming.md` §7, §8).

import type { SessionDatabase } from "@session/db";
import { nodes as nodesRepo, queue as queueRepo, runs as runsRepo } from "@session/db";
import type { ResearchRecapCandidate } from "@session/shared";

import type { Config } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { sessionEvent } from "../events/bus.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";

import { backoffFor, MAX_RATE_LIMIT_REQUEUES } from "./errors.js";
import type { LoopDeps } from "./loop.js";
import { runAttempt } from "./loop.js";
import type { MetadataRunner } from "./metadata.js";
import { createMetadataRunner } from "./metadata.js";
import type { Providers } from "./providers.js";
import { createProviders } from "./providers.js";
import { createToolCaches } from "./tools/context.js";
import type { RunToolContext } from "./tools/context.js";

/** A run on `gemini-flash` that produces a title, a recap, or an encyclopedia
 * page rather than an answer (`04-agent-runtime.md` §9). It has no node of its
 * own, so it cannot be addressed by node id like a research run. */
export type MetadataJob =
  | { kind: "title"; userId: string; nodeId: string }
  | { kind: "recap"; userId: string; nodeId: string; instructions?: string }
  | { kind: "encyclopedia"; userId: string; workspaceId: string; slug: string };

export interface RunsService {
  /** A node has been admitted and enqueued; wake the claim loop. */
  start(nodeId: string): void;
  /** The node's status has already been written; abort its provider stream if
   * one is open. */
  cancel(nodeId: string): void;
  /** Schedule a metadata run. Separate pool, separate concurrency. */
  enqueueMetadata(job: MetadataJob): void;
  /** A title, awaited: `research.generateTitle` answers the client with it. */
  requestTitle(userId: string, nodeId: string): Promise<string | null>;
  /** A recap candidate, awaited: the dialog is open and waiting for it. */
  requestRecapCandidate(
    userId: string,
    nodeId: string,
    instructions: string,
  ): Promise<ResearchRecapCandidate>;
  /** The candidate this server issued under `id`, so `recaps.applyCandidate`
   * stores the text that was generated rather than the text it was handed. */
  recallRecapCandidate(id: string): ResearchRecapCandidate | null;
  /** `SIGTERM`: stop admitting, persist checkpoints, mark open attempts
   * `interrupted` with `resume_pending` (`05` §7). Resolves when it is safe to
   * exit. */
  drain(): Promise<void>;
}

export interface NoopRunsService extends RunsService {
  /** What the API asked for, in order. The Phase 3 tests assert on this
   * instead of on a provider stream. */
  readonly started: string[];
  readonly cancelled: string[];
  readonly metadata: MetadataJob[];
  readonly drained: boolean;
}

export const METADATA_UNAVAILABLE = "metadata runs are not available on this server";

/** Records the calls and does nothing else. */
export function createNoopRunsService(): NoopRunsService {
  const started: string[] = [];
  const cancelled: string[] = [];
  const metadata: MetadataJob[] = [];
  let drained = false;
  return {
    started,
    cancelled,
    metadata,
    get drained() {
      return drained;
    },
    start(nodeId) {
      started.push(nodeId);
    },
    cancel(nodeId) {
      cancelled.push(nodeId);
    },
    enqueueMetadata(job) {
      metadata.push(job);
    },
    requestTitle(userId, nodeId) {
      metadata.push({ kind: "title", userId, nodeId });
      return Promise.resolve(null);
    },
    requestRecapCandidate(userId, nodeId, instructions) {
      metadata.push({ kind: "recap", userId, nodeId, instructions });
      return Promise.reject(new Error(METADATA_UNAVAILABLE));
    },
    recallRecapCandidate() {
      return null;
    },
    drain() {
      drained = true;
      return Promise.resolve();
    },
  };
}

/** How long a metadata run may take before the waiting caller gives up. The
 * job itself is not cancelled: a recap that lands late is still saved. */
export const METADATA_TIMEOUT_MS = 60_000;

/** Concurrent metadata runs (`04-agent-runtime.md` §10). */
export const METADATA_POOL_SIZE = 4;

/** How many times a node is auto-resumed after an interruption before it is
 * left `interrupted` for the user to retry (`05-run-lifecycle-and-streaming.md`
 * §3). */
export const MAX_AUTO_RESUMES = 2;

/** How often the claim loop looks for work it was not woken for — a backoff
 * that came due, or a slot another run freed. */
export const CLAIM_INTERVAL_MS = 250;

export interface RunsServiceDeps {
  config: Config;
  db: SessionDatabase;
  eventBus: EventBus;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
  /** Constructed from the config when absent. */
  providers?: Providers;
  metadata?: MetadataRunner;
  toolOverrides?: Pick<RunToolContext, "lookup" | "allowHosts">;
  /** Off in tests that drive the loop themselves. */
  autoStart?: boolean;
}

export interface AgentRunsService extends RunsService {
  /** Claims and runs whatever the caps allow, once. Awaited by tests instead
   * of waiting on the interval. */
  tick(): Promise<void>;
  /** Resolves when every attempt started so far has settled. */
  idle(): Promise<void>;
  readonly providers: Providers;
  readonly metadata: MetadataRunner;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

export function createRunsService(deps: RunsServiceDeps): AgentRunsService {
  const logger = deps.logger ?? createLogger({ level: "info" });
  const providers = deps.providers ?? createProviders(deps.config);
  const metadata =
    deps.metadata ??
    createMetadataRunner({
      config: deps.config,
      db: deps.db,
      eventBus: deps.eventBus,
      providers,
      logger,
    });
  const loopDeps: LoopDeps = {
    config: deps.config,
    db: deps.db,
    eventBus: deps.eventBus,
    providers,
    metadata,
    logger,
    caches: createToolCaches(),
    fetch: deps.fetch ?? globalThis.fetch,
    ...(deps.toolOverrides ? { toolOverrides: deps.toolOverrides } : {}),
  };

  const active = new Map<string, ActiveRun>();
  const requeues = new Map<string, number>();
  const metadataQueue: MetadataJob[] = [];
  const metadataRunning = new Set<Promise<void>>();
  let draining = false;
  let ticking: Promise<void> | null = null;

  const emit = (userId: string, type: string, payload: Record<string, unknown>): void => {
    deps.eventBus.emit(userId, sessionEvent(type, payload));
  };

  /** Everyone still waiting learns where they now stand (`05` §8). */
  const publishQueuePositions = (userId: string): void => {
    for (const [nodeId, position] of queueRepo.positions(deps.db, userId)) {
      const node = nodesRepo.get(deps.db, userId, nodeId);
      if (node && node.status === "queued") {
        emit(userId, "research.node.updated", { node, queuePosition: position });
      }
    }
  };

  const settleRateLimited = (userId: string, nodeId: string): void => {
    const spent = requeues.get(nodeId) ?? 0;
    const backoff = spent >= MAX_RATE_LIMIT_REQUEUES ? null : backoffFor(spent);
    if (backoff === null) {
      requeues.delete(nodeId);
      queueRepo.release(deps.db, nodeId);
      const node = nodesRepo.setStatus(deps.db, userId, nodeId, "failed", {
        error: "the model provider kept rate limiting this run; try again later",
      });
      emit(userId, "research.node.updated", { node });
      return;
    }
    requeues.set(nodeId, spent + 1);
    const node = nodesRepo.setStatus(deps.db, userId, nodeId, "queued");
    queueRepo.requeueWithBackoff(deps.db, nodeId, Date.now() + backoff);
    logger.info({ nodeId, backoffMs: backoff, attempt: spent + 1 }, "re-queued after a 429");
    emit(userId, "research.node.updated", { node });
  };

  const begin = (nodeId: string, userId: string, kind: "fresh" | "resume"): void => {
    if (active.has(nodeId)) {
      return;
    }
    const controller = new AbortController();
    const done = runAttempt(loopDeps, {
      userId,
      nodeId,
      kind,
      signal: controller.signal,
      isDraining: () => draining,
    })
      .then((result) => {
        if (result.outcome === "rate_limited") {
          settleRateLimited(userId, nodeId);
        } else {
          requeues.delete(nodeId);
          queueRepo.release(deps.db, nodeId);
        }
        if (result.outcome === "complete") {
          if (result.scheduleTitle === true) {
            service.enqueueMetadata({ kind: "title", userId, nodeId });
          }
          if (result.scheduleRecap === true) {
            service.enqueueMetadata({ kind: "recap", userId, nodeId });
          }
        }
      })
      .catch((error: unknown) => {
        logger.error({ nodeId, error }, "run attempt threw");
        queueRepo.release(deps.db, nodeId);
      })
      .finally(() => {
        active.delete(nodeId);
        publishQueuePositions(userId);
        if (!draining) {
          void service.tick();
        }
      });
    active.set(nodeId, { controller, done });
  };

  const runMetadataJob = async (job: MetadataJob): Promise<void> => {
    try {
      switch (job.kind) {
        case "title":
          await metadata.generateTitle(job.userId, job.nodeId);
          return;
        case "recap":
          await metadata.runScheduledRecap(job.userId, job.nodeId);
          return;
        case "encyclopedia":
          await metadata.generatePage(job.userId, job.workspaceId, job.slug);
          return;
      }
    } catch (error) {
      logger.warn({ job, error }, "metadata job failed");
    }
  };

  const pumpMetadata = (): void => {
    while (metadataRunning.size < METADATA_POOL_SIZE && metadataQueue.length > 0) {
      const job = metadataQueue.shift();
      if (!job) {
        return;
      }
      const promise = runMetadataJob(job).finally(() => {
        metadataRunning.delete(promise);
        pumpMetadata();
      });
      metadataRunning.add(promise);
    }
  };

  const withTimeout = async <T>(work: Promise<T>, message: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), METADATA_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const service: AgentRunsService = {
    providers,
    metadata,

    start() {
      // `autoStart: false` also means "claim only when asked": a test that
      // subscribes between admitting a node and running it would otherwise
      // miss the events the run has already emitted.
      if (!draining && deps.autoStart !== false) {
        void service.tick();
      }
    },

    cancel(nodeId) {
      active.get(nodeId)?.controller.abort();
      queueRepo.release(deps.db, nodeId);
    },

    enqueueMetadata(job) {
      metadataQueue.push(job);
      pumpMetadata();
    },

    requestTitle(userId, nodeId) {
      return withTimeout(
        metadata.generateTitle(userId, nodeId),
        "generating a title took too long",
      );
    },

    async requestRecapCandidate(userId, nodeId, instructions) {
      const candidate = await withTimeout(
        metadata.generateRecapCandidate(userId, nodeId, instructions),
        "generating the summary took too long; try again",
      );
      if (candidate === null) {
        throw new Error("this answer is too short to summarize");
      }
      return candidate;
    },

    recallRecapCandidate(id) {
      return metadata.recallRecapCandidate(id);
    },

    async tick() {
      if (draining) {
        return;
      }
      // One claim round at a time: two overlapping rounds would each see the
      // other's un-started claims as free capacity.
      if (ticking) {
        await ticking;
        return;
      }
      ticking = (async () => {
        const claimed = queueRepo.claim(deps.db, {
          pool: "research",
          perUser: deps.config.limits.perUser,
          perProvider: {
            vertex: deps.config.limits.vertex,
            openrouter: deps.config.limits.openrouter,
            anthropic: deps.config.limits.anthropic,
          },
        });
        const users = new Set<string>();
        for (const run of claimed) {
          users.add(run.userId);
          const node = nodesRepo.get(deps.db, run.userId, run.nodeId);
          if (!node) {
            queueRepo.release(deps.db, run.nodeId);
            continue;
          }
          // An interrupted node was re-queued by boot reconciliation; opening
          // a new attempt on it is what makes it runnable again, and its
          // committed turns come along as context (`05` §7).
          if (node.status === "interrupted") {
            const resumesSoFar = runsRepo
              .listAttempts(deps.db, node.id)
              .filter((attempt) => attempt.kind === "resume").length;
            if (resumesSoFar >= MAX_AUTO_RESUMES) {
              logger.warn({ nodeId: node.id }, "auto-resume gave up; leaving it interrupted");
              queueRepo.release(deps.db, node.id);
              continue;
            }
            const resumed = nodesRepo.resumeAttempt(deps.db, run.userId, node.id);
            emit(run.userId, "research.node.updated", { node: resumed });
            begin(run.nodeId, run.userId, "resume");
            continue;
          }
          if (nodesRepo.isTerminalStatus(node.status)) {
            queueRepo.release(deps.db, run.nodeId);
            continue;
          }
          begin(run.nodeId, run.userId, "fresh");
        }
        for (const userId of users) {
          publishQueuePositions(userId);
        }
        await Promise.resolve();
      })()
        .catch((error: unknown) => {
          // A claim round that throws must not take the process with it: the
          // most likely cause is the database closing under a test's feet.
          logger.error({ error }, "claim round failed");
        })
        .finally(() => {
          ticking = null;
        });
      await ticking;
    },

    async idle() {
      while (active.size > 0 || metadataRunning.size > 0) {
        await Promise.all([...[...active.values()].map((run) => run.done), ...metadataRunning]);
      }
    },

    async drain() {
      draining = true;
      const open = [...active.values()];
      for (const run of open) {
        run.controller.abort();
      }
      await Promise.all(open.map((run) => run.done));
      await Promise.all([...metadataRunning]);
    },
  };

  if (deps.autoStart !== false) {
    const timer = setInterval(() => {
      void service.tick();
    }, CLAIM_INTERVAL_MS);
    timer.unref();
  }

  return service;
}
