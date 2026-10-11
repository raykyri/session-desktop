import { useCallback, useLayoutEffect, useRef, type UIEvent } from "react";
import { scrollIntoColumn } from "../components/research/ResearchColumns";
import { columnScrollKey, type ResearchColumn, type ResearchLevel } from "../lib/researchColumns";
import { restoreResearchScrollPosition } from "../lib/researchNavigation";
import type { createResearchThreadPersistence } from "../lib/researchThreadPersistence";
import type { ResearchNodeContent } from "../types";

export type ResearchThreadPersistence = ReturnType<typeof createResearchThreadPersistence>;

/** The scroll offsets of the thread page's answer and messages columns:
 * restored as each column mounts (from this visit, else the persisted
 * store), recorded as it scrolls, and written to `persistence` by
 * `captureScroll` when the page unmounts. An offset is recorded only after
 * its column's offset was restored, so a column that mounts at the top
 * does not overwrite the stored offset first. */
export function useResearchColumnScroll({
  treeId,
  navigationPersistence,
  levels,
  levelPath,
  contentByNode,
  contentErrorByNode,
  pairColumn,
  selectedRow,
}: {
  treeId: string | null;
  navigationPersistence: ResearchThreadPersistence;
  levels: readonly ResearchLevel[];
  /** The selected message of each open level. */
  levelPath: readonly string[];
  contentByNode: Record<string, ResearchNodeContent>;
  contentErrorByNode: Record<string, string>;
  pairColumn: (kind: "messages" | "answer", level: number) => HTMLElement | null;
  selectedRow: (level: number) => HTMLElement | null;
}) {
  const treeIdRef = useRef(treeId);
  treeIdRef.current = treeId;
  // Answer scroll offsets, per node, for this mount; the persisted store
  // carries them across mounts.
  const answerScrollRef = useRef(new Map<string, number>());
  // Answers whose scroll offset has been restored since their column mounted.
  const restoredAnswerScrollRef = useRef(new Set<string>());
  // The same for each level's messages column, keyed by its head node.
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
    for (const [headId, top] of messagesScrollRef.current) {
      if (restoredTurnsScrollRef.current.has(headId)) {
        persistence.recordScroll(currentTreeId, headId, top, "messages");
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
    for (const nodeId of [...restoredAnswerScrollRef.current]) {
      if (!levelPath.includes(nodeId)) {
        restoredAnswerScrollRef.current.delete(nodeId);
      }
    }
    for (const nodeId of levelPath) {
      if (restoredAnswerScrollRef.current.has(nodeId) || !(contentByNode[nodeId] || contentErrorByNode[nodeId])) {
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
  }, [contentByNode, contentErrorByNode, levelPath, navigationPersistence, pairColumn, treeId]);

  // Each messages column, as it mounts: its scroll offset comes back (from
  // this visit, else the persisted store), then its selected message is
  // brought fully into view (top-aligned when taller than the column),
  // without animation. Showing the selected message can change the restored offset.
  useLayoutEffect(() => {
    if (!treeId) {
      return;
    }
    const heads = levels.map((level) => level.headId);
    for (const headId of [...restoredTurnsScrollRef.current]) {
      if (!heads.includes(headId)) {
        restoredTurnsScrollRef.current.delete(headId);
      }
    }
    heads.forEach((headId, level) => {
      if (restoredTurnsScrollRef.current.has(headId)) {
        return;
      }
      const scroller = pairColumn("messages", level)?.querySelector<HTMLElement>(":scope > .research-column-scroll");
      const row = selectedRow(level);
      if (!scroller || !row) {
        return;
      }
      restoredTurnsScrollRef.current.add(headId);
      scroller.scrollTop =
        messagesScrollRef.current.get(headId) ??
        restoreResearchScrollPosition(navigationPersistence.store[treeId], headId, Date.now(), "messages");
      scrollIntoColumn(row, "auto");
    });
  });

  const recordTurnsScroll = useCallback(
    (headId: string, scroller: HTMLElement) => {
      if (!restoredTurnsScrollRef.current.has(headId)) {
        return;
      }
      messagesScrollRef.current.set(headId, scroller.scrollTop);
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.recordScroll(currentTreeId, headId, scroller.scrollTop, "messages");
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
   * message, or a messages column's chain head). */
  const onColumnScroll = useCallback(
    (column: ResearchColumn) => {
      const scroll = columnScrollKey(column);
      if (!scroll) {
        return undefined;
      }
      return (event: UIEvent<HTMLElement>) =>
        scroll.kind === "answer"
          ? recordAnswerScroll(scroll.key, event.currentTarget)
          : recordTurnsScroll(scroll.key, event.currentTarget);
    },
    [recordAnswerScroll, recordTurnsScroll],
  );

  return {
    /** Answers whose scroll offset has been restored since their column
     * mounted. */
    restoredAnswerScrollRef,
    /** The scroll handler of a column that keeps its offset, else undefined. */
    onColumnScroll,
    captureScroll,
  };
}
