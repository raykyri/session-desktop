import { useCallback, useEffect } from "react";
import type React from "react";
import {
  revealResearchColumns,
  scrollIntoColumn,
  settleResearchStrip,
  type ResearchColumnsContext,
} from "../components/research/ResearchColumns";
import type { ResearchPostThreadHandle } from "../components/research/ResearchPostThread";
import { isEditableTarget } from "../lib/appHelpers";
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
import { columnIdOf } from "../lib/researchColumnDom";
import { cycleIndex, researchCycleColumn, type ResearchCycleRequest } from "@session/shared/lib/researchSiblingCycle";
import { listenToResearchFollowupsFocus } from "../lib/researchShortcuts";
import type { ResearchNode } from "../types";
import type { ResearchFocusTarget, ResearchStripFollow } from "./useResearchFocusRequests";

const EMPTY_BRANCHES: ResearchNode[] = [];

type Ref<T> = { readonly current: T };

/** Keyboard navigation of the thread page's strip. Returns the strip's
 * keydown handler (↑/↓, Home/End, Enter, ←/→ and ⌥↑/⌥↓ across messages,
 * answers, notes and follow-ups) and installs the window-level keys (history
 * and Esc), mouse buttons 3/4, ⌘J and ⌃Tab. Every input is read when a key
 * arrives, through refs or stable callbacks. */
