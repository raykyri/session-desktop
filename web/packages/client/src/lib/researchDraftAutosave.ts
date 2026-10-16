// Autosave controller for the saved-draft view, adapted from desktop
// `src/lib/researchDraftAutosave.ts`.

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ResearchDraftAutosaveOptions {
  /** Initial prompt value currently stored. */
  initial: string;
  delayMs: number;
  save: (prompt: string) => Promise<unknown>;
  /** Invoked when a save operation fails, unless superseded or finished. */
  onError: (message: string) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Debounces draft prompt autosaves by `delayMs`, skipping empty or unchanged text.
 * `flush` triggers an immediate write of pending edits. `saveNow` persists immediately,
 * returning a promise resolving to true on successful write or false if no write was required.
 * Failed writes reset state so subsequent save attempts can retry. `finish` aborts pending timers
 * and ignores errors when submitting or deleting the draft. `resume` re-enables saving if
 * submission or deletion fails.
 */
export function createResearchDraftAutosave({
  initial,
  delayMs,
  save,
  onError,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}: ResearchDraftAutosaveOptions) {
  /** Value currently being written or completed by the last write call. */
  let saved = initial;
  /** Value acknowledged by the most recent successful write. */
  let stored = initial;
  let storedWrite = 0;
  let writes = 0;
  /** Indicates whether the most recent write request failed. */
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
        // If superseded by a newer write, ignore failure; otherwise mark unsaved for retry.
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
        if (needsSave()) void write(latest);
      }, delayMs);
    },
    /** Initiates an immediate write if edits are pending; returns true if a write started. */
    flush(): boolean {
      cancel();
      if (!needsSave()) return false;
      void write(latest);
      return true;
    },
    /** Executes an immediate write; rejects on error after invoking `onError`. */
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

/**
 * Wraps `save` to omit image attachments (passing undefined) when the images array
 * identity matches the last successfully saved array, preventing redundant backend file reads
 * during text-only autosaves.
 */
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
