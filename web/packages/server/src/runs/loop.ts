// One attempt of one node (`04-agent-runtime.md` §3,
// `05-run-lifecycle-and-streaming.md` §4, §5).
//
// Load the node's context, open the provider stream, map its parts into turns,
// persist them as they settle, publish what a client needs to follow along,
// and settle the node. The module is provider-neutral: everything a particular
// provider needs is already in the `ResolvedModel` it is handed.
//
// Two rules shape persistence. Committed turns and the node sequence counter
// update in one transaction, so sequence *n* identifies the turns persisted
// through that event. In-flight text is checkpointed at most once per second or
// every 4 KiB to limit data loss during server restarts.

import type { SessionDatabase } from "@session/db";
import {
  documents as documentsRepo,
  messages as messagesRepo,
  nodes as nodesRepo,
  preferences as preferencesRepo,
  queue as queueRepo,
  researchDocuments,
  runs as runsRepo,
  snapshots as snapshotsRepo,
} from "@session/db";
import type { DocumentInfo, ResearchNode, Turn } from "@session/shared";
import { responsePreview } from "@session/shared";
import type { ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";

import type { Config } from "../config.js";
import type { EventBus } from "../events/bus.js";
import { sessionEvent } from "../events/bus.js";
import { emitFeedItemUpsertedForNode } from "../events/feed.js";
import type { Logger } from "../logger.js";

import type { ClassifiedError } from "./errors.js";
import { classifyRunError, refusalError, timeoutError } from "./errors.js";
import {
  createGroundingRedirectResolver,
  resolveGroundingRedirects,
} from "./groundingRedirects.js";
import { TurnMapper } from "./mapper.js";
import { buildMessages, messagesFromCommittedTurns } from "./messages.js";
import type { MetadataRunner } from "./metadata.js";
import { researchSystemPrompt, researchUserText } from "./prompts.js";
import type { Providers } from "./providers.js";
import { commitAnswer } from "./snapshots.js";
import type { RunToolContext, ToolCaches } from "./tools/context.js";
import { ToolBudget } from "./tools/context.js";
import { buildTools } from "./tools/index.js";
import { attemptUsageOf, costOf, recordAttemptUsage, recordToolUsage } from "./usage.js";

/** `04-agent-runtime.md` §3. */
export const MAX_STEPS = 25;

/** `05-run-lifecycle-and-streaming.md` §4, §5. */
export const DELTA_INTERVAL_MS = 50;
export const CHECKPOINT_INTERVAL_MS = 1_000;
export const CHECKPOINT_BYTES = 4 * 1024;
export const PREVIEW_INTERVAL_MS = 500;

export type AttemptOutcome = "complete" | "failed" | "cancelled" | "interrupted" | "rate_limited";

export interface AttemptResult {
  outcome: AttemptOutcome;
  error?: ClassifiedError;
  /** Set on `complete`: the metadata jobs the run earned. */
  scheduleTitle?: boolean;
  scheduleRecap?: boolean;
}

export interface LoopDeps {
  config: Config;
  db: SessionDatabase;
  eventBus: EventBus;
  providers: Providers;
  metadata: MetadataRunner;
  logger: Logger;
  caches: ToolCaches;
  fetch: typeof globalThis.fetch;
  /** Test seam for the SSRF guard's resolver and the loopback fixture host. */
  toolOverrides?: Pick<RunToolContext, "lookup" | "allowHosts">;
}

export interface RunAttemptInput {
  userId: string;
  nodeId: string;
  /** A resume replays the interrupted attempt's committed exchanges. */
  kind: "fresh" | "resume";
  /** Aborted by cancel and by drain; which one is told apart by `reason`. */
  signal: AbortSignal;
  /** Set by drain so the attempt settles as `interrupted` rather than failing. */
  isDraining: () => boolean;
}

/** The document ids in context for a node: its own and its ancestors'. A
 * follow-up may read a file its parent was given. */
function documentsInContext(db: SessionDatabase, userId: string, nodeId: string): DocumentInfo[] {
  const path = messagesRepo.ancestorPath(db, userId, nodeId);
  const byId = new Map<string, DocumentInfo>();
  for (const id of path) {
    for (const document of documentsRepo.attachedTo(db, userId, id)) {
      byId.set(document.id, document);
    }
  }
  return [...byId.values()];
}

/** The markdown of a `document` parent, which has no messages and rides in the
 * child's prompt instead (`04-agent-runtime.md` §4). */
function parentDocumentOf(
  db: SessionDatabase,
  userId: string,
  node: ResearchNode,
): { title: string; markdown: string } | undefined {
  if (node.parentNodeId === null || node.parentNodeId === undefined) {
    return undefined;
  }
  const parent = nodesRepo.get(db, userId, node.parentNodeId);
  if (!parent || parent.kind !== "document") {
    return undefined;
  }
  const snapshot = snapshotsRepo.read(db, userId, parent.id);
  const markdown = snapshot ? researchDocuments.markdownFromTurns(snapshot.turns) : null;
  if (markdown === null) {
    return undefined;
  }
  return { title: parent.title ?? parent.prompt, markdown };
}

/**
 * Runs one attempt to its end and settles the node.
 *
 * Returns rather than throws: every failure mode here is a state the node has
 * to end up in, and the caller (`service.ts`) needs to know which one to
 * decide between releasing the queue row and re-queueing it.
 */
export async function runAttempt(deps: LoopDeps, input: RunAttemptInput): Promise<AttemptResult> {
  const { db, eventBus, logger } = deps;
  const { userId, nodeId } = input;

  const node = nodesRepo.get(db, userId, nodeId);
  if (!node) {
    return { outcome: "failed" };
  }
  if (nodesRepo.isTerminalStatus(node.status)) {
    return { outcome: node.status === "complete" ? "complete" : "failed" };
  }

  const resolved = deps.providers.resolve(node.model);
  if (!resolved) {
    const error: ClassifiedError = {
      errorClass: "auth",
      message: `${node.model} is not configured on this deployment`,
      detail: "missing credential",
    };
    settleFailure(deps, userId, nodeId, node.attempt, error);
    return { outcome: "failed", error };
  }

  // ── sequence bookkeeping ────────────────────────────────────────────────
  // The counter lives here between writes: deltas are forwarded and consume a
  // sequence number without writing a row, and `advanceSeq` carries the value
  // back into the node before the next write bumps it.
  //
  // The loop owns the counter for the length of the attempt, so every number
  // it spends is carried by an event: `advanceSeq` and `commitTurn` are the
  // only allocators, and the writes that publish nothing with a `seq` — the
  // in-flight checkpoint and the status transitions — are handed the current
  // value to record. A number allocated but never emitted is a hole, and the
  // client freezes its buffer and refetches on one (`stores/liveTurns.ts`).
  let seq = runsRepo.advanceSeq(db, userId, nodeId, 0);
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };
  /**
   * The sequence number assigned to a terminal event, persisted and emitted.
   * Every other number lives only in this variable until a write carries it into the
   * row; the last one has no write after it, so a resume or a second attempt
   * would read the node back one short and hand the same number out twice.
   */
  const finishSeq = (): number => {
    seq = runsRepo.advanceSeq(db, userId, nodeId, seq + 1);
    return seq;
  };
  const emit = (type: string, payload: Record<string, unknown>): void => {
    eventBus.emit(userId, sessionEvent(type, payload));
  };
  const publishNode = (
    updated: ResearchNode,
    extra: Record<string, unknown> = {},
    updateFeed = false,
  ): void => {
    emit("research.node.updated", { node: updated, ...extra });
    if (updateFeed) emitFeedItemUpsertedForNode(deps, updated.id);
  };

  const started = nodesRepo.setStatus(db, userId, nodeId, "running", {
    startedAt: Date.now(),
    seq,
  });
  runsRepo.startAttempt(db, {
    nodeId,
    attempt: node.attempt,
    kind: input.kind,
    model: node.model,
  });
  publishNode(started, {}, true);
  emit("research.run.started", {
    nodeId,
    attempt: node.attempt,
    seq: nextSeq(),
    model: node.model,
  });

  // ── request assembly ────────────────────────────────────────────────────
  const budget = new ToolBudget();
  const toolUsage = { search: 0, fetch: 0 };
  const toolContext: RunToolContext = {
    config: deps.config,
    db,
    userId,
    nodeId,
    logger,
    fetch: deps.fetch,
    budget,
    caches: deps.caches,
    recordUsage: (kind, count) => {
      toolUsage[kind] += count;
    },
    ...(deps.toolOverrides?.lookup ? { lookup: deps.toolOverrides.lookup } : {}),
    ...(deps.toolOverrides?.allowHosts ? { allowHosts: deps.toolOverrides.allowHosts } : {}),
  };

  const documents = documentsInContext(db, userId, nodeId);
  const instruction = preferencesRepo.ensure(db, userId).researchLaunchInstruction;
  const system = researchSystemPrompt(instruction);
  const parentDocument = parentDocumentOf(db, userId, node);

  // A resume keeps the interrupted attempt's committed exchanges: they are
  // real messages, already paid for (`05` §7).
  const live = runsRepo.liveWindow(db, userId, nodeId);
  const priorTurns: Turn[] = input.kind === "resume" ? [...live.turns] : [];
  const priorMessages: ModelMessage[] = messagesFromCommittedTurns(priorTurns);

  // The question this attempt asks, kept so it can be stored as the node's own
  // first message. Only the text is stored: the document parts are rebuilt from
  // `documentsInContext` on every attempt, so persisting them here would put
  // file bytes into `node_messages` and send each attachment twice.
  const userText = researchUserText({ node, parentDocument });

  let messages: ModelMessage[];
  try {
    const built = await buildMessages({
      ctx: toolContext,
      node,
      entry: resolved.entry,
      userText,
      documents,
      priorMessages,
      summarize: ({ text, signal }) => deps.metadata.summarize({ text, userId, signal }),
      signal: input.signal,
    });
    messages = built.messages;
    logger.debug(
      {
        nodeId,
        estimatedTokens: built.estimatedTokens,
        elided: built.elidedToolResults,
        summarized: built.summarizedThrough,
      },
      "assembled run context",
    );
  } catch (error) {
    const classified = classifyRunError(error);
    settleFailure(deps, userId, nodeId, node.attempt, classified, seq);
    return { outcome: "failed", error: classified };
  }

  const tools = buildTools(toolContext, input.signal, {
    documentIds: documents.map((document) => document.id),
    nativeSearch: resolved.entry.nativeSearch,
    providerTools: resolved.providerTools,
  });

  // ── streaming ───────────────────────────────────────────────────────────
  let pendingDelta = "";
  let pendingTurnId = "";
  let lastDeltaAt = 0;
  let lastCheckpointAt = Date.now();
  let checkpointedLength = 0;
  let lastPreviewAt = 0;

  const flushDelta = (force: boolean): void => {
    if (pendingDelta === "") {
      return;
    }
    const now = Date.now();
    if (!force && now - lastDeltaAt < DELTA_INTERVAL_MS) {
      return;
    }
    lastDeltaAt = now;
    emit("research.turn.delta", {
      nodeId,
      seq: nextSeq(),
      turnId: pendingTurnId,
      text: pendingDelta,
    });
    pendingDelta = "";
  };

  const mapper = new TurnMapper(
    {
      runId: nodeId,
      agentId: nodeId,
      startStep: priorTurns.length,
      startSourceIndex: priorTurns.length,
    },
    {
      onTextDelta: (turnId, text) => {
        if (turnId !== pendingTurnId) {
          flushDelta(true);
          pendingTurnId = turnId;
        }
        pendingDelta += text;
        flushDelta(false);
      },
      onThinking: (active) => {
        emit("research.run.thinking", { nodeId, seq: nextSeq(), active });
      },
      onGroundedSearch: (queries) => {
        toolUsage.search += queries;
      },
      onTurnCommitted: (turn) => {
        flushDelta(true);
        seq = runsRepo.advanceSeq(db, userId, nodeId, seq);
        const written = runsRepo.commitTurn(db, userId, { nodeId, turn });
        seq = written.seq;
        checkpointedLength = 0;
        lastCheckpointAt = Date.now();
        emit("research.turn.committed", { nodeId, seq, turn });
      },
    },
  );

  const groundingRedirects = createGroundingRedirectResolver({
    fetch: deps.fetch,
    logger,
    signal: input.signal,
  });

  const checkpoint = (force: boolean): void => {
    const turn = mapper.inFlightTurn();
    if (!turn) {
      return;
    }
    const length = mapper.inFlightText.length;
    const now = Date.now();
    const stale = now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS;
    const grown = length - checkpointedLength >= CHECKPOINT_BYTES;
    if (!force && !stale && !grown) {
      return;
    }
    runsRepo.checkpointInFlight(db, userId, { nodeId, turn, seq });
    lastCheckpointAt = now;
    checkpointedLength = length;
  };

  const publishPreview = (): void => {
    const now = Date.now();
    if (now - lastPreviewAt < PREVIEW_INTERVAL_MS) {
      return;
    }
    lastPreviewAt = now;
    const current = nodesRepo.get(db, userId, nodeId);
    if (!current) {
      return;
    }
    const preview = responsePreview([
      ...priorTurns,
      ...mapper.committedTurns,
      ...(mapper.inFlightTurn() ? [mapper.inFlightTurn() as Turn] : []),
    ]);
    publishNode({ ...current, responsePreview: preview ?? current.responsePreview ?? null });
  };

  const timeoutMs = deps.config.limits.runTimeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout]);

  let streamError: unknown = null;
  let finishReason: string | undefined;
  let rawFinishReason: string | undefined;
  let usage = attemptUsageOf(undefined);
  let responseMessages: ModelMessage[] = [];
  let steps = 0;

  try {
    const result = streamText({
      model: resolved.model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
      providerOptions: resolved.providerOptions,
      // The loop owns retry policy: a 429 re-queues with backoff and keeps its
      // place in the admission order, which a transport-level retry cannot do.
      maxRetries: 0,
      onError: ({ error }) => {
        streamError = error;
      },
    });

    for await (const part of result.fullStream) {
      if (part.type === "error") {
        streamError = part.error;
        break;
      }
      if (part.type === "abort") {
        break;
      }
      // Grounded citations arrive as Google redirect links; the mapper commits
      // the step with the pages they stand for (`groundingRedirects.ts`).
      mapper.handle(await resolveGroundingRedirects(part, groundingRedirects));
      if (part.type === "text-delta") {
        checkpoint(false);
        publishPreview();
      }
      if (part.type === "finish-step") {
        steps += 1;
      }
      if (part.type === "finish") {
        finishReason = part.finishReason;
        rawFinishReason = part.rawFinishReason;
      }
    }
    if (streamError === null) {
      usage = attemptUsageOf(await result.totalUsage);
      responseMessages = await result.responseMessages;
    }
  } catch (error) {
    streamError = error;
  }

  flushDelta(true);
  mapper.finish();
  flushDelta(true);

  // ── outcome ─────────────────────────────────────────────────────────────
  const aborted = input.signal.aborted;
  const timedOut = timeout.aborted && !aborted;
  const draining = input.isDraining();
  const current = nodesRepo.get(db, userId, nodeId);
  const cancelled = current?.status === "cancelled";

  const finishAttempt = (outcome: string, error?: ClassifiedError): void => {
    runsRepo.finishAttempt(db, {
      nodeId,
      attempt: node.attempt,
      outcome,
      errorClass: error?.errorClass ?? null,
      steps,
      toolCalls: budget.searches + budget.fetches,
      usage,
      // The same estimate `usage_events` carries, from the registry's price
      // table, so a per-attempt cost is readable without a join.
      costEstimateMicros: costOf(resolved.entry, usage),
    });
  };

  const recordUsage = (): void => {
    recordAttemptUsage({
      db,
      userId,
      nodeId,
      entry: resolved.entry,
      kind: "research",
      usage,
    });
    recordToolUsage(db, userId, nodeId, "search", "search", toolUsage.search);
    recordToolUsage(db, userId, nodeId, "fetch", "fetch", toolUsage.fetch);
  };

  if (draining && !cancelled) {
    checkpoint(true);
    const interrupted = nodesRepo.markInterrupted(db, userId, nodeId, seq);
    finishAttempt("interrupted");
    recordUsage();
    emit("research.run.finished", {
      nodeId,
      attempt: node.attempt,
      seq: finishSeq(),
      status: "interrupted",
    });
    publishNode(interrupted, {}, true);
    return { outcome: "interrupted" };
  }

  if (cancelled) {
    // The status was already written by `research.cancelNode`; the partial
    // stays in `run_turns` so the document keeps what it produced.
    finishAttempt("cancelled");
    recordUsage();
    // `research.cancelNode` wrote the status from outside the loop and took a
    // number with it. This event carries that number rather than one past it,
    // which is what keeps the sequence contiguous whether or not the cancel
    // raced a write of the loop's own.
    seq = runsRepo.advanceSeq(db, userId, nodeId, seq + 1);
    emit("research.run.finished", {
      nodeId,
      attempt: node.attempt,
      seq,
      status: "cancelled",
    });
    const settled = nodesRepo.get(db, userId, nodeId);
    if (settled) {
      publishNode(settled, {}, true);
    }
    return { outcome: "cancelled" };
  }

  if (streamError !== null || timedOut) {
    const classified = timedOut
      ? timeoutError(Math.round(timeoutMs / 1000))
      : classifyRunError(streamError);
    if (classified.errorClass === "rate_limited") {
      finishAttempt("rate_limited", classified);
      recordUsage();
      return { outcome: "rate_limited", error: classified };
    }
    finishAttempt("failed", classified);
    recordUsage();
    settleFailure(deps, userId, nodeId, node.attempt, classified, seq);
    return { outcome: "failed", error: classified };
  }

  if (finishReason === "content-filter") {
    const classified = refusalError(rawFinishReason);
    finishAttempt("failed", classified);
    recordUsage();
    settleFailure(deps, userId, nodeId, node.attempt, classified, seq);
    return { outcome: "failed", error: classified };
  }

  // ── completion ──────────────────────────────────────────────────────────
  let commit;
  try {
    commit = commitAnswer({ db, userId, nodeId, status: "complete", seq });
  } catch (error) {
    const classified: ClassifiedError = {
      errorClass: "unknown",
      message: error instanceof Error ? error.message : String(error),
      detail: String(error),
    };
    finishAttempt("failed", classified);
    recordUsage();
    settleFailure(deps, userId, nodeId, node.attempt, classified, seq);
    return { outcome: "failed", error: classified };
  }
  if (!commit.committed) {
    const classified: ClassifiedError = {
      errorClass: "unknown",
      message: commit.reason ?? "Research completed without generating response content",
      detail: commit.reason ?? "no answer",
    };
    finishAttempt("failed", classified);
    recordUsage();
    settleFailure(deps, userId, nodeId, node.attempt, classified, seq);
    return { outcome: "failed", error: classified };
  }

  // The conversation is appended only now: `node_messages` is append-only and
  // only a completed node's exchanges belong in the thread's history. The
  // question must come first because descendants replay this node as one
  // exchange, and providers such as Anthropic require alternating user and
  // assistant turns.
  const askedMessage: ModelMessage = { role: "user", content: userText };
  messagesRepo.appendMessages(
    db,
    userId,
    nodeId,
    [askedMessage, ...priorMessages, ...responseMessages].map((message) => ({
      message,
      model: message.role === "assistant" ? node.model : null,
    })),
  );
  finishAttempt("complete");
  recordUsage();
  emit("research.run.finished", {
    nodeId,
    attempt: node.attempt,
    seq: finishSeq(),
    status: "complete",
  });
  const settled = nodesRepo.get(db, userId, nodeId);
  if (settled) {
    publishNode(settled, {}, true);
  }
  return { outcome: "complete", scheduleTitle: settled?.title == null, scheduleRecap: true };
}

