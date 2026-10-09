import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  RESEARCH_DRAFTS_FOLDER_ID,
  researchPlaceIsReorderable,
} from "../lib/researchFolders";

/** What a drag carries: a tree card (any place) or a draft card (Drafts only). */
interface ResearchDragItem {
  kind: "tree" | "draft";
  id: string;
  place: string;
}

export type ResearchCardDragStart = (
  event: ReactPointerEvent<HTMLElement>,
  item: ResearchDragItem,
) => void;

interface ResearchCardDragOptions {
  onMoveTree: (treeId: string, place: string, beforeId: string | null) => void;
  onMoveDraft: (draftId: string, beforeId: string | null) => void;
  /** A collapsed tray held under the pointer opens after SPRING_MS. */
  onSpringOpen: (place: string) => void;
}

const DRAG_THRESHOLD_PX = 5;
/** The ghost sits below and to the right of the pointer, clear of the drop target. */
const GHOST_OFFSET_X = 14;
const GHOST_OFFSET_Y = 16;
const SPRING_MS = 650;
const AUTO_SCROLL_EDGE_PX = 48;
const MARK_CLASSES = ["is-drop-target", "is-drop-same", "is-insert-before", "is-insert-after"];

/** Swallows the click that the browser sends after a drag's pointerup. */
function swallowNextClick() {
  const swallowClick = (clickEvent: MouseEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
  };
  window.addEventListener("click", swallowClick, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
}

/**
 * Pointer-driven card dragging shared by the feed, the sidebar, and the strip.
 * Drop zones carry `data-research-drop="<place>"`; cards carry
 * `data-research-card="<id>"` and `data-research-card-kind`. Marks are set on
 * the DOM directly so a drag re-renders nothing until it ends. Pointer events
 * are used instead of HTML drag and drop, which the native window's file-drop
 * handling can intercept.
 */
export function useResearchCardDrag(options: ResearchCardDragOptions): ResearchCardDragStart {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  return useCallback((event: ReactPointerEvent<HTMLElement>, item: ResearchDragItem) => {
    if (event.button !== 0 || !event.isPrimary || cancelRef.current) return;
    const target = event.target as Element;
    if (target.closest("a, input, textarea, select, [data-research-no-drag]")) return;
    const card = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const scroller = card.closest<HTMLElement>("[data-research-scroll]");
    const root = document.documentElement;
    const marked = new Set<Element>();
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let lastX = startX;
    let lastY = startY;
    let drop: { place: string; beforeId: string | null } | null = null;
    let springPlace: string | null = null;
    let springTimer = 0;
    let frame = 0;

    const clearMarks = () => {
      for (const element of marked) element.classList.remove(...MARK_CLASSES);
      marked.clear();
    };
    const mark = (element: Element, className: string) => {
      element.classList.add(className);
      marked.add(element);
    };
    const resetSpring = () => {
      window.clearTimeout(springTimer);
      springPlace = null;
    };

    const evaluate = () => {
      if (!dragging) return;
      if (ghost) {
        ghost.style.transform = `translate(${lastX + GHOST_OFFSET_X}px, ${lastY + GHOST_OFFSET_Y}px)`;
      }
      clearMarks();
      drop = null;
      const hit = document.elementFromPoint(lastX, lastY);
      const zone = hit?.closest<HTMLElement>("[data-research-drop]") ?? null;
      const place = zone?.dataset.researchDrop ?? null;
      if (!zone || !place || (item.kind === "draft" && place !== RESEARCH_DRAFTS_FOLDER_ID)) {
        resetSpring();
        root.classList.add("is-research-drop-none");
        return;
      }
      if (zone.hasAttribute("data-research-tray-collapsed")) {
        if (springPlace !== place) {
          resetSpring();
          springPlace = place;
          springTimer = window.setTimeout(() => {
            springPlace = null;
            optionsRef.current.onSpringOpen(place);
            // The opened tray re-renders without the marks; mark it again
            // once it has, without waiting for the pointer to move.
            requestAnimationFrame(() => requestAnimationFrame(evaluate));
          }, SPRING_MS);
        }
      } else {
        resetSpring();
      }
      let beforeId: string | null = null;
      let positioned = false;
      if (researchPlaceIsReorderable(place)) {
        const selector = `[data-research-card-kind="${item.kind}"]`;
        const over = hit?.closest<HTMLElement>(selector) ?? null;
        if (over && zone.contains(over) && over.dataset.researchCard !== item.id) {
          const rect = over.getBoundingClientRect();
          const after = lastY > rect.top + rect.height / 2;
          mark(over, after ? "is-insert-after" : "is-insert-before");
          positioned = true;
          if (after) {
            const cards = [...zone.querySelectorAll<HTMLElement>(selector)].filter(
              (candidate) => candidate.dataset.researchCard !== item.id,
            );
            beforeId = cards[cards.indexOf(over) + 1]?.dataset.researchCard ?? null;
          } else {
            beforeId = over.dataset.researchCard ?? null;
          }
        }
      }
      const same = place === item.place && !positioned;
      mark(zone, same ? "is-drop-same" : "is-drop-target");
      root.classList.toggle("is-research-drop-none", same);
      if (!same) drop = { place, beforeId };
    };

    const autoScroll = () => {
      frame = requestAnimationFrame(autoScroll);
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      if (lastX < rect.left || lastX > rect.right) return;
      let delta = 0;
      if (lastY < rect.top + AUTO_SCROLL_EDGE_PX) {
        delta = -Math.ceil((rect.top + AUTO_SCROLL_EDGE_PX - lastY) / 4);
      } else if (lastY > rect.bottom - AUTO_SCROLL_EDGE_PX) {
        delta = Math.ceil((lastY - rect.bottom + AUTO_SCROLL_EDGE_PX) / 4);
      }
      if (delta === 0) return;
      const before = scroller.scrollTop;
      scroller.scrollTop += delta;
      if (scroller.scrollTop !== before) evaluate();
    };

    // A compact label of the card (its title, else its question) rather than
    // a full-size copy, so the drop target under the pointer stays visible.
    const begin = () => {
      dragging = true;
      ghost = document.createElement("div");
      ghost.className = "research-drag-ghost";
      ghost.setAttribute("aria-hidden", "true");
      ghost.textContent = (
        card.querySelector(".research-feed-card-title, .research-feed-card-question")
          ?.textContent ?? ""
      ).trim();
      document.body.appendChild(ghost);
      card.classList.add("is-dragging");
      root.classList.add("is-research-dragging");
      window.getSelection()?.removeAllRanges();
      frame = requestAnimationFrame(autoScroll);
    };

    const cleanup = () => {
      dragging = false;
      cancelRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cleanup);
      window.removeEventListener("scroll", onScroll, true);
      cancelAnimationFrame(frame);
      resetSpring();
      clearMarks();
      ghost?.remove();
      card.classList.remove("is-dragging");
      root.classList.remove("is-research-dragging", "is-research-drop-none");
    };

    function onMove(moveEvent: PointerEvent) {
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      if (!dragging) {
        if (Math.hypot(lastX - startX, lastY - startY) < DRAG_THRESHOLD_PX) return;
        begin();
      }
      moveEvent.preventDefault();
      evaluate();
    }

    function onUp() {
      const wasDragging = dragging;
      const result = drop;
      cleanup();
      if (!wasDragging) return;
      swallowNextClick();
      if (!result) return;
      if (item.kind === "tree") {
        optionsRef.current.onMoveTree(item.id, result.place, result.beforeId);
      } else {
        optionsRef.current.onMoveDraft(item.id, result.beforeId);
      }
    }

    // A wheel scroll during the drag moves the list under the pointer.
    function onScroll() {
      evaluate();
    }

    function onKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== "Escape" || !dragging) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cleanup();
      // The release that follows a cancelled drag must not open the card.
      window.addEventListener("pointerup", swallowNextClick, { capture: true, once: true });
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cleanup);
    cancelRef.current = cleanup;
  }, []);
}
