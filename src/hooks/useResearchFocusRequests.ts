import { useCallback, useLayoutEffect, useRef } from "react";
import {
  researchScrollBehavior,
  revealResearchColumns,
  scrollIntoColumn,
  settleResearchStrip,
} from "../components/research/ResearchColumns";
import { columnIdOf, columnLevelIndex, columnSelector } from "../lib/researchColumns";

/** How long a focus request waits for its element to render. */
const FOCUS_REQUEST_TTL_MS = 2_000;

/** What a focus request puts focus on in the thread page's strip. */
export type ResearchFocusTarget =
  | { kind: "row"; level: number }
  | { kind: "answer"; level: number }
  | { kind: "marker"; level: number; key: string }
  | { kind: "composer"; key: string }
  | { kind: "editor" }
  /** A note's column (N{level}): its … button with `menu`, else its scroll
   * area. */
  | { kind: "note"; level: number; menu: boolean };

/** How the strip follows a focus request: `reveal` shows the level's pair by
 * the least scroll, `settle` shows the strip's last column with the target's
 * column in view. */
export type ResearchStripFollow = "reveal" | "settle" | "none";

/** Where focus goes once the next render has committed, and how the strip
 * follows it. */
interface FocusRequest {
  target: ResearchFocusTarget;
  strip: ResearchStripFollow;
  /** Only when focus was lost (it sat in a column that went away). */
  onlyIfLost: boolean;
  at: number;
}

type ColumnsLayoutRef = {
  readonly current: { row: HTMLElement | null } | null;
};

/** Focus requests in the thread page's strip. `requestFocus` records the
 * target; it is focused on the next animation frame, or after the next
 * commit that renders it, within FOCUS_REQUEST_TTL_MS. Every commit also
 * puts the strip back at its horizontal position as of the render: a
 * re-render never moves it, only an explicit reveal or settle does. */
export function useResearchFocusRequests({
  row,
  columnsLayoutRef,
  workspaceRef,
  pairColumn,
  selectedRow,
  composerField,
  editorField,
}: {
  /** The strip as of this render. */
  row: HTMLElement | null;
  columnsLayoutRef: ColumnsLayoutRef;
  workspaceRef: { readonly current: HTMLElement | null };
  pairColumn: (kind: "messages" | "answer", level: number) => HTMLElement | null;
  selectedRow: (level: number) => HTMLElement | null;
  /** The ask box of the composer registered under `key`. Stable. */
  composerField: (key: string) => HTMLElement | null;
  /** The editor column's field while it is connected. Stable. */
  editorField: () => HTMLElement | null;
}) {
  const focusRequestRef = useRef<FocusRequest | null>(null);
  // The strip's horizontal position as of the last render.
  const stripLeftRef = useRef<number | null>(null);
  stripLeftRef.current = row?.scrollLeft ?? null;

  const resolveFocusTarget = useCallback(
    (target: ResearchFocusTarget): HTMLElement | null => {
      switch (target.kind) {
        case "row":
          return selectedRow(target.level);
        case "answer":
          return (
            pairColumn("answer", target.level)?.querySelector<HTMLElement>(":scope > .research-column-scroll") ??
            null
          );
        case "marker":
          return (
            pairColumn("answer", target.level)?.querySelector<HTMLElement>(
              `[data-research-marker="${CSS.escape(target.key)}"]`,
            ) ?? null
          );
        case "composer":
          return composerField(target.key);
        case "editor":
          return editorField();
        case "note": {
          const column =
            workspaceRef.current?.querySelector<HTMLElement>(columnSelector(`N${target.level}`)) ?? null;
          return (
            (target.menu ? column?.querySelector<HTMLElement>(".research-head-menu") : null) ??
            column?.querySelector<HTMLElement>(":scope > .research-column-scroll") ??
            null
          );
        }
      }
    },
    [composerField, editorField, pairColumn, selectedRow, workspaceRef],
  );

  const processFocusRequest = useCallback(() => {
    const request = focusRequestRef.current;
    if (!request) {
      return;
    }
    const active = document.activeElement;
    if (
      Date.now() - request.at > FOCUS_REQUEST_TTL_MS ||
      (request.onlyIfLost && active && active !== document.body && active.isConnected)
    ) {
      focusRequestRef.current = null;
      return;
    }
    const element = resolveFocusTarget(request.target);
    if (!element) {
      return;
    }
    focusRequestRef.current = null;
    element.focus({ preventScroll: true });
    if (request.target.kind !== "answer" && request.target.kind !== "editor" && request.target.kind !== "note") {
      scrollIntoColumn(element, request.target.kind === "composer" ? researchScrollBehavior() : "auto");
    }
    const strip = columnsLayoutRef.current?.row ?? null;
    const columnId = columnIdOf(element);
    if (request.strip === "settle") {
      settleResearchStrip(strip, columnId);
    } else if (request.strip === "reveal" && columnId) {
      const column = strip?.querySelector<HTMLElement>(columnSelector(columnId)) ?? null;
      const level = columnLevelIndex(columnId);
      revealResearchColumns(
        strip,
        level === null ? column : pairColumn("messages", level) ?? column,
        level === null ? column : pairColumn("answer", level) ?? column,
      );
    }
  }, [columnsLayoutRef, pairColumn, resolveFocusTarget]);

  const requestFocus = useCallback(
    (target: ResearchFocusTarget, strip: ResearchStripFollow = "reveal", onlyIfLost = false) => {
      focusRequestRef.current = { target, strip, onlyIfLost, at: Date.now() };
      window.requestAnimationFrame(processFocusRequest);
    },
    [processFocusRequest],
  );

  useLayoutEffect(() => {
    const strip = columnsLayoutRef.current?.row;
    const left = stripLeftRef.current;
    if (strip && left !== null && Math.abs(strip.scrollLeft - left) > 1) {
      strip.scrollLeft = left;
    }
    processFocusRequest();
  });

  return requestFocus;
}
