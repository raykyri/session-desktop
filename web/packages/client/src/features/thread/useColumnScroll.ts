// The scroll offsets of a thread's answer, messages and branches columns,
// ported from the desktop `useResearchColumnScroll`. Each column's offset is
// restored as it mounts (from this visit, else the persisted store), recorded
// as it scrolls, and stored per tree (`persistence.ts`). An offset is recorded
// only after its column's offset was restored, so a column that mounts at the
// top does not overwrite the stored offset first; an answer is restored only
// once its content has loaded, since a short loading placeholder would clamp
// the offset.

import {
  COLUMN_ROW_SELECTOR,
  columnScrollKey,
  columnSelector,
  type ResearchColumn,
  type ResearchScrollKind,
} from "@session/shared/lib/researchColumns";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { UIEvent } from "react";

import { recordScroll, savedScroll } from "./persistence.js";
import { columnScroller, scrollIntoColumn } from "./stripDom.js";

type ListKind = Exclude<ResearchScrollKind, "answer">;
const listId = (kind: ListKind, key: string) => `${kind}\n${key}`;

export function useColumnScroll({
  treeId,
  columns,
  levelPath,
  queuedAnswerId,
  settledAnswers,
  workspaceRef,
}: {
  treeId: string;
  columns: readonly ResearchColumn[];
  /** The selected message of each open level. */
  levelPath: readonly string[];
  /** A message whose answer column shows a selected queued message instead. */
  queuedAnswerId: string | null;
  /** Answers whose content (or a load error) is on screen. */
  settledAnswers: ReadonlySet<string>;
  workspaceRef: { readonly current: HTMLElement | null };
}) {
  const answerScroll = useRef(new Map<string, number>());
  const restoredAnswers = useRef(new Set<string>());
  const listScroll = useRef(new Map<string, number>());
  const restoredLists = useRef(new Set<string>());

  const answerScroller = useCallback(
    (level: number) =>
      columnScroller(workspaceRef.current?.querySelector(columnSelector(`A${level}`)) ?? null),
    [workspaceRef],
  );

  useLayoutEffect(() => {
    const shown = (nodeId: string) => levelPath.includes(nodeId) && nodeId !== queuedAnswerId;
    for (const nodeId of [...restoredAnswers.current]) {
      if (!shown(nodeId)) restoredAnswers.current.delete(nodeId);
    }
    levelPath.forEach((nodeId, level) => {
      if (!shown(nodeId) || restoredAnswers.current.has(nodeId) || !settledAnswers.has(nodeId)) {
        return;
      }
      const scroller = answerScroller(level);
      if (!scroller) return;
      restoredAnswers.current.add(nodeId);
      scroller.scrollTop =
        answerScroll.current.get(nodeId) ?? savedScroll(treeId, "answer", nodeId);
    });
  }, [answerScroller, levelPath, queuedAnswerId, settledAnswers, treeId]);

  // Messages and branches columns: the offset comes back as the column
  // mounts, then its selected message is brought fully into view.
  useLayoutEffect(() => {
    const shown = columns.flatMap((column) => {
      const scroll = columnScrollKey(column);
      return scroll && scroll.kind !== "answer"
        ? [{ column, kind: scroll.kind, key: scroll.key, id: listId(scroll.kind, scroll.key) }]
        : [];
    });
    for (const id of [...restoredLists.current]) {
      if (!shown.some((entry) => entry.id === id)) restoredLists.current.delete(id);
    }
    for (const { column, kind, key, id } of shown) {
      if (restoredLists.current.has(id)) continue;
      const element = workspaceRef.current?.querySelector<HTMLElement>(columnSelector(column.id));
      const scroller = columnScroller(element);
      const row = element?.querySelector<HTMLElement>(COLUMN_ROW_SELECTOR) ?? null;
      const rendered =
        row ?? (kind === "branches" ? element?.querySelector("[data-research-row]") : null);
      if (!scroller || !rendered) continue;
      restoredLists.current.add(id);
      scroller.scrollTop = listScroll.current.get(id) ?? savedScroll(treeId, kind, key);
      if (row) scrollIntoColumn(row, "auto");
    }
  });

  const onColumnScroll = useCallback(
    (column: ResearchColumn) => {
      const scroll = columnScrollKey(column);
      if (!scroll) return undefined;
      const { kind, key } = scroll;
      return (event: UIEvent<HTMLElement>) => {
        const scroller = event.currentTarget;
        if (kind === "answer") {
          // Wide tables and code blocks scroll inside their own containers;
          // a programmatic scroll can still shift the hidden axis.
          if (scroller.scrollLeft !== 0) scroller.scrollLeft = 0;
          if (!restoredAnswers.current.has(key)) return;
          answerScroll.current.set(key, scroller.scrollTop);
        } else {
          const id = listId(kind, key);
          if (!restoredLists.current.has(id)) return;
          listScroll.current.set(id, scroller.scrollTop);
        }
        recordScroll(treeId, kind, key, scroller.scrollTop);
      };
    },
    [treeId],
  );

  return {
    /** Answers whose offset was restored since their column mounted. */
    restoredAnswers,
    onColumnScroll,
  };
}