/** Writes a failure onto the node and publishes it. The partial turns are left
 * in `run_turns`: a failed answer is still readable, which is what the desktop
 * did and what makes a retry an informed choice. */
function settleFailure(
  deps: LoopDeps,
  userId: string,
  nodeId: string,
  attempt: number,
  error: ClassifiedError,
  seq?: number,
): void {
  const { db, eventBus, logger } = deps;
  logger.warn({ nodeId, errorClass: error.errorClass, detail: error.detail }, "run failed");
  let node;
  try {
    node = nodesRepo.setStatus(db, userId, nodeId, "failed", {
      error: error.message,
      // Inside a run the loop owns the counter and the `research.run.finished`
      // below is what spends the next number; outside one (a model that will
      // not resolve) this write is the allocator.
      ...(seq === undefined ? {} : { seq }),
    });
  } catch {
    // Already terminal: a cancel landed between the failure and this write.
    node = nodesRepo.get(db, userId, nodeId);
  }
  const next = runsRepo.advanceSeq(db, userId, nodeId, (seq ?? 0) + 1);
  eventBus.emit(
    userId,
    sessionEvent("research.run.finished", {
      nodeId,
      attempt,
      seq: next,
      status: "failed",
      error: error.message,
    }),
  );
  if (node) {
    eventBus.emit(userId, sessionEvent("research.node.updated", { node }));
    emitFeedItemUpsertedForNode(deps, node.id);
  }
}

/** Releases the queue row for a node that will not run again. */
export function releaseQueue(db: SessionDatabase, nodeId: string): void {
  queueRepo.release(db, nodeId);
}
