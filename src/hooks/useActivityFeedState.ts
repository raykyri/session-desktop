import { useCallback, useEffect, useRef } from "react";
import type { ResearchActivityFeedProps } from "../components/research/ResearchActivityFeed";
import {
  readActivityFeedState,
  saveActivityFeedState,
  type ActivityFeedScrollAnchor,
  type ActivityFeedState,
} from "../lib/activityFeedState";

/** Preserves activity feed scroll anchor state across unmounts. */
export function useActivityFeedState(): Pick<
  ResearchActivityFeedProps,
  "initialScrollAnchor" | "onScrollAnchorChange"
> {
  const stateRef = useRef<ActivityFeedState | null>(null);
  if (stateRef.current === null) stateRef.current = readActivityFeedState();
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    if (stateRef.current) saveActivityFeedState(stateRef.current);
  }, []);
  const onScrollAnchorChange = useCallback((anchor: ActivityFeedScrollAnchor | null) => {
    if (anchor && (anchor.key === "" || !Number.isFinite(anchor.offset))) return;
    const current = stateRef.current!.scroll;
    if (current?.key === anchor?.key && current?.offset === anchor?.offset) return;
    stateRef.current = { ...stateRef.current!, scroll: anchor };
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
    initialScrollAnchor: stateRef.current.scroll,
    onScrollAnchorChange,
  };
}
