/** Joins class names, dropping falsy entries. Components compose Tailwind
 * utilities as plain strings; this is the only helper they need to merge a
 * caller's `className` into a primitive's own. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
