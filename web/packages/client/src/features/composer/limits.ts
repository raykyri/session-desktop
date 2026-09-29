// The size ceilings a launched question or an imported report has to fit under
// (`10-home-feed-journal.md` §5).
//
// One module because two surfaces enforce them and the import dialog's
// documentation says they are "the same limits the composer applies" — which is
// only true if both read the same numbers and refuse with the same sentence.
// The subject noun is the only thing that differs, so the sentence stays
// grammatical in both places.

export const MAX_PROMPT_WORDS = 10_000;
export const MAX_PROMPT_BYTES = 10 * 1024 * 1024;

export function countPromptWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

export function promptByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Why this text is too large to send, or null when it fits.
 *
 * `byteSize` is passed in where the caller already knows it — a picked file
 * reports its own size, and re-encoding a ten-megabyte string to count its
 * bytes is work the picker already did.
 */
export function oversizeRefusal(
  text: string,
  subject: "question" | "report",
  byteSize = promptByteLength(text),
): string | null {
  if (byteSize > MAX_PROMPT_BYTES) return `The ${subject} exceeds the 10 MiB size limit.`;
  const words = countPromptWords(text);
  if (words > MAX_PROMPT_WORDS) {
    return `The ${subject} is ${words.toLocaleString()} words, which exceeds the 10,000-word limit.`;
  }
  return null;
}
