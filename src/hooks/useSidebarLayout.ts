import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  clampSidebarWidth,
  maxSidebarWidth,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
} from "../lib/sidebarLayout";
import { RESEARCH_SIDEBAR_AUTO_RAIL_WIDTH } from "../lib/sidebarMode";

function claimResizePointer(event: ReactPointerEvent<HTMLDivElement>): () => void {
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  handle.setPointerCapture(pointerId);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
  };
}

/**
 * The left sidebar's layout: collapsed to the icon rail or expanded, and its
 * width while expanded, resized by pointer or arrow keys within bounds that
 * depend on the width of `appRef`.
 */
export function useSidebarLayout(appRef: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(SIDEBAR_MIN_WIDTH);
  const widthRef = useRef(width);
  widthRef.current = width;
  // The sidebar starts as the icon rail; the expand button, ⌘⇧G and the
  // command palette expand it for the session.
  const [collapsed, setCollapsed] = useState(true);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  // Below 900px of window width the sidebar shows as the icon rail without
  // changing the saved preference; collapsing also shows the rail.
  const [windowNarrow, setWindowNarrow] = useState(
    () => window.innerWidth < RESEARCH_SIDEBAR_AUTO_RAIL_WIDTH,
  );
  useEffect(() => {
    const onResize = () => setWindowNarrow(window.innerWidth < RESEARCH_SIDEBAR_AUTO_RAIL_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const rail = collapsed || windowNarrow;

  const appWidth = useCallback(
    () => appRef.current?.getBoundingClientRect().width ?? window.innerWidth,
    [appRef],
  );
  // Keep the sidebar within bounds as the window resizes.
  useEffect(() => {
    const handleResize = () => {
      setWidth((current) => clampSidebarWidth(current, appWidth()));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [appWidth]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const releasePointer = claimResizePointer(event);
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWidth = startWidth + moveEvent.clientX - startX;
        setWidth(clampSidebarWidth(nextWidth, appWidth()));
      };
      const stopResize = () => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        releasePointer();
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [appWidth],
  );

  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }

      event.preventDefault();
      const step = event.shiftKey ? 40 : 16;
      const delta = event.key === "ArrowRight" ? step : -step;
      setWidth((current) => clampSidebarWidth(current + delta, appWidth()));
    },
    [appWidth],
  );

  const collapse = useCallback(() => setCollapsed(true), []);
  const expand = useCallback(() => setCollapsed(false), []);
  const toggle = useCallback(() => setCollapsed(!collapsedRef.current), []);

  return {
    width,
    rail,
    /** The rail is shown because the window is narrow. */
    forcedRail: windowNarrow,
    effectiveWidth: rail ? SIDEBAR_RAIL_WIDTH : width,
    /** The current maximum width, measured from the app element. */
    maxWidth: () => maxSidebarWidth(appWidth()),
    startResize,
    resizeWithKeyboard,
    collapse,
    expand,
    toggle,
  };
}
