import { memo, useMemo, useState } from "react";
import type { ResearchTreeSummary } from "../../types";
import { RESEARCH_ARCHIVE_FOLDER_ID } from "../../lib/researchFolders";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";
import ResearchFeedPost from "./ResearchFeedPost";
import { researchPlaceEmptyText } from "./ResearchFeedTray";
import { ResearchMenu, researchMenuPoint } from "./ResearchMenu";
import { ResearchTreeDeleteDialog, ResearchTreeMenuItems } from "./ResearchTreeMenu";

export interface ResearchArchivedFeedProps {
  /** Archived trees in any order; the list sorts them newest-archived first. */
  trees: ResearchTreeSummary[];
  /** The thread open in the content column beside this list. */
  selectedTreeId?: string | null;
  /** The tree whose … menu is open. */
  menuTreeId?: string | null;
  onOpen: (treeId: string) => void;
  onRestore: (treeId: string) => Promise<void>;
  onRemove: (treeId: string) => Promise<void>;
  onMenu?: (treeId: string, anchor: HTMLElement) => void;
  onDragStart?: ResearchCardDragStart;
}

type ArchivedMenu = { treeId: string; x: number; y: number };

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

/** The cards of Archive, in its Home tray and in its own view. Each card
 * opens its thread; the … menu moves it out, and the context menu
 * unarchives or deletes it. */
function ResearchArchivedFeed({
  trees,
  selectedTreeId = null,
  menuTreeId = null,
  onOpen,
  onRestore,
  onRemove,
  onMenu,
  onDragStart,
}: ResearchArchivedFeedProps) {
  const sortedTrees = useMemo(() => archivedFeedTrees(trees), [trees]);
  const [menu, setMenu] = useState<ArchivedMenu | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  const menuTree = menu ? (sortedTrees.find((tree) => tree.id === menu.treeId) ?? null) : null;

  return (
    <>
      {sortedTrees.map((tree) => (
        <ResearchFeedPost
          key={tree.id}
          cardId={tree.id}
          place={RESEARCH_ARCHIVE_FOLDER_ID}
          renderBody={(asQuestion) => asQuestion(tree.title)}
          label={tree.title}
          tooltip={archivedTooltip(tree.archivedAt)}
          selected={tree.id === selectedTreeId}
          menuOpen={tree.id === menuTreeId}
          onOpen={() => onOpen(tree.id)}
          onMenu={onMenu ? (anchor) => onMenu(tree.id, anchor) : undefined}
          onContextMenu={(x, y) => setMenu({ treeId: tree.id, x, y })}
          onDragStart={onDragStart}
        />
      ))}
      {sortedTrees.length === 0 ? (
        <div className="research-feed-empty">
          {researchPlaceEmptyText(RESEARCH_ARCHIVE_FOLDER_ID)}
        </div>
      ) : null}
      {menu && menuTree ? (
        <ResearchMenu
          anchor={researchMenuPoint(menu.x, menu.y)}
          align="point"
          label={`Actions for ${menuTree.title}`}
          onClose={() => setMenu(null)}
        >
          <ResearchTreeMenuItems
            tree={menuTree}
            archived
            onClose={() => setMenu(null)}
            onRestore={(treeId) => void onRestore(treeId)}
            onDelete={(tree) => {
              setMenu(null);
              setDeletingTree(tree);
            }}
          />
        </ResearchMenu>
      ) : null}
      {deletingTree ? (
        <ResearchTreeDeleteDialog
          tree={deletingTree}
          onClose={() => setDeletingTree(null)}
          onRemove={onRemove}
        />
      ) : null}
    </>
  );
}

export default memo(ResearchArchivedFeed);
