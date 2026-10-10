import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { registerResearchMenuReturnFocus, restoreResearchFocus } from "./researchFocus";

const MENU_MARGIN = 8;
const MENU_GAP = 4;
/** A start-aligned menu begins this far left of its button, so the item
 * icons line up under the button's icon. */
const MENU_START_OFFSET = 4;
const MENU_SIDE_GAP = 6;
const ENABLED_ITEM_SELECTOR = "[role^='menuitem']:not(:disabled)";

/** A viewport rectangle a menu opens against, such as the pointer. */
export interface ResearchMenuRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The anchor of a context menu: the pointer. */
export function researchMenuPoint(x: number, y: number): ResearchMenuRect {
  return { left: x, top: y, right: x, bottom: y };
}

/** Where a menu opens relative to its anchor:
 * - "start": below it, the menu's left edge 4px left of the anchor's (buttons
 *   at the start of a row, such as the question meta row);
 * - "end": below it, the right edges level;
 * - "point": at its bottom-left corner (a context menu at the pointer);
 * - "side": to its right, the bottom edges level (the sidebar strip).
 * "start" and "end" open above the anchor when the menu doesn't fit below but
 * fits above. When it fits on neither side it opens on the taller side with
 * `maxHeight` set to that side's room, and scrolls, so it never covers its
 * button (a second click on the button closes it). A context menu opens above
 * the pointer when the space below is too short and the space above is
 * taller. Every menu is kept inside the viewport. */
export type ResearchMenuAlign = "start" | "end" | "point" | "side";

export function researchMenuPosition(
  anchor: ResearchMenuRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  align: ResearchMenuAlign,
): { left: number; top: number; maxHeight?: number } {
  let left: number;
  let top: number;
  let maxHeight: number | undefined;
  if (align === "side") {
    left = anchor.right + MENU_SIDE_GAP;
    top = anchor.bottom - size.height;
  } else {
    left =
      align === "start"
        ? anchor.left - MENU_START_OFFSET
        : align === "end"
          ? anchor.right - size.width
          : anchor.left;
    const gap = align === "point" ? 0 : MENU_GAP;
    const roomBelow = viewport.height - MENU_MARGIN - (anchor.bottom + gap);
    const roomAbove = anchor.top - gap - MENU_MARGIN;
    if (align !== "point" && size.height > roomBelow && size.height > roomAbove) {
      const above = roomAbove > roomBelow;
      maxHeight = Math.max(0, above ? roomAbove : roomBelow);
      top = above ? anchor.top - gap - maxHeight : anchor.bottom + gap;
    } else {
      top =
        size.height > roomBelow && roomAbove > roomBelow
          ? anchor.top - gap - size.height
          : anchor.bottom + gap;
    }
  }
  const height = maxHeight ?? size.height;
  const position = {
    left: Math.max(MENU_MARGIN, Math.min(left, viewport.width - size.width - MENU_MARGIN)),
    top: Math.max(MENU_MARGIN, Math.min(top, viewport.height - height - MENU_MARGIN)),
  };
  return maxHeight === undefined ? position : { ...position, maxHeight };
}

/** The item index a navigation key moves focus to, among `count` enabled
 * items with focus on `index` (-1 when it is on none of them): ↓ and ↑ wrap,
 * Home and End go to the ends. Null for any other key. */
export function researchMenuKeyTarget(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return index < 0 ? 0 : (index + 1) % count;
    case "ArrowUp":
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Whether a key press closes the open menu and returns focus to its
 * trigger: Escape (outside IME composition) and Tab, which would otherwise
 * move focus out of the portaled menu while it stays open. */
export function researchMenuClosesOn(event: { key: string; isComposing?: boolean }): boolean {
  return (event.key === "Escape" && !event.isComposing) || event.key === "Tab";
}

/** The item shortcut a key press names: a bare letter or digit, lower-cased.
 * Null when ⌘, Ctrl or ⌥ is held, or during IME composition. */
export function researchMenuShortcutKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return null;
  const key = event.key.toLowerCase();
  return /^[a-z0-9]$/.test(key) ? key : null;
}

