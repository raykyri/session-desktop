// The composer grows with its content up to a cap, then scrolls. The height
// math is here so it can be tested without a layout engine; the client's
// `composerTextarea` wrapper reads `scrollHeight` off the element and writes
// the result back to `style.height`.

/** Tallest the composer grows before its content starts scrolling, in CSS pixels. */
export const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;

/** Height to apply for a measured content height. */
export function composerTextareaHeight(scrollHeight: number): number {
  return Math.min(scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT);
}