export function useResearchPairsKeyboard({
  columnsLayout,
  columnsLayoutRef,
  workspaceRef,
  stripRef,
  levelPathRef,
  branchesByParentRef,
  pendingRef,
  editorRef,
  currentLevelRef,
  threadHandlesRef,
  anyOverlayOpenRef,
  goBack,
  goForward,
  closeAfter,
  requestFocus,
  selectMessage,
  openBranch,
  goBranch,
  selectedRow,
  moveFocusedMessage,
}: {
  columnsLayout: React.ContextType<typeof ResearchColumnsContext>;
  columnsLayoutRef: Ref<React.ContextType<typeof ResearchColumnsContext>>;
  workspaceRef: Ref<HTMLDivElement | null>;
  stripRef: Ref<ReturnType<typeof researchStrip>>;
  /** The selected message of each open level, root level first. */
  levelPathRef: Ref<readonly string[]>;
  branchesByParentRef: Ref<ReadonlyMap<string, ResearchNode[]>>;
  pendingRef: Ref<{ parentNodeId: string } | null>;
  editorRef: Ref<{ kind: "document" | "post" } | null>;
  /** The level ⌘J focuses the ask box of. */
  currentLevelRef: Ref<number>;
  /** The follow-ups column of each note level, by level index. */
  threadHandlesRef: Ref<Map<number, ResearchPostThreadHandle>>;
  /** A menu, popover or dialog is open: Esc is theirs. */
  anyOverlayOpenRef: Ref<boolean>;
  goBack: () => void;
  goForward: () => void;
  closeAfter: (level: number) => void;
  requestFocus: (target: ResearchFocusTarget, strip?: ResearchStripFollow, onlyIfLost?: boolean) => void;
  selectMessage: (level: number, nodeId: string) => void;
  openBranch: (level: number, headId: string, end?: "first" | "last", selectParent?: boolean) => void;
  goBranch: (level: number, headId: string, end?: "first" | "last") => void;
  selectedRow: (level: number) => HTMLElement | null;
  moveFocusedMessage: (row: HTMLElement, level: number, step: -1 | 1) => void;
}) {
  // Keyboard: ⌘[ / ⌘] and Alt+←/→ (and mouse buttons 3/4) walk history; Esc
  // returns to the root level when no menu, popover, or dialog is
  // open. Keys are ignored while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        // An IME composition uses Escape to cancel itself.
        if (event.isComposing || event.keyCode === 229 || anyOverlayOpenRef.current) {
          return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (
          isEditableTarget(event.target) ||
          target?.closest("[role='menu'], [role='dialog'], [role='alertdialog'], .popover-surface")
        ) {
          return;
        }
        if (levelPathRef.current.length > 0 && document.querySelector(".research-columns")?.contains(target ?? document.body)) {
          event.preventDefault();
          // On a note, Esc also closes the open follow-up; focus returns to
          // its row in the follow-ups column.
          const levelsNow = stripRef.current.levels;
          if (levelsNow[0]?.kind === "post" && levelsNow.length > 1) {
            closeAfter(0);
          }
          requestFocus({ kind: "row", level: 0 }, "reveal");
        }
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      const primary = event.metaKey || event.ctrlKey;
      let handler: (() => void) | null = null;
      if (primary && !event.altKey && !event.shiftKey && event.code === "BracketLeft") {
        handler = goBack;
      } else if (primary && !event.altKey && !event.shiftKey && event.code === "BracketRight") {
        handler = goForward;
      } else if (event.altKey && !primary && !event.shiftKey && event.key === "ArrowLeft") {
        handler = goBack;
      } else if (event.altKey && !primary && !event.shiftKey && event.key === "ArrowRight") {
        handler = goForward;
      }
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        goBack();
      } else if (event.button === 4) {
        event.preventDefault();
        goForward();
      }
    };
    const mouseTarget = workspaceRef.current;
    window.addEventListener("keydown", onKeyDown);
    mouseTarget?.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      mouseTarget?.removeEventListener("mouseup", onMouseUp);
    };
  }, [closeAfter, goBack, goForward, requestFocus]);

  /** The branches of `level`'s selected answer, in the order the branches
   * column lists them. */
  const siblingsAt = useCallback((level: ResearchLevel | undefined) => {
    const parentId = level?.selectedId;
    return researchBranchesInPassageOrder(
      parentId ? branchesByParentRef.current.get(parentId) ?? EMPTY_BRANCHES : EMPTY_BRANCHES,
    );
  }, []);

  /** → from level `level`: an unsent branch's ask box; the selected row of
   * the branches column after it; with no selection there, the first branch
   * of the selected answer (which selects it); with no branches of the
   * selected message, the first row of the branches column, which selects
   * nothing; with no branches at all, the message keeps focus. */
  const rightFrom = useCallback(
    (level: number) => {
      const strip = stripRef.current;
      const levels = strip.levels;
      const siblings = siblingsAt(levels[level]);
      if (strip.pending?.levelIndex === level + 1) {
        requestFocus({ kind: "composer", key: `pending:${strip.pending.parentNodeId}` }, "settle");
        return;
      }
      if (levels[level + 1]) {
        requestFocus({ kind: "row", level: level + 1 }, "settle");
        return;
      }
      if (siblings.length === 0) {
        if (strip.columns.some((column) => column.role === "branches" && column.levelIndex === level + 1)) {
          requestFocus({ kind: "branches", level: level + 1 }, "settle");
          return;
        }
        // The last pair: the answer is already beside the message, so focus
        // stays on the message and ↑/↓ keep moving between messages.
        requestFocus({ kind: "row", level }, "settle");
        return;
      }
      goBranch(level, siblings[0].id);
    },
    [goBranch, requestFocus, siblingsAt],
  );

  /** Keys in the pairs: ↑/↓ move between messages (across the groups of a
   * branches column; at a note follow-up's first or last message, to the
   * previous or next follow-up), Enter opens a message's answer, → selects a
   * row in the branches column (or, in the last pair, selects the message and keeps focus
   * on it), ← goes to the parent message (or the feed). */
  const onPairsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    // ⌥↑ and ⌥↓ move a message up or down its column.
    if (
      target?.matches("[data-research-row]") &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey &&
      !event.defaultPrevented
    ) {
      const level = columnLevelIndex(columnIdOf(target));
      if (level !== null) {
        event.preventDefault();
        moveFocusedMessage(target, level, event.key === "ArrowUp" ? -1 : 1);
      }
      return;
    }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (!target) {
      return;
    }
    const key = event.key;
    // A note's follow-ups column: ↑/↓ move between its rows, Enter or → on a
    // follow-up opens it as the next level (focus goes to its message), ←
    // goes to the note.
    if (target.matches("[data-research-thread-row]")) {
      const column = target.closest<HTMLElement>(columnSelector());
      const level = columnLevelIndex(columnIdOf(column));
      if (level === null) {
        return;
      }
      const rows = [...(column?.querySelectorAll<HTMLElement>("[data-research-thread-row]") ?? [])];
      const index = rows.indexOf(target);
      const followUpId = target.dataset.nodeId ?? null;
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
        event.preventDefault();
        const nextIndex =
          key === "Home" ? 0 : key === "End" ? rows.length - 1 : index + (key === "ArrowDown" ? 1 : -1);
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
        const post = workspaceRef.current?.querySelector<HTMLElement>(columnSelector(`N${level}`)) ?? null;
        const scroller = post?.querySelector<HTMLElement>(":scope > .research-column-scroll");
        if (scroller) {
          scroller.focus({ preventScroll: true });
          revealResearchColumns(columnsLayoutRef.current?.row ?? null, post);
        } else if (
          editorRef.current?.kind === "post" &&
          stripRef.current.columns.some((candidate) => candidate.id === `E${level}`)
        ) {
          // This level's note is being edited: its editor is in the note
          // column's place.
          requestFocus({ kind: "editor" }, "reveal");
        }
      }
      return;
    }
    // A post's own column: → goes to its thread (the current row, or the
    // composer of an empty thread), ← to the feed.
    if (target.matches("[data-research-pair='post'] > .research-column-scroll")) {
      const level = columnLevelIndex(columnIdOf(target));
      if (level === null) {
        return;
      }
      if (key === "ArrowRight") {
        event.preventDefault();
        const headId = stripRef.current.levels[level]?.headId;
        requestFocus(
          selectedRow(level) || !headId ? { kind: "row", level } : { kind: "composer", key: headId },
          "reveal",
        );
      } else if (key === "ArrowLeft") {
        event.preventDefault();
        columnsLayoutRef.current?.focusFeed();
      }
      return;
    }
    if (target.matches("[data-research-row]")) {
      const nodeId = target.dataset.nodeId ?? "";
      const levels = stripRef.current.levels;
      const columnId = columnIdOf(target);
      const level = columnLevelIndex(columnId) ?? -1;
      const stripColumn = stripRef.current.columns.find((candidate) => candidate.id === columnId);
      if (!stripColumn || (stripColumn.role !== "messages" && stripColumn.role !== "branches")) {
        return;
      }
      const column = target.closest<HTMLElement>(columnSelector());
      // A branches column's rows are every group's, top to bottom.
      const rows = [...(column?.querySelectorAll<HTMLElement>("[data-research-row]") ?? [])];
      const index = rows.indexOf(target);
      // A note's follow-up: at its first or last message, ↑/↓ go to the
      // note's previous or next follow-up.
      if (
        stripColumn.role === "messages" &&
        (key === "ArrowDown" || key === "ArrowUp") &&
        level > 0 &&
        (key === "ArrowUp" ? index === 0 : index === rows.length - 1)
      ) {
        const siblings = siblingsAt(levels[level - 1]);
        const head = levels[level].headId;
        const at = siblings.findIndex((branch) => branch.id === head);
        const next = siblings[key === "ArrowUp" ? at - 1 : at + 1];
        event.preventDefault();
        if (at >= 0 && next) {
          goBranch(level - 1, next.id, key === "ArrowUp" ? "last" : "first");
        }
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
        event.preventDefault();
        const nextIndex =
          key === "Home" ? 0 : key === "End" ? rows.length - 1 : index + (key === "ArrowDown" ? 1 : -1);
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
        // An unselected message: it is selected, and focus moves to the
        // branches column's selection; with none there, selecting the
        // message and its first branch is one visit, in one render; with no
        // branches, only the selection.
        const branches = researchBranchesInPassageOrder(branchesByParentRef.current.get(nodeId) ?? EMPTY_BRANCHES);
        if (levels[level + 1]) {
          selectMessage(level, nodeId);
          requestFocus({ kind: "row", level: level + 1 }, "settle");
        } else if (branches.length > 0) {
          openBranch(level, branches[0].id, undefined, true);
          requestFocus({ kind: "row", level: level + 1 }, "settle");
        } else {
          // No branches: the message's pair is the last one. Its answer
          // shows beside it and focus stays on the message.
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
      if (key === "ArrowLeft") {
        event.preventDefault();
        if (level > 0) {
          requestFocus({ kind: "row", level: level - 1 }, "reveal");
        } else {
          columnsLayoutRef.current?.focusFeed();
        }
      }
      return;
    }
    if (target.matches("[data-research-pair='answer'] > .research-column-scroll")) {
      const level = columnLevelIndex(columnIdOf(target));
      if (level === null) {
        return;
      }
      if (key === "ArrowRight") {
        event.preventDefault();
        // A document's editor column sits right of the root's answer.
        if (level === 0 && editorRef.current) {
          requestFocus({ kind: "editor" }, "settle");
        } else {
          rightFrom(level);
        }
      } else if (key === "ArrowLeft") {
        event.preventDefault();
        requestFocus({ kind: "row", level }, "reveal");
      }
    }
  };

  // ⌘J routed from the app-level shortcut dispatcher: the ask box of the
  // current pair (the deepest level before anything is focused; the feed's
  // composer while the feed is current).
  useEffect(
    () =>
      listenToResearchFollowupsFocus(() => {
        if (columnsLayoutRef.current?.feedCurrent) {
          document.querySelector<HTMLElement>(".research-feed-composer textarea")?.focus();
          return;
        }
        const level = currentLevelRef.current;
        const pendingNow = pendingRef.current;
        const key =
          pendingNow && level >= levelPathRef.current.length
            ? `pending:${pendingNow.parentNodeId}`
            : stripRef.current.levels[level]?.headId;
        if (key) {
          requestFocus({ kind: "composer", key }, "reveal");
        }
      }),
    [requestFocus],
  );

  // ⌃Tab / ⌃⇧Tab, dispatched by ResearchColumns: the next or previous row of
  // the column last interacted with, wrapping. Rows are what ↑/↓ move
  // between: a messages column's messages (an answer column cycles its
  // level's messages), selected as a click selects them; a post's thread
  // column's rows, where a follow-up row also opens its follow-up. The cycle
  // starts from the focused row when focus is on one, else from the selected
  // message or the thread's current row. Focus moves to the new row unless
  // it is in a text field. A column without rows uses the nearest one to its
  // left. Returns false when the column to cycle is the feed, which then
  // handles the request.
  const cycleRows = useCallback(
    (request: ResearchCycleRequest): boolean => {
      const workspace = workspaceRef.current;
      if (!workspace) {
        return false;
      }
      const columnElement = (id: ResearchColumnId) => workspace.querySelector<HTMLElement>(columnSelector(id));
      const strip = stripRef.current;
      const candidates = strip.columns.flatMap((column) =>
        column.role === "messages" ||
        (column.role === "branches" && columnMessageIds(column).length > 0) ||
        (column.role === "thread" && columnElement(column.id)?.querySelector("[data-research-thread-row]"))
          ? [column.id]
          : [],
      );
      const targetId = researchCycleColumn(candidates, request.column);
      const column = strip.columns.find((candidate) => candidate.id === targetId);
      const element = targetId === "feed" ? null : columnElement(targetId);
      if (!column || !element || (column.role !== "messages" && column.role !== "thread" && column.role !== "branches")) {
        return false;
      }
      const level = column.role === "branches" ? column.levelIndex : column.level.index;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const stripRow = columnsLayoutRef.current?.row ?? null;
      if (column.role === "messages" || column.role === "branches") {
        // A branches column cycles through every group's messages, top to
        // bottom; selecting one opens its branch.
        const ids = columnMessageIds(column);
        const selectedId = column.role === "messages" ? column.level.selectedId : (column.level?.selectedId ?? "");
        const focusedId =
          active?.matches("[data-research-row]") && element.contains(active) ? active.dataset.nodeId : undefined;
        const nextId = ids[cycleIndex(ids.length, ids.indexOf(focusedId ?? selectedId), request.direction)];
        if (!nextId) {
          return true;
        }
        selectMessage(level, nextId);
        if (!request.keepFocus) {
          requestFocus({ kind: "row", level }, "reveal");
          return true;
        }
        window.requestAnimationFrame(() => {
          const current = columnElement(targetId);
          const row = current?.querySelector<HTMLElement>(`[data-research-row][data-node-id="${CSS.escape(nextId)}"]`);
          if (current && row) {
            scrollIntoColumn(row);
            revealResearchColumns(stripRow, current);
          }
        });
        return true;
      }
      const rows = [...element.querySelectorAll<HTMLElement>("[data-research-thread-row]")];
      const current =
        (active && rows.includes(active) ? active : null) ?? element.querySelector<HTMLElement>(COLUMN_ROW_SELECTOR);
      const next = rows[cycleIndex(rows.length, current ? rows.indexOf(current) : -1, request.direction)];
      if (!next) {
        return true;
      }
      const followUpId = next.dataset.nodeId;
      if (followUpId) {
        openBranch(level, followUpId);
      }
      if (request.keepFocus) {
        threadHandlesRef.current.get(level)?.makeCurrent(next);
      } else {
        next.focus({ preventScroll: true });
      }
      scrollIntoColumn(next);
      if (followUpId) {
        window.requestAnimationFrame(() => settleResearchStrip(columnsLayoutRef.current?.row ?? null, targetId));
      } else {
        revealResearchColumns(stripRow, element);
      }
      return true;
    },
    [openBranch, requestFocus, selectMessage],
  );
  useEffect(() => columnsLayout?.registerCycle("thread", cycleRows), [columnsLayout, cycleRows]);

  return onPairsKeyDown;
}
