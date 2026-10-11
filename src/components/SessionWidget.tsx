import { createContext, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, Play, RotateCcw } from "lucide-react";
import { prepareResearchWidget, type ResearchWidgetUrls } from "../lib/api";
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

// Displays one complete `session-html` block from a research answer in a
// sandboxed frame. The backend stores the HTML under its content hash and
// returns its URLs (src-tauri/src/research_widgets.rs): a static page whose
// CSP blocks the widget's scripts, and, while widget scripts are allowed, a
// run page that admits them. The frame starts on the static page; the
// widget's scripts start only when the reader clicks Run scripts, because a
// sandboxed cross-origin frame in WKWebView can share the app's web content
// process and a script that never yields would stall the whole interface.
//
// The frame's chrome holds no text nodes (labels are CSS generated content and
// ARIA attributes), so the answer's text projection, which highlights and
// branch anchors are stored against, and find-in-page see only answer prose.

/** Whether the answer containing a widget block is still being written. An
 * unclosed block shows a placeholder while it is, and its source with a notice
 * once the answer has settled (a cancelled or truncated run, or a closing
 * fence CommonMark does not accept). */
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

/** How long after Run or Reload focus entering the new frame is Session's own
 * move rather than the widget's. */
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
}: {
  html: string;
  /** Opens a widget URL in the thread's sandboxed browser overlay. */
  onOpen: (url: string) => void;
}) {
  const [frame, dispatch] = useReducer(sessionWidgetFrameReducer, SESSION_WIDGET_FRAME_INITIAL);
  const [height, setHeight] = useState(SESSION_WIDGET_INITIAL_HEIGHT);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Set by Run and Reload, whose buttons the new frame replaces or hides:
  // keyboard focus moves to the new frame instead of falling to the page. This
  // is the only programmatic focus move into a widget frame.
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
  // Stopping an expanded copy also stops this instance. A stopped choice is
  // retained across remounts until the reader explicitly runs it again.
  useEffect(() => {
    if (execution === "focus") dispatch({ type: "stop", reason: "focus" });
  }, [execution]);

  const pageUrl = sessionWidgetFrameUrl(frame);
  const frameUrl = pageUrl ? withBodyFont(pageUrl) : null;
  const openUrl = sessionWidgetOpenUrl(frame);
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
      className="session-widget"
      data-state={frame.phase}
      data-running={frame.running || undefined}
      data-scripts={scriptsUnavailable ? "unavailable" : frame.stopped ? "stopped" : undefined}
      aria-label="Answer widget"
    >
      <div className="session-widget-bar">
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
          // The first load is the widget page. A later one means the page
          // navigated itself (a link, a refresh), which would show content
          // Session did not serve; the reducer drops the frame instead.
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
    </figure>
  );
}

/** Placeholder for a widget block whose closing fence has not arrived yet. */
export function SessionWidgetPending() {
  return (
    <figure className="session-widget" data-state="pending" aria-label="Answer widget">
      <div
        className="session-widget-placeholder"
        role="status"
        aria-label="Widget is being written"
        data-label="Widget is being written"
      />
    </figure>
  );
}
