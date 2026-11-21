// Reduced motion: the system's preference or the app's own "Reduce motion"
// setting, which `ThemeEffects` writes onto `<html>` as `data-reduce-motion`
// (the desktop's `.app-shell.reduce-motion`). CSS reads the attribute
// (`prose.css`, `feed.css`); scripted scrolling reads this.

export const REDUCE_MOTION_ATTRIBUTE = "data-reduce-motion";

/** Whether motion is reduced, by the system or by the setting. `matchMedia`
 * is optional because jsdom does not implement it. */
export function prefersReducedMotion(): boolean {
  if (
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute(REDUCE_MOTION_ATTRIBUTE)
  ) {
    return true;
  }
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The scroll that brings `rect` into `box` with `below` px under it and
 * `above` px over it (`focusGlide`): positive scrolls down, 0 when it is in
 * view. */
export function paddedScrollDelta(
  rect: { top: number; bottom: number },
  box: { top: number; bottom: number },
  below = 24,
  above = 60,
): number {
  if (rect.bottom > box.bottom - below) return rect.bottom - box.bottom + below;
  if (rect.top < box.top + above) return rect.top - box.top - above;
  return 0;
}

/** Scrolls the shell's scroll container so `element` (its form, when it is
 * a field) is in view with 24 px below and 60 px above, smoothly or at once
 * under reduced motion, and focuses `element` without scrolling (02 W4.5). */
export function scrollIntoPadded(element: HTMLElement | null): void {
  if (!element) return;
  element.focus({ preventScroll: true });
  const scroller = element.closest<HTMLElement>("[data-shell-scroll]");
  if (!scroller) return;
  const target = (element.closest("form") ?? element).getBoundingClientRect();
  const dy = paddedScrollDelta(target, scroller.getBoundingClientRect());
  if (dy) scroller.scrollBy({ top: dy, behavior: prefersReducedMotion() ? "instant" : "smooth" });
}
