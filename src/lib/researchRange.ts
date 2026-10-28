// A range selection in a list column (the feed, or a level's messages
// column): the rows from the column's selected row (the anchor) to another
// row of the same list (the far end), in the order the column lists them.
// The content column shows the range's rows one after another, read-only.

/** The ids from `anchor` to `far`, inclusive, in `ids`' order; null when
 * either is not in `ids` or they are the same row (a range holds at least
 * two rows). */
export function researchRangeIds(
  ids: readonly string[],
  anchor: string,
  far: string,
): string[] | null {
  const from = ids.indexOf(anchor);
  const to = ids.indexOf(far);
  if (from < 0 || to < 0 || from === to) return null;
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** The row one step from `far` (Shift+↑ is -1, Shift+↓ is 1), or null at
 * the end of the list or when `far` is not in it. */
export function researchRangeStep(
  ids: readonly string[],
  far: string,
  direction: -1 | 1,
): string | null {
  const index = ids.indexOf(far);
  if (index < 0) return null;
  return ids[index + direction] ?? null;
}
