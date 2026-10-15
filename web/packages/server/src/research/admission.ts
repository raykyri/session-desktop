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

/** What the launch checks read: the deployment's configuration, the
 * database, and the account that pays for the run. A procedure passes its
 * context; the follow-up queue passes the queued item's author. */
export interface LaunchCheckContext {
  config: Config;
  db: SessionDatabase;
  user: Pick<User, "id" | "isAdmin">;
}

/** A refused launch: the tRPC code a procedure throws, and the message the
 * follow-up queue stores as the item's `failedReason`. */
export interface LaunchRefusal {
  code: "PRECONDITION_FAILED" | "TOO_MANY_REQUESTS";
  message: string;
}

function raise(refusal: LaunchRefusal | null): void {
  if (refusal !== null) {
    throw new TRPCError(refusal);
  }
}

/** Why this account may not launch on this model, or null. */
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
 * Whether this account may launch on this model, and whether the deployment
 * can reach it at all. Returns PRECONDITION_FAILED when an unavailable or unconfigured model is requested, indicating client state needs refreshing.
 * (`04-agent-runtime.md` §1).
 */
export function assertModelUsable(ctx: LaunchCheckContext, modelId: string): string {
  raise(modelRefusal(ctx, modelId));
  return findModel(modelId)?.provider ?? modelId;
}

/** Refuses an effort the model does not accept (`ModelEntry.efforts`). Null
 * and absent mean the model's default. */
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
  /** Count the account's queued questions as runs already spent: true at
   * admission, so the queue cannot hold more than the day allows; false for
   * the dispatcher's check before a queued run starts, whose own row is
   * among them. */
  reserveQueued?: boolean;
}

/** Which daily limit refuses another run, or null. */
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

/** Why the account's daily limits refuse another run, or null. */
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
 * Why a queued run may not start now, as its waiting node shows it, or null:
 * the dispatcher's check of the payer's daily limits before a fresh attempt
 * (`runs/service.ts`). Worded for every reader of the thread, not only the
 * payer.
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
 * Daily token and run limits (`06-auth-and-users.md` §8), with the
 * account's queued questions counted as spent. Usage is tracked
 * unconditionally; SESSION_ENFORCE_LIMITS controls whether requests exceeding
 * the limit are rejected.
 */
export function assertWithinDailyLimits(ctx: LaunchCheckContext): void {
  raise(dailyLimitRefusal(ctx, { reserveQueued: true }));
}

/** Why the account's run queue is full, or null (`assertQueueHasRoom`). */
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
 * A ceiling on what one account may have *waiting* (`06-auth-and-users.md`
 * §8). The per-user concurrency cap (`SESSION_RUNS_PER_USER`) bounds how many
 * of an account's runs hold a provider stream at once, and the daily limits
 * bound the day; between them nothing bounds the queue, and a queued node is
 * spend the deployment has already committed to — a script that submits a
 * thousand questions is admitted a thousand times and billed for all of them
 * two at a time.
 *
 * Applies whatever `SESSION_ENFORCE_LIMITS` says, unlike the daily limits: the
 * daily ceilings are a billing policy an operator opts into, this is a
 * structural bound on the queue itself. Admins are exempt, as they are there.
 */
export function assertQueueHasRoom(ctx: LaunchCheckContext): void {
  raise(queueRoomRefusal(ctx));
}

/** The checks that depend on what the account has already queued: the
 * daily limits with the queue counted as spent, then the queue cap. */
export function admissionRefusal(ctx: LaunchCheckContext): LaunchRefusal | null {
  return dailyLimitRefusal(ctx, { reserveQueued: true }) ?? queueRoomRefusal(ctx);
}

/** Every check a launch passes, in the order the procedures apply them: the
 * model, the daily limits, the run queue. */
export function launchRefusal(ctx: LaunchCheckContext, modelId: string): LaunchRefusal | null {
  return modelRefusal(ctx, modelId) ?? admissionRefusal(ctx);
}

/**
 * Admits a run: checks the daily limits and the queue cap again and runs
 * `admit` (the repository write that creates or relaunches the node and puts
 * it in `run_queue`) in one transaction. Nothing is awaited between the check
 * and the write, so two requests that both passed the procedure's early
 * checks before an `await` (resolving a linked post) cannot both be
 * admitted past the cap. The early checks stay so that a launch that will be
 * refused does not spend a fetch. Call `ctx.runs.start` after it returns,
 * outside the transaction.
 */
export function admitWithinLimits<T>(ctx: LaunchContext, admit: (db: SessionDatabase) => T): T {
  return transact(ctx.db, (tx) => {
    raise(admissionRefusal({ config: ctx.config, db: tx, user: ctx.user }));
    return admit(tx);
  });
}

/** Why a metadata run (a title, a recap) may not be billed to this account
 * now, or null: the metadata model must be usable on this deployment and the
 * account's daily limits must allow another run. */
export function metadataRefusal(ctx: LaunchCheckContext): LaunchRefusal | null {
  return modelRefusal(ctx, METADATA_MODEL_ID) ?? dailyLimitRefusal(ctx);
}

/**
 * The checks before a metadata run someone asked for and waits on
 * (`research.generateTitle`, `recaps.generateCandidate`): the account's
 * metadata budget (`RATE_LIMITS.metadata`), then `metadataRefusal`. The
 * requester pays for the run.
 */
export function assertMetadataAllowed(ctx: LaunchContext): void {
  takeBudget(ctx, "metadata", "Too many titles and recaps requested; try again in a few minutes.");
  raise(metadataRefusal(ctx));
}

/**
 * Schedules the automatic recap of an imported report: after the import and
 * after an edit of its body, which clears its recap (the desktop's
 * `research_recap::schedule` in `import_research_report` and
 * `update_research_document`). Billed to the person who imported or edited
 * it, and skipped without a word when their metadata model or daily limits
 * refuse it, as an automatic recap is. The metadata runner checks the node
 * again (`shouldScheduleRecap`) when the job runs.
 */
export function scheduleDocumentRecap(ctx: LaunchContext, nodeId: string): void {
  if (metadataRefusal(ctx) !== null) {
    return;
  }
  ctx.runs.enqueueMetadata({ kind: "recap", userId: ctx.user.id, nodeId });
}

/** Puts an admitted node in the run queue, inside `admitWithinLimits`. The
 * row persists across restarts; `runs.start`, called once the transaction
 * has committed, only wakes the agent loop. */
export function queueRun(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  modelId: string,
): void {
  const provider = findModel(modelId)?.provider ?? modelId;
  repo(() => queue.enqueue(db, userId, { nodeId, pool: "research", provider }));
}

/** 1-based place in the queue while the node waits, absent once it is
 * claimed. Whoever pays for the run; the caller has checked that `ctx.user`
 * may read the node. */
export function queuePositionOf(
  ctx: { db: AppContext["db"]; user: { id: string } | null },
  nodeId: string,
): number | undefined {
  const position = queue.position(ctx.db, null, nodeId);
  return position > 0 ? position : undefined;
}

/**
 * Everything one node needs to render (`03-api-and-events.md` §4). Source
 * preference follows the desktop's `main.rs:1843`: the durable snapshot, then
 * the live window from `run_turns`, then an explanation for a finished node
 * that produced nothing readable.
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
  // The snapshot is read first so `seq`, read with the live window, is never
  // older than the turns returned beside it: a snapshot committed between the
  // two reads costs the client a refetch, not a silently stale sequence.
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
