/**
 * The clock the repositories read. Every persisted timestamp is milliseconds
 * since the Unix epoch (`docs/02-domain-model-and-database.md` §1), and every
 * repository takes its `now` from here so a test can pin it by stubbing one
 * module rather than the global `Date`.
 */
export function now(): number {
  return Date.now();
}

/**
 * The next value of a timestamp that must increase even when two writes land
 * in the same millisecond. `trees.updated_at` and `nodes.response_snapshot_at`
 * are read as change tokens by the client, so the desktop forced them forward
 * with `now.max(previous + 1)` (`state.rs:5074`); this is that rule.
 */
export function strictlyAfter(previous: number | null | undefined, candidate: number): number {
  return previous === null || previous === undefined
    ? candidate
    : Math.max(candidate, previous + 1);
}

/** Start of the UTC day containing `at`, the bucket daily limits count in. */
export function startOfUtcDay(at: number): number {
  return Math.floor(at / 86_400_000) * 86_400_000;
}
