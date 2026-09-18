// Size policy for rendered transcript content (`09-research-document-view.md`
// §7).
//
// The server caps a response snapshot at 64 MB, which is far past what
// Markdown parsing and eager React element creation absorb without freezing
// the tab. Past `MARKDOWN_CHAR_LIMIT` a block renders as preformatted text,
// itself capped at `PLAINTEXT_DISPLAY_CHAR_LIMIT` because laying out one
// multi-megabyte text node is as expensive as parsing it.

export interface OversizedMarkdownPolicy {
  maxCharacters: number;
  /** Cap on what the plain-text fallback puts in the DOM. */
  maxDisplayCharacters?: number;
  fallbackClassName?: string;
}

export const MARKDOWN_CHAR_LIMIT = 100_000;
export const PLAINTEXT_DISPLAY_CHAR_LIMIT = 1_000_000;
export const ACTIVITY_PAYLOAD_CHAR_LIMIT = 200_000;

/** Hoisted so the memoized renderer sees one prop identity: an inline object
 * literal would miss its render cache on every delta. */
export const OVERSIZED_MARKDOWN_POLICY: OversizedMarkdownPolicy = {
  maxCharacters: MARKDOWN_CHAR_LIMIT,
  maxDisplayCharacters: PLAINTEXT_DISPLAY_CHAR_LIMIT,
  fallbackClassName: "research-plaintext",
};

/** Reasoning runs long and react-markdown re-parses on every render, so the
 * thinking disclosure uses the same guardrail as the answer. */
export const OVERSIZED_THINKING_MARKDOWN: OversizedMarkdownPolicy = {
  maxCharacters: MARKDOWN_CHAR_LIMIT,
  maxDisplayCharacters: MARKDOWN_CHAR_LIMIT,
  fallbackClassName: "research-plaintext",
};

/** What the plain-text fallback shows, with a truncation notice when the
 * source is longer than the display cap. */
export function oversizedFallbackText(source: string, policy: OversizedMarkdownPolicy): string {
  const limit = policy.maxDisplayCharacters;
  if (limit === undefined || source.length <= limit) return source;
  return (
    `${source.slice(0, limit)}\n… (truncated: showing ${limit.toLocaleString()} of ` +
    `${source.length.toLocaleString()} characters)`
  );
}

export function isOversizedMarkdown(
  source: string,
  policy: OversizedMarkdownPolicy | undefined,
): policy is OversizedMarkdownPolicy {
  return policy !== undefined && source.length > policy.maxCharacters;
}
