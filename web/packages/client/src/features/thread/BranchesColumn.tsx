// The branches column after a level (`09-research-document-view.md` §3),
// ported from the desktop `ResearchBranchesColumn`: every branch created from
// a message the level's column lists, stacked in reading order, each as a
// group with its source and passage, its messages and its queue. The group
// that holds the column's selection ends with its ask box; the unsent branch
// is a group with its source and the ask box for its first question. The
// header reads "Branches · N"; its × clears the column's selection.

import {
  columnAttributes,
  type ResearchBranchesColumn as BranchesColumnData,
  type ResearchStackGroup,
} from "@session/shared/lib/researchColumns";
import { researchNodeLabel } from "@session/shared/lib/researchThreadView";
import type { ReactNode, UIEvent } from "react";

import { cn } from "../../lib/cn.js";

import { PairHeader } from "./ColumnChrome.js";
import { ColumnResizer } from "./ColumnResizer.js";
import {
  BranchSource,
  COLUMN_SCROLL,
  ChainRows,
  type BranchSourceProps,
  type ChainRowsShared,
  type QueueProps,
} from "./MessagesColumn.js";

export function BranchesColumn({
  column,
  current,
  shared,
  openSourceId,
  sourceOf,
  composerOf,
  queueOf,
  onClear,
  onScroll,
}: {
  column: BranchesColumnData;
  current: boolean;
  shared: ChainRowsShared;
  /** The source message of the branch selected in the next column. */
  openSourceId: string | null;
  sourceOf: (group: ResearchStackGroup) => BranchSourceProps;
  /** The ask box of the selected group, or of the unsent branch. */
  composerOf: (group: ResearchStackGroup) => ReactNode;
  queueOf: (headId: string, chainIds: readonly string[]) => QueueProps;
  onClear: () => void;
  onScroll: ((event: UIEvent<HTMLElement>) => void) | undefined;
}) {
  const { levelIndex: level, groups } = column;
  const branchCount = groups.filter((group) => group.kind === "branch").length;
  const anySelected = groups.some((group) => group.kind === "branch" && group.selectedId !== null);
  const firstBranch = groups.find((group) => group.kind === "branch");
  return (
    <section
      className={cn(
        "research-pair-messages is-branches relative flex h-full w-(--research-messages-width) min-w-0 shrink-0 flex-col",
        "border-border-strong border-r border-l border-r-[var(--surface-divider)] bg-[var(--research-feed-bg)]",
        !column.level && "is-closed",
        current && "is-current",
      )}
      {...columnAttributes(column)}
      data-research-pending-only={branchCount === 0 ? "" : undefined}
      aria-label="Branches"
    >
      <PairHeader
        title="Branches"
        count={branchCount}
        branchIcon
        current={current}
        spanned={column.level !== null}
        clear={column.level ? { label: "Clear branch selection", onClear } : null}
      />
      <div className={COLUMN_SCROLL} data-research-scroll="" onScroll={onScroll}>
        <div className="research-column-content research-reading-surface">
          {groups.map((group) => {
            if (group.kind === "pending") {
              return (
                <section
                  key={`pending:${group.parentNodeId}`}
                  className="border-border-divider border-b last:border-b-0"
                  data-research-branch-group={`pending:${group.parentNodeId}`}
                  aria-label="New branch"
                >
                  <BranchSource {...sourceOf(group)} />
                  {composerOf(group)}
                </section>
              );
            }
            const head = shared.nodeById.get(group.headId);
            const selected = group.selectedId !== null;
            return (
              <section
                key={group.headId}
                className={cn(
                  "border-border-divider border-b last:border-b-0",
                  selected && "is-open",
                )}
                data-research-branch-group={group.headId}
                aria-label={`Branch: ${researchNodeLabel(head, "Branch")}`}
              >
                <BranchSource {...sourceOf(group)} />
                <ChainRows
                  shared={shared}
                  level={level}
                  headId={group.headId}
                  displayIds={group.displayIds}
                  selectedId={group.selectedId}
                  openSourceId={openSourceId}
                  firstFocusable={!anySelected && group === firstBranch}
                  queue={queueOf(group.headId, group.chainIds)}
                />
                {selected ? composerOf(group) : null}
              </section>
            );
          })}
        </div>
      </div>
      <ColumnResizer
        kind="messages"
        label="Resize messages column"
        belowHeader={column.level !== null}
      />
    </section>
  );
}
