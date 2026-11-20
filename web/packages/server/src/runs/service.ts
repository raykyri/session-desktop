// Integration between the API and the agent loop.
//
// The API admits a node by inserting the database row, enqueuing it in `run_queue`,
// and emitting events. This module processes the queue under concurrency limits,
// streams provider responses, re-queues rate-limited attempts, handles `SIGTERM`
// draining, and manages the metadata execution pool for titles and recaps
// (`04-agent-runtime.md` §2, §9, `05-run-lifecycle-and-streaming.md` §7, §8).

import type { SessionDatabase } from "@session/db";
import {
  nextUtcMidnight,
  nodes as nodesRepo,
  queue as queueRepo,
  runs as runsRepo,
  users as usersRepo,
} from "@session/db";
import type { ResearchNode, ResearchRecapCandidate } from "@session/shared";
import { nodeStatus } from "@session/shared/lib/researchNodeTypes";

import type { Config } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { sessionEvent } from "../events/bus.js";
import { emitFeedItemUpsertedForNode } from "../events/feed.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { dailyLimitWait } from "../research/admission.js";
import type { FollowupDeps } from "../research/followups.js";
import { dispatchTree } from "../research/followups.js";
import { notifyRunFinished } from "../research/notifications.js";

import { backoffFor, MAX_RATE_LIMIT_REQUEUES } from "./errors.js";
import type { LoopDeps } from "./loop.js";
import { runAttempt } from "./loop.js";
import type { MetadataRunner } from "./metadata.js";
import { createMetadataRunner } from "./metadata.js";
import type { Providers } from "./providers.js";
import { createProviders } from "./providers.js";
import { createToolCaches } from "./tools/context.js";
import type { RunToolContext } from "./tools/context.js";

/** A run on `gemini-flash` that produces a title or recap rather than an answer (`04-agent-runtime.md` §9). It has no node of its
 * own, so it cannot be addressed by node id like a research run. */
export type MetadataJob =
  | { kind: "title"; userId: string; nodeId: string }
  | { kind: "recap"; userId: string; nodeId: string; instructions?: string };

export interface RunsService {
  /** A node has been admitted and enqueued; notify the claim loop to process the queue. */
  start(nodeId: string): void;
  /** The node's status has already been written; abort its provider stream if
   * one is open. */
  cancel(nodeId: string): void;
  /** Schedule a metadata run. Separate pool, separate concurrency. */
  enqueueMetadata(job: MetadataJob): void;
  /** Generates and returns a title for `research.generateTitle`. */
  requestTitle(userId: string, nodeId: string): Promise<string | null>;
  /** Generates and returns a recap candidate for display. */
  requestRecapCandidate(
    userId: string,
    nodeId: string,
    instructions: string,
  ): Promise<ResearchRecapCandidate>;
  /** Retrieves the recap candidate generated under `id`, allowing
   * `recaps.applyCandidate` to verify and store generated text rather than
   * unverified client input. */
  recallRecapCandidate(userId: string, id: string): ResearchRecapCandidate | null;
  /** `SIGTERM`: stop admitting, persist checkpoints, mark open attempts
   * `interrupted` with `resume_pending` (`05` §7). Resolves when it is safe to
   * exit. */
  drain(): Promise<void>;
}

export interface NoopRunsService extends RunsService {
  /** The sequence of requested operations, recorded for Phase 3 test assertions. */
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

/** Timeout for awaiting a metadata run. The background execution continues
 * if the timeout expires, preserving late completions. */
export const METADATA_TIMEOUT_MS = 60_000;

/** Concurrent metadata runs (`04-agent-runtime.md` §10). */
export const METADATA_POOL_SIZE = 4;

/** Maximum automatic resume attempts after an interruption before the node is
 * left `interrupted` for the user to retry (`05-run-lifecycle-and-streaming.md`
 * §3). */
export const MAX_AUTO_RESUMES = 2;

/** How often the claim loop checks for available queue items that have expired
 * backoff timers or freed concurrency capacity. */
export const CLAIM_INTERVAL_MS = 250;

/** Maximum wait duration in the run queue for a parent run before
 * re-evaluating. Completion of the parent run triggers earlier processing. */
export const PARENT_WAIT_MS = 60_000;

/** How long a claimed node waits when its previous attempt is still
 * terminating (such as a retry or rerun immediately following cancellation).
 * Completion of that attempt allows earlier processing; this interval bounds
 * missed notifications. */
export const PREVIOUS_ATTEMPT_WAIT_MS = 1_000;

/** Error message for a node whose parent run terminated without completing
 * an answer. */
export const PARENT_INCOMPLETE = "The answer this question follows did not complete.";

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
  /** Nodes claimed while an earlier attempt was still active, deferred until
   * that attempt completes (`begin`). */
  const deferred = new Set<string>();
  const metadataQueue: MetadataJob[] = [];
  const metadataRunning = new Set<Promise<void>>();
  let draining = false;
  let ticking: Promise<void> | null = null;
  let tickAgain = false;

