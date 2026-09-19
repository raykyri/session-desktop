// The document preview panel (`11-artifacts-and-browser.md` §3).
//
// A floating panel over the right of the stage holding one sandboxed iframe
// pointed at the artifact origin. `allow-same-origin` in the sandbox refers to
// *that* origin, never the app's, which is the whole reason the artifacts live
// on a second hostname: the frame gets a real origin (so a PDF viewer and the
// scroll bridge work) without getting the app's cookie or DOM.
//
// Everything the desktop's `BrowserOverlay.tsx` did for the native and
// screencast modes is gone. What is left is the chrome that was always pure
// DOM — address row, reload, open in a tab, close, resize, full width — plus
// two messages over `postMessage`:
//
//   - `session-preview-scroll`, posted by the rendered Markdown page, which is
//     what lets a reload land where the reader was;
//   - `session-preview-error`, posted by the 404/410 body, which is how a
//     cross-origin iframe reports a status its embedder cannot read; the panel
//     answers it by minting a new token.
//
// Both messages are accepted only from the artifact origin provided by
// `system.runtimeConfig` (`features.artifactOrigin`). Messages are ignored until
// the deployment-specific origin is available.

import { ExternalLink, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { mintArtifactToken } from "../../api/api.js";
import { useRuntimeConfig, useSignedIn } from "../../api/queries.js";
import { useArtifactPanelStore } from "../../stores/artifactPanel.js";
import { OVERLAY_PRIORITY } from "../../stores/overlays.js";
import { ICON_BUTTON } from "../../ui/surfaces.js";
import { useOverlay } from "../../ui/useOverlay.js";

/** The shapes the artifact origin is allowed to send. Anything else from that
 * origin is dropped rather than coerced. */
export type ArtifactPanelMessage =
  | { type: "session-preview-scroll"; x: number; y: number }
  | { type: "session-preview-error"; status: number };

export function parseArtifactMessage(data: unknown): ArtifactPanelMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record["type"] === "session-preview-scroll") {
    const { x, y } = record;
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { type: "session-preview-scroll", x, y };
  }
  if (record["type"] === "session-preview-error") {
    const status = record["status"];
    return { type: "session-preview-error", status: typeof status === "number" ? status : 0 };
  }
  return null;
}

/** The statuses a fresh token can fix (`11-artifacts-and-browser.md` §2). */
export function isRemintableStatus(status: number): boolean {
  return status === 404 || status === 410;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  axis: "width" | "both";
}

/**
 * Mounted once by `AppShell`. It renders nothing while the panel is closed but
 * keeps its hooks — the Shift-Cmd-E listener has to be live for the chord to
 * reopen the last document.
 */
