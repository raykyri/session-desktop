// Canonical session-html fence contract shared by desktop and web.
import { closesFence, markerRunAtLineStart } from "./mathDelimiters.js";

const SESSION_WIDGET_LANGUAGE = "session-html";
/** Mirrors `MAX_WIDGET_BYTES` in src-tauri/src/research_widgets.rs. */
export const MAX_SESSION_WIDGET_BYTES = 64 * 1024;
/** Property the remark plugin sets on a widget block's `code` element. */
export const SESSION_WIDGET_STATE_ATTRIBUTE = "data-session-widget";

type SessionWidgetState = "complete" | "partial";

/** Whether a fenced code block's info string marks a widget: its first word
 * is exactly `session-html`. */
export function isSessionWidgetInfo(info: string | null | undefined): boolean {
  return info?.trim().split(/\s+/u)[0] === SESSION_WIDGET_LANGUAGE;
}

/** Whether react-markdown's `language-…` class on a `code` element marks a
 * widget. */
export function isSessionWidgetClassName(className: unknown): boolean {
  return (
    typeof className === "string" &&
    className.split(/\s+/u).includes(`language-${SESSION_WIDGET_LANGUAGE}`)
  );
}

export function sessionWidgetByteLength(html: string): number {
  return new TextEncoder().encode(html).length;
}

/** Whether the widget's HTML contains anything that only runs on the run page:
 * a script element, an inline event handler or a `javascript:` URL. Without
 * these the static page already shows the whole widget. */
export function sessionWidgetHasScripts(html: string): boolean {
  return /<script\b|\son[a-z]+\s*=|javascript:/iu.test(html);
}

/** Content-Security-Policy of a downloaded widget file: the static preview's
 * policy (no scripts, no network, no forms, no base URL). A `<meta>` policy
 * cannot sandbox the page, so `http-equiv` in the widget is neutralised as on
 * the served pages (a refresh would otherwise navigate). Mirrors
 * `research_widgets::download_document` in src-tauri. */
export const SESSION_WIDGET_DOWNLOAD_POLICY =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function sessionWidgetDownloadDocument(html: string): string {
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${SESSION_WIDGET_DOWNLOAD_POLICY}">\n</head>\n<body>\n${html.replace(/http-equiv/giu, "data-http-equiv")}\n</body>\n</html>\n`;
}

export interface WidgetMarkdownNode {
  type: string;
  lang?: string | null | undefined;
  meta?: string | null | undefined;
  value?: string | undefined;
  data?: { hProperties?: Record<string, unknown> | undefined } | undefined;
  position?:
    { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
  children?: WidgetMarkdownNode[] | undefined;
}

/** Whether a fenced code block was closed by a closing fence. `raw` is the
 * block's source slice (opening fence through its end, container prefixes
 * included) and `value` the parser's code text. A closed block's slice is the
 * opening fence, the value's lines and the closing fence; an unclosed one (an
 * answer still streaming, or a closing fence CommonMark does not accept, such
 * as one indented four or more spaces past its container) has no extra line,
 * or ends with a line that is not a fence. An answer still streaming leaves
 * its last block open, and CommonMark then runs the block to the end of its
 * container. */
export function fencedBlockIsClosed(raw: string, value: string): boolean {
  const lines = raw.split("\n");
  const fence = markerRunAtLineStart(lines[0]?.trimStart() ?? "");
  if (!fence || lines.length < 2) {
    return false;
  }
  const valueLines = value === "" ? 0 : value.split("\n").length;
  if (valueLines !== lines.length - 2) {
    return false;
  }
  // The slice's last line is now known not to be code text; strip its
  // container prefix (block quote markers, list indentation).
  const last = (lines[lines.length - 1] ?? "").replace(/^[\s>]*/u, "");
  return closesFence(last, fence);
}

/** Remark plugin: marks each `session-html` code block as complete or partial
 * on the rendered `code` element, so the renderer can show a placeholder for a
 * block that is still streaming instead of a frame around half a page. */
export function remarkSessionWidgetFences() {
  return (tree: WidgetMarkdownNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : "";
    const visit = (node: WidgetMarkdownNode) => {
      if (node.type === "code" && isSessionWidgetInfo(node.lang)) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const state: SessionWidgetState =
          start !== undefined &&
          end !== undefined &&
          fencedBlockIsClosed(source.slice(start, end), node.value ?? "")
            ? "complete"
            : "partial";
        const opening =
          start === undefined || end === undefined
            ? ""
            : (source.slice(start, end).split(/\r?\n/u)[0] ?? "");
        const rawMeta = opening.includes("session-html")
          ? opening.slice(opening.indexOf("session-html") + "session-html".length).trim()
          : (node.meta ?? "");
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataSessionWidget: state,
            dataSessionWidgetMeta: rawMeta,
            dataSessionWidgetSlot: String(start ?? 0),
          },
        };
        return;
      }
      for (const child of node.children ?? []) {
        visit(child);
      }
    };
    visit(tree);
  };
}

/** Longest widget title, in characters. Mirrors `MAX_TITLE_CHARS` in
 * src-tauri/src/research_artifacts.rs. */
export const MAX_SESSION_WIDGET_TITLE_CHARS = 120;

/** One line of at most 120 characters: control characters and line breaks
 * become spaces and runs of whitespace collapse, so an agent-written title
 * cannot lay itself out as several rows of app chrome. Same rule as
 * `normalize_title` in src-tauri/src/research_artifacts.rs. */
export function sessionWidgetTitle(title: string): string {
  return [
    ...title
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .split(/\s+/u)
      .filter(Boolean)
      .join(" "),
  ]
    .slice(0, MAX_SESSION_WIDGET_TITLE_CHARS)
    .join("");
}

/** Optional metadata does not change the legacy fence format. `parentRevision`
 * is the declared `parent=` as written: the desktop store records a value that
 * is not a revision hash, or names a revision it does not hold, as an
 * unresolved parent and treats the revision as a root
 * (src-tauri/src/research_artifacts.rs). */
export function sessionWidgetMetadata(meta: string): {
  artifactId?: string | undefined;
  title?: string | undefined;
  parentRevision?: string | undefined;
} {
  const fields: Record<string, string> = {};
  for (const match of meta.matchAll(/(?:^|\s)(id|title|parent)=("(?:\\.|[^"\\\r\n])*"|[^\s]+)/gu)) {
    try {
      fields[match[1]!] = match[2]!.startsWith('"') ? (JSON.parse(match[2]!) as string) : match[2]!;
    } catch {
      /* Ignore malformed metadata. */
    }
  }
  return {
    artifactId: /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(fields.id ?? "")
      ? fields.id
      : undefined,
    title: fields.title === undefined ? undefined : sessionWidgetTitle(fields.title) || undefined,
    parentRevision: fields.parent?.slice(0, 128),
  };
}
