import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

export interface ResearchToast {
  id: number;
  message: ReactNode;
  tone?: "warning";
  /** Shown as an Undo button; the toast then stays 6s instead of 3.5s. */
  undo?: () => void;
}

const TOAST_MS = 3500;
const UNDO_TOAST_MS = 6000;
/** A resumed toast stays at least this long, so it can be read. */
const RESUME_MIN_MS = 1500;

/** The timer of the toast showing: `expire` runs once its time has run out.
 * Pausing keeps the time left; resuming restarts with that (at least
 * RESUME_MIN_MS). Starting another toast replaces the running one. */
export function createResearchToastTimer(
  expire: (id: number) => void,
  now: () => number = Date.now,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The running toast's id, the time left, and when its timer last started.
  let clock: { id: number; remaining: number; startedAt: number } | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const start = (id: number, ms: number) => {
    clear();
    clock = { id, remaining: ms, startedAt: now() };
    timer = setTimeout(() => {
      timer = null;
      clock = null;
      expire(id);
    }, ms);
  };

  return {
    start,
    pause() {
      if (!clock || timer === null) return;
      clear();
      clock.remaining = Math.max(0, clock.remaining - (now() - clock.startedAt));
    },
    resume() {
      if (!clock || timer !== null) return;
      start(clock.id, Math.max(RESUME_MIN_MS, clock.remaining));
    },
    stop() {
      clear();
      clock = null;
    },
  };
}

/** One toast at a time for feed and folder actions; a new one replaces it.
 * Its timer pauses while the pointer or focus is on it. */
export function useResearchToast() {
  const [toast, setToast] = useState<ResearchToast | null>(null);
  const [nextId] = useState(() => {
    let id = 1;
    return () => id++;
  });
  const [timer] = useState(() =>
    createResearchToastTimer((id) =>
      setToast((current) => (current?.id === id ? null : current)),
    ),
  );

  const dismissToast = useCallback(() => {
    timer.stop();
    setToast(null);
  }, [timer]);

  const showToast = useCallback(
    (message: ReactNode, options: { undo?: () => void; tone?: "warning" } = {}) => {
      const id = nextId();
      setToast({ id, message, ...options });
      timer.start(id, options.undo ? UNDO_TOAST_MS : TOAST_MS);
    },
    [nextId, timer],
  );

  const undoToast = useCallback(() => {
    const undo = toast?.undo;
    dismissToast();
    undo?.();
  }, [dismissToast, toast]);

  useEffect(() => () => timer.stop(), [timer]);

  return {
    toast,
    showToast,
    dismissToast,
    undoToast,
    pauseToast: timer.pause,
    resumeToast: timer.resume,
  };
}
