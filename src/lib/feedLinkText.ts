/** A run of feed card text: plain text, or a URL shown in the link color.
 * The feed card is one open button, so URLs are not links there. */
type FeedTextRun = { kind: "text"; text: string } | { kind: "url"; text: string };

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;
// Sentence punctuation that usually follows a URL rather than ending it.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"’”]+$/;

/** Splits text into plain runs and http(s) URL runs. A URL stops at
 * whitespace, and trailing sentence punctuation stays plain text. */
export function feedTextRuns(text: string): FeedTextRun[] {
  const runs: FeedTextRun[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let url = match[0];
    const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    // Keep a closing parenthesis that the URL itself opened, as in
    // https://en.wikipedia.org/wiki/Foo_(bar).
    const keepParen = trailing.startsWith(")") && url.slice(0, -trailing.length).includes("(");
    const cut = keepParen ? trailing.slice(1) : trailing;
    if (cut) url = url.slice(0, -cut.length);
    if (url.length <= "https://".length) continue;
    if (start > last) runs.push({ kind: "text", text: text.slice(last, start) });
    runs.push({ kind: "url", text: url });
    last = start + url.length;
  }
  if (last < text.length) runs.push({ kind: "text", text: text.slice(last) });
  return runs;
}

/** Replaces each run of line breaks that encloses blank (or whitespace-only)
 * lines with one line break, so a note's Home preview spends no lines on
 * paragraph gaps. Display only; the stored text keeps its blank lines. */
export function collapseBlankLines(text: string): string {
  return text.replace(/\r?\n(?:[ \t]*\r?\n)+/g, "\n");
}
