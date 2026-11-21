// The question of a run, read through the asker's current scope, for the
// Usage page's recent runs (`03-agents-and-research.md` K5).
//
// The ledger holds ids and numbers only (`ledger.ts`), so `usage.listRuns`
// reads each run's question here. A run whose thread or node was removed, or
// whose thread the person can no longer read, is listed without its
// question. The implementation over the `run` and node records comes with
// the SQLite server half (M3, M5a); `MemoryRunTexts` is the tests' and
// `UNAVAILABLE_RUN_TEXTS` the default until then.

export type RunText =
  | { question: string }
  /** `removed`: the thread or node was removed or deleted; `unavailable`:
   * the person can no longer read the thread, or the run is unknown. */
  | { missing: "removed" | "unavailable" };

export interface RunTexts {
  questionOf(viewerId: string, runId: string): RunText;
}

export const UNAVAILABLE_RUN_TEXTS: RunTexts = {
  questionOf: () => ({ missing: "unavailable" }),
};

interface MemoryRunText {
  question: string;
  /** Who may read the thread now. */
  readers: Set<string>;
  removed: boolean;
}

export class MemoryRunTexts implements RunTexts {
  readonly #runs = new Map<string, MemoryRunText>();

  /** Records a run's question, readable by `readers`. */
  set(runId: string, question: string, readers: Iterable<string>): void {
    this.#runs.set(runId, { question, readers: new Set(readers), removed: false });
  }

  /** The run's thread was removed: its text is erased. */
  remove(runId: string): void {
    const run = this.#runs.get(runId);
    if (run) this.#runs.set(runId, { question: "", readers: run.readers, removed: true });
  }

  /** `viewerId` can no longer read the run's thread. */
  revoke(runId: string, viewerId: string): void {
    this.#runs.get(runId)?.readers.delete(viewerId);
  }

  questionOf(viewerId: string, runId: string): RunText {
    const run = this.#runs.get(runId);
    if (run?.removed) return { missing: "removed" };
    if (!run?.readers.has(viewerId)) return { missing: "unavailable" };
    return { question: run.question };
  }
}
