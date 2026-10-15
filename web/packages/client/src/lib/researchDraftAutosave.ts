// The saved-draft view's autosave, ported unchanged from the desktop's
// `src/lib/researchDraftAutosave.ts`.

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ResearchDraftAutosaveOptions {
  /** The prompt as stored. */
  initial: string;
  delayMs: number;
  save: (prompt: string) => Promise<unknown>;
  /** A failed save, unless a send or delete started since. */
  onError: (message: string) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Saves edits after `delayMs` without further input, unless the text is
 * empty or already stored. `flush` saves a pending edit immediately when
 * closing the view; `saveNow` does too (⌘S) and resolves true once that save
 * succeeds, or false at once when nothing needed saving. A failed save
 * leaves the text unsaved again, unless a newer save started since, so ⌘S,
 * `flush` and the next pause save it again. `finish` stops
 * saves and ignores pending save errors when sending or deleting, preventing
 * the draft from being recreated. `resume` allows saves again if sending or
 * deleting fails. */
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
        // A newer write supersedes this one; otherwise the text is unsaved
        // again and the next save retries it.
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
    /** Returns whether it started a save. */
    flush(): boolean {
      cancel();
      if (!needsSave()) return false;
      void write(latest);
      return true;
    },
    /** Rejects when the save fails, after `onError` reported it. */
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

/** Wraps `save` so it receives the draft's images only when the array
 * differs (by identity) from the one last saved successfully, and undefined
 * otherwise, which keeps the stored images; text autosaves then do not make
 * the backend read every image file again. */
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
