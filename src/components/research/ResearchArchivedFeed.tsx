import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ResearchTreeSummary } from "../../types";
import { IS_MAC } from "../../lib/appHelpers";
import { formatRelativeTime } from "../../lib/transcriptSessions";
import { ResearchDocumentFrame } from "./ResearchDocumentChrome";
import ResearchFeedPost from "./ResearchFeedPost";
import {
  RESEARCH_TREE_MENU_WIDTH,
  ResearchTreeDeleteDialog,
  ResearchTreeMenuItems,
} from "./ResearchTreeMenu";

const MENU_HEIGHT_ESTIMATE = 96;
const MENU_VIEWPORT_MARGIN = 8;

export interface ResearchArchivedFeedProps {
  /** Archived trees in any order; the view sorts them newest-archived first. */
  trees: ResearchTreeSummary[];
  /** The thread open in the content column beside this list. */
  selectedTreeId?: string | null;
  onOpen: (treeId: string) => void;
  onRestore: (treeId: string) => Promise<void>;
  onRemove: (treeId: string) => Promise<void>;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}

type ArchivedMenu = { treeId: string; left: number; top: number };

/** Archived threads newest-archived first, for the journal's Archived page.
 * Each card opens its thread in the content column; the context menu
 * unarchives or deletes it. */
export function archivedFeedTrees(trees: ResearchTreeSummary[]): ResearchTreeSummary[] {
  return trees
    .filter((tree) => tree.archivedAt != null && tree.kind !== "document")
    .sort(
      (left, right) =>
        (right.archivedAt ?? 0) - (left.archivedAt ?? 0) || left.id.localeCompare(right.id),
    );
}

function ResearchArchivedFeed({
  trees,
  selectedTreeId = null,
  onOpen,
  onRestore,
  onRemove,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeOnReflow);
    window.addEventListener("scroll", closeOnReflow, true);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", handleKeyDown);
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
    <ResearchDocumentFrame
      title="Archived"
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
      forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
      onBack={onBack}
      onForward={onForward}
    >
      <div className="research-document-scroll journal-scroll">
        <div className="journal-column research-reading-surface">
          <div className="journal-feed" role="feed" aria-label="Archived research">
            {sortedTrees.map((tree, index) => (
              <div
                key={tree.id}
                className="recent-activity-unit journal-archived-row"
                role="article"
                aria-posinset={index + 1}
                aria-setsize={sortedTrees.length}
              >
                <ResearchFeedPost
                  kind={
                    tree.kind === "note" || tree.kind === "conversation" ? tree.kind : "question"
                  }
                  title={tree.title}
                  renderBody={() => null}
                  time={
                    tree.archivedAt != null ? (
                      <time
                        dateTime={new Date(tree.archivedAt).toISOString()}
                        title={`Archived ${new Date(tree.archivedAt).toLocaleString()}`}
                      >
                        {formatRelativeTime(tree.archivedAt)}
                      </time>
                    ) : null
                  }
                  selected={tree.id === selectedTreeId}
                  onOpen={() => onOpen(tree.id)}
                  onContextMenu={(clientX, clientY) =>
                    openContextMenu(tree.id, clientX, clientY)
                  }
                />
              </div>
            ))}
            {sortedTrees.length === 0 ? (
              <div className="journal-empty-container">
                <p className="journal-empty">
                  Archived research appears here, most recently archived first.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
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
    </ResearchDocumentFrame>
  );
}

export default memo(ResearchArchivedFeed);
