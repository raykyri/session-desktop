import remarkParse from "remark-parse";
import { unified } from "unified";

import { isSessionWidgetInfo, type WidgetMarkdownNode } from "./sessionWidgets.js";

/** Widget source is retained for copy/export, but excluded from derived prose. */
export function stripSessionWidgetBlocks(markdown: string): string {
  if (!markdown.includes("session-html")) return markdown;
  const kept: string[] = [];
  let cursor = 0;
  const visit = (node: WidgetMarkdownNode) => {
    if (node.type === "code" && isSessionWidgetInfo(node.lang)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        kept.push(markdown.slice(cursor, start), "\n\n");
        cursor = end;
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(unified().use(remarkParse).parse(markdown));
  kept.push(markdown.slice(cursor));
  return kept.join("");
}
