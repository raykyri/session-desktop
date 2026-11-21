// The text of runs still streaming, from the ephemeral `run.delta` events
// of the sync stream (`03-agents-and-research.md` T2, T3; ADR-22).
//
// The rule of T3: a delta applies only when its `seq` is the next one for
// its `(run, attempt)`; a lower one (a duplicate) is dropped, and so is a
// delta of an older attempt. A gap, a delta of an attempt not yet seen past
// its first delta, and a reconnect read `GET /api/runs/:id/live`, which
// answers the attempt's streaming text with its `seq`; a read that fails is
// tried again with a growing wait. A run's text is dropped when the run
// leaves `running` or changes attempt, when its ask is moderated and the
// viewer may not read it, and when its space's log is read again (`resync`);
// the replica decides each (`syncReplica.ts`). Deltas are an
// optimization: committed turns and the answer are records the replica
// pulls (T1), so a reader that misses every delta still converges on the
// same answer.

/** A `run.delta` event (`spaceRunDeltaSchema`): `n` is the number of the
 * turn record the text belongs to. */
export interface RunDelta {
  run: string;
  attempt: number;
  seq: number;
  n: number;
  text: string;
}

/** What `/live` answers of the streaming turn. */
export interface LiveRead {
  attempt: number;
  live: { n: number; text: string; seq: number } | null;
}

/** A run's streaming turn as the client holds it. */
export interface LiveText {
  attempt: number;
  /** The number of the turn the text belongs to. */
  n: number;
  text: string;
  seq: number;
}

export interface RunLiveOptions {
  /** `GET /api/runs/:id/live`; null when the run is not readable. A read that
   * fails (rejects) is tried again after `retryMs`, doubled on each failure
   * up to `maxRetryMs`, until it answers or the run's text is dropped. */
  read: (run: string) => Promise<LiveRead | null>;
  /** The held texts changed. */
  onChange: () => void;
  /** 1 s when absent. */
  retryMs?: number;
  /** 30 s when absent. */
  maxRetryMs?: number;
}

export class RunLiveTexts {
  readonly #texts = new Map<string, LiveText>();
  /** Runs whose `/live` read is in flight, and whether another is due. */
  readonly #reading = new Map<string, boolean>();
  /** Failed reads waiting to be tried again: the timer and the next wait. */
  readonly #retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>();
  /** Bumped when a run's text is dropped: a read begun before it is
   * ignored when it answers. */
  readonly #epochs = new Map<string, number>();
  readonly #options: RunLiveOptions;

  constructor(options: RunLiveOptions) {
    this.#options = options;
  }

  get(run: string): LiveText | null {
    return this.#texts.get(run) ?? null;
  }

  /** The runs with a held text. */
  runs(): string[] {
    return [...this.#texts.keys()];
  }

  apply(d: RunDelta): void {
    const held = this.#texts.get(d.run);
    if (held && d.attempt < held.attempt) return;
    if (!held || d.attempt > held.attempt) {
      // a new attempt: its first delta starts the text; any later one means
      // earlier deltas were missed
      if (d.seq === 1) this.#set(d.run, { attempt: d.attempt, n: d.n, text: d.text, seq: 1 });
      else this.refetch(d.run);
      return;
    }
    if (d.seq <= held.seq) return;
    if (d.seq !== held.seq + 1) {
      this.refetch(d.run);
      return;
    }
    const text = d.n > held.n ? d.text : held.n === d.n ? held.text + d.text : held.text;
    this.#set(d.run, { attempt: d.attempt, n: Math.max(d.n, held.n), text, seq: d.seq });
  }

  /** Read `/live` for `run` (a gap, a reconnect). One read at a time per run;
   * one asked for while a read is in flight follows it. */
  refetch(run: string): void {
    if (this.#reading.has(run)) {
      this.#reading.set(run, true);
      return;
    }
    const retry = this.#retries.get(run);
    if (retry) clearTimeout(retry.timer);
    this.#reading.set(run, false);
    const epoch = this.#epochs.get(run) ?? 0;
    const current = () => (this.#epochs.get(run) ?? 0) === epoch;
    void this.#options
      .read(run)
      .then(
        (r) => {
          if (!current()) return;
          this.#retries.delete(run);
          if (r === null) {
            if (this.#texts.delete(run)) this.#options.onChange();
            return;
          }
          const held = this.#texts.get(run);
          if (held && r.attempt < held.attempt) return;
          if (r.live === null) {
            if (this.#texts.delete(run)) this.#options.onChange();
            return;
          }
          // a delta that arrived during the read may be ahead of its answer
          if (held && held.attempt === r.attempt && held.seq >= r.live.seq) return;
          this.#set(run, { attempt: r.attempt, ...r.live });
        },
        () => {
          if (current()) this.#retry(run);
        },
      )
      .finally(() => {
        if (!current()) return;
        const again = this.#reading.get(run) === true;
        this.#reading.delete(run);
        if (again) this.refetch(run);
      });
  }

  /** A failed read: try again after a growing wait. */
  #retry(run: string): void {
    const base = this.#options.retryMs ?? 1_000;
    const wait = this.#retries.get(run)?.wait ?? base;
    const timer = setTimeout(() => this.refetch(run), wait);
    (timer as { unref?: () => void }).unref?.();
    this.#retries.set(run, {
      timer,
      wait: Math.min(wait * 2, this.#options.maxRetryMs ?? 30_000),
    });
  }

  /** The stream reconnected: every held text may have missed deltas. */
  reconnected(runs: Iterable<string> = this.#texts.keys()): void {
    for (const run of [...runs]) this.refetch(run);
  }

  /** Forget a run's text (it ended, its attempt is not running, or the
   * viewer may no longer read it), and any read of it in flight or due. */
  drop(run: string): void {
    this.#epochs.set(run, (this.#epochs.get(run) ?? 0) + 1);
    this.#reading.delete(run);
    const retry = this.#retries.get(run);
    if (retry) clearTimeout(retry.timer);
    this.#retries.delete(run);
    if (this.#texts.delete(run)) this.#options.onChange();
  }

  /** Forget every run's text: the replica stopped. */
  clear(): void {
    for (const run of new Set([
      ...this.#texts.keys(),
      ...this.#reading.keys(),
      ...this.#retries.keys(),
    ]))
      this.drop(run);
  }

  #set(run: string, text: LiveText): void {
    this.#texts.set(run, text);
    this.#options.onChange();
  }
}
