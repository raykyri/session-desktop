// Focus requests in a thread's strip, ported from the desktop
// `useResearchFocusRequests`. A request names what should take focus (a
// column's selected row, an answer, a composer, the editor, ...) and how the
// strip follows it; it is honoured on the next frame, or after the next commit
// that renders its target, within FOCUS_REQUEST_TTL_MS.

import { columnLevelIndex, columnSelector } from "@session/shared/lib/researchColumns";
import { useCallback, useLayoutEffect, useRef } from "react";

import {
  columnIdOf,
  columnScroller,
  cssEscape,
  revealColumns,
  scrollIntoColumn,
  settleStrip,
  stripScrollBehavior,
} from "./stripDom.js";

const FOCUS_REQUEST_TTL_MS = 2_000;

export type FocusTarget =
  | { kind: "row"; level: number }
  | { kind: "answer"; level: number }
  /** The branches column T{level}: its selected row, else its first row. */
  | { kind: "branches"; level: number }
  | { kind: "marker"; level: number; key: string }
  | { kind: "composer"; key: string }
  | { kind: "editor" }
  /** A note's column N{level}: its … button with `menu`, else its body. */
  | { kind: "note"; level: number; menu: boolean };

/** `reveal`: show the level's pair by the least scroll; `settle`: show the
 * strip's last column with the target's column in view. */
export type StripFollow = "reveal" | "settle" | "none";

interface FocusRequest {
  target: FocusTarget;
  strip: StripFollow;
  onlyIfLost: boolean;
  at: number;
}

export type RequestFocus = (target: FocusTarget, strip?: StripFollow, onlyIfLost?: boolean) => void;

export function useFocusRequests({
  rowRef,
  workspaceRef,
  composerField,
  editorField,
}: {
  /** The strip. */
  rowRef: { readonly current: HTMLElement | null };
  workspaceRef: { readonly current: HTMLElement | null };
  /** The field of the composer registered under `key`. Stable. */
  composerField: (key: string) => HTMLElement | null;
  /** The editor column's field while it is connected. Stable. */
  editorField: () => HTMLElement | null;
}): RequestFocus {
  const requestRef = useRef<FocusRequest | null>(null);

  const column = useCallback(
    (id: string) =>
      workspaceRef.current?.querySelector<HTMLElement>(columnSelector(id as never)) ?? null,
    [workspaceRef],
  );

  const resolve = useCallback(
    (target: FocusTarget): HTMLElement | null => {
      switch (target.kind) {
        case "row":
          return (
            column(`T${target.level}`)?.querySelector<HTMLElement>(
              ".research-msg-row.is-selected .research-msg-hit, [data-research-thread-row][tabindex='0']",
            ) ?? null
          );
        case "branches": {
          const element = column(`T${target.level}`);
          return (
            element?.querySelector<HTMLElement>(
              ".research-msg-row.is-selected .research-msg-hit",
            ) ??
            element?.querySelector<HTMLElement>("[data-research-row][tabindex='0']") ??
            element?.querySelector<HTMLElement>("[data-research-row]") ??
            null
          );
        }
        case "answer":
          return columnScroller(column(`A${target.level}`));
        case "marker":
          return (
            column(`A${target.level}`)?.querySelector<HTMLElement>(
              `[data-research-marker="${cssEscape(target.key)}"]`,
            ) ?? null
          );
        case "composer":
          return composerField(target.key);
        case "editor":
          return editorField();
        case "note": {
          const element = column(`N${target.level}`);
          return (
            (target.menu
              ? element?.querySelector<HTMLElement>("[data-research-head-menu]")
              : null) ?? columnScroller(element)
          );
        }
      }
    },
    [column, composerField, editorField],
  );

  const process = useCallback(() => {
    const request = requestRef.current;
    if (!request) return;
    const active = document.activeElement;
    if (
      Date.now() - request.at > FOCUS_REQUEST_TTL_MS ||
      (request.onlyIfLost && active && active !== document.body && active.isConnected)
    ) {
      requestRef.current = null;
      return;
    }
    const element = resolve(request.target);
    if (!element) return;
    requestRef.current = null;
    element.focus({ preventScroll: true });
    if (
      request.target.kind !== "answer" &&
      request.target.kind !== "editor" &&
      request.target.kind !== "note"
    ) {
      // A row of a branches column brings its whole group into view (its
      // source first) when the group fits.
      const group =
        request.target.kind === "row"
          ? element.closest<HTMLElement>("[data-research-branch-group]")
          : null;
      const scroller = group?.closest<HTMLElement>("[data-research-scroll]");
      const fits = Boolean(group && scroller && group.offsetHeight <= scroller.clientHeight);
      scrollIntoColumn(
        fits && group ? group : element,
        request.target.kind === "composer" ? stripScrollBehavior() : "auto",
      );
    }
    const strip = rowRef.current;
    const columnId = columnIdOf(element);
    if (request.strip === "settle") {
      settleStrip(strip, columnId);
    } else if (request.strip === "reveal" && columnId) {
      const own = column(columnId);
      const level = columnLevelIndex(columnId);
      revealColumns(
        strip,
        level === null ? own : (column(`T${level}`) ?? column(`N${level}`) ?? own),
        level === null ? own : (column(`A${level}`) ?? own),
      );
    }
  }, [column, resolve, rowRef]);

  const requestFocus = useCallback<RequestFocus>(
    (target, strip = "reveal", onlyIfLost = false) => {
      requestRef.current = { target, strip, onlyIfLost, at: Date.now() };
      requestAnimationFrame(process);
    },
    [process],
  );

  useLayoutEffect(() => {
    process();
  });

  return requestFocus;
}
