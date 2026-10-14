// A complete `session-html` block in an answer (the desktop's
// `SessionWidget.tsx`): one header bar with the title, the script status,
// Preview/Source, Ask for changes, Run scripts or Reload and the "…" menu,
// over a sandboxed frame on the artifact origin.
//
// The frame first shows the static page (markup and CSS only). Run scripts
// loads the run page; the server mints it only while widget scripts are
// allowed (`server/src/artifacts/site.ts`), and "Scripts off" says when they
// are not. The frame is `sandbox="allow-scripts"` without
// `allow-same-origin`, `allow-top-navigation`, `allow-popups` or
// `allow-forms`; its messages go through the validated bridge
// (`widgetBridge.ts`).
//
// The widget subtree is excluded from the answer's text projection
// (`data-research-widget`), so changing view modes and controls does not move
// stored highlights or branch anchors.

import type { ResearchArtifactRevision, ResearchWidgetUrls } from "@session/shared";
import { sessionWidgetDownloadDocument } from "@session/shared";
import {
  SESSION_WIDGET_FRAME_INITIAL,
  SESSION_WIDGET_INITIAL_HEIGHT,
  sessionWidgetFrameReducer,
  sessionWidgetFrameUrl,
  sessionWidgetHasScripts,
  sessionWidgetMetadata,
  sessionWidgetOpenUrl,
} from "@session/shared/lib/sessionWidgets";
import { MessageSquare, Play, RotateCcw } from "lucide-react";
import {
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { prepareResearchWidget, prepareResearchWidgetRevision } from "../../api/api.js";

import { SessionWidgetMenu } from "./SessionWidgetMenu.js";
import { WidgetPreviewDialog, type WidgetPreviewTarget } from "./WidgetPreviewDialog.js";
import { changeArtifactState, loadArtifactState, useArtifactState } from "./artifactState.js";
import {
  SessionWidgetStreamingContext,
  WidgetAnswerContext,
  WidgetChangeContext,
} from "./context.js";
import { useWidgetGuards, useWidgetMessages } from "./useWidgetGuards.js";
import { useArtifactHistory, useWidgetRevision } from "./useWidgetRevision.js";
import {
  readWidgetExecution,
  rememberWidgetExecution,
  subscribeWidgetExecution,
} from "./widgetExecution.js";

type PreparedWidget = ResearchWidgetUrls & { expiresAt: number };

/** Pages are capability URLs that expire after an hour; a cached preparation
 * is reused until a minute before that. */
const PAGE_REUSE_MARGIN_MS = 60_000;
const MAX_PREPARED_WIDGETS = 64;
const preparedWidgets = new Map<string, { page: Promise<PreparedWidget>; expiresAt: number }>();

function prepareWidget(nodeId: string, html: string, fresh: boolean): Promise<PreparedWidget> {
  const key = JSON.stringify([nodeId, html]);
  const cached = preparedWidgets.get(key);
  if (!fresh && cached && Date.now() < cached.expiresAt - PAGE_REUSE_MARGIN_MS) return cached.page;
  const page = prepareResearchWidget(nodeId, html);
  // Reusable until the result says when its pages expire.
  const entry = { page, expiresAt: Number.POSITIVE_INFINITY };
  preparedWidgets.delete(key);
  preparedWidgets.set(key, entry);
  page.then(
    (prepared) => {
      entry.expiresAt = prepared.expiresAt;
    },
    () => {
      if (preparedWidgets.get(key) === entry) preparedWidgets.delete(key);
    },
  );
  if (preparedWidgets.size > MAX_PREPARED_WIDGETS) {
    const oldest = preparedWidgets.keys().next().value;
    if (oldest !== undefined) preparedWidgets.delete(oldest);
  }
  return page;
}

/** Shown on "Scripts off" when the server withholds the run page. */
const SCRIPTS_OFF_TITLE =
  "Widget scripts are off. This server serves widgets from the app's own site, so it does not run their scripts.";

/** Time after Run or Reload during which frame focus counts as app-initiated. */
const PROGRAMMATIC_FOCUS_MS = 1500;

export interface SessionWidgetProps {
  html: string;
  /** The fence's metadata: the opening line after `session-html`. */
  meta?: string;
  /** Where the block starts in its answer text; with the message key, the
   * revision's slot. */
  slot?: string;
  /** The answer node that holds the block. */
  nodeId: string;
}

export function SessionWidget({ html, meta = "", slot = "0", nodeId }: SessionWidgetProps) {
  const answer = useContext(WidgetAnswerContext);
  const streaming = useContext(SessionWidgetStreamingContext);
  const change = useContext(WidgetChangeContext);
  const artifact = useWidgetRevision(nodeId, answer?.messageKey, html, meta, slot, streaming);
  const revision = artifact.revision;
  const history = useArtifactHistory(revision);
  const [source, setSource] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState<WidgetPreviewTarget | null>(null);
  const [frame, dispatch] = useReducer(sessionWidgetFrameReducer, SESSION_WIDGET_FRAME_INITIAL);
  const [height, setHeight] = useState(SESSION_WIDGET_INITIAL_HEIGHT);
  const [prepareAttempt, setPrepareAttempt] = useState({ count: 0, fresh: false, run: false });
  const [expiresAt, setExpiresAt] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Run and Reload replace or hide their buttons, so move keyboard focus to
  // the new frame. This is the only programmatic focus of a widget frame.
  const focusFrameRef = useRef(false);
  const programmaticFocusUntilRef = useRef(0);
  const hasScripts = sessionWidgetHasScripts(html);
  const title = revision?.title ?? sessionWidgetMetadata(meta).title ?? null;

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "prepare" });
    prepareWidget(nodeId, html, prepareAttempt.fresh).then(
      (page) => {
        if (cancelled) return;
        setExpiresAt(page.expiresAt);
        const execution = readWidgetExecution(html);
        dispatch({
          type: "prepared",
          urls: { staticUrl: page.staticUrl, runUrl: page.runUrl },
          running: prepareAttempt.run || execution === "running",
          stopped: execution === "focus" ? "focus" : null,
        });
      },
      () => {
        if (!cancelled) dispatch({ type: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, html, prepareAttempt]);

  const execution = useSyncExternalStore(
    subscribeWidgetExecution,
    () => readWidgetExecution(html),
    () => null,
  );
  // Stopping an expanded copy also stops this instance. Preserve that state
  // across remounts until the reader runs it again.
  useEffect(() => {
    if (execution === "focus") dispatch({ type: "stop", reason: "focus" });
  }, [execution]);

  const frameUrl = sessionWidgetFrameUrl(frame);
  const openUrl = sessionWidgetOpenUrl(frame);
  const state = useArtifactState(revision, frameRef, frameUrl, frame.loads >= 1);
  const canRun =
    frame.phase === "ready" && hasScripts && !frame.running && Boolean(frame.urls?.runUrl);
  const scriptsUnavailable = hasScripts && frame.urls !== null && frame.urls.runUrl === null;
  const scriptStatus = scriptsUnavailable
    ? { key: "off", label: "Scripts off", title: SCRIPTS_OFF_TITLE }
    : frame.stopped
      ? {
          key: "stopped",
          label: "Stopped",
          title: "Scripts stopped: the widget kept taking keyboard focus",
        }
      : frame.running
        ? { key: "running", label: "Running", title: "The widget's scripts are running" }
        : null;

  /** Loads a new page for Run or Reload: the current one, or freshly
   * prepared pages when the current ones are about to expire. */
  const reloadOrRun = (kind: "run" | "reload") => {
    focusFrameRef.current = true;
    if (Date.now() >= expiresAt - PAGE_REUSE_MARGIN_MS) {
      const run = kind === "run" || frame.running;
      setPrepareAttempt((attempt) => ({ count: attempt.count + 1, fresh: true, run }));
      return;
    }
    dispatch({ type: kind });
  };

  const action = async (work: () => Promise<unknown>, success: string) => {
    try {
      const result = await work();
      setActionStatus(result === false ? "" : success);
    } catch {
      setActionStatus("Action failed. Try again.");
    }
  };

  const previewRevision = async (entry: ResearchArtifactRevision) => {
    try {
      const page = await prepareResearchWidgetRevision({
        treeId: entry.treeId,
        artifactId: entry.artifactId,
        revision: entry.revision,
      });
      setActionStatus("");
      setPreview({
        url: page.staticUrl,
        html: entry.html,
        staticPage: true,
        reference: entry,
        title: `${entry.title} · ${entry.revision.slice(0, 8)}`,
      });
    } catch {
      setActionStatus("Revision preview unavailable. Try again.");
    }
  };

  useEffect(() => {
    if (focusFrameRef.current && frameUrl) {
      focusFrameRef.current = false;
      programmaticFocusUntilRef.current = performance.now() + PROGRAMMATIC_FOCUS_MS;
      frameRef.current?.focus();
    }
  }, [frameUrl, frame.generation]);

  const guard = useWidgetGuards({
    frameRef,
    frameUrl,
    generation: frame.generation,
    pageLoaded: frame.phase === "ready" && frame.loads >= 1,
    running: frame.running,
    programmaticFocusUntilRef,
    onNavigate: () => dispatch({ type: "unload" }),
    onStop: () => {
      rememberWidgetExecution(html, "focus");
      dispatch({ type: "stop", reason: "focus" });
    },
    onHeight: setHeight,
  });
  useWidgetMessages(frameRef, (message) => {
    guard(message);
    state.onMessage(message);
  });

  const blockedChange = answer
    ? (change?.blocked ??
      answer.blocked ??
      (revision === null ? "Waiting for the revision to be saved" : null))
    : null;

  return (
    <figure
      data-research-widget=""
      className="session-widget"
      data-state={frame.phase}
      data-running={frame.running || undefined}
      data-scripts={scriptsUnavailable ? "unavailable" : frame.stopped ? "stopped" : undefined}
      aria-label="Answer widget"
    >
      <div className="session-widget-bar" data-widget-chrome="">
        <div className="session-widget-heading">
          {title ? (
            <span className="session-widget-title" title={title}>
              {title}
            </span>
          ) : (
            <span className="session-widget-title" data-placeholder="">
              Widget
            </span>
          )}
          {scriptStatus ? (
            <span
              className="session-widget-status"
              data-status={scriptStatus.key}
              title={scriptStatus.title}
            >
              {scriptStatus.label}
            </span>
          ) : null}
        </div>
        <div className="session-widget-controls">
          <div className="session-widget-view" role="group" aria-label="Widget view">
            <button
              type="button"
              className="session-widget-segment"
              aria-pressed={!source}
              onClick={() => setSource(false)}
            >
              Preview
            </button>
            <button
              type="button"
              className="session-widget-segment"
              aria-pressed={source}
              onClick={() => setSource(true)}
            >
              Source
            </button>
          </div>
          {answer && change ? (
            <button
              type="button"
              className="session-widget-action"
              disabled={blockedChange !== null}
              title={blockedChange ?? "Ask for changes"}
              aria-label="Ask for widget changes"
              onClick={() =>
                change.ask(revision ? { ...answer, artifact: revision } : answer, html)
              }
            >
              <MessageSquare aria-hidden="true" />
            </button>
          ) : null}
          {frame.phase === "failed" ? (
            <button
              type="button"
              className="session-widget-action"
              title="Retry loading widget"
              aria-label="Retry loading widget"
              onClick={() =>
                setPrepareAttempt((attempt) => ({
                  count: attempt.count + 1,
                  fresh: true,
                  run: false,
                }))
              }
            >
              <RotateCcw aria-hidden="true" />
            </button>
          ) : null}
          {canRun ? (
            <button
              type="button"
              className="session-widget-run"
              title="Run the widget's scripts"
              aria-label="Run the widget's scripts"
              onClick={() => {
                rememberWidgetExecution(html, "running");
                reloadOrRun("run");
              }}
            >
              <Play aria-hidden="true" />
              <span className="session-widget-run-label">Run scripts</span>
            </button>
          ) : null}
          {frame.phase === "navigated" || (frame.phase === "ready" && frame.running) ? (
            <button
              type="button"
              className="session-widget-action"
              title="Reload widget"
              aria-label="Reload widget"
              onClick={() => reloadOrRun("reload")}
            >
              <RotateCcw aria-hidden="true" />
            </button>
          ) : null}
          <SessionWidgetMenu
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (open) history.load();
            }}
            revision={revision}
            hasScripts={hasScripts}
            stateEntry={state.entry}
            history={history.history}
            onLoadHistory={history.load}
            onCopy={() => void action(() => navigator.clipboard.writeText(html), "HTML copied")}
            onDownload={() =>
              void action(() => Promise.resolve(downloadWidget(html)), "HTML downloaded")
            }
            onOpenExpanded={
              openUrl
                ? () =>
                    setPreview({
                      url: openUrl,
                      html,
                      staticPage: openUrl === frame.urls?.staticUrl,
                      reference: revision,
                      title: title ?? "Widget",
                    })
                : null
            }
            onPreviewRevision={(entry) => void previewRevision(entry)}
          />
        </div>
      </div>
      {artifact.error ? (
        <div className="session-widget-feedback" data-widget-chrome="" role="status">
          {artifact.error}{" "}
          <button type="button" className="research-link-button" onClick={artifact.retry}>
            Retry saving revision
          </button>
        </div>
      ) : null}
      {revision && hasScripts && state.entry.error ? (
        <div className="session-widget-feedback" data-widget-chrome="" role="status">
          {state.entry.error}
          {state.entry.config?.enabled ? (
            <>
              {" "}
              <button
                type="button"
                className="research-link-button"
                disabled={state.entry.pending > 0}
                onClick={() =>
                  void changeArtifactState(revision, "save", state.entry.config?.value)
                }
              >
                Retry saving
              </button>
            </>
          ) : null}
          {!state.entry.config ? (
            <>
              {" "}
              <button
                type="button"
                className="research-link-button"
                onClick={() => void loadArtifactState(revision)}
              >
                Retry
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {actionStatus ? (
        <div className="session-widget-feedback" data-widget-chrome="" role="status">
          {actionStatus}
        </div>
      ) : null}
      {source ? (
        <pre className="session-widget-source" onPointerDown={allowSourceSelection}>
          <code>{html}</code>
        </pre>
      ) : null}
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
            // The first load is the widget page. A later load means the frame
            // navigated to content Session did not serve, so it is removed.
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
      <WidgetPreviewDialog target={preview} onClose={() => setPreview(null)} />
    </figure>
  );
}

/** Saves the widget as a file. The file carries the static page's policy (no
 * scripts, no network) as a meta CSP, since it opens outside the sandbox. */
function downloadWidget(html: string) {
  const url = URL.createObjectURL(
    new Blob([sessionWidgetDownloadDocument(html)], { type: "text/html;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "session-widget.html";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The Source view is `user-select: none` so a selection that starts in the
 * answer's prose does not copy the widget's source. A selection that starts
 * inside the Source view may select it: the press marks it selectable until
 * the next press elsewhere. */
function allowSourceSelection(event: ReactPointerEvent<HTMLPreElement>) {
  const pre = event.currentTarget;
  if (pre.dataset["selectable"] !== undefined) return;
  pre.dataset["selectable"] = "";
  const release = (next: PointerEvent) => {
    if (next.target instanceof Node && pre.contains(next.target)) return;
    delete pre.dataset["selectable"];
    document.removeEventListener("pointerdown", release, true);
  };
  document.addEventListener("pointerdown", release, true);
}
