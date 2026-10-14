// Notes and saved links (post nodes): the limits and the derived title the
// desktop applies in `research.rs` (`MAX_POST_TEXT_BYTES`,
// `post_default_title`). The server enforces them; the composer and the note
// editor use them to refuse an oversized note before sending it.

/** Longest note, in UTF-8 bytes (`research.rs` `MAX_POST_TEXT_BYTES`). */
export const MAX_POST_TEXT_BYTES = 64 * 1024;

/** Longest derived post title, in code points. */
const POST_TITLE_MAX_CHARS = 80;

/**
 * The tree title a post's text gives its thread: the first non-empty line, cut
 * to 80 code points with an ellipsis, at a word boundary when one falls in
 * the second half (`post_default_title`). "Post" when the text has no
 * non-empty line. `updatePost` compares a thread's title against this value
 * for the old text to decide whether the title follows an edit.
 */
export function postDefaultTitle(body: string): string {
  const line =
    body
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== "") ?? "Post";
  const points = [...line];
  if (points.length <= POST_TITLE_MAX_CHARS) {
    return line;
  }
  let cut = points.slice(0, POST_TITLE_MAX_CHARS - 1);
  let space = -1;
  cut.forEach((point, index) => {
    if (/\s/u.test(point)) space = index;
  });
  if (space > POST_TITLE_MAX_CHARS / 2) {
    cut = cut.slice(0, space);
    return `${cut.join("").trimEnd()}…`;
  }
  return `${cut.join("")}…`;
}

/** The UTF-8 length of a note's text, as the limit counts it. */
export function postTextBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
