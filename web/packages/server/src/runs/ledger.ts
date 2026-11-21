// The usage ledger: tokens recorded as they are spent, one row per provider
// call (`03-agents-and-research.md` K1, K2, E5).
//
// The run loop opens a row when a provider call starts, with the input tokens
// counted for the request; updates its output tokens from the stream at most
// every `LEDGER_CHECKPOINT_MS` (`meter.ts`); and closes it when the call ends,
// for any reason. Ledger writes are never fenced by the run's attempt (`03`
// E1): a superseded attempt still closes the row of the call it was making.
// Each write commits on its own, never in the transaction of a record write.
//
// Allowance reads count open rows, so a member's concurrent runs see each
// other's spending as of their last checkpoint. Rows hold ids and numbers, no
// text. `sqliteLedger.ts` implements it over `usage_events`;
// `memoryLedger.ts` is the in-memory one the tests use.

import type { ModelEntry, ModelProvider } from "@session/shared";

/** Who pays for a call (`03` K8). */
export type Payer = "included" | "key:anthropic" | "key:openai";

/** What a call was for. Every kind bills the run's asker. */
export type CallKind = "research" | "title" | "summary" | "context";

/** How a call ended (`03` E5, last column). Stored for diagnosis only; the
 * counts are what bill. */
export type CallEnding =
  /** The provider's `finish`: its own final counts. */
  | "finish"
  /** Cancel or delete (`03` G6). */
  | "cancel"
  | "timeout"
  /** A provider error, mid-stream or before the first chunk. */
  | "error"
  /** A 429 before the first chunk; closed at 0, the retry opens a new row. */
  | "rate_limited"
  /** The attempt fence stopped the attempt (`03` E1). */
  | "superseded"
  /** The member reached allowance plus overdraft (`03` K9). */
  | "overdraft"
  /** The run reached `SESSION_RUN_MAX_TOKENS` (`03` L1). */
  | "run_cap"
  /** `SIGTERM` (`01` S5). */
  | "drain"
  /** Still open at boot after a crash: closed with its last checkpoint. */
  | "boot";

/** Raw token counts of one call. `inputTokens` includes `cachedTokens`;
 * `outputTokens` includes `reasoningTokens` (`03` K2). */
export interface LedgerCounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export const ZERO_COUNTS: LedgerCounts = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
});

/** The row a provider call opens. */
export interface LedgerCall {
  runId: string;
  attempt: number;
  userId: string;
  payer: Payer;
  /** `weekOf` the call's start: the week its tokens count in (`03` K3). */
  week: string;
  kind: CallKind;
  provider: ModelProvider;
  model: string;
  /** How much a cached input token counts (`cachedInputRatio`). */
  cachedInputRatio: number;
  /** Input tokens as counted for the request; output 0. */
  counts: LedgerCounts;
  /** Epoch milliseconds. */
  openedAt: number;
}

export type LedgerState = "open" | "closed";

/** A row as stored. */
export interface LedgerRow extends LedgerCall {
  id: string;
  state: LedgerState;
  /** `countedTokens(counts, cachedInputRatio)`. */
  counted: number;
  updatedAt: number;
  ending: CallEnding | null;
}

/** One run's rows in one week, summed (`03` K5). */
export interface LedgerRunTotal {
  runId: string;
  /** Counted tokens of every row, every payer and attempt. */
  counted: number;
  /** Counted tokens paid with included tokens. */
  includedCounted: number;
  /** The payers of the run's rows. */
  payers: ReadonlySet<Payer>;
  /** The earliest `openedAt` of the run's rows (epoch ms). */
  startedAt: number;
}

export interface Ledger {
  /** Inserts an `open` row and returns its id. */
  open(call: LedgerCall): string;
  /** Replaces an open row's counts (the stream's latest). A closed or unknown
   * row is left as it is. */
  checkpoint(id: string, counts: LedgerCounts, at: number): void;
  /** Closes an open row with its final counts. Closing a closed row changes
   * nothing, so every ending path may close without coordinating. */
  close(id: string, counts: LedgerCounts, ending: CallEnding, at: number): void;
  /** Boot (`01` S5): closes every row still open with the counts of its last
   * checkpoint and returns how many it closed. */
  closeOpen(at: number): number;
  /** The member's counted `included` tokens in `week`, open rows counted. */
  includedUsage(userId: string, week: string): number;
  /** The counted tokens of a run, every payer: of one attempt, or of every
   * attempt when `attempt` is absent. The run record's `tok` is the latter. */
  runTokens(runId: string, attempt?: number): number;
  /** The member's runs with rows in `week`, open rows counted, newest
   * `startedAt` first (ties by run id, descending): the Usage page's recent
   * runs (`03` K5). */
  runsOf(userId: string, week: string): LedgerRunTotal[];
}

/** The ledger checkpoint bound of `03` K1: at most this much of a call's
 * output can go unbilled after a crash. */
export const LEDGER_CHECKPOINT_MS = 2_000;

/** How much a cached input token counts for `entry`: its registry ratio
 * (`ModelEntry.cachedInputRatio`, `03` K2, decision P12), or 1 for a model
 * without one, which never undercounts. */
export function cachedInputRatio(entry: Pick<ModelEntry, "cachedInputRatio">): number {
  return entry.cachedInputRatio ?? 1;
}

/** Input plus output, with cached input at its ratio, rounded up (`03` K2). */
export function countedTokens(counts: LedgerCounts, ratio: number): number {
  const cached = Math.min(Math.max(counts.cachedTokens, 0), Math.max(counts.inputTokens, 0));
  const uncached = Math.max(counts.inputTokens, 0) - cached;
  return uncached + Math.ceil(cached * ratio) + Math.max(counts.outputTokens, 0);
}

const DAY_MS = 86_400_000;

/** The ISO date (`YYYY-MM-DD`) of the Friday 00:00 UTC that starts the week
 * holding `at` (`03` K1, K3). */
export function weekOf(at: number): string {
  const day = new Date(at);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  // getUTCDay: Sunday 0 … Friday 5, Saturday 6.
  const sinceFriday = (day.getUTCDay() + 2) % 7;
  return new Date(midnight - sinceFriday * DAY_MS).toISOString().slice(0, 10);
}

/** When the week holding `at` ends: the next Friday 00:00 UTC. */
export function weekResetAt(at: number): number {
  return Date.parse(`${weekOf(at)}T00:00:00.000Z`) + 7 * DAY_MS;
}