  /** Broadcasts a node event to thread viewers and the requesting `userId`. */
  const emit = (userId: string, type: string, payload: Record<string, unknown>): void => {
    const event = sessionEvent(type, payload);
    const treeId = (payload["node"] as ResearchNode | undefined)?.treeId;
    if (treeId === undefined) deps.eventBus.emit(userId, event);
    else deps.eventBus.emitToTree(treeId, event, [userId]);
  };

  /** Broadcasts updated queue positions to waiting clients. */
  const publishQueuePositions = (userId: string): void => {
    for (const [nodeId, position] of queueRepo.positions(deps.db, userId)) {
      const node = nodesRepo.get(deps.db, userId, nodeId);
      if (node && nodeStatus(node) === "queued") {
        emit(userId, "research.node.updated", { node, queuePosition: position });
      }
    }
  };

  /** Counts prior rate-limit attempts from run_attempts to persist retry state across server restarts. */
  const rateLimitedSoFar = (nodeId: string): number =>
    runsRepo.listAttempts(deps.db, nodeId).filter((attempt) => attempt.outcome === "rate_limited")
      .length;

  const settleRateLimited = (userId: string, nodeId: string): void => {
    // The attempt has already recorded its `rate_limited` status,
    // so the count increments and applies the initial backoff.
    const spent = rateLimitedSoFar(nodeId);
    const backoff = spent > MAX_RATE_LIMIT_REQUEUES ? null : backoffFor(spent - 1);
    if (backoff === null) {
      queueRepo.release(deps.db, nodeId);
      const node = nodesRepo.setStatus(deps.db, userId, nodeId, "failed", {
        error: "Model provider rate limit exceeded repeatedly; please try again later",
      });
      emit(userId, "research.node.updated", { node });
      emitFeedItemUpsertedForNode(deps, node.id);
      return;
    }
    const node = nodesRepo.requeueAfterRateLimit(deps.db, userId, nodeId);
    queueRepo.requeueWithBackoff(deps.db, nodeId, Date.now() + backoff);
    logger.info({ nodeId, backoffMs: backoff, requeue: spent }, "re-queued after a 429");
    emit(userId, "research.node.updated", { node });
    emitFeedItemUpsertedForNode(deps, node.id);
  };

  /** Fails a node if an unhandled error occurred outside loop settlement,
   * ensuring nodes do not remain `running`. Only applied while the failed
   * attempt is still current for the node. */
  const settleUnhandled = (nodeId: string, userId: string, attempt: number): void => {
    try {
      if (nodesRepo.attemptOf(deps.db, nodeId) !== attempt) {
        return;
      }
      const node = nodesRepo.get(deps.db, userId, nodeId);
      if (!node || nodesRepo.isTerminalStatus(nodeStatus(node))) {
        return;
      }
      const failed = nodesRepo.setStatus(deps.db, userId, nodeId, "failed", {
        error: "Research execution terminated unexpectedly; please retry",
      });
      emit(userId, "research.node.updated", { node: failed });
      emitFeedItemUpsertedForNode(deps, failed.id);
    } catch (error) {
      logger.error({ nodeId, error }, "could not settle a node after a failed attempt");
    }
  };

  const followupDeps: FollowupDeps = {
    config: deps.config,
    db: deps.db,
    eventBus: deps.eventBus,
    logger,
    runs: { start: (nodeId) => service.start(nodeId) },
  };

  /** When a run completes, release dependent follow-up runs. Queued reruns
   * and retries held in `parentGate` become claimable immediately, and pending
   * tree follow-ups are dispatched. */
  const afterSettle = (userId: string, nodeId: string): void => {
    try {
      queueRepo.wakeChildrenOf(deps.db, nodeId);
      const node = nodesRepo.get(deps.db, userId, nodeId);
      if (node) {
        dispatchTree(followupDeps, node.treeId);
      }
    } catch (error) {
      logger.error({ nodeId, error }, "could not dispatch follow-ups after a run settled");
    }
  };

