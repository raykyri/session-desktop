import { useSessionArtifactState } from "../hooks/useSessionArtifactState";
import { withArtifactState } from "../lib/sessionArtifactState";
import SessionArtifactStateControls from "./SessionArtifactStateControls";
import { useResearchArtifact } from "../hooks/useResearchArtifact";
import SessionArtifactDetails from "./SessionArtifactDetails";
import { createContext, useContext, useEffect, useReducer, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, Download, MessageSquare, ExternalLink, Play, RotateCcw } from "lucide-react";
import { downloadResearchWidget, prepareResearchWidget, type ResearchWidgetUrls } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import { WidgetAnswerContext, WidgetChangeContext } from "../lib/sessionWidgetActions";
import { useSessionWidgetGuards } from "../hooks/useSessionWidgetGuards";
import { readWidgetExecution, registerWidgetUrls, rememberWidgetExecution, subscribeWidgetExecution } from "../lib/sessionWidgetExecution";
import {
  SESSION_WIDGET_FRAME_INITIAL,
  SESSION_WIDGET_INITIAL_HEIGHT,
  sessionWidgetFrameReducer,
  sessionWidgetFrameUrl,
  sessionWidgetHasScripts,
  sessionWidgetOpenUrl,
} from "../lib/sessionWidgets";

// Displays a complete `session-html` block in a sandboxed frame. The backend
// stores the HTML by content hash and returns static and executable URLs
// (src-tauri/src/research_widgets.rs). The static page blocks scripts with
// CSP. Run scripts loads the executable page on request because WKWebView may
// run a sandboxed cross-origin frame in the app's web content process, where
// a non-yielding script would block the interface.
//
// The widget subtree is excluded from the answer text projection so changing
// view modes and controls does not move stored highlights or branch anchors.

/** Whether the answer containing a widget block is still streaming. An
 * unclosed block shows a placeholder during streaming, then its source with a
 * notice after cancellation, truncation, or an invalid CommonMark fence. */
export const SessionWidgetStreamingContext = createContext(false);

const MAX_PREPARED_WIDGETS = 64;
const preparedWidgets = new Map<string, Promise<ResearchWidgetUrls>>();

function prepareWidget(html: string): Promise<ResearchWidgetUrls> {
  let prepared = preparedWidgets.get(html);
  if (!prepared) {
    prepared = prepareResearchWidget(html).then(registerWidgetUrls);
    preparedWidgets.set(html, prepared);
    prepared.catch(() => preparedWidgets.delete(html));
    if (preparedWidgets.size > MAX_PREPARED_WIDGETS) {
      const oldest = preparedWidgets.keys().next().value;
      if (oldest !== undefined) {
        preparedWidgets.delete(oldest);
      }
    }
  }
  return prepared;
}

/** Time after Run or Reload during which frame focus counts as app-initiated. */
const PROGRAMMATIC_FOCUS_MS = 1500;

/** The frame URL with the app's body font, which the widget page's wrapper
 * uses for unstyled text. */
function withBodyFont(url: string): string {
  const bodyFont =
    typeof document === "undefined" ? undefined : document.documentElement.dataset.bodyFont;
  if (!bodyFont) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("session-body-font", bodyFont);
    return parsed.toString();
  } catch {
    return url;
  }
}

