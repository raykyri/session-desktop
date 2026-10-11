import { useEffect, useState } from "react";

/** The current time in ms, read again every `intervalMs` while it is not
 * null. Only the component that calls this re-renders on each tick, so a
 * clock belongs in the leaf that displays it. */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
