import { useEffect, useRef, useState } from "react";
import type { FocusEvent, RefObject } from "react";

/** Focus tracking for a composer that is one line until it is focused, and
 * shows its controls while focused. `inside` decides whether a node belongs to
 * the composer; pass it when the composer owns a portal (a menu).
 *
 * The composer stays open while focus is inside it, and closes on a press
 * elsewhere. The close waits for that press to be released, so content below
 * the composer doesn't move between the press and the release that clicks
 * what was pressed. */
export function useComposerPopOpen(
  rootRef: RefObject<HTMLElement | null>,
  inside: (root: HTMLElement | null, target: EventTarget | null) => boolean = containsNode,
) {
  const [focused, setFocused] = useState(false);
  const pointerDownOutsideRef = useRef(false);
  // Set from a press inside the composer until it is released. WebKit does
  // not focus a clicked button, so pressing one of the composer's buttons
  // blurs the field with no related target; closing then would remove the
  // button before its click event fires. Such a blur keeps the composer
  // open, and the next press outside it closes it.
  const pointerDownInsideRef = useRef(false);
  const insideRef = useRef(inside);
  insideRef.current = inside;

  const collapse = () => {
    if (!pointerDownOutsideRef.current) {
      setFocused(false);
      return;
    }
    window.addEventListener(
      "pointerup",
      () => {
        pointerDownOutsideRef.current = false;
        window.setTimeout(() => setFocused(false), 0);
      },
      { once: true },
    );
  };

  useEffect(() => {
    if (!focused) return;
    const onPointerDown = (event: PointerEvent) => {
      if (insideRef.current(rootRef.current, event.target)) return;
      pointerDownOutsideRef.current = true;
      collapse();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [focused, rootRef]);

  /** A focused button that becomes disabled (Send while it works) loses focus
   * without a blur event; call this afterwards to close the composer as after
   * a press elsewhere, if focus has left it. */
  const collapseIfFocusLeft = () => {
    if (!insideRef.current(rootRef.current, document.activeElement)) setFocused(false);
  };

  const rootProps = {
    onFocus: () => setFocused(true),
    onPointerDownCapture: () => {
      pointerDownInsideRef.current = true;
      const release = () => window.setTimeout(() => (pointerDownInsideRef.current = false), 0);
      window.addEventListener("pointerup", release, { once: true });
      window.addEventListener("pointercancel", release, { once: true });
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (insideRef.current(rootRef.current, event.relatedTarget)) return;
      if (pointerDownInsideRef.current && !event.relatedTarget) return;
      collapse();
    },
  };

  return { focused, collapseIfFocusLeft, rootProps };
}

function containsNode(root: HTMLElement | null, target: EventTarget | null) {
  return target instanceof Node && Boolean(root?.contains(target));
}
