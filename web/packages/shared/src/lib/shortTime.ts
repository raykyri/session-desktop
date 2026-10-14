const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAYS_BEFORE_DATE = 30;

/** Compact relative time for dense metadata rows: "just now", "31 min",
 * "2h", "2d", then a short calendar date ("Sep 12", or "Sep 12, 2025" outside
 * the current year). Future timestamps (clock skew) read as "just now". */
export function shortWhen(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} min`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h`;
  }
  if (elapsed < DAYS_BEFORE_DATE * DAY_MS) {
    return `${Math.floor(elapsed / DAY_MS)}d`;
  }
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Elapsed run time as m:ss (or h:mm:ss past an hour), for status lines. */
export function formatElapsedClock(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** A finished run's length for prose: "42s", "1m 02s", "2h 05m". */
export function formatRunDuration(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
