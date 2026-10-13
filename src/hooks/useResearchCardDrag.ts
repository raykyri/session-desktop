import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  RESEARCH_DRAFTS_FOLDER_ID,
  researchPlaceIsReorderable,
  type ResearchDropPosition,
} from "../lib/researchFolders";
import { researchCardDropZone, researchChildCount } from "../lib/researchGroups";

/** The draggable item: a tree card, a Drafts card, or a message row. */
interface ResearchDragItem {
  kind: "tree" | "draft" | "message";
  id: string;
  place: string;
}

/** Starts a drag from a pointer down. `source` is the card being dragged
 * when the pointer went down elsewhere (a child row drags its question's
 * card); by default it is the element the handler is on. */
export type ResearchCardDragStart = (
  event: ReactPointerEvent<HTMLElement>,
  item: ResearchDragItem,
  source?: HTMLElement | null,
) => void;

interface ResearchCardDragOptions {
  /** `position` is null for a drop on a place rather than between cards. */
  onMoveTree?: (treeId: string, place: string, position: ResearchDropPosition | null) => void;
  onMoveDraft?: (draftId: string, beforeId: string | null) => void;
  onMoveMessage?: (nodeId: string, place: string, beforeId: string | null) => void;
  /** A drop on a question's or document's card, or within its group: lists
   * the tree under `parentId`, before `beforeId` (one of its children) or at
   * the end of the group for null. */
  onNestTree?: (treeId: string, parentId: string, beforeId: string | null) => void;
  /** A collapsed tray held under the pointer opens after SPRING_MS. */
  onSpringOpen?: (place: string) => void;
  /** A collapsed group held under the pointer expands after SPRING_MS. */
  onSpringOpenGroup?: (parentId: string) => void;
}

/** Where a drop puts the dragged item: in a place (between cards, or on the
 * place), under a parent, or nowhere with the reason shown. */
type ResearchDrop =
  | { place: string; position: ResearchDropPosition | null }
  | { place: string; nest: { parentId: string; beforeId: string | null } };

const DRAG_THRESHOLD_PX = 5;
/** The ghost sits below and to the right of the pointer, clear of the drop target. */
const GHOST_OFFSET_X = 14;
const GHOST_OFFSET_Y = 16;
const SPRING_MS = 650;
const AUTO_SCROLL_EDGE_PX = 48;
const MARK_CLASSES = [
  "is-drop-target",
  "is-drop-same",
  "is-insert-before",
  "is-insert-after",
  "is-drop-nest",
  "is-drop-invalid",
];
const TREE_CARD = '.research-feed-card[data-research-card-kind="tree"]';

