// Class names from parts (the mockup's `cls${on ? ' on' : ''}`): written as
// parts because the formatter's Tailwind plugin trims the spaces inside a
// className template literal, which joined the mockup's classes.

export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");
