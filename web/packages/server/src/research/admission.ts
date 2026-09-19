// Launch-time checks and the queue hand-off shared by `createTree`,
// `forkNode`, and `retryNode` (`03-api-and-events.md` §2,
// `05-run-lifecycle-and-streaming.md` §8, `06-auth-and-users.md` §8).

import { nodes, queue, runs as runsRepo, snapshots, trees, usage } from "@session/db";
import type { ResearchNodeContent, ResearchNodeCard } from "@session/shared";
import { canUseModel, findModel } from "@session/shared";
import { TRPCError } from "@trpc/server";

import type { AppContext } from "../trpc/base.js";
import { repo, required } from "../trpc/errors.js";

export interface LaunchContext extends AppContext {
  user: NonNullable<AppContext["user"]>;
}

/**
 * Whether this account may launch on this model, and whether the deployment
 * can reach it at all. Returns PRECONDITION_FAILED when an unavailable or unconfigured model is requested, indicating client state needs refreshing.
 * (`04-agent-runtime.md` §1).
 */
export function assertModelUsable(ctx: LaunchContext, modelId: string): string {
  const model = findModel(modelId);
  if (!model || !canUseModel(ctx.user, modelId)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${modelId} is not available on this account`,
    });
  }
  if (!ctx.config.credentials[model.provider]) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${model.label} is not configured on this deployment`,
    });
  }
  return model.provider;
}

/**
 * Daily token and run limits (`06-auth-and-users.md` §8). Usage is tracked unconditionally; SESSION_ENFORCE_LIMITS controls whether requests exceeding the limit are rejected.
 */
export function assertWithinDailyLimits(ctx: LaunchContext): void {
  if (!ctx.config.limits.enforceDailyLimits) {
    return;
  }
  const decision = usage.admissionCheck(ctx.db, ctx.user.id, {
    isAdmin: ctx.user.isAdmin,
    defaults: {
      dailyTokens: ctx.config.limits.dailyTokens,
      dailyRuns: ctx.config.limits.dailyRuns,
    },
  });
  if (!decision.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        decision.reason === "runs"
          ? "You have reached your daily research limit. The limit resets at midnight UTC."
          : "You have reached your daily token limit. The limit resets at midnight UTC.",
    });
  }
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
export function assertQueueHasRoom(ctx: LaunchContext): void {
  if (ctx.user.isAdmin) {
    return;
  }
  const cap = ctx.config.limits.queuedPerUser;
  if (queue.queuedCount(ctx.db, ctx.user.id) < cap) {
    return;
  }
  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: `You already have ${cap} questions queued. Wait for running questions to finish before submitting more.`,
  });
}

/** Puts an admitted node in the run queue and wakes the agent loop. The
 * database row is what survives a restart; `runs.start` is only a nudge. */
export function enqueueRun(ctx: LaunchContext, nodeId: string, modelId: string): void {
  const provider = findModel(modelId)?.provider ?? modelId;
  repo(() => queue.enqueue(ctx.db, ctx.user.id, { nodeId, pool: "research", provider }));
  ctx.runs.start(nodeId);
}

/** 1-based place in the queue while the node waits, absent once it is claimed. */
export function queuePositionOf(
  ctx: { db: AppContext["db"]; user: { id: string } },
  nodeId: string,
): number | undefined {
  const position = queue.position(ctx.db, ctx.user.id, nodeId);
  return position > 0 ? position : undefined;
}

function toCard(node: {
  id: string;
  prompt: string;
  responsePreview?: string | null;
  status: ResearchNodeCard["status"];
  createdAt: number;
}): ResearchNodeCard {
  return {
    id: node.id,
    prompt: node.prompt,
    responsePreview: node.responsePreview ?? null,
    status: node.status,
    createdAt: node.createdAt,
  };
}

/**
 * Everything one node needs to render (`03-api-and-events.md` §4). Source
 * preference follows the desktop's `main.rs:1843`: the durable snapshot, then
 * the live window from `run_turns`, then an explanation for a finished node
 * that produced nothing readable.
 */
export function nodeContent(
  ctx: { db: AppContext["db"]; user: { id: string } },
  nodeId: string,
): ResearchNodeContent {
  const node = required(
    repo(() => nodes.get(ctx.db, ctx.user.id, nodeId)),
    `research node ${nodeId} was not found`,
  );
  const detail = repo(() => trees.detail(ctx.db, ctx.user.id, node.treeId));
  const children = detail.nodes.filter((child) => child.parentNodeId === node.id).map(toCard);
  // The snapshot is read first so `seq`, read with the live window, is never
  // older than the turns returned beside it: a snapshot committed between the
  // two reads costs the client a refetch, not a silently stale sequence.
  const snapshot = repo(() => snapshots.read(ctx.db, ctx.user.id, nodeId));
  const live = repo(() => runsRepo.liveWindow(ctx.db, ctx.user.id, nodeId));

  const content: ResearchNodeContent = {
    node,
    turns: [],
    children,
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
  } else if (nodes.isTerminalStatus(node.status)) {
    content.sourceError = node.error ?? "Research completed without generating response content";
  }
  if (node.status === "queued") {
    const position = queuePositionOf(ctx, nodeId);
    if (position !== undefined) {
      content.queuePosition = position;
    }
  }
  return content;
}