export function ArtifactPanel() {
  const current = useArtifactPanelStore((state) => state.current);
  const width = useArtifactPanelStore((state) => state.width);
  const height = useArtifactPanelStore((state) => state.height);
  const fullWidth = useArtifactPanelStore((state) => state.fullWidth);
  const reloadNonce = useArtifactPanelStore((state) => state.reloadNonce);
  const close = useArtifactPanelStore((state) => state.close);
  const reload = useArtifactPanelStore((state) => state.reload);
  const toggleFullWidth = useArtifactPanelStore((state) => state.toggleFullWidth);
  const signedIn = useSignedIn();

  const artifactOrigin = useRuntimeConfig().data?.features.artifactOrigin ?? null;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [reminting, setReminting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useOverlay(current !== null, OVERLAY_PRIORITY.artifactPanel, close);

  useEffect(() => {
    if (!signedIn) close();
  }, [signedIn, close]);

  // Shift-Cmd-E, re-dispatched by the shell (07 §5).
  useEffect(() => {
    const onShortcut = (event: Event) => {
      const command = (event as CustomEvent<{ type?: string }>).detail;
      if (command?.type !== "toggleArtifactPanel" || !signedIn) return;
      useArtifactPanelStore.getState().toggle();
    };
    window.addEventListener("session:shortcut", onShortcut);
    return () => window.removeEventListener("session:shortcut", onShortcut);
  }, [signedIn]);

  const remint = useCallback(
    (documentId: string) => {
      if (!signedIn) return;
      setReminting(true);
      mintArtifactToken(documentId)
        .then(({ url, expiresAt }) => {
          const state = useArtifactPanelStore.getState();
          // The panel may have moved on to another document while the mint was
          // in flight; a stale answer must not replace it.
          if (state.current?.documentId !== documentId) return;
          state.remint(url, expiresAt);
          setError(null);
        })
        .catch(() => setError("This preview could not be reopened."))
        .finally(() => setReminting(false));
    },
    [signedIn],
  );

  // The bridge. Registered whenever the origin is known, not only while the
  // panel is open, so a message racing a close is still dropped by origin
  // rather than by luck.
  useEffect(() => {
    if (artifactOrigin === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== artifactOrigin) return;
      // Same origin is necessary but not sufficient: only the frame this panel
      // owns may drive it.
      if (frameRef.current && event.source !== frameRef.current.contentWindow) return;
      const message = parseArtifactMessage(event.data);
      if (!message) return;
      if (message.type === "session-preview-scroll") {
        useArtifactPanelStore.getState().recordScroll({ x: message.x, y: message.y });
        return;
      }
      const documentId = useArtifactPanelStore.getState().current?.documentId;
      if (documentId && isRemintableStatus(message.status) && !reminting) {
        remint(documentId);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifactOrigin, remint, reminting]);

  const onFrameLoad = useCallback(() => {
    if (artifactOrigin === null) return;
    const { scroll } = useArtifactPanelStore.getState();
    if (scroll.x === 0 && scroll.y === 0) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: "session-preview-scroll-restore", x: scroll.x, y: scroll.y },
      artifactOrigin,
    );
  }, [artifactOrigin]);

  const onResizePointerDown = useCallback(
    (axis: DragState["axis"]) => (event: ReactPointerEvent<HTMLElement>) => {
      const state = useArtifactPanelStore.getState();
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: state.width,
        startHeight: state.height,
        axis,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    [],
  );

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // The panel is anchored to the right edge, so dragging left grows it.
    const nextWidth = drag.startWidth + (drag.startX - event.clientX);
    const size: { width: number; height?: number } = { width: nextWidth };
    if (drag.axis === "both") size.height = drag.startHeight + (event.clientY - drag.startY);
    useArtifactPanelStore.getState().resize(size);
  }, []);

  const onResizePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  if (!current) return null;

  return (
    <aside
      data-testid="artifact-panel"
      aria-label={`Preview of ${current.name}`}
      className="border-border-divider bg-surface-panel shadow-dialog pointer-events-auto fixed right-4 bottom-4 z-(--z-dialog) flex flex-col overflow-hidden rounded-lg border"
      style={
        fullWidth
          ? { left: "1rem", top: "4rem" }
          : { width: `${width}px`, height: `${height}px`, maxWidth: "calc(100vw - 2rem)" }
      }
    >
      <div className="border-border-divider flex min-h-9 shrink-0 items-center gap-2 border-b px-2">
        <span className="text-fg-secondary min-w-0 flex-1 truncate text-xs" title={current.name}>
          {current.name}
        </span>
        <button
          type="button"
          className={`${ICON_BUTTON} h-6 px-1 text-xs`}
          aria-pressed={fullWidth}
          onClick={toggleFullWidth}
        >
          {fullWidth ? "Shrink" : "Full width"}
        </button>
        <button
          type="button"
          className={`${ICON_BUTTON} size-6`}
          aria-label="Reload"
          title="Reload"
          disabled={reminting}
          onClick={reload}
        >
          <RotateCw size={14} aria-hidden="true" />
        </button>
        <a
          className={`${ICON_BUTTON} size-6`}
          aria-label="Open in new tab"
          title="Open in new tab"
          href={current.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={14} aria-hidden="true" />
        </a>
        <button
          type="button"
          className={`${ICON_BUTTON} size-6`}
          aria-label="Close preview"
          title="Close preview"
          onClick={close}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {error ? (
        <p className="text-status-failed px-3 py-2 text-xs" role="alert">
          {error}
        </p>
      ) : null}

      <iframe
        key={reloadNonce}
        ref={frameRef}
        title={current.name}
        data-testid="artifact-frame"
        className="min-h-0 flex-1 border-0 bg-transparent"
        src={current.url}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        onLoad={onFrameLoad}
      />

      {/* The left edge and the bottom-left corner. `role="separator"` is what
          a pointer-driven splitter is; there is no keyboard resize on the
          desktop either, and the panel's size is not load-bearing. */}
      {fullWidth ? null : (
        <>
          <div
            role="separator"
            aria-label="Resize preview width"
            aria-orientation="vertical"
            data-testid="artifact-resize-edge"
            className="absolute top-0 bottom-3 left-0 w-1.5 cursor-ew-resize"
            onPointerDown={onResizePointerDown("width")}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
          />
          <div
            role="separator"
            aria-label="Resize preview"
            data-testid="artifact-resize-corner"
            className="absolute bottom-0 left-0 size-3 cursor-nesw-resize"
            onPointerDown={onResizePointerDown("both")}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
          />
        </>
      )}
    </aside>
  );
}
