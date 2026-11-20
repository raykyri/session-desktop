// Keyboard navigation of a thread's strip (`09-research-document-view.md`
// §4), ported from the desktop `useResearchPairsKeyboard`. Returns the
// strip's keydown handler: ↑/↓, Home/End, Enter, ←/→ across messages,
// answers, notes and follow-ups, and ⌥↑/⌥↓ to move a message within its
// column. Installs Esc (focus to the root level's selected row), ⌘J (the
// current level's ask box, re-dispatched by the app shell) and the ⌃Tab
// handler the strip dispatches.
//
// Back and Forward are the browser's on the web: ⌘[ / ⌘], ⌥← / ⌥→ and the
// mouse buttons all reach browser history, which holds the selection.

import type { ResearchNode } from "@session/shared";
import { researchBranchesInPassageOrder } from "@session/shared/lib/researchBranchView";
import {
  COLUMN_ROW_SELECTOR,
  columnLevelIndex,
  columnMessageIds,
  columnSelector,
  type ResearchColumnId,
  type ResearchLevel,
  type researchStrip,
} from "@session/shared/lib/researchColumns";
import {
  cycleIndex,
  researchCycleColumn,
  type ResearchCycleRequest,
} from "@session/shared/lib/researchSiblingCycle";
import { useCallback, useContext, useEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { ColumnsLayoutContext } from "./Columns.js";
import type { PostThreadHandle } from "./PostThread.js";
import {
  columnIdOf,
  columnScroller,
  revealColumns,
  rowSelector,
  scrollIntoColumn,
  settleStrip,
} from "./stripDom.js";
import { isEditableEventTarget } from "./textRanges.js";
import type { RequestFocus } from "./useFocusRequests.js";

const NO_BRANCHES: ResearchNode[] = [];

type Ref<T> = { readonly current: T };

export function useThreadKeyboard({
  workspaceRef,
  stripRef,
  levelPathRef,
  branchesByParentRef,
  editorRef,
  threadHandlesRef,
  anyOverlayOpenRef,
  pendingRef,
  closeAfter,
  requestFocus,
  selectMessage,
  openBranch,
  goBranch,
  moveFocusedMessage,
}: {
  workspaceRef: Ref<HTMLElement | null>;
  stripRef: Ref<ReturnType<typeof researchStrip>>;
  levelPathRef: Ref<readonly string[]>;
  branchesByParentRef: Ref<ReadonlyMap<string, ResearchNode[]>>;
  editorRef: Ref<{ kind: "document" | "post" } | null>;
  threadHandlesRef: Ref<Map<number, PostThreadHandle>>;
  /** A menu, popover or dialog of the page is open: Esc belongs to that overlay. */
  anyOverlayOpenRef: Ref<boolean>;
  /** The unsent branch, whose ask box follows the deepest level. */
  pendingRef: Ref<{ parentNodeId: string } | null>;
  closeAfter: (level: number) => void;
  requestFocus: RequestFocus;
  selectMessage: (level: number, nodeId: string) => void;
  openBranch: (
    level: number,
    headId: string,
    end?: "first" | "last",
    selectParent?: boolean,
  ) => void;
  goBranch: (level: number, headId: string, end?: "first" | "last") => void;
  moveFocusedMessage: (row: HTMLElement, level: number, step: -1 | 1) => void;
}) {
  const layout = useContext(ColumnsLayoutContext);
  const rowRef = useCallback(() => layout?.row ?? null, [layout]);

  // Esc returns focus to the root level when nothing else claims it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.isComposing || anyOverlayOpenRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        isEditableEventTarget(event.target) ||
        target?.closest("[role='menu'], [role='dialog'], [role='alertdialog'], [role='toolbar']")
      ) {
        return;
      }
      if (levelPathRef.current.length === 0) return;
      if (!workspaceRef.current?.contains(target ?? document.body) && target !== document.body) {
        return;
      }
      event.preventDefault();
      // On a note, Esc also closes the open follow-up.
      const levels = stripRef.current.levels;
      if (levels[0]?.kind === "post" && levels.length > 1) closeAfter(0);
      requestFocus({ kind: "row", level: 0 }, "reveal");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anyOverlayOpenRef, closeAfter, levelPathRef, requestFocus, stripRef, workspaceRef]);

  // ⌘J, re-dispatched by the app shell (07 §5): the ask box of the level that
  // holds focus, else of the deepest level (the unsent branch's when there
  // is one).
  useEffect(() => {
    const onShortcut = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string }>).detail;
      if (detail?.type !== "focusFollowups") return;
      const path = levelPathRef.current;
      const pendingNow = pendingRef.current;
      const focused = columnLevelIndex(
        columnIdOf(document.activeElement instanceof Element ? document.activeElement : null),
      );
      const level = focused ?? (pendingNow ? path.length : stripRef.current.levels.length - 1);
      const key =
        pendingNow && level >= path.length
          ? `pending:${pendingNow.parentNodeId}`
          : stripRef.current.levels[level]?.headId;
      if (key) requestFocus({ kind: "composer", key }, "reveal");
    };
    window.addEventListener("session:shortcut", onShortcut);
    return () => window.removeEventListener("session:shortcut", onShortcut);
  }, [levelPathRef, pendingRef, requestFocus, stripRef]);

  /** The branches of `level`'s selected answer in branches-column order. */
  const siblingsAt = useCallback(
    (level: ResearchLevel | undefined) => {
      const parentId = level?.selectedId;
      return researchBranchesInPassageOrder(
        parentId ? (branchesByParentRef.current.get(parentId) ?? NO_BRANCHES) : NO_BRANCHES,
      );
    },
    [branchesByParentRef],
  );

  /** → from level `level`: the unsent branch's ask box; the selected row of
   * the branches column after it; else the first branch of the selected
   * answer; else the branches column's first row; else the message keeps
   * focus. */
  const rightFrom = useCallback(
    (level: number) => {
      const strip = stripRef.current;
      const levels = strip.levels;
      if (strip.pending?.levelIndex === level + 1) {
        requestFocus({ kind: "composer", key: `pending:${strip.pending.parentNodeId}` }, "settle");
        return;
      }
      if (levels[level + 1]) {
        requestFocus({ kind: "row", level: level + 1 }, "settle");
        return;
      }
      const siblings = siblingsAt(levels[level]);
      const first = siblings[0];
      if (!first) {
        if (
          strip.columns.some(
            (column) => column.role === "branches" && column.levelIndex === level + 1,
          )
        ) {
          requestFocus({ kind: "branches", level: level + 1 }, "settle");
          return;
        }
        requestFocus({ kind: "row", level }, "settle");
        return;
      }
      goBranch(level, first.id);
    },
    [goBranch, requestFocus, siblingsAt, stripRef],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      target?.matches("[data-research-row]") &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.defaultPrevented
    ) {
      const level = columnLevelIndex(columnIdOf(target));
      if (level !== null) {
        event.preventDefault();
        moveFocusedMessage(target, level, event.key === "ArrowUp" ? -1 : 1);
      }
      return;
    }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !target) return;
    const key = event.key;

    // A note's follow-ups column.
    if (target.matches("[data-research-thread-row]")) {
      const column = target.closest<HTMLElement>(columnSelector());
      const level = columnLevelIndex(columnIdOf(column));
      if (level === null) return;
      const rows = [...(column?.querySelectorAll<HTMLElement>("[data-research-thread-row]") ?? [])];
      const index = rows.indexOf(target);
      const followUpId = target.dataset["nodeId"] ?? null;
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
        event.preventDefault();
        const nextIndex =
          key === "Home"
            ? 0
            : key === "End"
              ? rows.length - 1
              : index + (key === "ArrowDown" ? 1 : -1);
        const next = rows[Math.max(0, Math.min(rows.length - 1, nextIndex))];
        if (next) {
          next.focus({ preventScroll: true });
          scrollIntoColumn(next);
        }
        return;
      }
      if (followUpId && (key === "Enter" || key === " " || key === "ArrowRight")) {
        event.preventDefault();
        goBranch(level, followUpId);
        return;
      }
      if (key === "ArrowLeft") {
        event.preventDefault();
        const post = workspaceRef.current?.querySelector<HTMLElement>(columnSelector(`N${level}`));
        const scroller = columnScroller(post);
        if (scroller) {
          scroller.focus({ preventScroll: true });
          revealColumns(rowRef(), post ?? null);
        } else if (editorRef.current?.kind === "post") {
          requestFocus({ kind: "editor" }, "reveal");
        }
      }
      return;
    }

    // A note's own column: → goes to its follow-ups.
    if (target.matches("[data-research-pair='post'] > [data-research-scroll]")) {
      const level = columnLevelIndex(columnIdOf(target));
      if (level === null || key !== "ArrowRight") return;
      event.preventDefault();
      const headId = stripRef.current.levels[level]?.headId;
      const rowShown = workspaceRef.current
        ?.querySelector(columnSelector(`T${level}`))
        ?.querySelector(COLUMN_ROW_SELECTOR);
      requestFocus(
        rowShown || !headId ? { kind: "row", level } : { kind: "composer", key: headId },
        "reveal",
      );
      return;
    }

    if (target.matches("[data-research-row]")) {
      const nodeId = target.dataset["nodeId"] ?? "";
      const levels = stripRef.current.levels;
      const columnId = columnIdOf(target);
      const level = columnLevelIndex(columnId) ?? -1;
      const stripColumn = stripRef.current.columns.find((candidate) => candidate.id === columnId);
      if (!stripColumn || (stripColumn.role !== "messages" && stripColumn.role !== "branches"))
        return;
      const column = target.closest<HTMLElement>(columnSelector());
      const rows = [...(column?.querySelectorAll<HTMLElement>("[data-research-row]") ?? [])];
      const index = rows.indexOf(target);
      // At a note follow-up's first or last message, ↑/↓ go to the note's
      // previous or next follow-up.
      if (
        stripColumn.role === "messages" &&
        (key === "ArrowDown" || key === "ArrowUp") &&
        level > 0 &&
        (key === "ArrowUp" ? index === 0 : index === rows.length - 1)
      ) {
        const siblings = siblingsAt(levels[level - 1]);
        const head = levels[level]?.headId;
        const at = siblings.findIndex((branch) => branch.id === head);
        const next = siblings[key === "ArrowUp" ? at - 1 : at + 1];
        event.preventDefault();
        if (at >= 0 && next) goBranch(level - 1, next.id, key === "ArrowUp" ? "last" : "first");
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
        event.preventDefault();
        const nextIndex =
          key === "Home"
            ? 0
            : key === "End"
              ? rows.length - 1
              : index + (key === "ArrowDown" ? 1 : -1);
        const next = rows[Math.max(0, Math.min(rows.length - 1, nextIndex))];
        if (next) {
          for (const row of rows) row.tabIndex = row === next ? 0 : -1;
          next.focus({ preventScroll: true });
          scrollIntoColumn(next);
        }
        return;
      }
      if (key === "ArrowRight") {
        event.preventDefault();
        if (levelPathRef.current[level] === nodeId) {
          rightFrom(level);
          return;
        }
        const branches = researchBranchesInPassageOrder(
          branchesByParentRef.current.get(nodeId) ?? NO_BRANCHES,
        );
        const first = branches[0];
        if (levels[level + 1]) {
          selectMessage(level, nodeId);
          requestFocus({ kind: "row", level: level + 1 }, "settle");
        } else if (first) {
          openBranch(level, first.id, undefined, true);
          requestFocus({ kind: "row", level: level + 1 }, "settle");
        } else {
          selectMessage(level, nodeId);
          requestFocus({ kind: "row", level }, "settle");
        }
        return;
      }
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        selectMessage(level, nodeId);
        requestFocus({ kind: "answer", level }, "reveal");
        return;
      }
      if (key === "ArrowLeft" && level > 0) {
        event.preventDefault();
        requestFocus({ kind: "row", level: level - 1 }, "reveal");
      }
      return;
    }

    if (target.matches("[data-research-pair='answer'] > [data-research-scroll]")) {
      const level = columnLevelIndex(columnIdOf(target));
      if (level === null) return;
      if (key === "ArrowRight") {
        event.preventDefault();
        if (level === 0 && editorRef.current) requestFocus({ kind: "editor" }, "settle");
        else rightFrom(level);
      } else if (key === "ArrowLeft") {
        event.preventDefault();
        requestFocus({ kind: "row", level }, "reveal");
      }
    }
  };

  // ⌃Tab / ⌃⇧Tab: the next or previous row of the column last interacted
  // with, wrapping; a column without rows uses the nearest one to its left.
  // Focus moves to the row unless it is in a text field.
  const cycleRows = useCallback(
    (request: ResearchCycleRequest): boolean => {
      const workspace = workspaceRef.current;
      if (!workspace) return false;
      const element = (id: ResearchColumnId) =>
        workspace.querySelector<HTMLElement>(columnSelector(id));
      const strip = stripRef.current;
      const candidates = strip.columns.flatMap((column) =>
        column.role === "messages" ||
        (column.role === "branches" && columnMessageIds(column).length > 0) ||
        (column.role === "thread" &&
          element(column.id)?.querySelector("[data-research-thread-row]"))
          ? [column.id]
          : [],
      );
      const targetId = researchCycleColumn(candidates, request.column);
      const column = strip.columns.find((candidate) => candidate.id === targetId);
      const columnElement = targetId === "feed" ? null : element(targetId);
      if (
        !column ||
        !columnElement ||
        (column.role !== "messages" && column.role !== "thread" && column.role !== "branches")
      ) {
        return false;
      }
      const level = column.role === "branches" ? column.levelIndex : column.level.index;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (column.role === "messages" || column.role === "branches") {
        const ids = columnMessageIds(column);
        const selectedId =
          column.role === "messages" ? column.level.selectedId : (column.level?.selectedId ?? "");
        const focusedId =
          active?.matches("[data-research-row]") && columnElement.contains(active)
            ? active.dataset["nodeId"]
            : undefined;
        const nextId =
          ids[cycleIndex(ids.length, ids.indexOf(focusedId ?? selectedId), request.direction)];
        if (!nextId) return true;
        selectMessage(level, nextId);
        if (!request.keepFocus) {
          requestFocus({ kind: "row", level }, "reveal");
          return true;
        }
        requestAnimationFrame(() => {
          const current = element(targetId);
          const row = current?.querySelector<HTMLElement>(rowSelector(nextId));
          if (current && row) {
            scrollIntoColumn(row);
            revealColumns(rowRef(), current);
          }
        });
        return true;
      }
      const rows = [...columnElement.querySelectorAll<HTMLElement>("[data-research-thread-row]")];
      const current =
        (active && rows.includes(active) ? active : null) ??
        columnElement.querySelector<HTMLElement>(COLUMN_ROW_SELECTOR);
      const next =
        rows[cycleIndex(rows.length, current ? rows.indexOf(current) : -1, request.direction)];
      if (!next) return true;
      const followUpId = next.dataset["nodeId"];
      if (followUpId) openBranch(level, followUpId);
      if (request.keepFocus) threadHandlesRef.current.get(level)?.makeCurrent(next);
      else next.focus({ preventScroll: true });
      scrollIntoColumn(next);
      if (followUpId) requestAnimationFrame(() => settleStrip(rowRef(), targetId));
      else revealColumns(rowRef(), columnElement);
      return true;
    },
    [openBranch, requestFocus, rowRef, selectMessage, stripRef, threadHandlesRef, workspaceRef],
  );
  useEffect(() => layout?.registerCycle(cycleRows), [cycleRows, layout]);

  return onKeyDown;
}
