// A message row's text in a thread's messages and branches columns is
// clamped to 12 lines (research.css, .research-msg-clamp) until the row's
// Show more expands it. These are the clamp's measurement and the thread's
// set of expanded rows.

/** The clamped text is cut off: its content is taller than its clamped box.
 * One pixel of slack absorbs subpixel rounding of the two heights. */
export function researchTileOverflows(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight > 1;
}

/** `expanded` with `id` added, or removed when it is already there. */
export function toggleResearchTile(expanded: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
}
