import { useCallback, useEffect, useRef, useState } from "react";
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

/** One toast at a time for feed and folder actions; a new one replaces it.
 * Its timer pauses while the pointer or focus is on it. */
export function useResearchToast() {
  const [toast, setToast] = useState<ResearchToast | null>(null);
  const timerRef = useRef<number | null>(null);
  const nextIdRef = useRef(1);
  // The running toast's id, the time left, and when its timer last started.
  const clockRef = useRef<{ id: number; remaining: number; startedAt: number } | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const startTimer = useCallback((id: number, ms: number) => {
    clearTimer();
    clockRef.current = { id, remaining: ms, startedAt: Date.now() };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      clockRef.current = null;
      setToast((current) => (current?.id === id ? null : current));
    }, ms);
  }, []);

  const dismissToast = useCallback(() => {
    clearTimer();
    clockRef.current = null;
    setToast(null);
  }, []);

  const showToast = useCallback(
    (message: ReactNode, options: { undo?: () => void; tone?: "warning" } = {}) => {
      const id = nextIdRef.current++;
      setToast({ id, message, ...options });
      startTimer(id, options.undo ? UNDO_TOAST_MS : TOAST_MS);
    },
    [startTimer],
  );

  const pauseToast = useCallback(() => {
    const clock = clockRef.current;
    if (!clock || timerRef.current === null) return;
    clearTimer();
    clock.remaining = Math.max(0, clock.remaining - (Date.now() - clock.startedAt));
  }, []);

  const resumeToast = useCallback(() => {
    const clock = clockRef.current;
    if (!clock || timerRef.current !== null) return;
    startTimer(clock.id, Math.max(1500, clock.remaining));
  }, [startTimer]);

  const undoToast = useCallback(() => {
    const undo = toast?.undo;
    dismissToast();
    undo?.();
  }, [dismissToast, toast]);

  useEffect(() => clearTimer, []);

  return { toast, showToast, dismissToast, undoToast, pauseToast, resumeToast };
}
