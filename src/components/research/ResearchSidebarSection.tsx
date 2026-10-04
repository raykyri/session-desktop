import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { FileText, LoaderCircle, MoreHorizontal, Terminal } from "lucide-react";
import type { ResearchTreeSummary } from "../../types";
import {
  ResearchTreeDeleteDialog,
  ResearchTreeMenuItems,
  ResearchTreeRenameDialog,
} from "./ResearchTreeMenu";
import { moveResearchTreeIdToGap } from "../../lib/researchOrder";

const RESEARCH_MENU_WIDTH = 190;
const RESEARCH_MENU_HEIGHT_ESTIMATE = 132;
const RESEARCH_MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

interface ResearchSidebarSectionProps {
  /** Active (non-archived) trees in the current folder scope, in display order. */
  trees: ResearchTreeSummary[];
  activeTreeId: string | null;
  onSelect: (treeId: string) => void;
  onRename: (treeId: string, title: string) => Promise<void>;
  onArchive: (treeId: string) => Promise<void>;
  onRemove: (treeId: string) => Promise<void>;
  onReorder: (orderedTreeIds: string[]) => void;
}

type ResearchMenu = { treeId: string; left: number; top: number };

type ResearchPointerDrag = {
  pointerId: number;
  treeId: string;
  startX: number;
  startY: number;
  active: boolean;
};

const RESEARCH_DRAG_START_THRESHOLD = 4;
const RESEARCH_DRAG_CLICK_SUPPRESS_MS = 100;

function ResearchSidebarTitle({ tree }: { tree: ResearchTreeSummary }) {
  return (
    <span className="research-sidebar-title">
      {tree.kind === "document" ? (
        <FileText className="research-sidebar-doc-icon" size={12} aria-hidden="true" />
      ) : tree.kind === "conversation" ? (
        <Terminal className="research-sidebar-doc-icon" size={12} aria-hidden="true" />
      ) : null}
      <span className="research-sidebar-title-text">{tree.title}</span>
    </span>
  );
}

