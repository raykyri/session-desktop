import { useCallback, useLayoutEffect, useRef, type UIEvent } from "react";
import { scrollIntoColumn } from "../components/research/ResearchColumns";
import {
  COLUMN_ROW_SELECTOR,
  columnScrollKey,
  columnSelector,
  type ResearchColumn,
  type ResearchScrollKind,
} from "@session/shared/lib/researchColumns";
import { restoreResearchScrollPosition } from "../lib/researchNavigation";
import type { createResearchThreadPersistence } from "../lib/researchThreadPersistence";
import type { ResearchNodeContent } from "../types";

export type ResearchThreadPersistence = ReturnType<typeof createResearchThreadPersistence>;

/** A messages or branches column's scroll kind and key, as one string. */
type ListScrollKind = Exclude<ResearchScrollKind, "answer">;
const listScrollId = (kind: ListScrollKind, key: string) => `${kind}\n${key}`;
const parseListScrollId = (id: string) => {
  const [kind, key] = id.split("\n") as [ListScrollKind, string];
  return { kind, key };
};

/** The scroll offsets of the thread page's answer, messages and branches
 * columns: restored as each column mounts (from this visit, else the
 * persisted store), recorded as it scrolls, and written to `persistence` by
 * `captureScroll` when the page unmounts. An offset is recorded only after
 * its column's offset was restored, so a column that mounts at the top
 * does not overwrite the stored offset first. */
