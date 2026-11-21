// What the run loop and the dispatcher read and write, as one interface.
//
// The loop used to read and write the research tables directly (`nodes`,
// `run_turns`, `run_attempts`, `response_snapshots`, `node_messages`,
// `node_summaries`, `run_queue`, `user_preferences`) and publish on the
// research event bus. Those tables and the bus were removed with the research
// API (plan `01` A2, M4). The loop now calls this interface instead;
// `recordStore.ts` implements it over the `run`, turn and answer records
// (`03` §1-§3): writes through `serverApply` with attempt fencing (`03` E1),
// the in-flight checkpoint in `run_live` and deltas as ephemeral events on
// the sync SSE stream (`03` T1-T4).
//
// Token usage is not written here: it goes to the ledger (`ledger.ts`),
// whose writes are never fenced (`03` K1, E1).

import type { Spaces, Turn } from "@session/shared";
import type { ModelMessage } from "ai";

import type { ClassifiedError, RunErrorClass } from "./errors.js";
import type { Payer } from "./ledger.js";

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
  /** Always set (`03` K12): the effort the run was asked with. */
  effort: string;
  attempt: number;
  /** `resume` replays the committed turns of the interrupted attempt it
   * continues (`05-run-lifecycle-and-streaming.md` §7). The store answers
   * `resume` for an attempt that already committed turns: a boot resume, or
   * a claim after a 429 re-queue past the first step. */
  kind: "fresh" | "resume";
  /** The node's kind. A look-up runs under the limits of `03` L2. */
  node: "ask" | "lookup";
  /** Who pays when the attempt starts (`03` K8). The dispatcher re-checks it
   * before the attempt starts (`03` K10); the loop may move an `included`
   * run to the asker's Anthropic key at a step boundary (`03` K9). */
  payer: Payer;
  /** The asker's research instruction, added to the system prompt
   * (`prompts.ts`). */
  instruction: string | null;
  /** The text of the new user message (`prompts.ts`, `researchUserText`). */
  userText: string;
  /** The thread's earlier exchanges, root first, as stored. */
  history: readonly ContextMessage[];
  /** The final steps of a completed run (`03` E2): a new thread's title and
   * the root answer's summary line (`sum`). Absent: neither. */
  finalSteps?: { title: boolean; summary: boolean } | undefined;
  /** When the run's first claim started it (epoch ms): the wall clock of
   * `03` L1 counts from here across re-queues and resumes. Absent: now. */
  startedAt?: number | undefined;
}

/** Token counts for one attempt, as the AI SDK reports them. */
export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

/** The statuses an attempt ends in. A 429 is not one of them: the
 * dispatcher re-queues the run or fails it with `rate` (`03` E5). */
export type AttemptOutcome = "complete" | "failed" | "cancelled" | "interrupted";

/** The run record's `fail` (`03` §1, `runFailureSchema` in `spaces.ts`). */
export type RunFailure =
  | { why: "stopped" }
  | { why: "tokens" }
  | { why: "key"; detail: Spaces.RunKeyDetail }
  | { why: "rate"; at: number }
  | { why: "access" }
  | { why: "interrupted" }
  | { why: "error"; cls: Exclude<RunErrorClass, "rate_limited"> };

/** The run record's `bill` (`03` K9). */
export type BillLabel = Payer | "included+key:anthropic";

/** How an attempt ended, recorded once per attempt. */
export interface AttemptSummary {
  outcome: AttemptOutcome;
  /** Set for `failed` and `cancelled`. */
  fail?: RunFailure | undefined;
  error?: ClassifiedError | undefined;
  /** The stop note of a run that ended `complete` before the model finished
   * (`03` E5): `OVERDRAFT_STOP_NOTE` or `RUN_CAP_NOTE` (`allowance.ts`). */
  note?: string | undefined;
  /** The run record's `tok`: the counted tokens of every ledger row of the
   * run, every attempt (`03` K1). */
  tok: number;
  /** The payers of the research calls the writer of the summary knows of
   * (`billLabel`): the loop's, this claim's calls; the dispatcher's and a
   * thrown write's, none. A store with a ledger writes the run's `bill`
   * from the ledger instead (`runBill`, `RecordRunStore.finish`). */
  bill: BillLabel | null;
  steps: number;
  toolCalls: number;
  usage: AttemptUsage;
  costEstimateMicros: number;
}

/** The answer of a completed attempt. */
export interface CompletedAnswer {
  /** Every committed turn, those of a resumed attempt included. Holds
   * assistant text, except for a run stopped by a token limit (`note`),
   * which keeps whatever it committed. */
  turns: Turn[];
  /** The exchange as conversation messages: the question first, then the
   * replayed and new responses. A follow-up replays them as context. */
  messages: ContextMessage["message"][];
}

/** Progress phase (`03` E3): planning, searching, reading, writing; shown
 * as Step `step + 1`. */
export type RunStep = 0 | 1 | 2 | 3;

/** A summary of the oldest exchanges, cached on the last node it covers so
 * every descendant reuses it (`messages.ts`, `compactContext`). The cache is
 * an optimization: a read that fails or misses costs a new summary. */
