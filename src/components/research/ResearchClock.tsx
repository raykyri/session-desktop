import { useNow } from "../../hooks/useNow";
import { formatElapsedClock, shortWhen } from "../../lib/shortTime";

/** An active run's elapsed time ("1:08"), ticking once a second. Only this
 * span re-renders on each tick. */
export function ResearchElapsedClock({ since }: { since: number }) {
  const now = useNow(1000);
  return <span className="research-tnum">{formatElapsedClock(now - since)}</span>;
}

/** A relative time ("31 min", "2d") that refreshes once a minute. */
export function ResearchRelativeTime({ at }: { at: number }) {
  const now = useNow(60_000);
  return <>{shortWhen(at, now)}</>;
}
