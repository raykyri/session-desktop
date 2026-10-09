import type { ResearchFolderState } from "../types";
import { emptyResearchFolderState } from "./researchFolders";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ResearchFolderStoreOptions {
  list: () => Promise<ResearchFolderState>;
  save: (state: ResearchFolderState) => Promise<ResearchFolderState>;
  /** Every change of the local state. */
  onState: (state: ResearchFolderState) => void;
  /** The load failed (with the reason) or later succeeded (null). */
  onLoadError?: (message: string | null) => void;
}

/** The research folder state as stored by the backend, changed locally first
 * and written in order.
 *
 * Changes wait for the stored state to load, so a write never replaces
 * folders the frontend hasn't read; while the load fails, changes reject and
 * each one retries the load. A rejected write restores the state it replaced
 * unless a later change already superseded it. `refresh` re-reads the stored
 * state after another window changed it. It waits for this window's writes
 * and preserves local changes made during the refresh. */
export function createResearchFolderStore({
  list,
  save,
  onState,
  onLoadError,
}: ResearchFolderStoreOptions) {
  let state = emptyResearchFolderState();
  let loading: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let commitSeq = 0;

  const set = (next: ResearchFolderState) => {
    state = next;
    onState(next);
  };

  const load = (): Promise<void> => {
    loading ??= list().then(
      (loaded) => {
        set(loaded);
        onLoadError?.(null);
      },
      (err: unknown) => {
        loading = null;
        onLoadError?.(errorMessage(err));
        throw new Error(
          `Folders couldn't be loaded, so the change wasn't saved. ${errorMessage(err)}`,
        );
      },
    );
    return loading;
  };

  const commit = (update: (current: ResearchFolderState) => ResearchFolderState): Promise<void> =>
    load().then(() => {
      commitSeq += 1;
      const previous = state;
      const next = update(previous);
      if (next === previous) return;
      set(next);
      const write = writes
        .catch(() => undefined)
        .then(() => save(next))
        .then((saved) => {
          if (state === next) set(saved);
        })
        .catch((err: unknown) => {
          if (state === next) set(previous);
          throw err;
        });
      writes = write;
      return write;
    });

  const refresh = async (): Promise<void> => {
    const seq = commitSeq;
    await writes.catch(() => undefined);
    let stored: ResearchFolderState;
    try {
      stored = await list();
    } catch {
      return;
    }
    if (commitSeq !== seq) return;
    loading = Promise.resolve();
    onLoadError?.(null);
    set(stored);
  };

  return {
    getState: () => state,
    load,
    commit,
    refresh,
  };
}