export default function SessionWidget({
  html,
  onOpen,
  meta = "",
  slot = "0",
}: {
  html: string;
  meta?: string;
  slot?: string;
  /** Opens a widget URL in the thread's sandboxed browser overlay. */
  onOpen: (url: string) => void;
}) {
  const answer = useContext(WidgetAnswerContext);
  const streaming = useContext(SessionWidgetStreamingContext);
  const artifact = useResearchArtifact(answer, html, meta, slot, streaming);
  const askForChanges = useContext(WidgetChangeContext);
  const [source, setSource] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const action = async (work: () => Promise<unknown>, success: string) => {
    try { const result = await work(); setActionStatus(result === false ? "" : success); }
    catch { setActionStatus("Action failed. Try again."); }
  };
  const [frame, dispatch] = useReducer(sessionWidgetFrameReducer, SESSION_WIDGET_FRAME_INITIAL);
  const [height, setHeight] = useState(SESSION_WIDGET_INITIAL_HEIGHT);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Run and Reload replace or hide their buttons, so move keyboard focus to
  // the new frame. This is the only programmatic focus of a widget frame.
  const focusFrameRef = useRef(false);
  const programmaticFocusUntilRef = useRef(0);
  const hasScripts = sessionWidgetHasScripts(html);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "prepare" });
    prepareWidget(html).then(
      (urls) => {
        if (!cancelled) {
          const execution = readWidgetExecution(urls.staticUrl);
          dispatch({ type: "prepared", urls, running: execution === "running", stopped: execution === "focus" ? "focus" : null });
        }
      },
      () => {
        if (!cancelled) {
          dispatch({ type: "failed" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [html, prepareAttempt]);

  const execution = useSyncExternalStore(
    subscribeWidgetExecution,
    () => readWidgetExecution(frame.urls?.staticUrl),
    () => null,
  );
  // Stopping an expanded copy also stops this instance. Preserve that state
  // across remounts until the user runs it again.
  useEffect(() => {
    if (execution === "focus") dispatch({ type: "stop", reason: "focus" });
  }, [execution]);

  const pageUrl = sessionWidgetFrameUrl(frame);
  const frameUrl = pageUrl ? withBodyFont(pageUrl) : null;
  const rawOpenUrl = sessionWidgetOpenUrl(frame);
  const openUrl = rawOpenUrl ? withArtifactState(rawOpenUrl, artifact.revision) : null;
  const artifactState = useSessionArtifactState(artifact.revision, frameRef, frameUrl, frame.loads >= 1);
  const canRun = frame.phase === "ready" && hasScripts && !frame.running && Boolean(frame.urls?.runUrl);
  const scriptsUnavailable = hasScripts && frame.urls !== null && frame.urls.runUrl === null;

  useEffect(() => {
    if (focusFrameRef.current && frameUrl) {
      focusFrameRef.current = false;
      programmaticFocusUntilRef.current = performance.now() + PROGRAMMATIC_FOCUS_MS;
      frameRef.current?.focus();
    }
  }, [frameUrl, frame.generation]);

  useSessionWidgetGuards({
    frameRef, frameUrl, generation: frame.generation,
    pageLoaded: frame.phase === "ready" && frame.loads >= 1,
    running: frame.running, programmaticFocusUntilRef,
    onNavigate: () => dispatch({ type: "unload" }),
    onStop: () => {
      if (frame.urls) rememberWidgetExecution(frame.urls.staticUrl, "focus");
      dispatch({ type: "stop", reason: "focus" });
    },
    onHeight: setHeight,
  });

  return (
    <figure
      data-research-widget=""
      className="session-widget"
      data-state={frame.phase}
      data-running={frame.running || undefined}
      data-scripts={scriptsUnavailable ? "unavailable" : frame.stopped ? "stopped" : undefined}
      aria-label="Answer widget"
    >
      {artifact.revision ? <SessionArtifactDetails key={`${artifact.revision.artifactId}:${artifact.revision.revision}`} revision={artifact.revision} onOpen={onOpen} /> : null}
      {artifact.error ? <div className="session-widget-feedback" data-widget-chrome="" role="status">{artifact.error} <button type="button" onClick={artifact.retry}>Retry saving revision</button></div> : null}
      <div className="session-widget-bar" data-widget-chrome="">
        <button type="button" className="session-widget-run" aria-pressed={!source} onClick={() => setSource(false)}>Preview</button>
        <button type="button" className="session-widget-run" aria-pressed={source} onClick={() => setSource(true)}>Source</button>
        <button type="button" className="icon-button session-widget-action" title="Copy HTML" aria-label="Copy widget HTML" onClick={() => void action(() => writeClipboardText(html), "HTML copied")}><Copy /></button>
        <button type="button" className="icon-button session-widget-action" title="Download HTML" aria-label="Download widget HTML" onClick={() => void action(() => downloadResearchWidget(html), "HTML downloaded")}><Download /></button>
        {answer && askForChanges ? <button type="button" className="icon-button session-widget-action" disabled={Boolean(answer.blocked) || Boolean(answer.treeId && !artifact.revision)} title={answer.blocked ?? (answer.treeId && !artifact.revision ? "Waiting for the revision to be saved" : "Ask for changes")} aria-label="Ask for widget changes" onClick={() => askForChanges(artifact.revision ? { ...answer, artifact: artifact.revision } : answer, html)}><MessageSquare /></button> : null}
        {frame.phase === "failed" ? (
          <button
            type="button"
            className="icon-button session-widget-action"
            title="Retry loading widget"
            aria-label="Retry loading widget"
            onClick={() => setPrepareAttempt((attempt) => attempt + 1)}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        ) : null}
        {canRun ? (
          <button
            type="button"
            className="session-widget-run"
            data-label="Run scripts"
            title="Run the widget's scripts"
            aria-label="Run the widget's scripts"
            onClick={() => {
              if (frame.urls) {
                rememberWidgetExecution(frame.urls.staticUrl, "running");
              }
              focusFrameRef.current = true;
              dispatch({ type: "run" });
            }}
          >
            <Play aria-hidden="true" />
          </button>
        ) : null}
        {frame.phase === "navigated" || (frame.phase === "ready" && frame.running) ? (
          <button
            type="button"
            className="icon-button session-widget-action"
            title="Reload widget"
            aria-label="Reload widget"
            onClick={() => {
              focusFrameRef.current = true;
              dispatch({ type: "reload" });
            }}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        ) : null}
        {openUrl ? (
          <button
            type="button"
            className="icon-button session-widget-action"
            title="Open in browser"
            aria-label="Open widget in browser"
            onClick={() => onOpen(openUrl)}
          >
            <ExternalLink aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {artifact.revision && hasScripts ? <SessionArtifactStateControls revision={artifact.revision} entry={artifactState} /> : null}
      {actionStatus ? <div className="session-widget-feedback" data-widget-chrome="" role="status">{actionStatus}</div> : null}
      {source ? <pre className="session-widget-source" onPointerDown={allowSourceSelection}><code>{html}</code></pre> : null}
      <div hidden={source}>
      {frameUrl ? (
        <iframe
          key={`${frameUrl}:${frame.generation}`}
          ref={frameRef}
          className="session-widget-frame"
          src={frameUrl}
          title="Answer widget"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          style={{ height }}
          // The first load is the widget page. A later load indicates internal
          // navigation to content Session did not serve, so remove the frame.
          onLoad={() => dispatch({ type: "load" })}
        />
      ) : (
        <div
          className="session-widget-placeholder"
          role="status"
          aria-label={
            frame.phase === "failed"
              ? "The widget could not be loaded"
              : frame.phase === "navigated"
                ? "The widget left its page; reload it to show it again"
                : "Loading widget"
          }
          data-label={
            frame.phase === "failed"
              ? "Widget unavailable"
              : frame.phase === "navigated"
                ? "The widget navigated away from its page"
                : "Loading widget"
          }
          style={{ height: frame.phase === "loading" ? height : undefined }}
        />
      )}
      </div>
    </figure>
  );
}

/** The Source view is `user-select: none` (transcript.css) so a selection
 * that starts in the answer's prose does not copy the widget's source. A
 * selection that starts inside the Source view may select it: the press marks
 * it selectable until the next press elsewhere. */
function allowSourceSelection(event: ReactPointerEvent<HTMLPreElement>) {
  const pre = event.currentTarget;
  if (pre.dataset.selectable !== undefined) return;
  pre.dataset.selectable = "";
  const release = (next: PointerEvent) => {
    if (next.target instanceof Node && pre.contains(next.target)) return;
    delete pre.dataset.selectable;
    document.removeEventListener("pointerdown", release, true);
  };
  document.addEventListener("pointerdown", release, true);
}

/** Placeholder for an incomplete widget block in a streaming answer. */
export function SessionWidgetPending() {
  return (
    <figure className="session-widget" data-state="pending" aria-label="Answer widget">
      <div
        className="session-widget-placeholder"
        role="status"
        aria-label="Waiting for complete widget code"
        data-label="Waiting for complete widget code"
      />
    </figure>
  );
}