/** A card's short name for drop labels: its title, else its question. */
function cardName(card: Element | null): string {
  const text = (
    card?.querySelector(".research-feed-card-title, .research-feed-card-question")?.textContent ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text;
}

/** Swallows the click that the browser sends after a drag's pointerup. */
function swallowNextClick() {
  const swallowClick = (clickEvent: MouseEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
  };
  window.addEventListener("click", swallowClick, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
}

/** Whether a drop zone takes the dragged item. A zone with
 * `data-research-drop-kinds` takes only those kinds, and a message only in
 * its own column; any other zone takes trees, and Drafts also drafts. */
function zoneAccepts(zone: HTMLElement, place: string, item: ResearchDragItem): boolean {
  const kinds = zone.dataset.researchDropKinds;
  if (kinds !== undefined) {
    return kinds.split(" ").includes(item.kind) && (item.kind !== "message" || place === item.place);
  }
  return item.kind === "tree" || (item.kind === "draft" && place === RESEARCH_DRAFTS_FOLDER_ID);
}

/**
 * Pointer-driven card dragging shared by the feed, the sidebar, the rail and
 * the messages columns. Drop zones carry `data-research-drop="<place>"`;
 * cards carry `data-research-card="<id>"` and `data-research-card-kind`.
 * Over a card in a zone that keeps an order, an insertion line shows where
 * the item goes; a zone of another place is highlighted as a whole. A drop
 * in the item's own place needs a position (a reorder); elsewhere it moves
 * the item. Marks are set on the DOM directly so a drag re-renders nothing
 * until it ends. Pointer events are used instead of HTML drag and drop,
 * which the native window's file-drop handling can intercept.
 */
export function useResearchCardDrag(options: ResearchCardDragOptions): ResearchCardDragStart {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  return useCallback((event: ReactPointerEvent<HTMLElement>, item: ResearchDragItem, source?: HTMLElement | null) => {
    if (event.button !== 0 || !event.isPrimary || cancelRef.current) return;
    const target = event.target as Element;
    if (target.closest("a, input, textarea, select, [data-research-no-drag]")) return;
    const card = source ?? event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const scroller = card.closest<HTMLElement>("[data-research-scroll]");
    const root = document.documentElement;
    const marked = new Set<Element>();
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let lastX = startX;
    let lastY = startY;
    let drop: ResearchDrop | null = null;
    let label: HTMLElement | null = null;
    let springPlace: string | null = null;
    let springTimer = 0;
    let frame = 0;

    const clearMarks = () => {
      for (const element of marked) element.classList.remove(...MARK_CLASSES);
      marked.clear();
      label?.remove();
      label = null;
    };
    /** The label above a drop target: what the drop does, or why it can't. */
    const showLabel = (target: Element, text: string, invalid = false) => {
      if (!text) return;
      const rect = target.getBoundingClientRect();
      label = document.createElement("div");
      label.className = `research-drop-label${invalid ? " is-invalid" : ""}`;
      label.setAttribute("aria-hidden", "true");
      label.textContent = text;
      label.style.left = `${rect.left + 10}px`;
      label.style.top = `${rect.top - 4}px`;
      document.body.appendChild(label);
    };
    // A tree card's group: its parent, when it is a child, and how many
    // children move with it.
    const itemParentId = item.kind === "tree" ? (card.dataset.researchParent ?? null) : null;
    const itemChildCount = item.kind === "tree" ? Number(card.dataset.researchChildren ?? 0) : 0;
    const itemGroup =
      card.nextElementSibling?.classList.contains("research-feed-group") ? card.nextElementSibling : null;
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
      if (!zone || !place || !zoneAccepts(zone, place, item)) {
        resetSpring();
        root.classList.add("is-research-drop-none");
        return;
      }
      // A collapsed tray, or a collapsed group under the pointer, opens
      // after SPRING_MS.
      const collapsedGroup =
        item.kind === "tree"
          ? hit?.closest<HTMLElement>(`${TREE_CARD}[data-research-group-collapsed]`)
          : null;
      const springKey = zone.hasAttribute("data-research-tray-collapsed")
        ? `place:${place}`
        : collapsedGroup?.dataset.researchCard && collapsedGroup.dataset.researchCard !== item.id
          ? `group:${collapsedGroup.dataset.researchCard}`
          : null;
      if (springKey) {
        if (springPlace !== springKey) {
          resetSpring();
          springPlace = springKey;
          springTimer = window.setTimeout(() => {
            springPlace = null;
            if (springKey.startsWith("place:")) optionsRef.current.onSpringOpen?.(place);
            else optionsRef.current.onSpringOpenGroup?.(springKey.slice("group:".length));
            // The opened tray or group re-renders without the marks; mark it
            // again once it has, without waiting for the pointer to move.
            requestAnimationFrame(() => requestAnimationFrame(evaluate));
          }, SPRING_MS);
        }
      } else {
        resetSpring();
      }
      if (item.kind === "tree" && researchPlaceIsReorderable(place)) {
        const treeDrop = evaluateTree(zone, place, hit);
        if (treeDrop !== undefined) {
          root.classList.toggle("is-research-drop-none", treeDrop === null);
          if (treeDrop && !("nest" in treeDrop) && place !== item.place) mark(zone, "is-drop-target");
          drop = treeDrop;
          return;
        }
      }
      let position: ResearchDropPosition | null = null;
      if (researchPlaceIsReorderable(place)) {
        const selector = `[data-research-card-kind="${item.kind}"]`;
        const over = hit?.closest<HTMLElement>(selector) ?? null;
        const overId = over?.dataset.researchCard;
        if (over && overId && zone.contains(over) && overId !== item.id) {
          const rect = over.getBoundingClientRect();
          const after = lastY > rect.top + rect.height / 2;
          mark(over, after ? "is-insert-after" : "is-insert-before");
          if (after) {
            const cards = [...zone.querySelectorAll<HTMLElement>(selector)].filter(
              (candidate) => candidate.dataset.researchCard !== item.id,
            );
            const following = cards[cards.indexOf(over) + 1]?.dataset.researchCard;
            // A virtualized list may not render the card after the last
            // rendered one; the consumer finds it in its own list.
            position = following
              ? { beforeId: following }
              : over.hasAttribute("data-research-card-virtual")
                ? { afterId: overId }
                : { beforeId: null };
          } else {
            position = { beforeId: overId };
          }
        }
      }
      // In the item's own place only a positioned drop (a reorder) does
      // anything, and the place is not highlighted: the line shows it.
      const own = place === item.place;
      mark(zone, own ? "is-drop-same" : "is-drop-target");
      const none = own && !position;
      root.classList.toggle("is-research-drop-none", none);
      if (!none) drop = { place, position };
    };

    /** The id of the top-level card after `over`'s group in `zone`, as a
     * drop position after it. */
    const positionAfter = (zone: HTMLElement, over: HTMLElement): ResearchDropPosition => {
      const overId = over.dataset.researchCard ?? "";
      const cards = [...zone.querySelectorAll<HTMLElement>(`${TREE_CARD}:not([data-research-parent])`)].filter(
        (candidate) => candidate.dataset.researchCard !== item.id,
      );
      const following = cards[cards.indexOf(over) + 1]?.dataset.researchCard;
      // A virtualized list may not render the card after the last rendered
      // one; the consumer finds it in its own list.
      return following
        ? { beforeId: following }
        : over.hasAttribute("data-research-card-virtual")
          ? { afterId: overId }
          : { beforeId: null };
    };

    /** A tree over a tree card in a place that keeps an order: between
     * top-level cards, under a parent, or refused. Undefined when the
     * pointer is not over a card (the place itself); null for a drop that
     * does nothing. Marks the target and shows its label. */
    const evaluateTree = (
      zone: HTMLElement,
      place: string,
      hit: Element | null,
    ): ResearchDrop | null | undefined => {
      // A starred row under a card stands for the card's nest zone.
      const starred = hit?.closest<HTMLElement>("[data-research-child-of]");
      const over = starred
        ? zone.querySelector<HTMLElement>(
            `${TREE_CARD}[data-research-card="${CSS.escape(starred.dataset.researchChildOf ?? "")}"]`,
          )
        : (hit?.closest<HTMLElement>(TREE_CARD) ?? null);
      const overId = over?.dataset.researchCard;
      if (!over || !overId || !zone.contains(over)) return undefined;
      const rect = over.getBoundingClientRect();
      const refuse = (reason: string) => {
        mark(over, "is-drop-invalid");
        showLabel(over, reason, true);
        return null;
      };
      const nest = (parentId: string, beforeId: string | null, target: HTMLElement): ResearchDrop => {
        if (beforeId) mark(target, "is-insert-before");
        else mark(target, "is-drop-nest");
        const parent = zone.querySelector(`${TREE_CARD}[data-research-card="${CSS.escape(parentId)}"]`);
        if (itemParentId !== parentId) showLabel(beforeId ? target : over, `Make child of “${cardName(parent)}”`);
        return { place, nest: { parentId, beforeId } };
      };
      const between = (position: ResearchDropPosition, before: boolean): ResearchDrop => {
        mark(over, before ? "is-insert-before" : "is-insert-after");
        if (itemParentId) {
          const parent = zone.querySelector(`${TREE_CARD}[data-research-card="${CSS.escape(itemParentId)}"]`);
          showLabel(over, `Move out of “${cardName(parent)}”`);
        }
        return { place, position };
      };
      if (starred && over.dataset.researchParent === undefined) {
        // A starred row nests in its card, or for a card that can't hold
        // children, inserts after the card's group. A child card's starred
        // row counts as the lower half of that card (below).
        if (overId === item.id) return null;
        return over.hasAttribute("data-research-holds-children")
          ? nest(overId, null, over)
          : between(positionAfter(zone, over), false);
      }
      const overParentId = over.dataset.researchParent;
      if (overParentId) {
        // A child card splits at its midpoint and inserts within its group.
        if (overParentId === item.id) return refuse("Can’t move a group into itself.");
        if (overId === item.id) return null;
        const after = lastY > rect.top + rect.height / 2;
        const siblings = [
          ...(over.parentElement?.querySelectorAll<HTMLElement>(
            `:scope > ${TREE_CARD}[data-research-parent]`,
          ) ?? []),
        ].filter((candidate) => candidate.dataset.researchCard !== item.id);
        const next = siblings[siblings.indexOf(over) + 1];
        if (after && !next) {
          // Below the last child, left of its text: after the group, at the
          // top level.
          const textLeft =
            over.querySelector(".research-row-glyph")?.getBoundingClientRect().left ?? rect.left;
          const parent = zone.querySelector<HTMLElement>(
            `${TREE_CARD}[data-research-card="${CSS.escape(overParentId)}"]`,
          );
          if (lastX < textLeft && parent) {
            mark(over, "is-insert-after");
            return { place, position: positionAfter(zone, parent) };
          }
          return nest(overParentId, null, over);
        }
        if (after) return nest(overParentId, next.dataset.researchCard ?? null, next);
        return nest(overParentId, overId, over);
      }
      const holds = over.hasAttribute("data-research-holds-children");
      const zoneName = researchCardDropZone(rect.height, lastY - rect.top, holds);
      if (overId === item.id) {
        return zoneName === "nest" ? refuse("Can’t nest an item under itself.") : null;
      }
      if (zoneName === "before") return between({ beforeId: overId }, true);
      // A child dropped on its own parent goes to the end of the group.
      if (zoneName === "nest") return nest(overId, null, over);
      // The bottom edge of an expanded parent inserts before its first child.
      const expanded =
        Number(over.dataset.researchChildren ?? 0) > 0 && !over.hasAttribute("data-research-group-collapsed");
      if (expanded) {
        const first = [
          ...(over.nextElementSibling?.querySelectorAll<HTMLElement>(
            `:scope > ${TREE_CARD}[data-research-parent]`,
          ) ?? []),
        ].find((candidate) => candidate.dataset.researchCard !== item.id);
        if (first?.dataset.researchCard) return nest(overId, first.dataset.researchCard, first);
        return nest(overId, null, over);
      }
      return between(positionAfter(zone, over), false);
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
      // The clamp sits on an inner element: on the padded ghost itself a
      // third line would show in the bottom padding.
      const text = document.createElement("span");
      text.className = "research-drag-ghost-text";
      text.textContent = (
        card.querySelector("[data-research-drag-label], .research-feed-card-title, .research-feed-card-question")
          ?.textContent ?? ""
      ).trim();
      ghost.appendChild(text);
      if (itemChildCount > 0) {
        const children = document.createElement("span");
        children.className = "research-drag-ghost-children";
        children.textContent = `+ ${researchChildCount(itemChildCount)}`;
        ghost.appendChild(children);
      }
      document.body.appendChild(ghost);
      card.classList.add("is-dragging");
      itemGroup?.classList.add("is-dragging");
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
      itemGroup?.classList.remove("is-dragging");
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
      if ("nest" in result) {
        optionsRef.current.onNestTree?.(item.id, result.nest.parentId, result.nest.beforeId);
        return;
      }
      const beforeId = result.position && "beforeId" in result.position ? result.position.beforeId : null;
      if (item.kind === "tree") {
        optionsRef.current.onMoveTree?.(item.id, result.place, result.position);
      } else if (item.kind === "draft") {
        optionsRef.current.onMoveDraft?.(item.id, beforeId);
      } else {
        optionsRef.current.onMoveMessage?.(item.id, result.place, beforeId);
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
      // Suppress the click after a cancelled drag. If the pointer is released
      // outside the window, remove this listener on the next press so that
      // the next click is unaffected.
      const onRelease = () => {
        window.removeEventListener("pointerdown", forget, true);
        swallowNextClick();
      };
      const forget = () => window.removeEventListener("pointerup", onRelease, true);
      window.addEventListener("pointerup", onRelease, { capture: true, once: true });
      window.addEventListener("pointerdown", forget, { capture: true, once: true });
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
