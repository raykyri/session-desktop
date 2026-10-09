import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ResearchTreeSummary } from "../../types";
import { RESEARCH_ARCHIVE_FOLDER_ID } from "../../lib/researchFolders";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";
import ResearchFeedPost from "./ResearchFeedPost";
import { researchPlaceEmptyText } from "./ResearchFeedTray";
import {
  RESEARCH_TREE_MENU_WIDTH,
  ResearchTreeDeleteDialog,
  ResearchTreeMenuItems,
} from "./ResearchTreeMenu";

const MENU_HEIGHT_ESTIMATE = 96;
const MENU_VIEWPORT_MARGIN = 8;

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

type ArchivedMenu = { treeId: string; left: number; top: number };

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
    .filter((tree) => tree.archivedAt != null && tree.kind !== "document")
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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTree = menu ? (sortedTrees.find((tree) => tree.id === menu.treeId) ?? null) : null;

  // Outside mousedown, Escape, and viewport reflow close the menu; the D
  // keycap opens the delete confirmation, matching the Home feed's menu.
  useEffect(() => {
    if (!menu) {
      return;
    }
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenu(null);
      }
    };
    // Captured and stopped, so Esc closes only the menu (not the drawer).
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || !menuTree) {
        return;
      }
      if (event.key.toLowerCase() !== "d") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (menuTree.runningCount > 0) {
        return;
      }
      setMenu(null);
      setDeletingTree(menuTree);
    };
    const closeOnReflow = () => setMenu(null);
    document.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", closeOnReflow);
    window.addEventListener("scroll", closeOnReflow, true);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", closeOnReflow);
      window.removeEventListener("scroll", closeOnReflow, true);
    };
  }, [menu, menuTree]);

  // The height estimate is a guess; clamp the rendered menu inside the viewport.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) {
      return;
    }
    const height = element.getBoundingClientRect().height;
    const top = Math.max(
      MENU_VIEWPORT_MARGIN,
      Math.min(menu.top, window.innerHeight - MENU_VIEWPORT_MARGIN - height),
    );
    if (top !== menu.top) {
      element.style.top = `${top}px`;
    }
  }, [menu]);

  function openContextMenu(treeId: string, clientX: number, clientY: number) {
    setMenu({
      treeId,
      left: Math.max(
        MENU_VIEWPORT_MARGIN,
        Math.min(clientX, window.innerWidth - RESEARCH_TREE_MENU_WIDTH - MENU_VIEWPORT_MARGIN),
      ),
      top: Math.max(
        MENU_VIEWPORT_MARGIN,
        Math.min(clientY, window.innerHeight - MENU_HEIGHT_ESTIMATE - MENU_VIEWPORT_MARGIN),
      ),
    });
  }

  return (
    <>
      {sortedTrees.map((tree) => (
        <ResearchFeedPost
          key={tree.id}
          cardId={tree.id}
          place={RESEARCH_ARCHIVE_FOLDER_ID}
          renderBody={(clamp) => clamp(tree.title)}
          label={tree.title}
          tooltip={archivedTooltip(tree.archivedAt)}
          selected={tree.id === selectedTreeId}
          menuOpen={tree.id === menuTreeId}
          onOpen={() => onOpen(tree.id)}
          onMenu={onMenu ? (anchor) => onMenu(tree.id, anchor) : undefined}
          onContextMenu={(clientX, clientY) => openContextMenu(tree.id, clientX, clientY)}
          onDragStart={onDragStart}
        />
      ))}
      {sortedTrees.length === 0 ? (
        <div className="research-feed-empty">
          {researchPlaceEmptyText(RESEARCH_ARCHIVE_FOLDER_ID)}
        </div>
      ) : null}
      {menu && menuTree
        ? createPortal(
            <div
              ref={menuRef}
              className="popover-surface popover-surface--context pane-context-menu research-sidebar-menu"
              role="menu"
              aria-label={`Actions for ${menuTree.title}`}
              style={{ left: menu.left, top: menu.top }}
              onMouseDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
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
            </div>,
            document.body,
          )
        : null}
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
