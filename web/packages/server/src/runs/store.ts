// What the run loop reads and writes, as one interface.
//
// The loop used to read and write the research tables directly (`nodes`,
// `run_turns`, `run_attempts`, `response_snapshots`, `node_messages`,
// `node_summaries`, `run_queue`, `user_preferences`) and publish on the
// research event bus. Those tables and the bus were removed with the research
// API (plan `01` A2, M4). The loop now calls this interface instead, and
// nothing in this build implements it. M5a implements it over the `run`,
// turn and answer records (`03` §1-§3): writes through `serverApply` with
// attempt fencing (`03` E1), the in-flight checkpoint in `run_live` and
// deltas as ephemeral events on the sync SSE stream (`03` T1-T4).

import type { Turn } from "@session/shared";
import type { ModelMessage } from "ai";

import type { ClassifiedError } from "./errors.js";

/** One stored message of the thread's earlier exchanges. */
export interface ContextMessage {
  /** The node whose exchange the message belongs to. Context compaction
   * groups messages by it (`messages.ts`). */
  nodeId: string;
  message: ModelMessage;
  /** The model that produced an assistant message; null for the others. */
  model: string | null;
}

/** One attempt of one run, as the store hands it to the loop. */
export interface RunRequest {
  runId: string;
  /** The asker: whose usage is recorded and whose instruction applies. */
  userId: string;
  model: string;
  effort?: string | null | undefined;
  attempt: number;
  /** `resume` replays the committed turns of the interrupted attempt it
   * continues (`05-run-lifecycle-and-streaming.md` §7). */
  kind: "fresh" | "resume";
  /** The asker's research instruction, added to the system prompt
   * (`prompts.ts`). */
  instruction: string | null;
  /** The text of the new user message (`prompts.ts`, `researchUserText`). */
  userText: string;
  /** The thread's earlier exchanges, root first, as stored. */
  history: readonly ContextMessage[];
}

/** Token counts for one attempt, as the AI SDK reports them. */
export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export type AttemptOutcome = "complete" | "failed" | "cancelled" | "interrupted" | "rate_limited";

/** How an attempt ended, recorded once per attempt. */
export interface AttemptSummary {
  outcome: AttemptOutcome;
  error?: ClassifiedError | undefined;
  steps: number;
  toolCalls: number;
  usage: AttemptUsage;
  costEstimateMicros: number;
}

/** The answer of a completed attempt. */
export interface CompletedAnswer {
  /** Every committed turn, those of a resumed attempt included. Holds
   * assistant text: the loop fails an attempt that produced none. */
  turns: Turn[];
  /** The exchange as conversation messages: the question first, then the
   * replayed and new responses. A follow-up replays them as context. */
  messages: ContextMessage["message"][];
}

/** A summary of the oldest exchanges, cached on the last node it covers so
 * every descendant reuses it (`messages.ts`, `compactContext`). The cache is
 * an optimization: a read that fails or misses costs a new summary. */
export interface SummaryCache {
  read(nodeId: string): string | null;
  write(nodeId: string, summary: string): void;
}

export interface RunStore {
  /** True while `request.attempt` is the run's current attempt. Once false,
   * a retry or rerun has started a newer attempt, and the loop writes
   * nothing further for this one. Called before every write; it must be
   * synchronous, so a check and the write after it cannot interleave with
   * the newer attempt's start. */
  isCurrent(request: RunRequest): boolean;
  /** True once the run was cancelled. */
  isCancelled(request: RunRequest): boolean;
  /** The turns the interrupted attempt committed, for a `resume`. */
  committedTurns(request: RunRequest): Turn[];
  /** The attempt has started; the run is `running`. */
  markRunning(request: RunRequest): void;
  /** A turn reached its final form. */
  commitTurn(request: RunRequest, turn: Turn): void;
  /** The turn still streaming, at most once a second or every 4 KiB of new
   * text, so a restart loses little (`loop.ts`, `CHECKPOINT_INTERVAL_MS`). */
  checkpoint(request: RunRequest, turn: Turn): void;
  /** New text of the turn still streaming; not stored. */
  delta(request: RunRequest, turnId: string, text: string): void;
  /** Reasoning started or ended; no content is carried. */
  thinking(request: RunRequest, active: boolean): void;
  /** The attempt ended. `answer` is set only when `summary.outcome` is
   * `complete`. A failed, cancelled or interrupted attempt keeps the turns it
   * committed. */
  finish(request: RunRequest, summary: AttemptSummary, answer?: CompletedAnswer): void;
  /** Absent: context compaction summarizes again on every attempt. */
  summaries?: SummaryCache;
}
