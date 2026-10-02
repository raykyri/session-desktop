/** One startup run owns both hydration phases, cancellation, and window reveal. */
export function startAppStartup<Initial, Secondary>(options: {
  loadInitial: () => Promise<Initial>;
  loadSecondary: (initial: Initial) => Promise<Secondary>;
  applyInitial: (initial: Initial, isCancelled: () => boolean) => Promise<void>;
  applySecondary: (secondary: Secondary) => void;
  onError: (error: unknown) => void;
  reveal: () => Promise<unknown>;
}): () => void {
  let cancelled = false;
  const isCancelled = () => cancelled;
  async function secondary(initial: Initial) {
    try {
      const snapshot = await options.loadSecondary(initial);
      if (!cancelled) options.applySecondary(snapshot);
    } catch (error) {
      if (!cancelled) options.onError(error);
    }
  }
  async function boot() {
    try {
      const snapshot = await options.loadInitial();
      if (cancelled) return;
      void secondary(snapshot);
      await options.applyInitial(snapshot, isCancelled);
    } catch (error) {
      if (!cancelled) options.onError(error);
    } finally {
      // A failed boot must still show its error. A cancelled run never reveals.
      if (!cancelled) void options.reveal().catch(() => undefined);
    }
  }
  void boot();
  return () => {
    cancelled = true;
  };
}
