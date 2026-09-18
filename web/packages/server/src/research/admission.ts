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
 * can reach it at all. Both answer `PRECONDITION_FAILED`: a client that shows
 * a model it should not have is a stale client, not a forbidden user
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
 * Daily token and run limits (`06-auth-and-users.md` §8). Usage is recorded
 * whatever `SESSION_ENFORCE_LIMITS` says; only the refusal is switched.
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
          ? "you have reached today's research limit; it resets at midnight UTC"
          : "you have reached today's token limit; it resets at midnight UTC",
    });
  }
}

/** Puts an admitted node in the run queue and wakes the agent loop. The
 * database row is what survives a restart; `runs.start` is only a nudge. */
export function enqueueRun(ctx: LaunchContext, nodeId: string, modelId: string): void {
  const provider = findModel(modelId)?.provider ?? modelId;
  repo(() => queue.enqueue(ctx.db, ctx.user.id, { nodeId, pool: "research", provider }));
  ctx.runs.start(nodeId);
}

/** 1-based place in the queue while the node waits, absent once it is claimed. */
export function queuePositionOf(ctx: LaunchContext, nodeId: string): number | undefined {
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
export function nodeContent(ctx: LaunchContext, nodeId: string): ResearchNodeContent {
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
    content.sourceError = node.error ?? "this research produced no readable response";
  }
  if (node.status === "queued") {
    const position = queuePositionOf(ctx, nodeId);
    if (position !== undefined) {
      content.queuePosition = position;
    }
  }
  return content;
}
