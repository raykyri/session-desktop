// Look up is offered for 1-4 whole words (02 §4.4, the mock's
// `lookPhrase`): a selection that starts or ends inside a word (a letter or
// digit on both sides of its edge) is not one; punctuation at the edges is
// trimmed.

const WORD = /[\p{L}\p{N}]/u;

export interface SelectionEdges {
  /** The characters on either side of the selection's start and end, ""
   * at a text boundary. */
  beforeStart: string;
  atStart: string;
  beforeEnd: string;
  atEnd: string;
}

export function lookPhrase(text: string, edges?: SelectionEdges): string | null {
  if (edges) {
    if (WORD.test(edges.beforeStart) && WORD.test(edges.atStart)) return null;
    if (WORD.test(edges.atEnd) && WORD.test(edges.beforeEnd)) return null;
  }
  const t = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const n = t ? t.split(/\s+/).length : 0;
  return n >= 1 && n <= 4 ? t : null;
}

/** The edges of a DOM range, for `lookPhrase`. */
export function rangeEdges(range: Range): SelectionEdges {
  const charAt = (node: Node, offset: number) =>
    node.nodeType === 3 ? ((node as Text).data[offset] ?? "") : "";
  return {
    beforeStart: range.startOffset > 0 ? charAt(range.startContainer, range.startOffset - 1) : "",
    atStart: charAt(range.startContainer, range.startOffset),
    beforeEnd: range.endOffset > 0 ? charAt(range.endContainer, range.endOffset - 1) : "",
    atEnd: charAt(range.endContainer, range.endOffset),
  };
}
