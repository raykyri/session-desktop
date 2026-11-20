// One attempt of one node (`04-agent-runtime.md` §3,
// `05-run-lifecycle-and-streaming.md` §4, §5).
//
// Load the node's context, open the provider stream, map its parts into turns,
// persist them as they complete, publish required events to subscribers,
// and finalize the node state. The module is provider-neutral: all required
// provider configuration is contained in `ResolvedModel`.
//
// Two rules shape persistence. Committed turns and the node sequence counter
// update in one transaction, so sequence *n* identifies the turns persisted
// through that event. In-flight text is checkpointed at most once per second or
// every 4 KiB to limit data loss during server restarts.

import type { SessionDatabase } from "@session/db";
import {
  access as accessRepo,
  messages as messagesRepo,
  nodes as nodesRepo,
  preferences as preferencesRepo,
  queue as queueRepo,
  researchDocuments,
  runs as runsRepo,
  snapshots as snapshotsRepo,
} from "@session/db";
import type { ResearchNode, Turn } from "@session/shared";
import { DEFAULT_MODEL_ID, responsePreview } from "@session/shared";
import { nodePrompt } from "@session/shared/lib/researchNodeTypes";
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

/** `superseded`: a newer attempt of the node (a retry or rerun after a
 * cancel) began while this attempt was terminating; this attempt wrote nothing
 * to the node and holds no queue row. */
export type AttemptOutcome =
  "complete" | "failed" | "cancelled" | "interrupted" | "rate_limited" | "superseded";

export interface AttemptResult {
  outcome: AttemptOutcome;
  error?: ClassifiedError;
  /** Set on `complete`: the metadata jobs scheduled for the completed run. */
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
  /** Test hooks for the SSRF guard's resolver and the loopback fixture host. */
  toolOverrides?: Pick<RunToolContext, "lookup" | "allowHosts">;
}

export interface RunAttemptInput {
  userId: string;
  nodeId: string;
  /** A resume replays the interrupted attempt's committed exchanges. */
  kind: "fresh" | "resume";
  /** Aborted by cancel or drain, distinguished by `reason`. */
  signal: AbortSignal;
  /** Set by drain so the attempt ends as `interrupted` rather than failing. */
  isDraining: () => boolean;
  /** The node's attempt number when the service claimed it. If the attempt
   * number changed before the attempt starts, it does not run. */
  attempt?: number | undefined;
}

/** The markdown of a `document` parent, which has no messages and is included
 * in the child's prompt instead (`04-agent-runtime.md` §4). */
function parentDocumentOf(
  db: SessionDatabase,
  userId: string,
  node: ResearchNode,
): { title: string; markdown: string } | undefined {
  if (node.parentNodeId === null || node.parentNodeId === undefined) {
    return undefined;
  }
  const parent = nodesRepo.get(db, userId, node.parentNodeId);
  if (!parent || parent.type !== "document") {
    return undefined;
  }
  const snapshot = snapshotsRepo.read(db, userId, parent.id);
  const markdown = snapshot ? researchDocuments.markdownFromTurns(snapshot.turns) : null;
  if (markdown === null) {
    return undefined;
  }
  return { title: parent.title ?? nodePrompt(parent), markdown };
}

/**
 * Runs one attempt to its end and updates the node's final state.
 *
 * Returns rather than throws: each failure mode represents a terminal or
 * intermediate state that the caller (`service.ts`) inspects to decide between
 * releasing the queue row and re-queueing it.
 */
