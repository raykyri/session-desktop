// Reordering a messages column by drag (`09-research-document-view.md` §3),
// the message-row part of the desktop `useResearchCardDrag`. A press on a
// row that can move starts a drag once the pointer has travelled a few
// pixels; while it moves, the row is marked as dragged and the row it would
// land before or after is marked with an insertion line; on release the new
// position is reported. The click that ends a drag does not select the row.
//
// Rows carry `data-research-card` (the node id) and sit in a list with
// `data-research-drop` (the drop place, `chain:<head id>`). A press on an
// element marked `data-research-no-drag` (the … button, Show more, the
// branch indicator) starts no drag.

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { useLatest } from "./useLatest.js";

const DRAG_THRESHOLD_PX = 4;

export interface MessageDragStart {
  (event: ReactPointerEvent<HTMLElement>, item: { id: string; place: string }): void;
}

interface DragState {
  id: string;
  place: string;
  row: HTMLElement;
  list: HTMLElement;
  startY: number;
  pointerId: number;
  active: boolean;
  target: { element: HTMLElement; side: "before" | "after" } | null;
}

function clearMarks(list: HTMLElement | null) {
  for (const element of list?.querySelectorAll<HTMLElement>("[data-insert]") ?? []) {
    element.removeAttribute("data-insert");
  }
}

export function useMessageDrag({
  onMove,
}: {
  /** Moves `id` before `beforeId` (the end for null) in drop place `place`. */
  onMove: (id: string, place: string, beforeId: string | null) => void;
}): MessageDragStart {
  const dragRef = useRef<DragState | null>(null);
  const onMoveRef = useLatest(onMove);

  const finish = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      drag.row.removeAttribute("data-dragging");
      document.documentElement.classList.remove("is-research-dragging");
      clearMarks(drag.list);
      if (!drag.active) return;
      // The click that ends the drag does not select the row.
      const swallow = (event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (!commit || !drag.target) return;
      const rows = [...drag.list.querySelectorAll<HTMLElement>(":scope > [data-research-card]")];
      const index = rows.indexOf(drag.target.element);
      const before =
        drag.target.side === "before" ? drag.target.element : (rows[index + 1] ?? null);
      const beforeId = before?.dataset["researchCard"] ?? null;
      if (beforeId === drag.id) return;
      onMoveRef.current(drag.id, drag.place, beforeId);
    },
    [onMoveRef],
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        drag.row.setAttribute("data-dragging", "");
        document.documentElement.classList.add("is-research-dragging");
        window.getSelection()?.removeAllRanges();
      }
      event.preventDefault();
      const rows = [...drag.list.querySelectorAll<HTMLElement>(":scope > [data-research-card]")];
      let target: DragState["target"] = null;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (event.clientY < rect.top + rect.height / 2) {
          target = { element: row, side: "before" };
          break;
        }
        target = { element: row, side: "after" };
      }
      clearMarks(drag.list);
      if (target && target.element !== drag.row) {
        target.element.setAttribute("data-insert", target.side);
      }
      drag.target = target && target.element !== drag.row ? target : null;
    };
    const up = (event: PointerEvent) => {
      if (dragRef.current && event.pointerId === dragRef.current.pointerId) finish(true);
    };
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current?.active) {
        event.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
    };
  }, [finish]);

  return useCallback((event, item) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-research-no-drag], a, textarea, input")) return;
    const row = event.currentTarget;
    const list = row.closest<HTMLElement>("[data-research-drop]");
    if (!list) return;
    dragRef.current = {
      id: item.id,
      place: item.place,
      row,
      list,
      startY: event.clientY,
      pointerId: event.pointerId,
      active: false,
      target: null,
    };
  }, []);
}
