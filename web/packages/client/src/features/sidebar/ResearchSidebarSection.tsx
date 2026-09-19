// The sidebar's research list (`10-home-feed-journal-encyclopedia.md` §7,
// ported from `ResearchSidebarSection.tsx`).
//
// What the port keeps: the folder display model and its drag math (both now in
// `shared/research/folders.ts`), multi-select with Shift and Cmd, the row menu,
// the multi-selection menu, the visibility filter and the archived section.
//
// What it drops: the hand-positioned portal menus and their viewport clamping —
// Base UI positions its own popups and dismisses them with correct nesting
// (ADR-9) — and the per-row Cmd-N hint, because on the web the digit chords
// address routes rather than threads (07 §5).

import type {
  ResearchFolder,
  ResearchFolderState,
  ResearchSidebarUnit,
  ResearchTreeSummary,
} from "@session/shared";
import {
  addTreesToResearchFolder,
  buildResearchSidebarLists,
  createResearchFolder,
  dissolveResearchFolder,
  flattenResearchSidebarUnits,
  flattenVisibleResearchSidebarUnits,
  isResearchStarred,
  moveResearchFolderMemberToGap,
  moveResearchTreeIdToGap,
  moveResearchUnitToGap,
  removeTreesFromResearchFolderMembership,
  renameResearchFolder,
  researchSidebarUnitId,
  setResearchFolderCollapsed,
  toggleResearchStar,
  translateResearchGapAfterInsertion,
} from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  ChevronRight,
  FileText,
  Folder,
  FolderMinus,
  FolderPlus,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  SyntheticEvent as ReactSyntheticEvent,
} from "react";

import {
  useArchiveResearchTree,
  useFolders,
  useRemoveResearchTree,
  useRenameResearchTree,
  useTreeSummaries,
} from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { errorMessage, pushErrorToast } from "../../lib/toast.js";
import { useSelectionStore } from "../../stores/selection.js";
import { IconButton } from "../../ui/Button.js";
import { ContextMenu } from "../../ui/ContextMenu.js";
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.js";
import { ICON_BUTTON } from "../../ui/surfaces.js";
import { useOverlay } from "../../ui/useOverlay.js";
import { DeleteTreeDialog, RenameTreeDialog, ResearchTreeMenuItems } from "../research/treeMenu.js";

import { AsyncConfirmDialog, NameDialog } from "./dialogs.js";
import { useVisibilityFilter } from "./filter.js";
import { IconMenuItem } from "./menuRows.js";
import { applyFolderState, applyTreeOrder } from "./mutations.js";
import {
  SIDEBAR_ROW,
  SIDEBAR_ROW_MULTI,
  SIDEBAR_ROW_SELECTED,
  SIDEBAR_SECTION_HEADING,
} from "./rows.js";

/** Escape priority for the multi-selection: below the DOM search bar, which is
 * the layer a reader is most likely to be inside when both are open. */
export const MULTI_SELECT_OVERLAY_PRIORITY = 100;

/**
 * Whether an event on a row came from the row itself rather than from a popup
 * the row renders.
 *
 * A row's `⋯` menu is a React child of the row but a DOM child of Base UI's
 * portal, and React dispatches synthetic events along the component tree rather
 * than the DOM tree. Without this test a press on a menu item reaches the row's
 * `onPointerDown`, which takes pointer capture on the row; the capture then
 * retargets the release to the row, so the browser dispatches `click` on the
 * nearest common ancestor of the item and the row — `<body>` — and the item's
 * own handler never runs. The menu stays open over its inert backdrop and
 * swallows every later click. The same crossing would let a menu item's click,
 * Enter, or double click open, select, or rename the thread behind the menu.
 *
 * `contains` is a DOM test, which is exactly the distinction wanted: the portal
 * is outside the row's subtree, everything the row renders inline is inside it.
 */
function isOwnRowEvent(event: ReactSyntheticEvent<HTMLElement>): boolean {
  return event.currentTarget.contains(event.target instanceof Node ? event.target : null);
}

/** Whether the event originated from an internal row control, such as the menu
 * trigger or folder disclosure arrow. These controls must not also open the row. */
function inRowButton(event: ReactSyntheticEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest("button") !== null;
}

/** How far a pointer travels before a press becomes a drag. */
const DRAG_START_THRESHOLD = 4;
/** How long a completed drag keeps the click it produced from selecting. */
const DRAG_CLICK_SUPPRESS_MS = 100;

const ICON = 13;

type DragScope =
  | { kind: "units" }
  | { kind: "starred" }
  | { kind: "folder"; folderId: string }
  | { kind: "archived" };

interface PointerDrag {
  pointerId: number;
  /** Tree id, or folder id when a folder header is what moves. */
  id: string;
  scope: DragScope;
  startX: number;
  startY: number;
  active: boolean;
}

type DropTarget =
  | { kind: "gap"; scope: DragScope; index: number }
  | { kind: "folder"; folderId: string; index: number; onHeader: boolean };

interface PendingFolder {
  treeIds: string[];
}

/** The path params of the deepest matched route. `useRouterState` types them as
 * the union of every route's params, which is `any` at this call site, so the
 * read is narrowed once here rather than at each use. */
export function routeParam(params: unknown, name: string): string | null {
  if (typeof params !== "object" || params === null) return null;
  const value = (params as Record<string, unknown>)[name];
  return typeof value === "string" ? value : null;
}

