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
