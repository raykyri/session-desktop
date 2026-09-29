// Compatibility for saved answers containing [[Term]] or [[Term|label]].
// Render their display text; new research does not generate these markers.

import { closesFence, markerRunAtLineStart, type MarkdownFence } from "./markdownMathDelimiters";

export const MAX_WIKILINK_CHARS = 160;

const BODY_PART = `[^\\[\\]|\\n]{1,${MAX_WIKILINK_CHARS}}`;
const WIKILINK_PATTERN = new RegExp(
  `\\[\\[(${BODY_PART})(?:\\|(${BODY_PART}))?\\]\\]`,
  "gu",
);

export interface Wikilink {
  /** The canonical term, trimmed. */
  term: string;
  /** What the reader sees: the alias when given, otherwise the term. */
  label: string;
}

export function parseWikilinkBody(term: string, alias?: string): Wikilink | null {
  const trimmedTerm = term.trim();
  if (!trimmedTerm) {
    return null;
  }
  const trimmedAlias = alias?.trim();
  return { term: trimmedTerm, label: trimmedAlias || trimmedTerm };
}

/** Replace every wikilink with its display text. */
export function stripWikilinks(text: string): string {
  if (!text.includes("[[")) {
    return text;
  }
  return text.replace(WIKILINK_PATTERN, (match, term: string, alias?: string) => {
    const link = parseWikilinkBody(term, alias);
    return link ? link.label : match;
  });
}

// An alias wikilink whose `|` is not already escaped. Used to escape the pipe
// on table rows; a term ending in `\` means the agent escaped it already, and
// doubling the backslash would turn it back into a cell separator.
const UNESCAPED_ALIAS_PATTERN = new RegExp(
  `\\[\\[(${BODY_PART})(?<!\\\\)\\|(${BODY_PART})\\]\\]`,
  "gu",
);

/** Escape the alias pipe of every wikilink on a Markdown table row, so the
 * GFM parser does not split `[[Term|shown]]` into two cells (which also drops
 * the row's overflow cell). GFM reads `\|` in a cell as a literal `|`, so the
 * remark transform still sees `[[Term|shown]]` after parsing. Runs on the
 * source before parsing, since the split happens during parsing.
 *
 * A line counts as a table row when it has a `|` outside its wikilinks; that
 * covers rows with or without leading pipes, and leaves prose alone. Lines in
 * fenced or indented code are skipped. Code spans on a row are rewritten
 * too: GFM splits cells on a pipe inside a code span as well, and `\|` is
 * the spec's way to keep one literal there. */
export function escapeWikilinkTablePipes(source: string): string {
  if (!source.includes("[[") || !source.includes("|")) {
    return source;
  }
  const lines = source.split("\n");
  let fence: MarkdownFence | null = null;
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }
      continue;
    }
    const openingFence = markerRunAtLineStart(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }
    if (line.startsWith("    ") || line.startsWith("\t")) {
      continue;
    }
    if (!line.includes("[[") || !line.replace(WIKILINK_PATTERN, "").includes("|")) {
      continue;
    }
    const escaped = line.replace(UNESCAPED_ALIAS_PATTERN, "[[$1\\|$2]]");
    if (escaped !== line) {
      lines[i] = escaped;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : source;
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}


// Contexts whose text must stay literal: code, URLs and existing links, raw
// HTML, and TeX. Bracketed array indices and URLs are not legacy prose markers.
const OPAQUE_NODE_TYPES = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
  "html",
  "math",
  "inlineMath",
]);

/** Strip legacy markers from prose while leaving code, links, and math literal. */
export function remarkWikilinks() {
  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      const children = node.children;
      if (!children) {
        return;
      }
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (OPAQUE_NODE_TYPES.has(child.type)) {
          continue;
        }
        if (child.type === "text") {
          child.value = stripWikilinks(child.value ?? "");
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}
