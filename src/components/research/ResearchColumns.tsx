import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";

const WIDTH_KEY = "session.research-feed-width.v1";
const DEFAULT_WIDTH = 384;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const CONTENT_MIN_WIDTH = 480;
// Keep aligned with the single-column container query in research-surface.css.
const SINGLE_COLUMN_WIDTH = 880;

export function maxResearchFeedWidth(availableWidth: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, availableWidth - CONTENT_MIN_WIDTH));
}

export function clampResearchFeedWidth(width: number, availableWidth: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(
    Number.isFinite(width) ? width : DEFAULT_WIDTH,
    maxResearchFeedWidth(availableWidth),
  )));
}

function loadWidth(): number {
  try {
    const stored = localStorage.getItem(WIDTH_KEY);
    return stored === null ? DEFAULT_WIDTH : clampResearchFeedWidth(Number(stored), Infinity);
  } catch {
    return DEFAULT_WIDTH;
  }
}

export default function ResearchColumns({
  hasDocument,
  children,
}: {
  hasDocument: boolean;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<() => void>(() => {});
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(loadWidth);
  const [availableWidth, setAvailableWidth] = useState(SINGLE_COLUMN_WIDTH);
  const [dragging, setDragging] = useState(false);
  const width = clampResearchFeedWidth(preferredWidth, availableWidth);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      setAvailableWidth(root.clientWidth);
      if (root.clientWidth <= SINGLE_COLUMN_WIDTH) stopRef.current();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(preferredWidth));
    } catch {
      // Resizing still works when preference storage is unavailable.
    }
  }, [preferredWidth]);

  useEffect(() => {
    const stop = () => stopRef.current();
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("blur", stop);
      stop();
    };
  }, []);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || dragRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    dragRef.current = { pointerId, x: event.clientX, width };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setDragging(true);
    stopRef.current = () => {
      stopRef.current = () => {};
      dragRef.current = null;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setDragging(false);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
  }

  return (
    <div
      ref={rootRef}
      className={`research-columns${hasDocument ? " has-document" : ""}`}
      style={{ "--research-feed-column-width": `${width}px` } as CSSProperties}
    >
      {children}
      <div
        className={`research-column-resizer${dragging ? " is-dragging" : ""}`}
        role="separator"
        aria-label="Resize feed column"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxResearchFeedWidth(availableWidth)}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setPreferredWidth(clampResearchFeedWidth(
            drag.width + event.clientX - drag.x,
            rootRef.current?.clientWidth ?? availableWidth,
          ));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) stopRef.current();
        }}
        onPointerCancel={() => stopRef.current()}
        onLostPointerCapture={() => stopRef.current()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          const step = event.shiftKey ? 40 : 16;
          setPreferredWidth(clampResearchFeedWidth(
            width + (event.key === "ArrowRight" ? step : -step), availableWidth,
          ));
        }}
      />
    </div>
  );
}
