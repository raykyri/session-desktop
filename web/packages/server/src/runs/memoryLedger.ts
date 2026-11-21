// The ledger in memory, for tests and for a server built without the
// database ledger (`ledger.ts`). Same semantics as the SQLite one: rows are
// written one call at a time, reads count open rows.

import { randomUUID } from "node:crypto";

import type {
  CallEnding,
  Ledger,
  LedgerCall,
  LedgerCounts,
  LedgerRow,
  LedgerRunTotal,
  Payer,
} from "./ledger.js";
import { countedTokens } from "./ledger.js";

/** One checkpoint or close, kept so a test can measure the output a call
 * streamed between two writes. */
export interface LedgerWrite {
  at: number;
  counts: LedgerCounts;
}

export interface MemoryLedgerRow extends LedgerRow {
  writes: LedgerWrite[];
}

export class MemoryLedger implements Ledger {
  readonly #rows = new Map<string, MemoryLedgerRow>();

  constructor(rows: Iterable<MemoryLedgerRow> = []) {
    for (const row of rows) {
      this.#rows.set(row.id, structuredClone(row));
    }
  }

  /** Every row, in insertion order. */
  rows(filter: Partial<Pick<LedgerRow, "runId" | "attempt" | "userId">> = {}): MemoryLedgerRow[] {
    return [...this.#rows.values()].filter(
      (row) =>
        (filter.runId === undefined || row.runId === filter.runId) &&
        (filter.attempt === undefined || row.attempt === filter.attempt) &&
        (filter.userId === undefined || row.userId === filter.userId),
    );
  }

  /** The rows as a process kill would leave them: a separate ledger holding
   * a copy of every row as last written. Writes to this ledger afterwards do
   * not reach the copy. */
  crashCopy(): MemoryLedger {
    return new MemoryLedger(this.#rows.values());
  }

  open(call: LedgerCall): string {
    const id = randomUUID();
    this.#rows.set(id, {
      ...structuredClone(call),
      id,
      state: "open",
      counted: countedTokens(call.counts, call.cachedInputRatio),
      updatedAt: call.openedAt,
      ending: null,
      writes: [{ at: call.openedAt, counts: { ...call.counts } }],
    });
    return id;
  }

  checkpoint(id: string, counts: LedgerCounts, at: number): void {
    const row = this.#rows.get(id);
    if (row?.state !== "open") {
      return;
    }
    this.#write(row, counts, at);
  }

  close(id: string, counts: LedgerCounts, ending: CallEnding, at: number): void {
    const row = this.#rows.get(id);
    if (row?.state !== "open") {
      return;
    }
    this.#write(row, counts, at);
    row.state = "closed";
    row.ending = ending;
  }

  closeOpen(at: number): number {
    let closed = 0;
    for (const row of this.#rows.values()) {
      if (row.state === "open") {
        row.state = "closed";
        row.ending = "boot";
        row.updatedAt = at;
        closed += 1;
      }
    }
    return closed;
  }

  includedUsage(userId: string, week: string): number {
    let total = 0;
    for (const row of this.#rows.values()) {
      if (row.userId === userId && row.week === week && row.payer === "included") {
        total += row.counted;
      }
    }
    return total;
  }

  runTokens(runId: string, attempt?: number): number {
    let total = 0;
    for (const row of this.#rows.values()) {
      if (row.runId === runId && (attempt === undefined || row.attempt === attempt)) {
        total += row.counted;
      }
    }
    return total;
  }

  runPayers(runId: string, attempt: number): ReadonlySet<Payer> {
    const payers = new Set<Payer>();
    for (const row of this.#rows.values())
      if (row.runId === runId && row.attempt === attempt) payers.add(row.payer);
    return payers;
  }

  runsOf(userId: string, week: string): LedgerRunTotal[] {
    const runs = new Map<
      string,
      { counted: number; includedCounted: number; payers: Set<Payer>; startedAt: number }
    >();
    for (const row of this.#rows.values()) {
      if (row.userId !== userId || row.week !== week) continue;
      const run = runs.get(row.runId) ?? {
        counted: 0,
        includedCounted: 0,
        payers: new Set<Payer>(),
        startedAt: row.openedAt,
      };
      run.counted += row.counted;
      if (row.payer === "included") run.includedCounted += row.counted;
      run.payers.add(row.payer);
      run.startedAt = Math.min(run.startedAt, row.openedAt);
      runs.set(row.runId, run);
    }
    return [...runs.entries()]
      .map(([runId, run]) => ({ runId, ...run }))
      .sort((a, b) =>
        a.startedAt !== b.startedAt
          ? b.startedAt - a.startedAt
          : a.runId < b.runId
            ? 1
            : a.runId > b.runId
              ? -1
              : 0,
      );
  }

  #write(row: MemoryLedgerRow, counts: LedgerCounts, at: number): void {
    row.counts = { ...counts };
    row.counted = countedTokens(counts, row.cachedInputRatio);
    row.updatedAt = at;
    row.writes.push({ at, counts: { ...counts } });
  }
}
