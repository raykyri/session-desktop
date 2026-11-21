// What the client needs to know about an answer's Markdown that the server
// does not store (02 §4.4):
//
// - Citations: an answer cites page N of its `pages` as `[^N]` in the text
//   (no footnote definition follows, so GFM leaves it as text). The citation
//   plugin turns each into a "Source N" button.
// - Passages: the units a branch's passage index `b` counts, in reading
//   order: each top-level paragraph, heading, table, code block and quote,
//   and each item of a top-level list. The passage plugin numbers them the
//   same way on the rendered tree; `passageUnits` numbers them on a DOM.

/** `[^N]` with N from 1. */
export const CITATION = /\[\^(\d{1,3})\]/g;

const BLOCK_UNITS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TABLE",
  "PRE",
  "BLOCKQUOTE",
]);
const LIST_UNITS = new Set(["UL", "OL"]);

/** The passage units of a rendered answer root, in index order. */
export function passageUnits(root: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(root.children)) {
    if (BLOCK_UNITS.has(child.tagName)) out.push(child);
    else if (LIST_UNITS.has(child.tagName))
      for (const item of Array.from(child.children)) if (item.tagName === "LI") out.push(item);
  }
  return out;
}

/** Whether a passage unit tag is a block of its own (not a list item). */
export function isBlockUnit(tagName: string): boolean {
  return BLOCK_UNITS.has(tagName.toUpperCase());
}

export function isListTag(tagName: string): boolean {
  return LIST_UNITS.has(tagName.toUpperCase());
}
