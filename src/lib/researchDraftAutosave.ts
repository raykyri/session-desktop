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
 * closing the view. `finish` stops saves and ignores pending save errors
 * when sending or deleting, preventing the draft from being recreated.
 * `resume` allows saves again if sending or deleting fails. */
export function createResearchDraftAutosave({
  initial,
  delayMs,
  save,
  onError,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}: ResearchDraftAutosaveOptions) {
  let saved = initial;
  let latest = initial;
  let finished = false;
  let timer: unknown = null;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const needsSave = () => !finished && Boolean(latest.trim()) && latest !== saved;
  const write = (prompt: string) => {
    saved = prompt;
    void save(prompt).catch((err: unknown) => {
      if (!finished) onError(errorMessage(err));
    });
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
    flush() {
      cancel();
      if (needsSave()) write(latest);
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
