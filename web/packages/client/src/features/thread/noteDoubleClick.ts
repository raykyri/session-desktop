// A double-click on a note edits it (`09-research-document-view.md` §8),
// ported from the desktop `researchNoteDoubleClick.ts`. The rule (primary
// button, no modifier, not on a link, button or embed inside the note) is the
// shared `researchNoteDoubleClickEdits`.

import { researchNoteDoubleClickEdits } from "@session/shared/lib/researchNoteEdit";
import type { MouseEvent as ReactMouseEvent } from "react";

/** The props that make a double-click on a note item edit the note. `edit`
 * is undefined for a note that cannot be edited. `ignore` names children
 * that keep their own double-click. The second press of a double-click does
 * not select a word. */
export function noteDoubleClickProps(
  edit: ((item: HTMLElement) => void) | undefined,
  ignore?: string,
) {
  if (!edit) return {};
  const edits = (event: ReactMouseEvent<HTMLElement>) => {
    const item = event.currentTarget;
    const target = event.target instanceof Element ? event.target : null;
    // An event from a portal (an open menu) bubbles through React parents it
    // is not inside.
    const inside = target !== null && item.contains(target);
    const child = inside && ignore ? target.closest(ignore) : null;
    return researchNoteDoubleClickEdits({
      button: event.button,
      modifier: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey,
      interactive: !inside || event.defaultPrevented || (child !== null && item.contains(child)),
    });
  };
  return {
    onMouseDown(event: ReactMouseEvent<HTMLElement>) {
      if (event.detail >= 2 && edits(event)) event.preventDefault();
    },
    onDoubleClick(event: ReactMouseEvent<HTMLElement>) {
      if (!edits(event)) return;
      event.preventDefault();
      edit(event.currentTarget);
    },
  };
}