function ResearchSidebarSection({
  trees,
  activeTreeId,
  onSelect,
  onRename,
  onArchive,
  onRemove,
  onReorder,
}: ResearchSidebarSectionProps) {
  const [menu, setMenu] = useState<ResearchMenu | null>(null);
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const pointerDragRef = useRef<ResearchPointerDrag | null>(null);
  const dropGapRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const menuTree = menu ? (trees.find((tree) => tree.id === menu.treeId) ?? null) : null;

  useEffect(() => {
    if (!menu) {
      return;
    }
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !(target instanceof Element && target.closest("[data-research-menu-trigger]"))
      ) {
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
      const key = event.key.toLowerCase();
      if (key !== "a" && key !== "d") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (menuTree.runningCount > 0) {
        return;
      }
      setMenu(null);
      if (key === "d") {
        setDeletingTree(menuTree);
        return;
      }
      void onArchive(menuTree.id);
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
  }, [menu, menuTree, onArchive]);

  // The height estimate that positioned the menu is only a guess — the menu
  // varies with its optional items. Once the real menu has rendered, clamp it
  // back inside the viewport so its bottom items (Delete) stay reachable from
  // triggers near the window's bottom edge.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) {
      return;
    }
    const height = element.getBoundingClientRect().height;
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(menu.top, window.innerHeight - VIEWPORT_MARGIN - height),
    );
    if (top !== menu.top) {
      element.style.top = `${top}px`;
    }
  }, [menu]);

  function menuPositionFromTrigger(trigger: HTMLButtonElement) {
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        rect.right - RESEARCH_MENU_WIDTH,
        window.innerWidth - RESEARCH_MENU_WIDTH - VIEWPORT_MARGIN,
      ),
    );
    const below = rect.bottom + RESEARCH_MENU_GAP;
    const top =
      below + RESEARCH_MENU_HEIGHT_ESTIMATE <= window.innerHeight - VIEWPORT_MARGIN
        ? below
        : Math.max(
            VIEWPORT_MARGIN,
            rect.top - RESEARCH_MENU_HEIGHT_ESTIMATE - RESEARCH_MENU_GAP,
          );
    return { left, top };
  }

  function menuPositionFromPoint(clientX: number, clientY: number) {
    return {
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(clientX, window.innerWidth - RESEARCH_MENU_WIDTH - VIEWPORT_MARGIN),
      ),
      top: Math.max(
        VIEWPORT_MARGIN,
        Math.min(
          clientY,
          window.innerHeight - RESEARCH_MENU_HEIGHT_ESTIMATE - VIEWPORT_MARGIN,
        ),
      ),
    };
  }

  function openMenu(trigger: HTMLButtonElement, treeId: string) {
    if (menu?.treeId === treeId) {
      setMenu(null);
      return;
    }
    setMenu({ treeId, ...menuPositionFromTrigger(trigger) });
  }

  function openRenameDialog(tree: ResearchTreeSummary) {
    setMenu(null);
    setRenamingTree(tree);
  }

  function clearPointerDrag() {
    pointerDragRef.current = null;
    dropGapRef.current = null;
    setDraggingId(null);
    setDropGap(null);
  }

  // The gap (0..length) the pointer is over, or null when dropping there
  // would leave the dragged row where it is.
  function computeDropGap(clientY: number, treeId: string): number | null {
    const section = sectionRef.current;
    if (!section) {
      return null;
    }
    const dragIndex = trees.findIndex((tree) => tree.id === treeId);
    if (dragIndex < 0) {
      return null;
    }
    const rows = Array.from(
      section.querySelectorAll<HTMLElement>(".research-sidebar-row[data-research-tree-id]"),
    );
    let gap = rows.length;
    for (const [index, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        gap = index;
        break;
      }
    }
    return gap === dragIndex || gap === dragIndex + 1 ? null : gap;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, treeId: string) {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("[data-research-menu-trigger]"))
    ) {
      return;
    }
    pointerDragRef.current = {
      pointerId: event.pointerId,
      treeId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < RESEARCH_DRAG_START_THRESHOLD) {
        return;
      }
      drag.active = true;
      setMenu(null);
      setDraggingId(drag.treeId);
    }
    event.preventDefault();
    const gap = computeDropGap(event.clientY, drag.treeId);
    dropGapRef.current = gap;
    setDropGap(gap);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The platform may already have released capture.
    }
    if (!drag.active) {
      pointerDragRef.current = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, RESEARCH_DRAG_CLICK_SUPPRESS_MS);
    const gap = dropGapRef.current ?? computeDropGap(event.clientY, drag.treeId);
    clearPointerDrag();
    if (gap === null) {
      return;
    }
    const currentIds = trees.map((tree) => tree.id);
    const nextIds = moveResearchTreeIdToGap(currentIds, drag.treeId, gap);
    if (nextIds !== currentIds) {
      onReorder(nextIds);
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerDragRef.current?.pointerId === event.pointerId) {
      clearPointerDrag();
    }
  }

  // Row-level click handling, shared by the row and its select button. The row
  // takes pointer capture on pointerdown (for drag reordering), and a captured
  // pointer retargets the gesture's mouseup — and therefore its click — to the
  // capturing row, so a handler on the inner button alone never fires.
  function selectTreeFromClick(event: ReactMouseEvent<HTMLElement>, treeId: string) {
    if (suppressClickRef.current) {
      return;
    }
    // A double-click still selects the research on its first click, but does
    // not start a second redundant detail fetch before the rename dialog opens.
    if (event.detail > 1) {
      return;
    }
    // An uncaptured click on the menu trigger bubbles here; opening the menu
    // must not also switch the selection.
    if (
      event.target instanceof Element &&
      event.target.closest("[data-research-menu-trigger]")
    ) {
      return;
    }
    onSelect(treeId);
  }

  function dropClasses(index: number) {
    if (dropGap === null) {
      return "";
    }
    return `${dropGap === index ? " is-drop-before" : ""}${
      dropGap === trees.length && index === trees.length - 1 ? " is-drop-after" : ""
    }`;
  }

  function renderTreeRow(tree: ResearchTreeSummary, index: number) {
    return (
      <div
        key={tree.id}
        className={`research-sidebar-row${activeTreeId === tree.id ? " is-selected" : ""}${
          menu?.treeId === tree.id ? " has-open-menu" : ""
        }${draggingId === tree.id ? " is-dragging" : ""}${dropClasses(index)}`}
        data-research-tree-id={tree.id}
        onPointerDown={(event) => handlePointerDown(event, tree.id)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={(event) => selectTreeFromClick(event, tree.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ treeId: tree.id, ...menuPositionFromPoint(event.clientX, event.clientY) });
        }}
        onDoubleClick={() => openRenameDialog(tree)}
      >
        <button
          type="button"
          className="control-button research-sidebar-select"
          aria-current={activeTreeId === tree.id ? "page" : undefined}
          title={tree.title}
          onClick={(event) => {
            event.stopPropagation();
            selectTreeFromClick(event, tree.id);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            openRenameDialog(tree);
          }}
        >
          <span className="research-sidebar-copy">
            <ResearchSidebarTitle tree={tree} />
          </span>
          {tree.runningCount > 0 ? (
            <span
              className="research-sidebar-spinner"
              title={`${tree.runningCount} running`}
            >
              <LoaderCircle size={14} aria-hidden="true" />
            </span>
          ) : tree.hasUnseenFailure ? (
            <span
              className="research-sidebar-failed"
              title="Failed since last viewed — open to acknowledge"
            >
              !
            </span>
          ) : tree.hasUnseenUpdate ? (
            <span className="research-sidebar-unseen" title="Updated since last viewed">
              New
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="control-button research-sidebar-menu-trigger"
          title="Research actions"
          aria-label={`Actions for ${tree.title}`}
          aria-haspopup="menu"
          aria-expanded={menu?.treeId === tree.id}
          data-research-menu-trigger
          onClick={(event) => openMenu(event.currentTarget, tree.id)}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <>
      <section
        ref={sectionRef}
        className={`research-sidebar-section${draggingId ? " is-dragging" : ""}`}
        aria-label="Research"
      >
        <div className="research-sidebar-heading">
          <span>Research</span>
        </div>
        {trees.map(renderTreeRow)}
      </section>
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
                archived={false}
                onClose={() => setMenu(null)}
                onRename={openRenameDialog}
                onArchive={(treeId) => void onArchive(treeId)}
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
      {renamingTree ? (
        <ResearchTreeRenameDialog
          tree={renamingTree}
          onClose={() => setRenamingTree(null)}
          onRename={onRename}
        />
      ) : null}
    </>
  );
}

export default memo(ResearchSidebarSection);
