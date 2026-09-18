// The markdown pipeline, in one place.
//
// The desktop kept two plugin lists in two modules and they drifted
// (`06-porting-pain-points.md` pain point 6); here the base lists and the
// lazily-loaded math lists live together, so every surface that renders
// transcript markdown parses identically. The client composes them: it renders
// with the base lists, imports the math chunk in the background, and swaps the
// combined lists in when it resolves (`08-design-system-and-styling.md` §5).
//
// The lists are typed as unified's `PluggableList` rather than
// `react-markdown`'s `Options`, because `shared` does not depend on React.
// `rehypeTranscriptArtifacts` is client-side (it needs the artifact registry),
// so the base rehype list is empty here and the client appends to it.

import rehypeMathjax from "rehype-mathjax/svg";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

import { remarkWikilinks } from "./wikilinks.js";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: unknown;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

// remark-math alone mis-handles two shapes that dominate agent answers:
//
// - Prices: in "costs $5 and $10 more" it treats "5 and" as inline math.
//   Mirror GitHub's rule — when the character right after a closing $ is a
//   digit, the pair reads as currency, so the node reverts to literal text.
// - Single-line display math: LLMs routinely emit "$$…$$" on one line, but
//   micromark only accepts fenced ($$ on its own lines) math as display, so
//   the one-liner parses as inline math inside a paragraph. A paragraph that
//   is exactly one $$-delimited math node gets promoted to a display block.
// The same mdast shape mdast-util-math produces for fenced $$ blocks, so
// remark-rehype and rehype-mathjax treat promoted nodes identically.
function displayMathNode(value: string): MdastNode {
  return {
    type: "math",
    value,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value }],
        },
      ],
    },
  };
}

export function remarkTranscriptMathTweaks() {
  return (tree: MdastNode, file: { value?: unknown }) => {
    // The promotion test reads the original source around a node's offsets.
    // unified only hands back a string when the document was parsed from one;
    // with byte input there is nothing to compare against, so no paragraph is
    // promoted.
    const source = typeof file.value === "string" ? file.value : "";
    const visit = (node: MdastNode) => {
      const children = node.children;
      if (!children) {
        return;
      }
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (!child) {
          continue;
        }
        if (child.type === "paragraph" && child.children?.length === 1) {
          const only = child.children[0];
          const start = only?.position?.start.offset;
          const end = only?.position?.end.offset;
          if (
            only &&
            only.type === "inlineMath" &&
            start !== undefined &&
            end !== undefined &&
            source.startsWith("$$", start) &&
            source.slice(end - 2, end) === "$$"
          ) {
            children[i] = displayMathNode(only.value ?? "");
            continue;
          }
        }
        if (child.type === "inlineMath") {
          const next = children[i + 1];
          if (next?.type === "text" && /^\d/.test(next.value ?? "")) {
            children[i] = { type: "text", value: `$${child.value ?? ""}$` };
            continue;
          }
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

/** Parsed on every render: GFM tables and strikethrough, hard line breaks (an
 * answer's single newlines are meant literally), and `[[Term]]` wikilinks. */
export const baseRemarkPlugins: PluggableList = [remarkGfm, remarkBreaks, remarkWikilinks];

/** Empty on purpose: the only base rehype plugin, `rehypeTranscriptArtifacts`,
 * needs the client's artifact registry and is appended there. */
export const baseRehypePlugins: PluggableList = [];

/** Loaded on demand and appended to the base lists. remark-math recognizes
 * $…$ / $$…$$ TeX; rehype-mathjax renders it to self-contained inline SVG at
 * parse time — no webfonts, no external fetches — and the glyphs use
 * currentColor so they follow the surrounding text color. */
export const mathRemarkPlugins: PluggableList = [remarkMath, remarkTranscriptMathTweaks];

export const mathRehypePlugins: PluggableList = [rehypeMathjax];
