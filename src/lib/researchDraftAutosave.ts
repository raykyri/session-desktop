const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ResearchDraftAutosaveOptions {
  /** The prompt as stored. */
  initial: string;
  delayMs: number;
  save: (prompt: string) => Promise<unknown>;
  /** Callback invoked on save failure unless cancelled. */
  onError: (message: string) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Manages debounced draft persistence. Debounces writes by `delayMs`,
 * skipping empty or unchanged text. `flush` triggers an immediate write
 * during unmount. `saveNow` triggers an immediate write, resolving true if
 * changes were written or false if unchanged. Failed saves retain unpersisted
 * state so subsequent attempts retry persistence unless superseded by newer
 * writes. `finish` halts autosave and ignores pending errors during submission
 * or deletion. `resume` re-enables autosave if submission or deletion fails. */
export function createResearchDraftAutosave({
  initial,
  delayMs,
  save,
  onError,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}: ResearchDraftAutosaveOptions) {
  /** The text last written, or being written. */
  let saved = initial;
  /** The text the most recent successful write stored. */
  let stored = initial;
  let storedWrite = 0;
  let writes = 0;
  /** Whether the most recent write failed. */
  let latestFailed = false;
  let latest = initial;
  let finished = false;
  let timer: unknown = null;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const needsSave = () => !finished && Boolean(latest.trim()) && latest !== saved;
  const write = (prompt: string) => {
    const id = ++writes;
    saved = prompt;
    latestFailed = false;
    const saving = save(prompt);
    void saving.then(
      () => {
        if (id < storedWrite) return;
        stored = prompt;
        storedWrite = id;
        if (latestFailed) saved = stored;
      },
      (err: unknown) => {
        // If not superseded by a newer write, restore last stored text so
        // the next save retries.
        if (id === writes) {
          latestFailed = true;
          saved = stored;
        }
        if (!finished) onError(errorMessage(err));
      },
    );
    return saving;
  };

  return {
    edit(value: string) {
      latest = value;
      cancel();
      if (!needsSave()) return;
      timer = setTimer(() => {
        timer = null;
        if (needsSave()) write(latest);
      }, delayMs);
    },
    /** Returns whether a write was initiated. */
    flush(): boolean {
      cancel();
      if (!needsSave()) return false;
      void write(latest);
      return true;
    },
    /** Triggers an immediate write. Rejects if the save fails. */
    async saveNow(): Promise<boolean> {
      cancel();
      if (!needsSave()) return false;
      await write(latest);
      return true;
    },
    finish() {
      finished = true;
      cancel();
    },
    resume() {
      finished = false;
    },
  };
}

/** Wraps `save` to pass images only when the array reference differs from
 * the last successfully saved value, passing undefined otherwise to
 * preserve existing stored images and avoid redundant image reads. */
export function createResearchDraftImageSave<Image>(
  initial: readonly Image[],
  save: (prompt: string, images: readonly Image[] | undefined) => Promise<unknown>,
) {
  let saved = initial;
  return async (prompt: string, images: readonly Image[]) => {
    const changed = images !== saved ? images : undefined;
    await save(prompt, changed);
    if (changed) saved = changed;
  };
}
