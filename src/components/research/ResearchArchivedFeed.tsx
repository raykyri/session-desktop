import { memo, useMemo } from "react";
import type { ResearchTreeSummary } from "../../types";
import { RESEARCH_ARCHIVE_FOLDER_ID } from "../../lib/researchFolders";
import { researchThreadKind, researchThreadState } from "../../lib/researchRowGlyph";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";
import ResearchFeedCard from "./ResearchFeedCard";
import { researchPlaceEmptyText } from "./ResearchFeedTray";
import type { ResearchUnitMenuPlacement } from "./researchUnitMenu";

export interface ResearchArchivedFeedProps {
  /** Archived trees in any order; the list sorts them newest-archived first. */
  trees: ResearchTreeSummary[];
  /** The thread open in the content column beside this list. */
  selectedTreeId?: string | null;
  /** The tree whose … menu is open. */
  menuTreeId?: string | null;
  onOpen: (treeId: string) => void;
  /** Opens a card's menu below its … button. */
  onMenu?: (treeId: string, anchor: HTMLElement) => void;
  /** Opens the same menu as a context menu at `placement`; `control` is the
   * card's open button. */
  onContextMenu?: (treeId: string, placement: ResearchUnitMenuPlacement, control: HTMLElement) => void;
  onDragStart?: ResearchCardDragStart;
}

function archivedTooltip(archivedAt: number | null | undefined): string | undefined {
  if (archivedAt == null) return undefined;
  return `Archived ${new Date(archivedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

/** Archived threads newest-archived first, for Archive. */
export function archivedFeedTrees(trees: ResearchTreeSummary[]): ResearchTreeSummary[] {
  return trees
    .filter((tree) => tree.archivedAt != null)
    .sort(
      (left, right) =>
        (right.archivedAt ?? 0) - (left.archivedAt ?? 0) || left.id.localeCompare(right.id),
    );
}

/** The cards of the Archive, in its Home tray and in its own view. Each card
 * opens its thread; its … button and its context menu open the same menu
 * (Move to, Unarchive, Delete), which the feed owns. */
function ResearchArchivedFeed({
  trees,
  selectedTreeId = null,
  menuTreeId = null,
  onOpen,
  onMenu,
  onContextMenu,
  onDragStart,
}: ResearchArchivedFeedProps) {
  const sortedTrees = useMemo(() => archivedFeedTrees(trees), [trees]);

  return (
    <>
      {sortedTrees.map((tree) => (
        <ResearchFeedCard
          key={tree.id}
          cardId={tree.id}
          place={RESEARCH_ARCHIVE_FOLDER_ID}
          renderBody={(asQuestion) => asQuestion(tree.title)}
          label={tree.title}
          tooltip={archivedTooltip(tree.archivedAt)}
          kind={researchThreadKind(tree, undefined)}
          state={researchThreadState(tree, undefined)}
          statusLabel={tree.hasUnseenFailure ? "Failed since last viewed" : undefined}
          selected={tree.id === selectedTreeId}
          unread={tree.hasUnseenUpdate && tree.id !== selectedTreeId}
          menuOpen={tree.id === menuTreeId}
          onOpen={() => onOpen(tree.id)}
          onMenu={onMenu ? (anchor) => onMenu(tree.id, anchor) : undefined}
          onContextMenu={
            onContextMenu ? (placement, control) => onContextMenu(tree.id, placement, control) : undefined
          }
          onDragStart={onDragStart}
        />
      ))}
      {sortedTrees.length === 0 ? (
        <div className="research-feed-empty">
          {researchPlaceEmptyText(RESEARCH_ARCHIVE_FOLDER_ID)}
        </div>
      ) : null}
    </>
  );
}

export default memo(ResearchArchivedFeed);
