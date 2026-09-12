export const MAX_TERMINAL_TITLE_CHARS = 160;

/** Normalize an OSC title while removing known CLI branding. */
export function sanitizeTerminalTitle(rawTitle: string): string | null {
  let title = rawTitle
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) {
    return null;
  }

  // Grok's CLI brands OSC 0/2 titles with a trailing " - grok". Keep this
  // existing normalization adapter-agnostic for compatibility with persisted
  // titles and generated-title callers that do not have adapter context.
  title = title.replace(/ - grok$/i, "").trimEnd();
  if (!title) {
    return null;
  }

  const chars = Array.from(title);
  if (chars.length <= MAX_TERMINAL_TITLE_CHARS) {
    return title;
  }
  return `${chars.slice(0, MAX_TERMINAL_TITLE_CHARS - 1).join("").trimEnd()}…`;
}
