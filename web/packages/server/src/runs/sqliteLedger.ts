// The usage ledger over `usage_events` (`ledger.ts`; `03-agents-and-
// research.md` K1, K2, K5). One row per provider call: `open` inserts it
// with the input counted for the request, `checkpoint` replaces its counts at
// most every 2 s while the call streams, `close` writes the final counts. Each
// is one statement in its own implicit transaction, never inside a record
// write's transaction and never fenced (`03` E1). Allowance reads count open
// rows. The per-call tool rows (`recordToolUsage`) have no run id and are
// not part of the ledger.

import type { SessionDatabase } from "@session/db";
import { newId } from "@session/db";

import type {
  CallEnding,
  Ledger,
  LedgerCall,
  LedgerCounts,
  LedgerRunTotal,
  Payer,
} from "./ledger.js";
import { countedTokens } from "./ledger.js";

interface RunTotalRow {
  run_id: string;
  counted: number;
  included: number;
  payers: string;
  started_at: number;
}

export class SqliteLedger implements Ledger {
  readonly #s;

  constructor(db: SessionDatabase | SessionDatabase["$client"]) {
    const c = "$client" in db ? db.$client : db;
    this.#s = {
      open: c.prepare(
        `INSERT INTO usage_events (id, user_id, node_id, kind, provider, model, input_tokens,
           output_tokens, reasoning_tokens, cached_tokens, cost_estimate_micros, created_at,
           run_id, attempt, payer, week, state, ending, cached_ratio, counted, updated_at)
         VALUES (@id, @userId, NULL, @kind, @provider, @model, @inputTokens, @outputTokens,
           @reasoningTokens, @cachedTokens, 0, @openedAt, @runId, @attempt, @payer, @week, 'open',
           NULL, @ratio, @counted, @openedAt)`,
      ),
      write: c.prepare(
        `UPDATE usage_events SET input_tokens = @inputTokens, output_tokens = @outputTokens,
           reasoning_tokens = @reasoningTokens, cached_tokens = @cachedTokens,
           counted = @counted,
           updated_at = @at, state = @state, ending = @ending
         WHERE id = @id AND state = 'open'`,
      ),
      ratio: c.prepare<[string], { r: number }>(
        "SELECT cached_ratio AS r FROM usage_events WHERE id = ? AND state = 'open'",
      ),
      closeOpen: c.prepare(
        `UPDATE usage_events SET state = 'closed', ending = 'boot', updated_at = ? WHERE state = 'open'`,
      ),
      included: c.prepare<[string, string], { n: number | null }>(
        `SELECT sum(counted) AS n FROM usage_events
         WHERE user_id = ? AND week = ? AND payer = 'included' AND run_id IS NOT NULL`,
      ),
      runTokens: c.prepare<[string], { n: number | null }>(
        "SELECT sum(counted) AS n FROM usage_events WHERE run_id = ?",
      ),
      attemptTokens: c.prepare<[string, number], { n: number | null }>(
        "SELECT sum(counted) AS n FROM usage_events WHERE run_id = ? AND attempt = ?",
      ),
      runsOf: c.prepare<[string, string], RunTotalRow>(
        `SELECT run_id, sum(counted) AS counted,
           sum(CASE WHEN payer = 'included' THEN counted ELSE 0 END) AS included,
           group_concat(DISTINCT payer) AS payers, min(created_at) AS started_at
         FROM usage_events WHERE user_id = ? AND week = ? AND run_id IS NOT NULL
         GROUP BY run_id ORDER BY started_at DESC, run_id DESC`,
      ),
    };
  }

  open(call: LedgerCall): string {
    const id = newId();
    this.#s.open.run({
      id,
      userId: call.userId,
      kind: call.kind,
      provider: call.provider,
      model: call.model,
      ...call.counts,
      openedAt: call.openedAt,
      runId: call.runId,
      attempt: call.attempt,
      payer: call.payer,
      week: call.week,
      ratio: call.cachedInputRatio,
      counted: countedTokens(call.counts, call.cachedInputRatio),
    });
    return id;
  }

  #write(id: string, counts: LedgerCounts, at: number, ending: CallEnding | null): void {
    // a closed or unknown row is left as it is
    const row = this.#s.ratio.get(id);
    if (!row) return;
    this.#s.write.run({
      id,
      ...counts,
      counted: countedTokens(counts, row.r),
      at,
      state: ending === null ? "open" : "closed",
      ending,
    });
  }

  checkpoint(id: string, counts: LedgerCounts, at: number): void {
    this.#write(id, counts, at, null);
  }

  close(id: string, counts: LedgerCounts, ending: CallEnding, at: number): void {
    this.#write(id, counts, at, ending);
  }

  closeOpen(at: number): number {
    return this.#s.closeOpen.run(at).changes;
  }

  includedUsage(userId: string, week: string): number {
    return this.#s.included.get(userId, week)?.n ?? 0;
  }

  runTokens(runId: string, attempt?: number): number {
    return (
      (attempt === undefined
        ? this.#s.runTokens.get(runId)
        : this.#s.attemptTokens.get(runId, attempt)
      )?.n ?? 0
    );
  }

  runsOf(userId: string, week: string): LedgerRunTotal[] {
    return this.#s.runsOf.all(userId, week).map((r) => ({
      runId: r.run_id,
      counted: r.counted,
      includedCounted: r.included,
      payers: new Set(r.payers.split(",") as Payer[]),
      startedAt: r.started_at,
    }));
  }
}