function isElementAnchor(anchor: HTMLElement | ResearchMenuRect): anchor is HTMLElement {
  return typeof (anchor as HTMLElement).getBoundingClientRect === "function";
}

function enabledItems(menu: HTMLElement | null) {
  return [...(menu?.querySelectorAll<HTMLElement>(ENABLED_ITEM_SELECTOR) ?? [])];
}

/** A research menu: portaled, placed against its anchor, with the checked
 * item (or the first) focused when it opens. ↑, ↓, Home and End move between
 * items, and an item's shortcut letter selects it. Escape is captured and
 * stopped, so it closes only the menu (never what is open behind it),
 * and returns focus to the trigger; a modal dialog opened from the menu keeps
 * its own Escape. Tab closes the menu and returns focus to the trigger. When an
 * item's action leaves focus nowhere (the item was removed with the menu),
 * focus returns to the trigger, or to `fallbackFocus` when the trigger went
 * too. A press outside, a scroll outside, or a resize closes the menu without
 * moving focus. */
export function ResearchMenu({
  anchor,
  align = "end",
  trigger,
  label,
  describedBy,
  width,
  compact = false,
  footer,
  fallbackFocus,
  onClose,
  children,
}: {
  /** The menu's button, or a viewport rectangle such as the pointer's. */
  anchor: HTMLElement | ResearchMenuRect;
  align?: ResearchMenuAlign;
  /** The control that opened the menu, when it is not the anchor: presses on
   * it leave the menu to its own toggle, and Escape returns focus to it.
   * Without either, Escape returns focus to what had it when the menu opened. */
  trigger?: HTMLElement | null;
  label: string;
  /** The id of text in the menu that describes it (not a menu item). */
  describedBy?: string;
  /** A fixed width in pixels. Otherwise the menu sizes to its items within
   * the stylesheet's limits. */
  width?: number;
  /** The selection popover's tighter rows (26px), for menus that act on a
   * passage. */
  compact?: boolean;
  /** Content under the items in the same popover, such as the strip's account
   * control. It is not part of the menu's keyboard navigation. */
  footer?: ReactNode;
  /** Where focus goes when the menu closed and its trigger is gone, such as
   * after an action that removed the trigger's row. */
  fallbackFocus?: () => HTMLElement | null | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight?: number;
  } | null>(null);
  const owner = trigger ?? (isElementAnchor(anchor) ? anchor : null);
  const latestRef = useRef({ owner, onClose, fallbackFocus });
  latestRef.current = { owner, onClose, fallbackFocus };
  const [returnFocus] = useState<HTMLElement | null>(() =>
    owner ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );
  // Cleared by a close that should leave focus where the user put it (a
  // press, scroll or resize outside).
  const restoreOnCloseRef = useRef(true);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (popover && returnFocus && returnFocus !== document.body) {
      registerResearchMenuReturnFocus(popover, returnFocus);
    }
    return () => {
      if (restoreOnCloseRef.current) {
        restoreResearchFocus(returnFocus, latestRef.current.fallbackFocus);
      }
    };
  }, [returnFocus]);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    // Measured at its natural height, without a limit set for an earlier
    // position.
    const limit = popover.style.maxHeight;
    popover.style.maxHeight = "none";
    const size = popover.getBoundingClientRect();
    popover.style.maxHeight = limit;
    const next = researchMenuPosition(
      isElementAnchor(anchor) ? anchor.getBoundingClientRect() : anchor,
      size,
      { width: window.innerWidth, height: window.innerHeight },
      align,
    );
    // A rect anchor may be a new object on every render; an unchanged
    // position must not re-render.
    setPosition((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [align, anchor]);

  useLayoutEffect(() => {
    const items = enabledItems(menuRef.current);
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus({
      preventScroll: true,
    });
  }, []);

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (Boolean(popoverRef.current?.contains(target)) ||
        Boolean(latestRef.current.owner?.contains(target)) ||
        (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]') !== null));
    const closeFromOutside = () => {
      restoreOnCloseRef.current = false;
      latestRef.current.onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) closeFromOutside();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (dialog && !popoverRef.current?.contains(dialog)) return;
      if (researchMenuClosesOn(event)) {
        event.preventDefault();
        event.stopPropagation();
        latestRef.current.onClose();
        if (returnFocus?.isConnected && returnFocus !== document.body) {
          returnFocus.focus({ preventScroll: true });
        }
        return;
      }
      const shortcut = researchMenuShortcutKey(event);
      const item = shortcut
        ? menuRef.current?.querySelector<HTMLButtonElement>(`[data-shortcut="${shortcut}"]`)
        : null;
      if (!item) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!item.disabled) item.click();
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && popoverRef.current?.contains(event.target))) {
        closeFromOutside();
      }
    };
    const onResize = closeFromOutside;
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [returnFocus]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems(menuRef.current);
    const next = researchMenuKeyTarget(
      event.key,
      items.indexOf(document.activeElement as HTMLElement),
      items.length,
    );
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={popoverRef}
      className={`research-menu${compact ? " is-compact" : ""}`}
      // Keep the menu off-screen until measured to avoid briefly displaying
      // it at the viewport origin.
      style={{
        ...(position ?? { left: -9999, top: -9999 }),
        ...(width === undefined ? null : { width, minWidth: width }),
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={menuRef}
        className="research-menu-items"
        role="menu"
        aria-label={label}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
      {footer ? <div className="research-menu-footer">{footer}</div> : null}
    </div>,
    document.body,
  );
}

