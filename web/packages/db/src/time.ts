/**
 * Returns current timestamp in milliseconds since the Unix epoch.
 * Centralized clock function to allow deterministic mocking in tests.
 */
export function now(): number {
  return Date.now();
}

/**
 * Computes a strictly monotonic timestamp given a candidate value and previous timestamp.
 * Ensures timestamps advance by at least 1 millisecond for consecutive writes.
 */
export function strictlyAfter(previous: number | null | undefined, candidate: number): number {
  return previous === null || previous === undefined
    ? candidate
    : Math.max(candidate, previous + 1);
}

/** Returns the start of the UTC day containing timestamp `at` in milliseconds. */
export function startOfUtcDay(at: number): number {
  return Math.floor(at / 86_400_000) * 86_400_000;
}

/** Returns the next UTC midnight timestamp following `at` in milliseconds. */
export function nextUtcMidnight(at: number): number {
  return startOfUtcDay(at) + 86_400_000;
}
