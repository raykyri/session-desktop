// The answer's rehype plugins (02 §4.4). Both run on the tree react-markdown
// builds (raw HTML is off), so a streamed answer and a stored one get the
// same structure:
//
// - `rehypePassages` numbers the passage units (`replica/answerText.ts`):
//   each top-level paragraph, heading, table, code block and quote, and each
//   item of a top-level list, as `data-passage`;
// - `rehypeCitations` turns each `[^N]` into a "Source N" button and wraps
//   it with the word before it in a `nowrap` span, so a citation never
//   starts a line alone (the mock's `citeReady`).

import { CITATION, isBlockUnit, isListTag } from "../../replica/answerText.js";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function rehypePassages() {
  return (tree: HastNode) => {
    let index = 0;
    for (const child of tree.children ?? []) {
      if (child.type !== "element" || !child.tagName) continue;
      if (isBlockUnit(child.tagName)) {
        child.properties = { ...child.properties, dataPassage: index++ };
      } else if (isListTag(child.tagName)) {
        for (const item of child.children ?? []) {
          if (item.type === "element" && item.tagName === "li")
            item.properties = { ...item.properties, dataPassage: index++ };
        }
      }
    }
  };
}

const citation = (n: string): HastNode => ({
  type: "element",
  tagName: "button",
  properties: { type: "button", className: ["cite"], dataCite: n, ariaLabel: `Source ${n}` },
  children: [{ type: "text", value: n }],
});

const nowrap = (children: HastNode[]): HastNode => ({
  type: "element",
  tagName: "span",
  properties: { className: ["nw"] },
  children,
});

/** Splits the text children of `node` around citations. */
function splitCitations(node: HastNode): void {
  const children = node.children;
  if (!children) return;
  const out: HastNode[] = [];
  for (const child of children) {
    if (child.type === "element") {
      if (child.tagName !== "code" && child.tagName !== "pre") splitCitations(child);
      out.push(child);
      continue;
    }
    if (child.type !== "text" || !child.value || !CITATION.test(child.value)) {
      CITATION.lastIndex = 0;
      out.push(child);
      continue;
    }
    CITATION.lastIndex = 0;
    const text = child.value;
    let at = 0;
    for (const match of text.matchAll(CITATION)) {
      const before = text.slice(at, match.index);
      const word = /(\S+\s*)$/.exec(before);
      const lead = word ? before.slice(0, before.length - (word[1]?.length ?? 0)) : before;
      if (lead) out.push({ type: "text", value: lead });
      const cite = citation(match[1] ?? "");
      if (word?.[1]) out.push(nowrap([{ type: "text", value: word[1] }, cite]));
      else {
        // The citation follows an element (emphasis, a link): it joins it.
        const previous = out[out.length - 1];
        if (previous && previous.type === "element")
          out.splice(out.length - 1, 1, nowrap([previous, cite]));
        else out.push(cite);
      }
      at = match.index + match[0].length;
    }
    if (at < text.length) out.push({ type: "text", value: text.slice(at) });
  }
  node.children = out;
}

export function rehypeCitations() {
  return (tree: HastNode) => splitCitations(tree);
}
