// The app bar hides while a feed scrolls down and returns on any scroll up
// (02 W2.3; the mock's scroll handler in `renderNetwork`).
//
// - Within 48 px of the top the bar shows.
// - Past that, a downward step of more than 4 px hides it and an upward step
//   of more than 4 px shows it. The reference position moves only on such a
//   step or within 48 px of the top, so slow scrolling in small steps still
//   adds up to a step.
// - It stays shown while one of its menus is open or focus is inside it
//   (`pinned`), and on every screen that is not a feed (`enabled` false).
// - `keepBar`: the scroll that a jump from a notification causes does not
//   hide the bar; the reference position moves to the new offset.

import { useCallback, useEffect, useState } from "react";

export const BAR_TOP_ZONE = 48;
export const BAR_STEP = 4;

export interface BarState {
  hidden: boolean;
  /** The reference scroll offset steps are measured from. */
  lastY: number;
}

export type BarEvent =
  | { type: "scroll"; y: number; pinned: boolean; keepBar: boolean }
  /** A menu opened or focus entered the bar. */
  | { type: "show" }
  /** The screen stopped being a feed, or a new feed opened at `y`. */
  | { type: "reset"; y: number };

export const initialBarState: BarState = { hidden: false, lastY: 0 };

export function barReducer(state: BarState, event: BarEvent): BarState {
  switch (event.type) {
    case "show":
      return state.hidden ? { ...state, hidden: false } : state;
    case "reset":
      return { hidden: false, lastY: event.y };
    case "scroll": {
      const { y } = event;
      if (event.keepBar) return { hidden: state.hidden, lastY: y };
      const dy = y - state.lastY;
      let hidden = state.hidden;
      if (y < BAR_TOP_ZONE || event.pinned) hidden = false;
      else if (dy > BAR_STEP) hidden = true;
      else if (dy < -BAR_STEP) hidden = false;
      const lastY = Math.abs(dy) > BAR_STEP || y < BAR_TOP_ZONE ? y : state.lastY;
      return hidden === state.hidden && lastY === state.lastY ? state : { hidden, lastY };
    }
  }
}

let keepBarPending = false;

/** Marks the next scroll of the feed as a jump that keeps the bar in view
 * (a notification opening its thread, W2.6). */
export function keepBar(): void {
  keepBarPending = true;
}

/** Consumes the `keepBar` mark. Exported for tests. */
export function takeKeepBar(): boolean {
  const pending = keepBarPending;
  keepBarPending = false;
  return pending;
}

export interface BarAutoHide {
  hidden: boolean;
  /** For the bar's `onFocus` (React's `focusin`): shows the bar, so
   * Shift+Tab from the feed reaches it. */
  onFocusIn: () => void;
  /** For the bar's `onBlur`: focus left the bar if `next` is outside it. */
  onFocusOut: (next: EventTarget | null, bar: HTMLElement | null) => void;
}

/**
 * Drives the bar from `scrollEl`'s scroll events. `enabled` is false on
 * screens that are not feeds; `menuOpen` is true while one of the bar's
 * menus is open.
 */
export function useBarAutoHide(
  scrollEl: HTMLElement | null,
  enabled: boolean,
  menuOpen: boolean,
): BarAutoHide {
  const [state, setState] = useState<BarState>(initialBarState);
  const [screen, setScreen] = useState({ scrollEl, enabled });
  const [focusInside, setFocusInside] = useState(false);
  const pinned = menuOpen || focusInside;

  // A screen change starts from the bar shown, measured from where the new
  // screen is scrolled to. Adjusted during render, as React advises for
  // state derived from props.
  if (screen.scrollEl !== scrollEl || screen.enabled !== enabled) {
    setScreen({ scrollEl, enabled });
    setState(barReducer(state, { type: "reset", y: scrollEl?.scrollTop ?? 0 }));
  } else if (pinned && state.hidden) {
    // An open menu or focus inside shows the bar, and it stays shown after
    // the menu closes until the next downward step.
    setState(barReducer(state, { type: "show" }));
  }

  useEffect(() => {
    if (!scrollEl || !enabled) return;
    const onScroll = () => {
      const event: BarEvent = {
        type: "scroll",
        y: scrollEl.scrollTop,
        pinned,
        keepBar: takeKeepBar(),
      };
      setState((current) => barReducer(current, event));
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollEl, enabled, pinned]);

  const onFocusIn = useCallback(() => setFocusInside(true), []);
  const onFocusOut = useCallback((next: EventTarget | null, bar: HTMLElement | null) => {
    if (bar && next instanceof Node && bar.contains(next)) return;
    setFocusInside(false);
  }, []);

  return { hidden: enabled && state.hidden, onFocusIn, onFocusOut };
}
