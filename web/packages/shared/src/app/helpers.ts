// Small pure helpers shared by the research surfaces. Everything here is
// framework-free: the sidebar cycle, the numeric clamp used by layout math, and
// the editable-target test the global shortcut listener consults.

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** The subset of an event target the shortcut listener needs. Expressed
 * structurally so `shared` does not depend on the DOM lib; the client passes
 * the real `EventTarget` after narrowing it to an element. */
export interface EditableTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** True when keystrokes belong to a text field rather than to the app's chord
 * table. The global listener checks this before dispatching a shortcut. */
export function isEditableTarget(target: EditableTargetLike | null): boolean {
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The next id in the sidebar cycle, wrapping at both ends.
 *
 * `fallbackIndex` is the position to start from when the active id is not in
 * the list (its row was filtered out, or nothing is selected yet); without one,
 * a forward cycle starts before the first row and a backward cycle at the
 * first.
 */
export function cycleTabId(
  tabIds: string[],
  activeTabId: string | null | undefined,
  direction: -1 | 1,
  fallbackIndex?: number,
): string | null {
  if (tabIds.length === 0) {
    return null;
  }

  const listedIndex = tabIds.indexOf(activeTabId ?? "");
  const currentIndex =
    listedIndex !== -1 ? listedIndex : (fallbackIndex ?? (direction === 1 ? -1 : 0));
  const nextIndex = (currentIndex + direction + tabIds.length) % tabIds.length;
  return tabIds[nextIndex] ?? null;
}

// Turn validation lives with the schema that defines it, as `isTurn` in
// `types/turn.ts`. It used to be duplicated here as a cheaper shape check, but
// the copy read a different set of fields than the one in `research/events.ts`
// and neither matched the schema.
