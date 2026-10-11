// Inline HTML widgets in research answers: an answer carries one as a fenced
// code block whose language is `session-html`. The Markdown renderer marks each
// such block complete or still streaming (`remarkSessionWidgetFences`), and
// `SessionWidget` displays a complete one in a sandboxed frame served by the
// backend (see src-tauri/src/research_widgets.rs).

import type { ResearchWidgetUrls } from "./api";
import { fromMarkdown } from "mdast-util-from-markdown";
import { closesFence, markerRunAtLineStart } from "./markdownMathDelimiters";

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

interface MdastCode {
  type: string;
  lang?: string | null;
  meta?: string | null;
  value?: string;
  data?: { hProperties?: Record<string, unknown> };
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdastCode[];
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
  const last = lines[lines.length - 1].replace(/^[\s>]*/u, "");
  return closesFence(last, fence);
}

/** Remark plugin: marks each `session-html` code block as complete or partial
 * on the rendered `code` element, so the renderer can show a placeholder for a
 * block that is still streaming instead of a frame around half a page. */
export function remarkSessionWidgetFences() {
  return (tree: MdastCode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : String(file.value ?? "");
    const visit = (node: MdastCode) => {
      if (node.type === "code" && isSessionWidgetInfo(node.lang)) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const state: SessionWidgetState =
          start !== undefined && end !== undefined && fencedBlockIsClosed(source.slice(start, end), node.value ?? "")
            ? "complete"
            : "partial";
        const opening = start === undefined || end === undefined ? "" : source.slice(start, end).split(/\r?\n/u)[0];
        const rawMeta = opening.includes("session-html") ? opening.slice(opening.indexOf("session-html") + "session-html".length).trim() : node.meta ?? "";
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataSessionWidget: state, dataSessionWidgetMeta: rawMeta, dataSessionWidgetSlot: String(start ?? 0) },
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

/** Remove only parsed widget blocks, including fences immediately after list
 * markers. Using CommonMark also preserves indented code and samples inside
 * another fence, and ends unclosed blocks at their container's boundary. */
export function stripSessionWidgetBlocks(markdown: string): string {
  if (!markdown.includes(SESSION_WIDGET_LANGUAGE)) {
    return markdown;
  }
  const kept: string[] = [];
  let cursor = 0;
  interface SourceNode {
    type: string;
    lang?: string | null;
    position?: MdastCode["position"];
    children?: SourceNode[];
  }
  const visit = (node: SourceNode) => {
    if (node.type === "code" && isSessionWidgetInfo(node.lang)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        kept.push(markdown.slice(cursor, start), "\n\n");
        cursor = end;
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(markdown));
  kept.push(markdown.slice(cursor));
  return kept.join("");
}

/** Bounds on an answer widget's frame height, in CSS pixels. Content taller
 * than the maximum scrolls inside the frame. */
export const SESSION_WIDGET_MIN_HEIGHT = 48;
export const SESSION_WIDGET_MAX_HEIGHT = 900;
export const SESSION_WIDGET_INITIAL_HEIGHT = 160;

/** The frame height for a height the widget page reported, or null for a
 * message that is not a well-formed height report. */
export function sessionWidgetFrameHeight(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const { type, height } = message as { type?: unknown; height?: unknown };
  if (type !== "session-widget-height" || typeof height !== "number" || !Number.isFinite(height)) {
    return null;
  }
  return Math.min(SESSION_WIDGET_MAX_HEIGHT, Math.max(SESSION_WIDGET_MIN_HEIGHT, Math.ceil(height)));
}

/** The frame's lifecycle. `loads` counts load events of the current frame
 * document; `generation` changes whenever the frame must be recreated (Run,
 * Reload), which also restarts the count. */
interface SessionWidgetFrame {
  phase: "loading" | "ready" | "failed" | "navigated";
  urls: ResearchWidgetUrls | null;
  running: boolean;
  loads: number;
  generation: number;
  /** Why Session stopped the widget's scripts, if it did. */
  stopped: "focus" | null;
}

type SessionWidgetFrameEvent =
  | { type: "prepare" }
  | { type: "prepared"; urls: ResearchWidgetUrls; running: boolean; stopped?: "focus" | null }
  | { type: "failed" }
  | { type: "run" }
  | { type: "load" }
  | { type: "unload" }
  | { type: "stop"; reason: "focus" }
  | { type: "reload" };

export const SESSION_WIDGET_FRAME_INITIAL: SessionWidgetFrame = {
  phase: "loading",
  urls: null,
  running: false,
  loads: 0,
  generation: 0,
  stopped: null,
};

/** Transitions of a widget frame: prepare, static page, then (Run) the run
 * page. The page navigating itself drops the frame until Reload: reported by
 * the page's own guard when its document unloads, or seen as a second load of
 * the same frame. Run needs a run URL, which the backend gives only while
 * widget scripts are allowed. Stop returns a running widget to its static page
 * with a reason (a widget that keeps taking keyboard focus from the app). */
export function sessionWidgetFrameReducer(
  state: SessionWidgetFrame,
  event: SessionWidgetFrameEvent,
): SessionWidgetFrame {
  switch (event.type) {
    case "prepare":
      return { ...SESSION_WIDGET_FRAME_INITIAL, generation: state.generation + 1 };
    case "prepared":
      return {
        ...state,
        phase: "ready",
        urls: event.urls,
        running: event.running && event.urls.runUrl !== null,
        stopped: event.stopped ?? null,
        loads: 0,
      };
    case "failed":
      return { ...state, phase: "failed" };
    case "run":
      if (state.phase !== "ready" || state.running || !state.urls?.runUrl) {
        return state;
      }
      return { ...state, running: true, loads: 0, generation: state.generation + 1, stopped: null };
    case "unload":
      return state.phase === "ready" ? { ...state, phase: "navigated" } : state;
    case "stop":
      if (!state.running) {
        return state;
      }
      return {
        ...state,
        phase: state.phase === "navigated" ? "ready" : state.phase,
        running: false,
        loads: 0,
        generation: state.generation + 1,
        stopped: event.reason,
      };
    case "load":
      if (state.phase !== "ready") {
        return state;
      }
      return state.loads >= 1
        ? { ...state, phase: "navigated", loads: state.loads + 1 }
        : { ...state, loads: 1 };
    case "reload":
      if (state.phase !== "ready" && state.phase !== "navigated") {
        return state;
      }
      return { ...state, phase: "ready", loads: 0, generation: state.generation + 1 };
  }
}

/** The page the frame shows: the run page once the reader has run it. */
export function sessionWidgetFrameUrl(state: SessionWidgetFrame): string | null {
  if (state.phase !== "ready" || !state.urls) {
    return null;
  }
  return state.running && state.urls.runUrl ? state.urls.runUrl : state.urls.staticUrl;
}

/** The page "Open in browser" shows: the static page unless the reader has
 * already run the widget, so opening it never starts scripts by itself. */
export function sessionWidgetOpenUrl(state: SessionWidgetFrame): string | null {
  if (!state.urls) {
    return null;
  }
  return state.running && state.urls.runUrl ? state.urls.runUrl : state.urls.staticUrl;
}

/** A message from the widget frame: a height report, or the page's notice
 * that its document is unloading (it navigated). Null when the message did
 * not come from this frame's window or is neither. */
export function sessionWidgetFrameMessage(
  message: { source: unknown; data: unknown },
  frameWindow: unknown,
): { type: "height"; height: number } | { type: "unload" } | { type: "pong" } | null {
  if (!frameWindow || message.source !== frameWindow) {
    return null;
  }
  const data = message.data as { type?: unknown } | null;
  if (data && typeof data === "object" && data.type === "session-widget-unload") {
    return { type: "unload" };
  }
  if (data && typeof data === "object" && data.type === "session-widget-pong") {
    return { type: "pong" };
  }
  const height = sessionWidgetFrameHeight(message.data);
  return height === null ? null : { type: "height", height };
}

/** The answer pings a loaded widget page once a second; the page's guard
 * answers. This many pings in a row without an answer mean another document
 * has replaced the widget page (a navigation the page could not cancel), and
 * the frame is removed. Counted in pings rather than elapsed time, so a pause
 * of the app's own timers (a long task, a hidden window) is not a miss. */
export const SESSION_WIDGET_PING_INTERVAL_MS = 1000;
const SESSION_WIDGET_MISSED_PINGS_TO_DROP = 4;

/** One ping tick: the new count of unanswered pings and whether the widget
 * page is considered gone. */
export function sessionWidgetPingTick(unanswered: number): { unanswered: number; gone: boolean } {
  const next = unanswered + 1;
  return { unanswered: next, gone: next > SESSION_WIDGET_MISSED_PINGS_TO_DROP };
}

/** Focus entering a running widget's frame counts as taken by the widget when
 * Session did not move it there (Run, Reload), the pointer is not over the
 * frame, and the reader interacted with the app (a pointer press or a key
 * other than Tab) within the last second. */
const SESSION_WIDGET_FOCUS_INTERACTION_MS = 1000;
/** Taken focus is handed back each time; this many takes within the window
 * stop the widget's scripts. */
const SESSION_WIDGET_FOCUS_TAKES_TO_STOP = 3;
const SESSION_WIDGET_FOCUS_TAKE_WINDOW_MS = 10_000;

export function sessionWidgetTookFocus(input: {
  now: number;
  programmaticUntil: number;
  lastAppInteraction: number;
  pointerOverFrame: boolean;
}): boolean {
  return (
    input.now >= input.programmaticUntil &&
    !input.pointerOverFrame &&
    input.now - input.lastAppInteraction <= SESSION_WIDGET_FOCUS_INTERACTION_MS
  );
}

/** Records a focus take at `now` and says whether the widget should stop. */
export function sessionWidgetRecordFocusTake(takes: number[], now: number): { takes: number[]; stop: boolean } {
  const recent = [...takes.filter((at) => now - at < SESSION_WIDGET_FOCUS_TAKE_WINDOW_MS), now];
  return { takes: recent, stop: recent.length >= SESSION_WIDGET_FOCUS_TAKES_TO_STOP };
}

/** Optional metadata does not change the legacy fence format. */
export function sessionWidgetMetadata(meta: string): { artifactId?: string; title?: string; parentRevision?: string } {
  const fields: Record<string, string> = {};
  for (const match of meta.matchAll(/(?:^|\s)(id|title|parent)=("(?:\\.|[^"\\\r\n])*"|[^\s]+)/gu)) {
    try { fields[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) as string : match[2]; } catch { /* Ignore malformed metadata. */ }
  }
  return {
    artifactId: /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(fields.id ?? "") ? fields.id : undefined,
    title: fields.title?.slice(0, 120),
    parentRevision: /^[a-f0-9]{64}$/u.test(fields.parent ?? "") ? fields.parent : undefined,
  };
}