  /**
   * Determines whether a claimed node may start. If the parent run is still
   * active, the node must wait; if the parent terminated without completing an
   * answer, the child run fails. Posts and documents do not execute runs and
   * never block child nodes.
   */
  const parentGate = (userId: string, node: ResearchNode): "start" | "wait" | "fail" => {
    if (!node.parentNodeId) {
      return "start";
    }
    const parent = nodesRepo.get(deps.db, userId, node.parentNodeId);
    if (!parent || parent.type !== "exchange" || parent.run.status === "complete") {
      return "start";
    }
    const status = parent.run.status;
    const active =
      status === "queued" ||
      status === "starting" ||
      status === "running" ||
      (status === "interrupted" && parent.run.resumePending === true);
    return active ? "wait" : "fail";
  };

  /**
   * Starts the claimed attempt for the node. Attempt completion logic is
   * scoped to its attempt number: if a retry or rerun replaced it before the
   * aborted stream finished terminating, this attempt does not release the
   * queue row, update status, or send notifications belonging to the newer attempt.
   */
  /**
   * Verifies account daily usage limits before starting a fresh attempt
   * (`06-auth-and-users.md` §8). If limits were reduced or tokens consumed
   * concurrently, exceeded nodes remain `queued` with backoff until the next UTC
   * midnight (or until updated via `admin.setLimits`), recording the reason in
   * the run error field published with queue positions. Rate-limited re-queues
   * and resumed attempts bypass this check.
   */
  const heldForDailyLimits = (userId: string, nodeId: string): boolean => {
    if (!deps.config.limits.enforceDailyLimits) {
      return false;
    }
    if (runsRepo.listAttempts(deps.db, nodeId).at(-1)?.outcome === "rate_limited") {
      return false;
    }
    const payer = usersRepo.findById(deps.db, userId);
    const wait =
      payer === null ? null : dailyLimitWait({ config: deps.config, db: deps.db, user: payer });
    if (wait === null) {
      return false;
    }
    queueRepo.requeueWithBackoff(deps.db, nodeId, nextUtcMidnight(Date.now()));
    nodesRepo.noteQueuedWait(deps.db, nodeId, wait);
    logger.info({ nodeId, userId }, "queued run held for the daily limits");
    return true;
  };