export function useResearchColumnScroll({
  treeId,
  navigationPersistence,
  columns,
  levelPath,
  hiddenAnswerIds,
  contentByNode,
  contentErrorByNode,
  pairColumn,
  workspaceRef,
}: {
  treeId: string | null;
  navigationPersistence: ResearchThreadPersistence;
  /** The strip's columns. */
  columns: readonly ResearchColumn[];
  /** The selected message of each open level. */
  levelPath: readonly string[];
  /** Selected messages whose answer columns show something else in their
   * place (a selected queued message, or a range's answers): their answers
   * are not on screen. */
  hiddenAnswerIds: readonly string[];
  contentByNode: Record<string, ResearchNodeContent>;
  contentErrorByNode: Record<string, string>;
  pairColumn: (kind: "messages" | "answer", level: number) => HTMLElement | null;
  workspaceRef: { readonly current: HTMLElement | null };
}) {
  const treeIdRef = useRef(treeId);
  treeIdRef.current = treeId;
  // Answer scroll offsets, per node, for this mount; the persisted store
  // persists them across mounts.
  const answerScrollRef = useRef(new Map<string, number>());
  // Answers whose scroll offset has been restored since their column mounted.
  const restoredAnswerScrollRef = useRef(new Set<string>());
  // The same for each messages column (keyed by its level's head node) and
  // each branches column (by the head of the level its branches come from),
  // under `listScrollId`.
  const messagesScrollRef = useRef(new Map<string, number>());
  const restoredTurnsScrollRef = useRef(new Set<string>());

  /** Writes the restored columns' offsets to `persistence`. */
  const captureScroll = useCallback((persistence: ResearchThreadPersistence) => {
    const currentTreeId = treeIdRef.current;
    if (!currentTreeId) {
      return;
    }
    for (const [nodeId, top] of answerScrollRef.current) {
      if (restoredAnswerScrollRef.current.has(nodeId)) {
        persistence.recordScroll(currentTreeId, nodeId, top);
      }
    }
    for (const [id, top] of messagesScrollRef.current) {
      if (restoredTurnsScrollRef.current.has(id)) {
        const { kind, key } = parseListScrollId(id);
        persistence.recordScroll(currentTreeId, key, top, kind);
      }
    }
  }, []);

  // Each answer's scroll offset: restored once its content has loaded (a
  // short loading placeholder would clamp the offset), then recorded on
  // scroll, in memory and in the persisted store.
  useLayoutEffect(() => {
    if (!treeId) {
      return;
    }
    // An answer that leaves the screen (its message is no longer selected,
    // or a queued message is shown in its place) has its offset restored
    // again when its column mounts again.
    const shown = (nodeId: string) => levelPath.includes(nodeId) && !hiddenAnswerIds.includes(nodeId);
    for (const nodeId of [...restoredAnswerScrollRef.current]) {
      if (!shown(nodeId)) {
        restoredAnswerScrollRef.current.delete(nodeId);
      }
    }
    for (const nodeId of levelPath) {
      if (
        !shown(nodeId) ||
        restoredAnswerScrollRef.current.has(nodeId) ||
        !(contentByNode[nodeId] || contentErrorByNode[nodeId])
      ) {
        continue;
      }
      const level = levelPath.indexOf(nodeId);
      const scroller = pairColumn("answer", level)?.querySelector<HTMLElement>(":scope > .research-column-scroll");
      if (!scroller) {
        continue;
      }
      restoredAnswerScrollRef.current.add(nodeId);
      scroller.scrollTop =
        answerScrollRef.current.get(nodeId) ??
        restoreResearchScrollPosition(navigationPersistence.store[treeId], nodeId);
    }
  }, [contentByNode, contentErrorByNode, hiddenAnswerIds, levelPath, navigationPersistence, pairColumn, treeId]);

  // Each messages and branches column, as it mounts: its scroll offset comes
  // back (from this visit, else the persisted store), then its selected
  // message is brought fully into view (top-aligned when taller than the
  // column), without animation. Showing the selected message can change the
  // restored offset. A branches column with no open branch has no selected
  // message; its offset comes back once its rows have rendered.
  useLayoutEffect(() => {
    if (!treeId) {
      return;
    }
    const shown = columns.flatMap((column) => {
      const scroll = columnScrollKey(column);
      return scroll && scroll.kind !== "answer"
        ? [{ column, kind: scroll.kind, key: scroll.key, id: listScrollId(scroll.kind, scroll.key) }]
        : [];
    });
    for (const id of [...restoredTurnsScrollRef.current]) {
      if (!shown.some((entry) => entry.id === id)) {
        restoredTurnsScrollRef.current.delete(id);
      }
    }
    for (const { column, kind, key, id } of shown) {
      if (restoredTurnsScrollRef.current.has(id)) {
        continue;
      }
      const element = workspaceRef.current?.querySelector<HTMLElement>(columnSelector(column.id)) ?? null;
      const scroller = element?.querySelector<HTMLElement>(":scope > .research-column-scroll");
      const row = element?.querySelector<HTMLElement>(COLUMN_ROW_SELECTOR) ?? null;
      const rendered = row ?? (kind === "branches" ? element?.querySelector("[data-research-row]") : null);
      if (!scroller || !rendered) {
        continue;
      }
      restoredTurnsScrollRef.current.add(id);
      scroller.scrollTop =
        messagesScrollRef.current.get(id) ??
        restoreResearchScrollPosition(navigationPersistence.store[treeId], key, Date.now(), kind);
      if (row) {
        scrollIntoColumn(row, "auto");
      }
    }
  });

  const recordTurnsScroll = useCallback(
    (kind: ListScrollKind, key: string, scroller: HTMLElement) => {
      const id = listScrollId(kind, key);
      if (!restoredTurnsScrollRef.current.has(id)) {
        return;
      }
      messagesScrollRef.current.set(id, scroller.scrollTop);
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.recordScroll(currentTreeId, key, scroller.scrollTop, kind);
      }
    },
    [navigationPersistence],
  );

  const recordAnswerScroll = useCallback(
    (nodeId: string, scroller: HTMLElement) => {
      // The column never scrolls sideways legitimately (wide tables and code
      // blocks scroll inside their own containers), but programmatic scrolls
      // can still shift a hidden axis. Pin it back to the left edge.
      if (scroller.scrollLeft !== 0) {
        scroller.scrollLeft = 0;
      }
      if (!restoredAnswerScrollRef.current.has(nodeId)) {
        return;
      }
      answerScrollRef.current.set(nodeId, scroller.scrollTop);
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.recordScroll(currentTreeId, nodeId, scroller.scrollTop);
      }
    },
    [navigationPersistence],
  );

  /** Saves a column's scroll offset under its scroll key (an answer's
   * message, a messages column's chain head, or a branches column's first
   * branch; see columnScrollKey). */
  const onColumnScroll = useCallback(
    (column: ResearchColumn) => {
      const scroll = columnScrollKey(column);
      if (!scroll) {
        return undefined;
      }
      const { kind, key } = scroll;
      return (event: UIEvent<HTMLElement>) =>
        kind === "answer"
          ? recordAnswerScroll(key, event.currentTarget)
          : recordTurnsScroll(kind, key, event.currentTarget);
    },
    [recordAnswerScroll, recordTurnsScroll],
  );

  return {
    /** Answers whose scroll offset has been restored since their column
     * mounted. */
    restoredAnswerScrollRef,
    /** The scroll handler for a persisted column, or undefined. */
    onColumnScroll,
    captureScroll,
  };
}
