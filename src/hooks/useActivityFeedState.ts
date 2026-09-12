import { useCallback, useEffect, useRef } from "react";
import { readActivityFeedState, saveActivityFeedState, type ActivityFeedState } from "../lib/activityFeedState";

/** App-owned state survives feed unmounts without rerendering App on each keystroke/scroll. */
export function useActivityFeedState() {
  const stateRef = useRef<ActivityFeedState | null>(null);
  if (stateRef.current === null) stateRef.current = readActivityFeedState();
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    if (stateRef.current) saveActivityFeedState(stateRef.current);
  }, []);
  const onScrollChange = useCallback((scrollTop: number) => {
    if (!Number.isFinite(scrollTop)) return;
    const top = Math.max(0, scrollTop);
    if (stateRef.current!.scrollTop === top) return;
    stateRef.current = { ...stateRef.current!, scrollTop: top };
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 200);
  }, [flush]);
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  return {
    initialScrollTop: stateRef.current.scrollTop,
    onScrollChange,
  };
}