export async function runAttempt(deps: LoopDeps, input: RunAttemptInput): Promise<AttemptResult> {
  const { db, eventBus, logger } = deps;
  const { userId, nodeId } = input;

  const node = nodesRepo.get(db, userId, nodeId);
  // Only exchanges have runs; a post or document in the queue is a bug
  // upstream, and failing the attempt releases its queue row.
  if (!node || node.type !== "exchange") {
    return { outcome: "failed" };
  }
  if (nodesRepo.isTerminalStatus(node.run.status)) {
    return { outcome: node.run.status === "complete" ? "complete" : "failed" };
  }
  const modelId = node.agent.model ?? DEFAULT_MODEL_ID;
  const attempt = node.run.attempt ?? 1;
  if (input.attempt !== undefined && input.attempt !== attempt) {
    return { outcome: "superseded" };
  }
  /**
   * Whether this attempt is still the node's current attempt. A retry or rerun
   * increments the attempt number in the queue transaction, so a cancelled
   * attempt whose stream is still terminating observes the newer attempt number
   * and writes nothing further to the node: no turns, status, or events.
   * Because database operations are synchronous, a check followed by a write
   * without an intervening `await` cannot interleave with the retry.
   */
  const owned = (): boolean => nodesRepo.attemptOf(db, nodeId) === attempt;

  const resolved = deps.providers.resolve(modelId, node.agent.effort);
  if (!resolved) {
    const error: ClassifiedError = {
      errorClass: "auth",
      message: `${modelId} is not configured on this deployment`,
      detail: "missing credential",
    };
    settleFailure(deps, userId, nodeId, attempt, error);
    return { outcome: "failed", error };
  }

  // ── sequence bookkeeping ────────────────────────────────────────────────
  // The counter remains here between writes: deltas are forwarded and consume a
  // sequence number without writing a row, and `advanceSeq` carries the value
  // back into the node before the next write increments it.
  //
  // The loop manages the counter for the duration of the attempt, so every
  // allocated sequence number is emitted with an event: `advanceSeq` and
  // `commitTurn` are the only allocators, and writes that publish no event with
  // a `seq` — the in-flight checkpoint and status transitions — record the
  // current sequence value. An allocated sequence number that is never emitted
  // creates a sequence gap, causing the client to pause its buffer and
  // refetch (`stores/liveTurns.ts`).
  let seq = runsRepo.advanceSeq(db, userId, nodeId, 0);
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };
  /**
   * The sequence number assigned to a terminal event, persisted and emitted.
   * Every other number remains only in this variable until a write stores it in the
   * row; the last one has no write after it, so a resume or a second attempt
   * would read an outdated sequence number and emit duplicate sequence values.
   */
  const finishSeq = (): number => {
    seq = runsRepo.advanceSeq(db, userId, nodeId, seq + 1);
    return seq;
  };
  // Run events are emitted to thread viewers and the requesting user;
  // superseded attempt events are dropped.
  const emit = (type: string, payload: Record<string, unknown>): void => {
    if (!owned()) return;
    eventBus.emitToTree(node.treeId, sessionEvent(type, payload), [userId]);
  };
  const publishNode = (
    updated: ResearchNode,
    extra: Record<string, unknown> = {},
    updateFeed = false,
  ): void => {
    if (!owned()) return;
    emit("research.node.updated", { node: updated, ...extra });
    if (updateFeed) emitFeedItemUpsertedForNode(deps, updated.id);
  };

  const started = nodesRepo.setStatus(db, userId, nodeId, "running", {
    startedAt: Date.now(),
    seq,
    // Wait reason recorded while the node was queued.
    error: null,
  });
  runsRepo.startAttempt(db, {
    nodeId,
    attempt: attempt,
    kind: input.kind,
    model: modelId,
  });
  publishNode(started, {}, true);
  emit("research.run.started", {
    nodeId,
    attempt: attempt,
    seq: nextSeq(),
    model: modelId,
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

  let usage = attemptUsageOf(undefined);
  let steps = 0;

  const finishAttempt = (outcome: string, error?: ClassifiedError): void => {
    runsRepo.finishAttempt(db, {
      nodeId,
      attempt: attempt,
      outcome,
      errorClass: error?.errorClass ?? null,
      steps,
      toolCalls: budget.searches + budget.fetches,
      usage,
      // The estimated cost recorded in `usage_events`, allowing per-attempt
      // cost lookups without a join.
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

  /** A newer attempt is active for the node: this attempt closes its attempt
   * record and records usage without modifying the node. */
  const settleSuperseded = (): AttemptResult => {
    finishAttempt("cancelled");
    recordUsage();
    return { outcome: "superseded" };
  };

  /**
   * Ends a cancelled attempt. Explicit cancellation updates status before
   * aborting the signal; an abort that is not a drain is treated as a cancellation
   * even if status was not pre-written, ensuring it does not remain `running`.
   * Partial turns remain in `run_turns` to preserve generated output.
   */
  const settleCancelled = (): AttemptResult => {
    const now = nodesRepo.get(db, userId, nodeId);
    if (now?.type === "exchange" && now.run.status !== "cancelled") {
      nodesRepo.stopRun(db, nodeId);
    }
    finishAttempt("cancelled");
    recordUsage();
    // Cancellation updated status externally and allocated a sequence number.
    // Emitting this event with the current sequence number maintains
    // contiguous sequencing even if cancellation interleaved with a loop write.
    seq = runsRepo.advanceSeq(db, userId, nodeId, seq + 1);
    emit("research.run.finished", {
      nodeId,
      attempt: attempt,
      seq,
      status: "cancelled",
    });
    const settled = nodesRepo.get(db, userId, nodeId);
    if (settled) {
      publishNode(settled, {}, true);
    }
    return { outcome: "cancelled" };
  };

  // User preferences: the research launch instruction and widget display settings.
  const preferences = preferencesRepo.ensure(db, userId);
  const system = researchSystemPrompt(preferences.researchLaunchInstruction, {
    widgets: preferences.settings.researchInlineWidgets,
  });
  const parentDocument = parentDocumentOf(db, userId, node);

  // Resumed attempts retain committed turns from the interrupted attempt (`05` §7).
  const live = runsRepo.liveWindow(db, userId, nodeId);
  const priorTurns: Turn[] = input.kind === "resume" ? [...live.turns] : [];
  const priorMessages: ModelMessage[] = messagesFromCommittedTurns(priorTurns);

  // User prompt text preserved to store as the node's initial message.
  const userText = researchUserText({ node, parentDocument });

  let messages: ModelMessage[];
  try {
    const built = await buildMessages({
      ctx: toolContext,
      node,
      userText,
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
    if (!owned()) {
      return settleSuperseded();
    }
    if (input.signal.aborted && !input.isDraining()) {
      return settleCancelled();
    }
    const classified = classifyRunError(error);
    settleFailure(deps, userId, nodeId, attempt, classified, seq);
    return { outcome: "failed", error: classified };
  }

  const tools = buildTools(toolContext, input.signal, {
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
        if (!owned()) return;
        seq = runsRepo.advanceSeq(db, userId, nodeId, seq);
        const written = runsRepo.commitTurn(db, userId, { nodeId, turn, attempt });
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
    if ((!force && !stale && !grown) || !owned()) {
      return;
    }
    runsRepo.checkpointInFlight(db, userId, { nodeId, turn, seq, attempt });
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
    if (current.type !== "exchange") {
      return;
    }
    publishNode({
      ...current,
      run: { ...current.run, responsePreview: preview ?? current.run.responsePreview ?? null },
    });
  };

  const timeoutMs = deps.config.limits.runTimeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout]);

  let streamError: unknown = null;
  let finishReason: string | undefined;
  let rawFinishReason: string | undefined;
  let responseMessages: ModelMessage[] = [];

  try {
    const result = streamText({
      model: resolved.model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
      providerOptions: resolved.providerOptions,
      // The loop implements retry policy: a 429 re-queues with backoff and keeps its
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
      // the step with the resolved target URLs (`groundingRedirects.ts`).
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
  // Everything from here to the return is synchronous, so this one check
  // covers every write below it.
  if (!owned()) {
    return settleSuperseded();
  }
  const current = nodesRepo.get(db, userId, nodeId);
  const cancelled = current?.type === "exchange" && current.run.status === "cancelled";

  if (draining && !cancelled) {
    checkpoint(true);
    const interrupted = nodesRepo.markInterrupted(db, userId, nodeId, seq);
    finishAttempt("interrupted");
    recordUsage();
    emit("research.run.finished", {
      nodeId,
      attempt: attempt,
      seq: finishSeq(),
      status: "interrupted",
    });
    publishNode(interrupted, {}, true);
    return { outcome: "interrupted" };
  }

  // After draining, an aborted signal represents a cancellation.
  if (cancelled || aborted) {
    return settleCancelled();
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
    settleFailure(deps, userId, nodeId, attempt, classified, seq);
    return { outcome: "failed", error: classified };
  }

  if (finishReason === "content-filter") {
    const classified = refusalError(rawFinishReason);
    finishAttempt("failed", classified);
    recordUsage();
    settleFailure(deps, userId, nodeId, attempt, classified, seq);
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
    settleFailure(deps, userId, nodeId, attempt, classified, seq);
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
    settleFailure(deps, userId, nodeId, attempt, classified, seq);
    return { outcome: "failed", error: classified };
  }

  // Conversation messages are appended only upon completion: `node_messages`
  // is append-only and only a completed node's exchanges belong in the thread's
  // history. The question must come first because descendants replay this node
  // as one exchange, and providers such as Anthropic require alternating user
  // and assistant turns.
  const askedMessage: ModelMessage = { role: "user", content: userText };
  messagesRepo.appendMessages(
    db,
    userId,
    nodeId,
    [askedMessage, ...priorMessages, ...responseMessages].map((message) => ({
      message,
      model: message.role === "assistant" ? modelId : null,
    })),
  );
  finishAttempt("complete");
  recordUsage();
  emit("research.run.finished", {
    nodeId,
    attempt: attempt,
    seq: finishSeq(),
    status: "complete",
  });
  const settled = nodesRepo.get(db, userId, nodeId);
  if (settled) {
    publishNode(settled, {}, true);
  }
  return { outcome: "complete", scheduleTitle: settled?.title == null, scheduleRecap: true };
}

/** Writes a failure status to the node and emits the event. Partial turns remain
 * in `run_turns` so incomplete output can be inspected before retrying. */
function settleFailure(
  deps: LoopDeps,
  userId: string,
  nodeId: string,
  attempt: number,
  error: ClassifiedError,
  seq?: number,
): void {
  const { db, eventBus, logger } = deps;
  if (nodesRepo.attemptOf(db, nodeId) !== attempt) {
    // A newer attempt is active for the node; discard this failure report.
    logger.info({ nodeId, attempt }, "a superseded attempt ended without writing its failure");
    return;
  }
  logger.warn({ nodeId, errorClass: error.errorClass, detail: error.detail }, "run failed");
  let node;
  try {
    node = nodesRepo.setStatus(db, userId, nodeId, "failed", {
      error: error.message,
      // Inside a run, `research.run.finished` allocates the sequence number;
      // outside a run (such as unresolvable model errors), this write allocates it.
      ...(seq === undefined ? {} : { seq }),
    });
  } catch {
    // Already terminal: a cancellation occurred between the failure and this write.
    node = nodesRepo.get(db, userId, nodeId);
  }
  const next = runsRepo.advanceSeq(db, userId, nodeId, (seq ?? 0) + 1);
  const treeId = accessRepo.nodeTreeId(db, nodeId);
  const emit = (event: ReturnType<typeof sessionEvent>): void => {
    if (treeId === null) eventBus.emit(userId, event);
    else eventBus.emitToTree(treeId, event, [userId]);
  };
  emit(
    sessionEvent("research.run.finished", {
      nodeId,
      attempt,
      seq: next,
      status: "failed",
      error: error.message,
    }),
  );
  if (node) {
    emit(sessionEvent("research.node.updated", { node }));
    emitFeedItemUpsertedForNode(deps, node.id);
  }
}

/** Releases the queue row for a node that will not run again. */
export function releaseQueue(db: SessionDatabase, nodeId: string): void {
  queueRepo.release(db, nodeId);
}
