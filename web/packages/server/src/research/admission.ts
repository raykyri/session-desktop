// Launch-time checks and the queue hand-off shared by `createTree`,
// `forkNode`, `retryNode`, `rerunNode` and the follow-up queue (`03-api-and-events.md` §2,
// `05-run-lifecycle-and-streaming.md` §8, `06-auth-and-users.md` §8).

import type { SessionDatabase } from "@session/db";
import { nodes, queue, runs as runsRepo, snapshots, transact, usage } from "@session/db";
import type { ResearchNodeContent, User } from "@session/shared";
import { METADATA_MODEL_ID, canUseModel, findModel } from "@session/shared";
import { nodeRun, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { TRPCError } from "@trpc/server";

import type { Config } from "../config.js";
import type { AppContext } from "../trpc/base.js";
import { takeBudget } from "../trpc/base.js";
import { repo, required } from "../trpc/errors.js";

export interface LaunchContext extends AppContext {
  user: NonNullable<AppContext["user"]>;
}

/** Inputs for launch admission checks: deployment configuration, database,
 * and requesting user. Procedures supply request context; the follow-up
 * queue supplies the author of the queued item. */
export interface LaunchCheckContext {
  config: Config;
  db: SessionDatabase;
  user: Pick<User, "id" | "isAdmin">;
}

/** Admission refusal details: the tRPC code thrown by procedures and stored
 * as `failedReason` for queued items. */
export interface LaunchRefusal {
  code: "PRECONDITION_FAILED" | "TOO_MANY_REQUESTS";
  message: string;
}

function raise(refusal: LaunchRefusal | null): void {
  if (refusal !== null) {
    throw new TRPCError(refusal);
  }
}

/** Returns a refusal reason if the user or deployment cannot use this model, or null. */
export function modelRefusal(ctx: LaunchCheckContext, modelId: string): LaunchRefusal | null {
  const model = findModel(modelId);
  if (!model || !canUseModel(ctx.user, modelId)) {
    return { code: "PRECONDITION_FAILED", message: `${modelId} is not available on this account` };
  }
  if (!ctx.config.credentials[model.provider]) {
    return {
      code: "PRECONDITION_FAILED",
      message: `${model.label} is not configured on this deployment`,
    };
  }
  return null;
}

/**
 * Asserts that the requested model is accessible to the account and configured
 * on the deployment. Throws PRECONDITION_FAILED if unavailable or unconfigured
 * (`04-agent-runtime.md` §1).
 */
export function assertModelUsable(ctx: LaunchCheckContext, modelId: string): string {
  raise(modelRefusal(ctx, modelId));
  return findModel(modelId)?.provider ?? modelId;
}

/** Validates that the reasoning effort is supported by the model (`ModelEntry.efforts`). */
export function assertEffortAccepted(modelId: string, effort: string | null | undefined): void {
  if (effort === null || effort === undefined) {
    return;
  }
  const model = findModel(modelId);
  if (model && !model.efforts.some((accepted) => accepted === effort)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${model.label} does not accept the reasoning effort '${effort}'`,
    });
  }
}

export interface DailyLimitOptions {
  /** When true, accounts for queued runs against the daily limit during
   * admission. When false, checks limits without reserving for currently
   * queued runs (used by the dispatcher). */
  reserveQueued?: boolean;
}

/** Determines whether daily run or token limits have been reached, returning
 * the exceeded limit type or null. */
function dailyLimitReached(
  ctx: LaunchCheckContext,
  options: DailyLimitOptions,
): "runs" | "tokens" | null {
  if (!ctx.config.limits.enforceDailyLimits) {
    return null;
  }
  const decision = usage.admissionCheck(ctx.db, ctx.user.id, {
    isAdmin: ctx.user.isAdmin,
    defaults: {
      dailyTokens: ctx.config.limits.dailyTokens,
      dailyRuns: ctx.config.limits.dailyRuns,
    },
    reservedRuns: options.reserveQueued === true ? queue.queuedCount(ctx.db, ctx.user.id) : 0,
  });
  return decision.allowed ? null : (decision.reason ?? "runs");
}

/** Returns a refusal if daily run or token limits are exceeded, or null. */
export function dailyLimitRefusal(
  ctx: LaunchCheckContext,
  options: DailyLimitOptions = {},
): LaunchRefusal | null {
  const reached = dailyLimitReached(ctx, options);
  if (reached === null) {
    return null;
  }
  return {
    code: "TOO_MANY_REQUESTS",
    message:
      reached === "runs"
        ? "You have reached your daily research limit. The limit resets at midnight UTC."
        : "You have reached your daily token limit. The limit resets at midnight UTC.",
  };
}

/**
 * Returns a status message displayed on waiting nodes when limits prevent a
 * queued run from starting, or null (`runs/service.ts`).
 */
export function dailyLimitWait(ctx: LaunchCheckContext): string | null {
  const reached = dailyLimitReached(ctx, { reserveQueued: false });
  if (reached === null) {
    return null;
  }
  return reached === "runs"
    ? "Queued until the daily research limit resets at midnight UTC."
    : "Queued until the daily token limit resets at midnight UTC.";
}

/**
 * Asserts that usage falls within daily token and run limits
 * (`06-auth-and-users.md` §8), accounting for queued requests as consumed quota.
 * Usage is tracked unconditionally; SESSION_ENFORCE_LIMITS controls whether
 * requests exceeding the limit are rejected.
 */
export function assertWithinDailyLimits(ctx: LaunchCheckContext): void {
  raise(dailyLimitRefusal(ctx, { reserveQueued: true }));
}

/** Checks if the user's queued run limit has been reached (`assertQueueHasRoom`). */
export function queueRoomRefusal(ctx: LaunchCheckContext): LaunchRefusal | null {
  if (ctx.user.isAdmin) {
    return null;
  }
  const cap = ctx.config.limits.queuedPerUser;
  if (queue.queuedCount(ctx.db, ctx.user.id) < cap) {
    return null;
  }
  return {
    code: "TOO_MANY_REQUESTS",
    message: `You already have ${cap} questions queued. Wait for running questions to finish before submitting more.`,
  };
}

/**
 * Enforces a maximum queue size per user (`SESSION_QUEUED_PER_USER`). While
 * concurrency limits control simultaneous executions and daily limits bound
 * total daily usage, the queue limit bounds pending workload. Unlike daily
 * usage limits, queue limits apply regardless of `SESSION_ENFORCE_LIMITS`.
 * Admins are exempt.
 */
export function assertQueueHasRoom(ctx: LaunchCheckContext): void {
  raise(queueRoomRefusal(ctx));
}

/** Evaluates admission checks that account for currently queued runs: daily
 * limits followed by queue capacity. */
export function admissionRefusal(ctx: LaunchCheckContext): LaunchRefusal | null {
  return dailyLimitRefusal(ctx, { reserveQueued: true }) ?? queueRoomRefusal(ctx);
}

/** Evaluates all launch admission checks in sequence: model availability,
 * daily limits, and queue capacity. */
export function launchRefusal(ctx: LaunchCheckContext, modelId: string): LaunchRefusal | null {
  return modelRefusal(ctx, modelId) ?? admissionRefusal(ctx);
}

/**
 * Admits a run: checks daily limits and queue capacity and executes `admit`
 * (creating or relaunching the node in `run_queue`) within a single transaction.
 * Synchronous transaction execution prevents concurrent requests from
 * exceeding queue limits. Call `ctx.runs.start` after this transaction commits.
 */
export function admitWithinLimits<T>(ctx: LaunchContext, admit: (db: SessionDatabase) => T): T {
  return transact(ctx.db, (tx) => {
    raise(admissionRefusal({ config: ctx.config, db: tx, user: ctx.user }));
    return admit(tx);
  });
}

/** Validates eligibility for metadata runs (title, recap), ensuring the model
 * is configured and daily limits are not exceeded. */
export function metadataRefusal(ctx: LaunchCheckContext): LaunchRefusal | null {
  return modelRefusal(ctx, METADATA_MODEL_ID) ?? dailyLimitRefusal(ctx);
}

/**
 * Validates rate limits and quota before executing an interactive metadata
 * request (`research.generateTitle`, `recaps.generateCandidate`).
 */
export function assertMetadataAllowed(ctx: LaunchContext): void {
  takeBudget(ctx, "metadata", "Too many titles and recaps requested; try again in a few minutes.");
  raise(metadataRefusal(ctx));
}

/**
 * Schedules automatic recap generation for an imported or edited document
 * (`import_research_report`, `update_research_document`). Attributed to the
 * authoring user; silently skipped if the user's account exceeds daily limits
 * or cannot access the metadata model.
 */
export function scheduleDocumentRecap(ctx: LaunchContext, nodeId: string): void {
  if (metadataRefusal(ctx) !== null) {
    return;
  }
  ctx.runs.enqueueMetadata({ kind: "recap", userId: ctx.user.id, nodeId });
}

/** Enqueues an admitted node in `run_queue`. Called within `admitWithinLimits`.
 * The record persists across restarts; `runs.start`, called after transaction
 * commit, notifies the execution loop. */
export function queueRun(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  modelId: string,
): void {
  const provider = findModel(modelId)?.provider ?? modelId;
  repo(() => queue.enqueue(db, userId, { nodeId, pool: "research", provider }));
}

/** Returns the 1-based position of a node in the queue, or undefined once claimed.
 * Callers must verify user read access. */
export function queuePositionOf(
  ctx: { db: AppContext["db"]; user: { id: string } | null },
  nodeId: string,
): number | undefined {
  const position = queue.position(ctx.db, null, nodeId);
  return position > 0 ? position : undefined;
}

/**
 * Loads all data needed to render a research node (`03-api-and-events.md` §4).
 * Resolution order: durable snapshot, live window from `run_turns`, and fallback
 * error messages for completed nodes with no readable content.
 */
export function nodeContent(
  ctx: { db: AppContext["db"]; user: { id: string } | null },
  nodeId: string,
): ResearchNodeContent {
  // Anyone who may read the thread, guests included for a public one.
  const userId = ctx.user?.id ?? null;
  const node = required(
    repo(() => nodes.get(ctx.db, userId, nodeId)),
    `research node ${nodeId} was not found`,
  );
  // Reads the snapshot prior to the live window so `seq` is monotonically
  // consistent with returned turns and avoids races with concurrent snapshot commits.
  const snapshot = repo(() => snapshots.read(ctx.db, userId, nodeId));
  const live = repo(() => runsRepo.liveWindow(ctx.db, userId, nodeId));

  const content: ResearchNodeContent = {
    node,
    turns: [],
    seq: live.seq,
  };
  if (snapshot && snapshot.turns.length > 0) {
    content.turns = snapshot.turns;
    content.responseRevision = snapshot.revision;
  } else if (live.turns.length > 0 || live.inFlightText !== undefined) {
    content.turns = live.turns;
    if (live.inFlightText !== undefined) {
      content.inFlightText = live.inFlightText;
    }
  } else if (node.type === "document") {
    content.sourceError = "This document's content is unavailable";
  } else if (node.type === "exchange" && nodes.isTerminalStatus(node.run.status)) {
    content.sourceError =
      nodeRun(node)?.error ?? "Research completed without generating response content";
  }
  if (nodeStatus(node) === "queued") {
    const position = queuePositionOf(ctx, nodeId);
    if (position !== undefined) {
      content.queuePosition = position;
    }
  }
  return content;
}