  const begin = (nodeId: string, userId: string, kind: "fresh" | "resume"): void => {
    if (active.has(nodeId)) {
      // The previous attempt for this node is still active. To prevent leaving
      // the queue row claimed without active execution, re-queue with backoff
      // until the prior attempt completes.
      queueRepo.requeueWithBackoff(deps.db, nodeId, Date.now() + PREVIOUS_ATTEMPT_WAIT_MS);
      deferred.add(nodeId);
      return;
    }
    const attempt = nodesRepo.attemptOf(deps.db, nodeId);
    if (attempt === null) {
      queueRepo.release(deps.db, nodeId);
      return;
    }
    const owned = (): boolean => nodesRepo.attemptOf(deps.db, nodeId) === attempt;
    const controller = new AbortController();
    const done = runAttempt(loopDeps, {
      userId,
      nodeId,
      kind,
      signal: controller.signal,
      isDraining: () => draining,
      attempt,
    })
      .then((result) => {
        if (result.outcome === "superseded" || !owned()) {
          return;
        }
        if (result.outcome === "rate_limited") {
          settleRateLimited(userId, nodeId);
        } else {
          queueRepo.releaseAttempt(deps.db, nodeId, attempt);
          // Notify the requesting user that the run finished or failed.
          const settled = nodesRepo.get(deps.db, userId, nodeId);
          if (settled) notifyRunFinished(deps, settled);
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
        queueRepo.releaseAttempt(deps.db, nodeId, attempt);
        // The loop handles expected failures directly. If an unhandled exception
        // occurs outside loop error handling (such as a database write error
        // during turn commit), mark the node failed to prevent remaining in
        // `running` status until server reconciliation.
        settleUnhandled(nodeId, userId, attempt);
      })
      .finally(() => {
        active.delete(nodeId);
        // Clear backoff for any attempt deferred while this attempt was active.
        if (deferred.delete(nodeId)) {
          queueRepo.clearBackoff(deps.db, nodeId);
        }
        if (!draining) {
          afterSettle(userId, nodeId);
        }
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
      // When `autoStart: false`, claim only when explicitly triggered so tests
      // can subscribe before execution begins and receive all emitted events.
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
      return withTimeout(metadata.generateTitle(userId, nodeId), "Title generation timed out");
    },

    async requestRecapCandidate(userId, nodeId, instructions) {
      const candidate = await withTimeout(
        metadata.generateRecapCandidate(userId, nodeId, instructions),
        "Recap generation timed out; please retry",
      );
      if (candidate === null) {
        throw new Error("Response content is too short to summarize");
      }
      return candidate;
    },

    recallRecapCandidate(userId, id) {
      return metadata.recallRecapCandidate(userId, id);
    },

    async tick() {
      if (draining) {
        return;
      }
      // Process one claim round at a time to prevent overlapping passes from
      // double-allocating capacity. A notification arriving during an active round
      // sets `tickAgain` to trigger a subsequent pass after completion.
      if (ticking) {
        tickAgain = true;
        await ticking;
        return;
      }
      tickAgain = false;
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
            // The requesting user no longer has thread access (left or removed):
            // terminate the run permanently rather than re-queuing on restart.
            const stopped = nodesRepo.stopRun(deps.db, run.nodeId, nodesRepo.ASKER_GONE_ERROR);
            if (stopped) {
              deps.eventBus.emitToTree(
                stopped.treeId,
                sessionEvent("research.node.updated", { node: stopped }),
              );
              emitFeedItemUpsertedForNode(deps, stopped.id);
              queueRepo.wakeChildrenOf(deps.db, stopped.id);
              dispatchTree(followupDeps, stopped.treeId);
            }
            continue;
          }
          // An interrupted node was re-queued during startup reconciliation;
          // starting a new attempt resumes it with committed turns as context (`05` §7).
          if (nodeStatus(node) === "interrupted") {
            const resumesSoFar = runsRepo
              .listAttempts(deps.db, node.id)
              .filter((attempt) => attempt.kind === "resume").length;
            if (resumesSoFar >= MAX_AUTO_RESUMES) {
              logger.warn(
                { nodeId: node.id },
                "maximum automatic resume attempts reached; node remains interrupted",
              );
              // Clear resumePending to prevent repeated re-queuing on subsequent restarts.
              nodesRepo.clearResumePending(deps.db, run.userId, node.id);
              // The node is now terminal; dependent operations may proceed.
              const settled = nodesRepo.get(deps.db, run.userId, node.id);
              if (settled) {
                emit(run.userId, "research.node.updated", { node: settled });
                emitFeedItemUpsertedForNode(deps, settled.id);
              }
              afterSettle(run.userId, node.id);
              continue;
            }
            const resumed = nodesRepo.resumeAttempt(deps.db, run.userId, node.id);
            emit(run.userId, "research.node.updated", { node: resumed });
            begin(run.nodeId, run.userId, "resume");
            continue;
          }
          if (nodesRepo.isTerminalStatus(nodeStatus(node))) {
            queueRepo.release(deps.db, run.nodeId);
            continue;
          }
          const gate = parentGate(run.userId, node);
          if (gate === "wait") {
            // Re-queued until parent run completion; the timeout bounds
            // delay if the completion notification is missed.
            queueRepo.requeueWithBackoff(deps.db, run.nodeId, Date.now() + PARENT_WAIT_MS);
            continue;
          }
          if (gate === "fail") {
            queueRepo.release(deps.db, run.nodeId);
            const failed = nodesRepo.setStatus(deps.db, run.userId, run.nodeId, "failed", {
              error: PARENT_INCOMPLETE,
            });
            emit(run.userId, "research.node.updated", { node: failed });
            emitFeedItemUpsertedForNode(deps, failed.id);
            afterSettle(run.userId, run.nodeId);
            continue;
          }
          if (heldForDailyLimits(run.userId, run.nodeId)) {
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
          // Catches queue claim errors to prevent process termination if the database closes during teardown.
          logger.error({ error }, "claim round failed");
        })
        .finally(() => {
          ticking = null;
        });
      await ticking;
      if (tickAgain && !draining) {
        await service.tick();
      }
    },

    async idle() {
      while (active.size > 0 || metadataRunning.size > 0) {
        await Promise.all([...[...active.values()].map((run) => run.done), ...metadataRunning]);
      }
    },

    async drain() {
      draining = true;
      tickAgain = false;
      // Await in-progress claim passes so starting attempts register in `active`
      // before controllers are aborted and drained.
      await ticking?.catch(() => undefined);
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
