import type { MouseEvent as ReactMouseEvent } from "react";
import { researchNoteDoubleClickEdits } from "../../lib/researchNoteEdit";

/** The props that make a double-click on a note item edit the note. `edit`
 * is undefined for a note that cannot be edited, which leaves the item's
 * double-click as it was. `ignore` names the item's children that keep their
 * own double-click (see NOTE_DOUBLE_CLICK_IGNORE_SELECTOR). The second press
 * of a double-click is kept from selecting a word; the first press and its
 * click are not changed. */
export function researchNoteDoubleClickProps(
  edit: ((item: HTMLElement) => void) | undefined,
  ignore?: string,
) {
  if (!edit) return {};
  const edits = (event: ReactMouseEvent<HTMLElement>) => {
    const item = event.currentTarget;
    const target = event.target instanceof Element ? event.target : null;
    // An event from a portal (an open menu) bubbles through React parents
    // it is not inside.
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