const EMPTY_FOLDER_STATE: ResearchFolderState = {
  folders: [],
  membership: {},
  starred: [],
  collapsed: [],
};

export function ResearchSidebarSection({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { filter, setFilter } = useVisibilityFilter();
  const includeArchived = filter !== "active";
  const summaries = useTreeSummaries({ workspaceId, includeArchived });
  const foldersQuery = useFolders(workspaceId);
  const rename = useRenameResearchTree();
  const archive = useArchiveResearchTree();
  const remove = useRemoveResearchTree();

  const activeTreeId = useRouterState({
    select: (state) => routeParam(state.matches.at(-1)?.params, "treeId"),
  });

  const selectedIds = useSelectionStore((state) => state.ids);
  const setSelection = useSelectionStore((state) => state.setSelection);
  const clearSelection = useSelectionStore((state) => state.clear);
  const anchorRef = useRef<string | null>(null);
  useOverlay(selectedIds.length > 0, MULTI_SELECT_OVERLAY_PRIORITY, clearSelection);

  // Memoized so the empty fallback is one object across renders: it feeds the
  // display-model memos below, and a fresh literal would rebuild them every
  // time the sidebar re-rendered for an unrelated reason.
  const folderState = useMemo<ResearchFolderState>(
    () => foldersQuery.data ?? EMPTY_FOLDER_STATE,
    [foldersQuery.data],
  );
  const all = useMemo(() => summaries.data ?? [], [summaries.data]);
  const trees = useMemo(() => all.filter((tree) => tree.archivedAt == null), [all]);
  const archivedTrees = useMemo(() => all.filter((tree) => tree.archivedAt != null), [all]);
  const visibleArchived = filter === "active" ? [] : archivedTrees;
  const activeListVisible = filter !== "archived";

  const lists = useMemo(
    () => buildResearchSidebarLists(trees, folderState, workspaceId),
    [trees, folderState, workspaceId],
  );
  const displayOrderIds = useMemo(
    () => [
      ...flattenVisibleResearchSidebarUnits(lists.starred, folderState),
      ...flattenVisibleResearchSidebarUnits(lists.main, folderState),
    ],
    [lists, folderState],
  );

  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<ResearchFolder | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<ResearchFolder | null>(null);
  const [dissolving, setDissolving] = useState<ResearchFolder | null>(null);
  const [pendingFolder, setPendingFolder] = useState<PendingFolder | null>(null);

  const sectionRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const suppressClickRef = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const writeFolders = useCallback(
    (next: ResearchFolderState) => void applyFolderState(client, workspaceId, next),
    [client, workspaceId],
  );
  const writeOrder = useCallback(
    (archived: boolean, treeIds: string[]) =>
      void applyTreeOrder(client, workspaceId, archived, treeIds),
    [client, workspaceId],
  );

  const openTree = useCallback(
    (treeId: string) => {
      void navigate({
        to: "/r/$treeId",
        params: { treeId },
        search: workspaceId === "" ? {} : { ws: workspaceId },
      });
    },
    [navigate, workspaceId],
  );

  /* ---------------------------------------------------------------------
   * Multi-select
   * ------------------------------------------------------------------ */

  const updateSelection = useCallback(
    (treeId: string, range: boolean) => {
      const ids = displayOrderIds;
      if (!ids.includes(treeId)) return;
      if (range) {
        const anchorCandidate =
          anchorRef.current && ids.includes(anchorRef.current)
            ? anchorRef.current
            : activeTreeId && ids.includes(activeTreeId)
              ? activeTreeId
              : treeId;
        anchorRef.current = anchorCandidate;
        const from = ids.indexOf(anchorCandidate);
        const to = ids.indexOf(treeId);
        const [start, end] = from <= to ? [from, to] : [to, from];
        setSelection(ids.slice(start, end + 1));
        return;
      }
      // A toggle that starts a fresh selection folds the open thread in, so
      // Cmd-clicking a second row reads as "these two".
      const base =
        selectedIds.length > 0
          ? selectedIds.filter((id) => ids.includes(id))
          : activeTreeId && ids.includes(activeTreeId) && activeTreeId !== treeId
            ? [activeTreeId]
            : [];
      anchorRef.current = treeId;
      setSelection(base.includes(treeId) ? base.filter((id) => id !== treeId) : [...base, treeId]);
    },
    [activeTreeId, displayOrderIds, selectedIds, setSelection],
  );

  const selectFromClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>, treeId: string, archived: boolean) => {
      if (suppressClickRef.current || event.detail > 1) return;
      if (!archived && (event.shiftKey || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        updateSelection(treeId, event.shiftKey);
        return;
      }
      if (selectedIds.length > 0) clearSelection();
      anchorRef.current = archived ? null : treeId;
      openTree(treeId);
    },
    [clearSelection, openTree, selectedIds.length, updateSelection],
  );

  /* ---------------------------------------------------------------------
   * Folder actions
   * ------------------------------------------------------------------ */

  const createFolder = (name: string, treeIds: string[]) => {
    writeFolders(createResearchFolder(folderState, workspaceId, treeIds, name).state);
    if (treeIds.length > 0) clearSelection();
  };

  const removeFromFolders = (treeIds: string[]) => {
    writeFolders(removeTreesFromResearchFolderMembership(folderState, treeIds));
  };

  const toggleStar = (id: string) => writeFolders(toggleResearchStar(folderState, id));

  const setCollapsed = (folderId: string, collapsed: boolean) =>
    writeFolders(setResearchFolderCollapsed(folderState, folderId, collapsed));

  const memberTrees = (folderId: string) =>
    [...trees, ...archivedTrees].filter((tree) => folderState.membership[tree.id] === folderId);

  /**
   * Applies a per-thread write across a selection, one at a time.
   *
   * A refusal is a property of a thread, not of the batch — archiving is
   * refused while that thread has a run in flight — so one refusal must not
   * strand the rest of the selection unprocessed. Every thread is attempted and
   * the count that failed is what the caller reports.
   */
  const applyToMany = async (
    treeIds: string[],
    write: (treeId: string) => Promise<unknown>,
  ): Promise<number> => {
    let failed = 0;
    for (const treeId of treeIds) {
      try {
        await write(treeId);
      } catch {
        failed += 1;
      }
    }
    return failed;
  };

  const archiveMany = (treeIds: string[]) =>
    applyToMany(treeIds, (treeId) => archive.mutateAsync({ treeId, archived: true }));

  const removeMany = (treeIds: string[]) =>
    applyToMany(treeIds, (treeId) => remove.mutateAsync(treeId));

  /** "3 of 5 could not be archived", or nothing when they all went through. */
  const reportBatch = (verb: "archived" | "deleted", failed: number, total: number) => {
    if (failed === 0) return;
    pushErrorToast(
      `Failed to ${verb === "archived" ? "archive" : "delete"} ${failed} of ${total} items`,
      new Error(
        failed === total
          ? `None of the ${total} items could be ${verb}.`
          : `Successfully ${verb} ${total - failed} of ${total} items; remaining items failed.`,
      ),
    );
  };

  /* ---------------------------------------------------------------------
   * Drag reorder
   * ------------------------------------------------------------------ */

  function clearDrag() {
    dragRef.current = null;
    dropRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
  }

  function computeDropTarget(
    clientX: number,
    clientY: number,
    drag: PointerDrag,
  ): DropTarget | null {
    const section = sectionRef.current;
    if (!section) return null;

    if (drag.scope.kind === "archived") {
      const dragIndex = visibleArchived.findIndex((tree) => tree.id === drag.id);
      if (dragIndex < 0) return null;
      const rows = [...section.querySelectorAll<HTMLElement>('[data-research-archived="true"]')];
      for (const [index, row] of rows.entries()) {
        const rect = row.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          return index === dragIndex || index === dragIndex + 1
            ? null
            : { kind: "gap", scope: drag.scope, index };
        }
      }
      return rows.length === dragIndex || rows.length === dragIndex + 1
        ? null
        : { kind: "gap", scope: drag.scope, index: rows.length };
    }

    const draggedTree = trees.find((tree) => tree.id === drag.id) ?? null;
    const unitGap = (list: "units" | "starred", index: number): DropTarget | null => {
      const units = list === "starred" ? lists.starred : lists.main;
      const dragIndex = units.findIndex((unit) => researchSidebarUnitId(unit) === drag.id);
      if (drag.scope.kind === list && (index === dragIndex || index === dragIndex + 1)) return null;
      return { kind: "gap", scope: { kind: list }, index };
    };

    const hit = document.elementFromPoint(clientX, clientY);
    const row = hit?.closest<HTMLElement>("[data-research-row]") ?? null;
    const hitRow = row && section.contains(row) ? row : null;

    const memberFolderId = hitRow?.dataset["researchFolderMember"];
    if (draggedTree && memberFolderId) {
      const unit = [...lists.starred, ...lists.main].find(
        (candidate) => candidate.kind === "folder" && candidate.folder.id === memberFolderId,
      );
      if (unit?.kind === "folder") {
        const memberIndex = unit.trees.findIndex(
          (tree) => tree.id === hitRow.dataset["researchTreeId"],
        );
        const rect = hitRow.getBoundingClientRect();
        const index = memberIndex + (clientY >= rect.top + rect.height / 2 ? 1 : 0);
        const dragIndex = unit.trees.findIndex((tree) => tree.id === drag.id);
        if (
          drag.scope.kind === "folder" &&
          memberFolderId === drag.scope.folderId &&
          (index === dragIndex || index === dragIndex + 1)
        ) {
          return null;
        }
        return { kind: "folder", folderId: memberFolderId, index, onHeader: false };
      }
    }

    const headerFolderId = hitRow?.dataset["researchFolderId"];
    if (hitRow && headerFolderId) {
      const list = hitRow.dataset["researchStarIndex"] === undefined ? "units" : "starred";
      const unitIndex = Number(
        list === "starred"
          ? hitRow.dataset["researchStarIndex"]
          : hitRow.dataset["researchUnitIndex"],
      );
      const rect = hitRow.getBoundingClientRect();
      const edge = Math.min(6, rect.height * 0.25);
      if (!draggedTree) {
        return unitGap(list, unitIndex + (clientY >= rect.top + rect.height / 2 ? 1 : 0));
      }
      if (clientY < rect.top + edge || clientY > rect.bottom - edge) {
        return unitGap(list, unitIndex + (clientY > rect.bottom - edge ? 1 : 0));
      }
      const target = [...lists.starred, ...lists.main].find(
        (unit) => unit.kind === "folder" && unit.folder.id === headerFolderId,
      );
      if (target?.kind === "folder") {
        return {
          kind: "folder",
          folderId: headerFolderId,
          index: target.trees.length,
          onHeader: true,
        };
      }
    }

    if (hitRow && !memberFolderId) {
      const list = hitRow.dataset["researchStarIndex"] !== undefined ? "starred" : "units";
      // Prevent cross-list drops into the starred section. Items enter it only
      // through the star action.
      if (draggedTree && list === "starred" && drag.scope.kind !== "starred") return null;
      const index = Number(
        list === "starred"
          ? hitRow.dataset["researchStarIndex"]
          : hitRow.dataset["researchUnitIndex"],
      );
      const rect = hitRow.getBoundingClientRect();
      return unitGap(list, index + (clientY >= rect.top + rect.height / 2 ? 1 : 0));
    }

    const list = drag.scope.kind === "starred" ? "starred" : "units";
    return unitGap(list, (list === "starred" ? lists.starred : lists.main).length);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>, id: string, scope: DragScope) {
    if (
      !isOwnRowEvent(event) ||
      event.button !== 0 ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      inRowButton(event)
    ) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      id,
      scope,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_START_THRESHOLD
      ) {
        return;
      }
      drag.active = true;
      setDraggingId(drag.id);
    }
    event.preventDefault();
    const target = computeDropTarget(event.clientX, event.clientY, drag);
    dropRef.current = target;
    setDropTarget(target);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.active) {
      dragRef.current = null;
      return;
    }
    event.preventDefault();
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, DRAG_CLICK_SUPPRESS_MS);
    const target = dropRef.current ?? computeDropTarget(event.clientX, event.clientY, drag);
    clearDrag();
    if (target) applyDrop(drag, target);
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId === event.pointerId) clearDrag();
  }

  function applyDrop(drag: PointerDrag, target: DropTarget) {
    if (drag.scope.kind === "archived" && target.kind === "gap") {
      const current = visibleArchived.map((tree) => tree.id);
      const next = moveResearchTreeIdToGap(current, drag.id, target.index);
      if (next !== current) writeOrder(true, next);
      return;
    }
    const draggedTree = trees.find((tree) => tree.id === drag.id) ?? null;

    if (target.kind === "folder" && draggedTree) {
      const proposedState = addTreesToResearchFolder(folderState, target.folderId, [drag.id]);
      const proposed = buildResearchSidebarLists(trees, proposedState, workspaceId);
      const targetIsStarred = proposed.starred.some(
        (unit) => unit.kind === "folder" && unit.folder.id === target.folderId,
      );
      const currentTarget = findFolderUnit([...lists.starred, ...lists.main], target.folderId);
      const proposedTarget = findFolderUnit(
        [...proposed.starred, ...proposed.main],
        target.folderId,
      );
      const insertedIntoTarget =
        currentTarget !== null && !currentTarget.trees.some((tree) => tree.id === drag.id);
      const proposedMemberIndex = proposedTarget
        ? proposedTarget.trees.findIndex((tree) => tree.id === drag.id)
        : -1;
      const targetIndex = insertedIntoTarget
        ? translateResearchGapAfterInsertion(target.index, proposedMemberIndex)
        : target.index;
      const moved = moveResearchFolderMemberToGap(
        targetIsStarred ? proposed.starred : proposed.main,
        target.folderId,
        drag.id,
        targetIndex,
      );
      // Membership and the star are one folder write; the order is the other.
      let nextState = proposedState;
      if (isResearchStarred(folderState, drag.id))
        nextState = toggleResearchStar(nextState, drag.id);
      writeFolders(nextState);
      if (moved) {
        writeOrder(false, [
          ...flattenResearchSidebarUnits(targetIsStarred ? moved : proposed.starred),
          ...flattenResearchSidebarUnits(targetIsStarred ? proposed.main : moved),
        ]);
      }
      return;
    }

    if (target.kind !== "gap") return;

    if (drag.scope.kind === "starred" && target.scope.kind === "starred") {
      // Starred item order is stored in client folder state rather than the
      // server list order.
      const current = lists.starred.map(researchSidebarUnitId);
      const next = moveResearchTreeIdToGap(current, drag.id, target.index);
      if (next !== current) {
        writeFolders({
          ...folderState,
          starred: withDisplayedStarOrder(folderState.starred, next),
        });
      }
      return;
    }
    if (target.scope.kind !== "units") return;

    const proposedState = draggedTree
      ? removeTreesFromResearchFolderMembership(folderState, [drag.id])
      : folderState;
    const proposed = buildResearchSidebarLists(trees, proposedState, workspaceId);
    const sourceFolder =
      drag.scope.kind === "folder"
        ? findFolderUnit([...lists.starred, ...lists.main], drag.scope.folderId)
        : null;
    // Extracting a member adds a top-level unit without removing its still
    // populated source folder, so a gap measured before the extraction moves
    // one slot right.
    const extractionAddsUnit =
      sourceFolder !== null &&
      (sourceFolder.trees.length > 1 || !lists.main.includes(sourceFolder));
    const proposedDragIndex = proposed.main.findIndex(
      (unit) => researchSidebarUnitId(unit) === drag.id,
    );
    const targetIndex = extractionAddsUnit
      ? translateResearchGapAfterInsertion(target.index, proposedDragIndex)
      : target.index;
    const moved = moveResearchUnitToGap(proposed.main, drag.id, targetIndex);
    if (draggedTree && folderState.membership[drag.id]) writeFolders(proposedState);
    if (moved) {
      writeOrder(false, [
        ...flattenResearchSidebarUnits(proposed.starred),
        ...flattenResearchSidebarUnits(moved),
      ]);
    }
  }

  /* ---------------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------------ */

  const treeMenuProps = (tree: ResearchTreeSummary, archived: boolean) => ({
    tree,
    archived,
    folderState,
    onToggleStar: toggleStar,
    onRename: setRenamingTree,
    onArchive: (treeId: string) => archive.mutate({ treeId, archived: true }),
    onRestore: (treeId: string) => archive.mutate({ treeId, archived: false }),
    onDelete: setDeletingTree,
    onRemoveFromFolder: removeFromFolders,
    onRequestCreateFolder: (treeIds: string[]) => setPendingFolder({ treeIds }),
  });

  const multiSelectionItems = (
    <>
      <IconMenuItem
        icon={<FolderPlus size={ICON} aria-hidden="true" />}
        label={`New folder with ${selectedIds.length} items`}
        onClick={() => setPendingFolder({ treeIds: selectedIds })}
      />
      {selectedIds.some((id) => Boolean(folderState.membership[id])) ? (
        <IconMenuItem
          icon={<FolderMinus size={ICON} aria-hidden="true" />}
          label="Remove from folders"
          onClick={() => removeFromFolders(selectedIds)}
        />
      ) : null}
      <MenuSeparator />
      <IconMenuItem
        icon={<Archive size={ICON} aria-hidden="true" />}
        label="Archive"
        onClick={() => {
          const ids = [...selectedIds];
          clearSelection();
          void archiveMany(ids).then((failed) => reportBatch("archived", failed, ids.length));
        }}
      />
      <IconMenuItem
        icon={<Trash2 size={ICON} aria-hidden="true" />}
        label="Delete"
        tone="danger"
        onClick={() => {
          const ids = [...selectedIds];
          clearSelection();
          void removeMany(ids).then((failed) => reportBatch("deleted", failed, ids.length));
        }}
      />
    </>
  );

  function renderTreeRow(
    tree: ResearchTreeSummary,
    options: {
      archived: boolean;
      dragScope: DragScope;
      unitIndex?: number;
      unitList?: "units" | "starred";
      folderId?: string;
      dropClass?: string;
    },
  ) {
    const { archived } = options;
    const starred = isResearchStarred(folderState, tree.id);
    const selected = activeTreeId === tree.id;
    const multi = !archived && selectedIds.includes(tree.id);
    const inSelectionMenu = multi && selectedIds.length > 1;
    return (
      <ContextMenu
        key={tree.id}
        label={
          inSelectionMenu
            ? `Actions for ${selectedIds.length} selected items`
            : `Actions for ${tree.title}`
        }
        items={
          inSelectionMenu ? (
            multiSelectionItems
          ) : (
            <ResearchTreeMenuItems {...treeMenuProps(tree, archived)} />
          )
        }
      >
        <div
          data-research-row
          data-research-tree-id={tree.id}
          data-research-archived={archived ? "true" : "false"}
          {...(options.unitList === "units" && options.unitIndex !== undefined
            ? { "data-research-unit-index": options.unitIndex }
            : {})}
          {...(options.unitList === "starred" && options.unitIndex !== undefined
            ? { "data-research-star-index": options.unitIndex }
            : {})}
          {...(options.folderId === undefined
            ? {}
            : { "data-research-folder-member": options.folderId })}
          className={cn(
            SIDEBAR_ROW,
            selected && SIDEBAR_ROW_SELECTED,
            multi && SIDEBAR_ROW_MULTI,
            options.folderId !== undefined && "pl-6",
            archived && "text-fg-muted",
            draggingId === tree.id && "opacity-50",
            options.dropClass,
          )}
          role="button"
          tabIndex={0}
          aria-current={selected ? "page" : undefined}
          title={tree.title}
          onPointerDown={(event) => onPointerDown(event, tree.id, options.dragScope)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onClick={(event) => {
            if (!isOwnRowEvent(event) || inRowButton(event)) return;
            selectFromClick(event, tree.id, archived);
          }}
          onKeyDown={(event) => {
            // The row and its ⋯ button are separate stops for the keyboard, so
            // Enter on the button must open the menu and nothing else.
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openTree(tree.id);
          }}
          onDoubleClick={
            archived
              ? undefined
              : (event) => {
                  if (!isOwnRowEvent(event) || inRowButton(event)) return;
                  setRenamingTree(tree);
                }
          }
        >
          <StatusDot tree={tree} archived={archived} />
          {tree.kind === "document" ? (
            <FileText size={12} aria-hidden="true" className="text-fg-subtle shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{tree.title}</span>
          {!archived && tree.runningCount > 0 ? (
            <span
              className="text-status-active flex shrink-0 items-center gap-1 text-xs"
              title={`${tree.runningCount} running`}
            >
              <LoaderCircle size={12} className="session-spin" aria-hidden="true" />
              {tree.runningCount > 1 ? tree.runningCount : null}
            </span>
          ) : !archived && tree.hasUnseenFailure ? (
            <span
              className="text-status-failed shrink-0 text-xs"
              title="Failed since last viewed — open to acknowledge"
            >
              !
            </span>
          ) : !archived && tree.hasUnseenUpdate ? (
            <span
              className="text-status-attention shrink-0 text-xs"
              title="Updated since last viewed"
            >
              New
            </span>
          ) : null}
          {starred ? (
            <Star size={12} aria-hidden="true" className="text-fg-subtle shrink-0" />
          ) : null}
          <Menu
            label={`Actions for ${tree.title}`}
            side="bottom"
            align="end"
            trigger={
              <IconButton label={`Actions for ${tree.title}`} className="shrink-0">
                <MoreHorizontal size={14} aria-hidden="true" />
              </IconButton>
            }
          >
            <ResearchTreeMenuItems {...treeMenuProps(tree, archived)} />
          </Menu>
        </div>
      </ContextMenu>
    );
  }

  function renderUnit(unit: ResearchSidebarUnit, unitIndex: number, list: "units" | "starred") {
    const units = list === "starred" ? lists.starred : lists.main;
    const scope: DragScope = { kind: list };
    if (unit.kind === "tree") {
      return renderTreeRow(unit.tree, {
        archived: false,
        dragScope: scope,
        unitIndex,
        unitList: list,
        dropClass: gapClass(dropTarget, list, unitIndex, units.length, "only"),
      });
    }
    const { folder } = unit;
    const collapsed = folderState.collapsed.includes(folder.id);
    const folderStarred = isResearchStarred(folderState, folder.id);
    const hasRunning = memberTrees(folder.id).some((tree) => tree.runningCount > 0);
    return (
      <div key={folder.id} role="group" aria-label={`${folder.name} (${unit.trees.length})`}>
        <ContextMenu
          label={`Actions for ${folder.name}`}
          items={
            <FolderMenuItems
              folder={folder}
              starred={folderStarred}
              memberCount={memberTrees(folder.id).length}
              hasRunning={hasRunning}
              onToggleStar={toggleStar}
              onRename={setRenamingFolder}
              onDissolve={setDissolving}
              onArchive={() => {
                const ids = memberTrees(folder.id).map((tree) => tree.id);
                void archiveMany(ids).then((failed) => reportBatch("archived", failed, ids.length));
              }}
              onDelete={setDeletingFolder}
            />
          }
        >
          <div
            data-research-row
            data-research-folder-id={folder.id}
            role="button"
            tabIndex={0}
            aria-expanded={!collapsed}
            {...(list === "units" ? { "data-research-unit-index": unitIndex } : {})}
            {...(list === "starred" ? { "data-research-star-index": unitIndex } : {})}
            className={cn(
              SIDEBAR_ROW,
              draggingId === folder.id && "opacity-50",
              dropTarget?.kind === "folder" &&
                dropTarget.folderId === folder.id &&
                dropTarget.onHeader
                ? "ring-focus-ring ring-1 ring-inset"
                : null,
              gapClass(
                dropTarget,
                list,
                unitIndex,
                units.length,
                collapsed || unit.trees.length === 0 ? "only" : "first",
              ),
            )}
            onPointerDown={(event) => onPointerDown(event, folder.id, scope)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onClick={(event) => {
              if (!isOwnRowEvent(event) || suppressClickRef.current || inRowButton(event)) {
                return;
              }
              setCollapsed(folder.id, !collapsed);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setCollapsed(folder.id, !collapsed);
            }}
          >
            <button
              type="button"
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${folder.name}`}
              aria-expanded={!collapsed}
              className="text-fg-subtle shrink-0 border-0 bg-transparent p-0"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed(folder.id, !collapsed);
              }}
            >
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={cn("transition-transform duration-[120ms]", !collapsed && "rotate-90")}
              />
            </button>
            <Folder size={12} aria-hidden="true" className="text-fg-subtle shrink-0" />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="text-fg-disabled shrink-0 text-xs">{unit.trees.length}</span>
            {folderStarred ? (
              <Star size={12} aria-hidden="true" className="text-fg-subtle shrink-0" />
            ) : null}
            <Menu
              label={`Actions for ${folder.name}`}
              side="bottom"
              align="end"
              trigger={
                <IconButton label={`Actions for ${folder.name}`} className="shrink-0">
                  <MoreHorizontal size={14} aria-hidden="true" />
                </IconButton>
              }
            >
              <FolderMenuItems
                folder={folder}
                starred={folderStarred}
                memberCount={memberTrees(folder.id).length}
                hasRunning={hasRunning}
                onToggleStar={toggleStar}
                onRename={setRenamingFolder}
                onDissolve={setDissolving}
                onArchive={() => {
                  const ids = memberTrees(folder.id).map((tree) => tree.id);
                  void archiveMany(ids).then((failed) =>
                    reportBatch("archived", failed, ids.length),
                  );
                }}
                onDelete={setDeletingFolder}
              />
            </Menu>
          </div>
        </ContextMenu>
        {collapsed
          ? null
          : unit.trees.map((tree, memberIndex) =>
              renderTreeRow(tree, {
                archived: false,
                dragScope: { kind: "folder", folderId: folder.id },
                unitIndex,
                unitList: list,
                folderId: folder.id,
                dropClass: cn(
                  memberDropClass(dropTarget, folder.id, memberIndex, unit.trees.length),
                  memberIndex === unit.trees.length - 1
                    ? gapClass(dropTarget, list, unitIndex, units.length, "last")
                    : undefined,
                ),
              }),
            )}
      </div>
    );
  }

  return (
    <section
      ref={sectionRef}
      aria-label="Research"
      className="flex min-w-0 flex-col gap-px px-2 pt-3"
    >
      <div className={SIDEBAR_SECTION_HEADING}>
        <span>Research</span>
        <span className="flex items-center gap-1">
          <Menu
            label="Show"
            side="bottom"
            align="end"
            trigger={
              <button
                type="button"
                aria-label={`Show ${filter} research`}
                title={`Show ${filter} research`}
                className={cn(ICON_BUTTON, "h-control-sm px-1 text-xs capitalize")}
              >
                {filter}
              </button>
            }
          >
            {(["active", "archived", "all"] as const).map((option) => (
              <MenuItem
                key={option}
                onClick={() => setFilter(option)}
                hint={filter === option ? "✓" : undefined}
              >
                <span className="capitalize">{option}</span>
              </MenuItem>
            ))}
          </Menu>
          <IconButton
            label="New research folder"
            title="New folder"
            disabled={workspaceId === ""}
            onClick={() => setPendingFolder({ treeIds: [] })}
          >
            <FolderPlus size={ICON} aria-hidden="true" />
          </IconButton>
        </span>
      </div>

      {selectedIds.length > 1 ? (
        <div className="text-fg-secondary flex items-center justify-between gap-2 px-2.5 py-1 text-xs">
          <span>{selectedIds.length} selected</span>
          <button
            type="button"
            className="text-fg-interactive border-0 bg-transparent p-0 underline-offset-2 hover:underline"
            onClick={clearSelection}
          >
            Clear
          </button>
        </div>
      ) : null}

      {activeListVisible && lists.starred.length > 0 ? (
        <div role="group" aria-label="Starred research" className="flex flex-col gap-px">
          {lists.starred.map((unit, index) => renderUnit(unit, index, "starred"))}
        </div>
      ) : null}
      {activeListVisible ? lists.main.map((unit, index) => renderUnit(unit, index, "units")) : null}

      {visibleArchived.length > 0 ? (
        <>
          <div className={SIDEBAR_SECTION_HEADING}>
            <span>Archived</span>
            <span className="text-fg-disabled text-xs">{visibleArchived.length}</span>
          </div>
          {visibleArchived.map((tree, index) =>
            renderTreeRow(tree, {
              archived: true,
              dragScope: { kind: "archived" },
              dropClass: archivedDropClass(dropTarget, index, visibleArchived.length),
            }),
          )}
        </>
      ) : null}

      {summaries.isSuccess && all.length === 0 ? (
        <p className="text-fg-muted m-0 px-2.5 py-2 text-sm">No research yet.</p>
      ) : null}

      <NameDialog
        open={pendingFolder !== null}
        title="New folder"
        description={
          pendingFolder && pendingFolder.treeIds.length > 0
            ? `Create a folder with ${pendingFolder.treeIds.length} ${pendingFolder.treeIds.length === 1 ? "item" : "items"}.`
            : "Create an empty folder for research you want to organize later."
        }
        label="Folder name"
        confirmLabel="Create"
        onOpenChange={(open) => {
          if (!open) setPendingFolder(null);
        }}
        onSubmit={(name) => createFolder(name, pendingFolder?.treeIds ?? [])}
      />

      {renamingTree ? (
        <RenameTreeDialog
          tree={renamingTree}
          open
          onClose={() => setRenamingTree(null)}
          onRename={(treeId, title) => rename.mutate({ treeId, title })}
        />
      ) : null}

      <NameDialog
        open={renamingFolder !== null}
        title="Rename folder"
        label="Folder name"
        initialValue={renamingFolder?.name ?? ""}
        confirmLabel="Rename"
        onOpenChange={(open) => {
          if (!open) setRenamingFolder(null);
        }}
        onSubmit={(name) => {
          if (renamingFolder)
            writeFolders(renameResearchFolder(folderState, renamingFolder.id, name));
        }}
      />

      {deletingTree ? (
        <DeleteTreeDialog
          tree={deletingTree}
          open
          busy={remove.isPending}
          error={remove.error ? errorMessage(remove.error) : null}
          onClose={() => setDeletingTree(null)}
          onRemove={(treeId) => {
            remove.mutate(treeId, { onSuccess: () => setDeletingTree(null) });
          }}
        />
      ) : null}

      <AsyncConfirmDialog
        open={deletingFolder !== null}
        title={deletingFolder ? `Delete “${deletingFolder.name}”?` : "Delete folder?"}
        description={
          deletingFolder
            ? `This permanently deletes the folder and all ${memberTrees(deletingFolder.id).length} research items inside it, including their completed work and follow-up history. This can’t be undone.`
            : undefined
        }
        confirmLabel="Delete folder and items"
        pendingLabel="Deleting…"
        onOpenChange={(open) => {
          if (!open) setDeletingFolder(null);
        }}
        onConfirm={async () => {
          if (!deletingFolder) return;
          const ids = memberTrees(deletingFolder.id).map((tree) => tree.id);
          const failed = await removeMany(ids);
          if (failed > 0) {
            // The folder still holds whatever was refused, so it is not
            // dissolved; the dialog stays open with this as its error.
            throw new Error(
              failed === ids.length
                ? `Could not delete any of the ${ids.length} items.`
                : `Deleted ${ids.length - failed} of ${ids.length} items; remaining items failed.`,
            );
          }
          writeFolders(dissolveResearchFolder(folderState, deletingFolder.id));
        }}
      />

      <AsyncConfirmDialog
        open={dissolving !== null}
        title={dissolving ? `Ungroup “${dissolving.name}”?` : "Ungroup folder?"}
        description="Research in this folder will move back to the main list, and the folder will be deleted. No research will be lost."
        confirmLabel="Ungroup folder"
        tone="default"
        onOpenChange={(open) => {
          if (!open) setDissolving(null);
        }}
        onConfirm={async () => {
          if (dissolving)
            await applyFolderState(
              client,
              workspaceId,
              dissolveResearchFolder(folderState, dissolving.id),
            );
        }}
      />
    </section>
  );
}

function StatusDot({ tree, archived }: { tree: ResearchTreeSummary; archived: boolean }) {
  const tone = archived
    ? "bg-fg-disabled"
    : tree.runningCount > 0
      ? "bg-status-active"
      : tree.hasUnseenFailure || tree.failedCount > 0
        ? "bg-status-failed"
        : "bg-status-success";
  return <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tone)} />;
}

function FolderMenuItems({
  folder,
  starred,
  memberCount,
  hasRunning,
  onToggleStar,
  onRename,
  onDissolve,
  onArchive,
  onDelete,
}: {
  folder: ResearchFolder;
  starred: boolean;
  memberCount: number;
  hasRunning: boolean;
  onToggleStar: (id: string) => void;
  onRename: (folder: ResearchFolder) => void;
  onDissolve: (folder: ResearchFolder) => void;
  onArchive: () => void;
  onDelete: (folder: ResearchFolder) => void;
}) {
  return (
    <>
      <IconMenuItem
        icon={
          starred ? (
            <StarOff size={ICON} aria-hidden="true" />
          ) : (
            <Star size={ICON} aria-hidden="true" />
          )
        }
        label={starred ? "Unstar" : "Star"}
        onClick={() => onToggleStar(folder.id)}
      />
      <IconMenuItem
        icon={<Pencil size={ICON} aria-hidden="true" />}
        label="Rename"
        onClick={() => onRename(folder)}
      />
      <MenuSeparator />
      <IconMenuItem
        icon={<FolderMinus size={ICON} aria-hidden="true" />}
        label={`Remove ${memberCount} ${memberCount === 1 ? "item" : "items"}…`}
        onClick={() => onDissolve(folder)}
      />
      <MenuSeparator />
      <IconMenuItem
        icon={<Archive size={ICON} aria-hidden="true" />}
        label="Archive"
        disabled={hasRunning}
        title={hasRunning ? "Folders with active runs cannot be archived" : undefined}
        onClick={onArchive}
      />
      <IconMenuItem
        icon={<Trash2 size={ICON} aria-hidden="true" />}
        label="Delete"
        tone="danger"
        disabled={hasRunning}
        title={hasRunning ? "Folders with active runs cannot be deleted" : undefined}
        onClick={() => onDelete(folder)}
      />
    </>
  );
}

function findFolderUnit(
  units: ResearchSidebarUnit[],
  folderId: string,
): Extract<ResearchSidebarUnit, { kind: "folder" }> | null {
  const unit = units.find(
    (candidate) => candidate.kind === "folder" && candidate.folder.id === folderId,
  );
  return unit?.kind === "folder" ? unit : null;
}

/** Applies a new order for the starred entries currently on screen while
 * keeping stored entries that are not displayed (other scopes, archived) after
 * them (`replaceResearchStarOrder`). */
function withDisplayedStarOrder(stored: string[], displayed: string[]): string[] {
  const shown = new Set(displayed);
  return [...displayed, ...stored.filter((id) => !shown.has(id))];
}

function gapClass(
  target: DropTarget | null,
  list: "units" | "starred",
  unitIndex: number,
  length: number,
  role: "first" | "last" | "only",
): string | undefined {
  if (target?.kind !== "gap" || target.scope.kind !== list) return undefined;
  const before = target.index === unitIndex && (role === "first" || role === "only");
  const after =
    target.index === length && unitIndex === length - 1 && (role === "last" || role === "only");
  if (before) return "border-accent border-t";
  if (after) return "border-accent border-b";
  return undefined;
}

function memberDropClass(
  target: DropTarget | null,
  folderId: string,
  index: number,
  length: number,
): string | undefined {
  if (target?.kind !== "folder" || target.folderId !== folderId || target.onHeader)
    return undefined;
  if (target.index === index) return "border-accent border-t";
  if (target.index === length && index === length - 1) return "border-accent border-b";
  return undefined;
}

function archivedDropClass(
  target: DropTarget | null,
  index: number,
  length: number,
): string | undefined {
  if (target?.kind !== "gap" || target.scope.kind !== "archived") return undefined;
  if (target.index === index) return "border-accent border-t";
  if (target.index === length && index === length - 1) return "border-accent border-b";
  return undefined;
}
