// Integration between the API and the agent loop.
//
// The API admits a node: it writes the row, enqueues it in `run_queue`, and
// emits the events. Everything after that is this module — claiming the queue
// under the concurrency caps, opening the provider stream, re-queueing a
// rate-limited attempt, draining on `SIGTERM` — and the metadata pool that
// titles and recaps run in
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
  /** The candidate this server issued to this account under `id`, so
   * `recaps.applyCandidate` stores the text that was generated rather than the
   * text it was handed. */
  recallRecapCandidate(userId: string, id: string): ResearchRecapCandidate | null;
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
 * job itself is not cancelled: a recap that finishes late is still saved. */
export const METADATA_TIMEOUT_MS = 60_000;

/** Concurrent metadata runs (`04-agent-runtime.md` §10). */
export const METADATA_POOL_SIZE = 4;

/** Maximum automatic resume attempts after an interruption before the node is
 * left `interrupted` for the user to retry (`05-run-lifecycle-and-streaming.md`
 * §3). */
export const MAX_AUTO_RESUMES = 2;

/** How often the claim loop looks for work it was not woken for — a backoff
 * that came due, or a slot another run freed. */
export const CLAIM_INTERVAL_MS = 250;

/** The longest a node waits in the run queue for its parent's run before it
 * is looked at again. The parent's settlement wakes it sooner. */
export const PARENT_WAIT_MS = 60_000;

/** How long a claimed node waits when its previous attempt is still
 * unwinding (a retry or rerun right after a cancel). That attempt's
 * settlement makes it claimable sooner; the delay only bounds a missed
 * wake-up. */
export const PREVIOUS_ATTEMPT_WAIT_MS = 1_000;

/** The error of a node whose parent settled without an answer while the
 * node waited for it. */
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
  /** Nodes claimed while an earlier attempt of theirs was still active, put
   * back to wait for it (`begin`). */
  const deferred = new Set<string>();
  const metadataQueue: MetadataJob[] = [];
  const metadataRunning = new Set<Promise<void>>();
  let draining = false;
  let ticking: Promise<void> | null = null;
  let tickAgain = false;

  /** A node event to everyone reading the node's thread, and to `userId`
   * (the run's asker). */
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
    // The attempt that just ended has already written its `rate_limited` row,
    // so the first 429 counts one and takes the first backoff.
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

  /** Last resort for an attempt that threw past the loop's own settlement:
   * a node no longer being run must not stay `running`. Only while the
   * attempt that threw is still the node's. */
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

  /** A run left `running`: release the follow-ups that wait on it. Its
   * reruns and retries held in the run queue (`parentGate`) become claimable
   * at once, and the thread's follow-up queues send what they can. */
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
   * Whether a claimed node may start: its parent's answer is its context, so
   * a parent that is still active (an answer being rerun ahead of a rerun of
   * its inline follow-up) holds it, and a parent that settled without an
   * answer fails it. Posts and documents have no run and never hold a child.
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
   * Starts the claimed node's attempt. Everything the attempt does when it
   * ends is fenced by its attempt number: once a retry or rerun has replaced
   * it (Cancel, then Retry, before the cancelled stream finished
   * unwinding), it releases no queue row, writes no status and sends no
   * notification, since those belong to the newer attempt now.
   */
  /**
   * Re-checks the payer's daily limits before a queued node's fresh attempt
   * starts (`06-auth-and-users.md` §8). Admission checked them, counting the
   * queue, but the queue can still hold more than the day allows: an
   * operator lowered the limit, tokens were spent meanwhile, a launch path
   * that did not count. A refused node stays `queued`, its row held until the
   * next UTC midnight (or until an operator changes the account's limits,
   * `admin.setLimits`), with the reason as its run's `error`, which the claim
   * round's queue positions publish. A 429 re-queue continues an attempt that
   * already started and is not held; nor is a resume, which never reaches
   * here.
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
      // The node's previous attempt has not settled yet. Dropping the claim
      // would leave the row claimed with nothing running it; it waits
      // instead, and that attempt's settlement makes it claimable.
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
          // The asker hears that their run finished or failed.
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
        // The loop completes the node for every expected failure; this is
        // the one it does not. A throw past its own handlers — a SQLite write
        // that failed while the last turn was being committed, most likely —
        // would otherwise leave the node `running` with nothing left to move
        // it, until a restart reconciled it hours later.
        settleUnhandled(nodeId, userId, attempt);
      })
      .finally(() => {
        active.delete(nodeId);
        // A newer attempt claimed while this one was active waits no longer.
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
      // One claim round at a time: two overlapping rounds would each see the
      // other's un-started claims as free capacity. A wake-up that arrives
      // mid-round is remembered rather than dropped — the round may already
      // have read the queue by then, and without the flag the node would wait
      // for the interval, or forever where there is no interval.
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
            // The payer can no longer read the thread (they left it or were
            // removed): nobody else may be billed, so the run stops for good
            // rather than waiting to be re-queued at the next boot.
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
          // An interrupted node was re-queued by boot reconciliation; opening
          // a new attempt on it is what makes it runnable again, and its
          // committed turns come along as context (`05` §7).
          if (nodeStatus(node) === "interrupted") {
            const resumesSoFar = runsRepo
              .listAttempts(deps.db, node.id)
              .filter((attempt) => attempt.kind === "resume").length;
            if (resumesSoFar >= MAX_AUTO_RESUMES) {
              logger.warn(
                { nodeId: node.id },
                "maximum automatic resume attempts reached; node remains interrupted",
              );
              // The flag goes with the queue row: left set, every later boot
              // would re-queue a node the runtime has already given up on.
              nodesRepo.clearResumePending(deps.db, run.userId, node.id);
              // The node is settled now: readers see that it will not resume
              // (Retry is offered), and what waited on it moves on.
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
            // Woken by `afterSettle` when the parent's run ends; the delay
            // only bounds how long a missed wake-up can hold it.
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
      // A claim round that was already past its `draining` check can still be
      // starting attempts; they have to be in `active` before it is read, or
      // the process would exit with a stream open and a node left `running`.
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