export function ResearchMenuItem({
  icon,
  label,
  detail,
  description,
  trailing,
  shortcut,
  checked,
  current = false,
  danger = false,
  disabled = false,
  title,
  onSelect,
}: {
  icon?: ReactNode;
  label: ReactNode;
  /** A second, muted line under the label, such as a workspace's path. */
  detail?: string;
  /** Read after the label by screen readers (what a trailing mark shows). */
  description?: string;
  trailing?: ReactNode;
  /** A letter that selects the item while the menu is open, shown as a keycap. */
  shortcut?: string;
  /** Set for a choice among options: the item becomes a menuitemradio. */
  checked?: boolean;
  /** The item is what is open now, such as the open branch. */
  current?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** For a disabled item, the reason it is disabled. */
  title?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      aria-current={current ? "true" : undefined}
      aria-keyshortcuts={shortcut?.toUpperCase()}
      className={`research-menu-item${danger ? " is-danger" : ""}${detail ? " has-detail" : ""}`}
      disabled={disabled}
      title={title}
      data-shortcut={shortcut?.toLowerCase()}
      onClick={onSelect}
    >
      {icon}
      <span className="research-menu-label">
        {detail ? (
          <>
            <span className="research-menu-label-name">{label}</span>
            <span className="research-menu-detail">{detail}</span>
          </>
        ) : (
          label
        )}
        {description ? <span className="research-visually-hidden">, {description}</span> : null}
      </span>
      {trailing}
      {shortcut ? (
        <kbd className="context-menu-shortcut is-keycap" aria-hidden="true">
          {shortcut.toUpperCase()}
        </kbd>
      ) : null}
    </button>
  );
}

export function ResearchMenuSeparator() {
  return <div className="research-menu-divider" role="separator" />;
}

/** A heading over the items, such as "Move to". Not an item. */
export function ResearchMenuTitle({ children }: { children: ReactNode }) {
  return (
    <div className="research-menu-title" role="presentation">
      {children}
    </div>
  );
}

/** A muted line of details, such as an answer's length and model. Not an item. */
export function ResearchMenuMeta({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="research-menu-meta" title={title}>
      {children}
    </div>
  );
}