export interface SummaryCache {
  read(nodeId: string): string | null;
  write(nodeId: string, summary: string): void;
}

/** A `run` record in status `queued`, as the dispatcher reads it. */
export interface QueuedRun {
  runId: string;
  attempt: number;
  userId: string;
  model: string;
  effort: string;
  payer: Payer;
  /** When the record was written `queued` (epoch ms): the admission order. */
  queuedAt: number;
  /** The attempt has been claimed before (`startedAt` set): a re-queue after
   * a 429 or a resume. Its claim admits it on overdraft (`payerAtStart`,
   * `03` K9, K10). Absent: the dispatcher reads the ledger rows of the
   * attempt alone. */
  ran?: boolean;
}

/** A `run` record in status `interrupted`, as boot reads it. */
export interface InterruptedRun {
  runId: string;
  attempt: number;
  userId: string;
  /** Automatic resumes this attempt has had (`03` E2: at most two). */
  resumes: number;
}

export interface RunStore {
  // ── the loop ──────────────────────────────────────────────────────────

  /** True while `request.attempt` is the run's current attempt and neither
   * the thread nor the node is removed or deleted (the fence of `03` E1).
   * Once false, the loop aborts the provider stream and writes nothing
   * further for this attempt. Called before every write; it must be
   * synchronous, so a check and the write after it cannot interleave with
   * the newer attempt's start. */
  isCurrent(request: RunRequest): boolean;
  /** True once the run was cancelled. */
  isCancelled(request: RunRequest): boolean;
  /** The turns the interrupted attempt committed, for a `resume`. */
  committedTurns(request: RunRequest): Turn[];
  /** The attempt has started: `startedAt`, step 0. */
  markRunning(request: RunRequest): void;
  /** The progress phase moved forward (`03` E3); called at most once per
   * phase, only with a larger step. */
  step(request: RunRequest, step: RunStep): void;
  /** A turn reached its final form. */
  commitTurn(request: RunRequest, turn: Turn): void;
  /** The turn still streaming, at most once a second or every 4 KiB of new
   * text, so a restart loses little (`loop.ts`, `CHECKPOINT_INTERVAL_MS`).
   * Goes to `run_live`, not to the records (`03` T4). */
  checkpoint(request: RunRequest, turn: Turn): void;
  /** New text of the turn still streaming; not stored (`03` T2). */
  delta(request: RunRequest, turnId: string, text: string): void;
  /** Reasoning started or ended; no content is carried. */
  thinking(request: RunRequest, active: boolean): void;
  /** The new thread's title, from the run's title step (`03` E2). */
  writeTitle(request: RunRequest, title: string): void;
  /** The root answer's summary line (`sum`), from the run's summary step. */
  writeSummary(request: RunRequest, summary: string): void;
  /** The attempt ended. `answer` is set only when `summary.outcome` is
   * `complete`. A failed, cancelled or interrupted attempt keeps the turns it
   * committed. */
  finish(request: RunRequest, summary: AttemptSummary, answer?: CompletedAnswer): void;
  /** The fence stopped the attempt and its ledger rows are closed. A run
   * record that still holds the attempt gets its `tok` and `bill`, and one
   * still `running` ends `failed { why: "access" }`. Absent: nothing is
   * written. */
  superseded?(request: RunRequest): void;
  /** Absent: context compaction summarizes again on every attempt. */
  summaries?: SummaryCache;

  // ── the dispatcher (`03` E2, `01` S5) ─────────────────────────────────

  /** Every run in status `queued`, oldest `queuedAt` first. */
  queued(): QueuedRun[];
  /** The compare-and-set of `03` E2, in one transaction: `queued` →
   * `running` where `id`, `attempt` and `status = 'queued'` still match.
   * Returns the attempt to run, or null when the record no longer matched
   * (another dispatcher claimed it, or it was cancelled or retried). It also
   * applies the access check of `03` G8: a run whose asker can no longer
   * read the thread is written `failed { why: "access" }` in the same
   * transaction, and null is returned. */
  claim(run: QueuedRun): RunRequest | null;
  /** Ends a queued run without running it (the payer re-check of `03` K10),
   * by compare-and-set on `queued` and the attempt. False when the record no
   * longer matched. */
  settleQueued(run: QueuedRun, summary: AttemptSummary): boolean;
  /** A 429: `running` → `queued` for the same attempt, keeping `queuedAt`
   * so the run keeps its place. False when the attempt is no longer
   * current. */
  requeue(request: RunRequest): boolean;
  /** Boot: every run still `running` (a crash) becomes `interrupted`.
   * Returns how many. */
  interruptRunning(): number;
  /** Every run in status `interrupted`. */
  interrupted(): InterruptedRun[];
  /** An automatic resume: `interrupted` → `queued` where the attempt and
   * `resumes` still match, with `resumes + 1`; the next claim answers a
   * `resume`. False when the record no longer matched. */
  resume(run: InterruptedRun): boolean;
  /** Boot: deletes the in-flight checkpoints no run continues (`01` D4).
   * Returns how many. Absent: there are none to delete. */
  sweepLive?(): number;
}
