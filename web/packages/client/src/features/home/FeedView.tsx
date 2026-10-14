// Home and the place views (the desktop's `ResearchActivityFeed.tsx`): Home
// lists the workspace's Unfiled threads, then one tray per folder, Drafts,
// Archive and Trash, and "+ New folder"; a folder, Drafts, Archive or Trash
// view lists that place alone. Cards nest one level under a question, note or
// document; a drag reorders, files or nests them (`useCardDrag`), and the
// card menu, ⌥↑/⌥↓, ⌥→ and ⌥← do the same from the keyboard.
//
// Card content is the thread's root entry (`useFeedRoot`), read per rendered
// card and batched per tick; the structure (order, places, groups) is the
// thread list and the folder state, as on the desktop.
//
// Web only: Shared with me lists the threads shared with the reader, with the
// invitations addressed to them. A shared thread can be filed in the
// reader's own folders and has their own Archive and Trash entries; its
// order and nesting are its owner's, and Delete leaves it.

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type {
  ResearchDraft,
  ResearchFolder,
  ResearchNodeContent,
  ResearchTreeSummary,
} from "@session/shared";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_TRASH_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchCardTitle,
  researchPlaceIsReorderable,
  researchPlaceName,
  researchFolderStateWithMembership,
  researchTreePlace,
  stepReorderTarget,
  type ResearchDropPosition,
} from "@session/shared/lib/researchFolders";
import {
  researchChildCount,
  researchGroupSummary,
  researchItemCount,
  researchNestCandidates,
  researchTreeGroups,
  researchTreeHoldsChildren,
} from "@session/shared/lib/researchGroups";
import { nodeType } from "@session/shared/lib/researchNodeTypes";
import { researchNoteEditable } from "@session/shared/lib/researchNoteEdit";
import { researchThreadKind, researchThreadState } from "@session/shared/lib/researchRowGlyph";
import {
  researchTrashCount,
  researchTrashEntries,
  type ResearchTrashEntry,
} from "@session/shared/lib/researchTrash";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FilePen,
  IndentDecrease,
  IndentIncrease,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { getResearchNodeContent } from "../../api/api.js";
import { invalidateKeys } from "../../api/cache.js";
import {
  useArchiveResearchTree,
  useSharedTrees,
  useDeleteResearchDraft,
  useEmptyResearchTrash,
  useFeedRoot,
  useMoveResearchDraft,
  useRenameResearchTree,
  useResearchDrafts,
  useResearchTrash,
} from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { pushErrorToast, pushToast } from "../../lib/toast.js";
import { useNavigationStore } from "../../stores/navigation.js";
import { AnchoredMenu, type MenuAnchor } from "../../ui/AnchoredMenu.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import { DeleteDialog } from "../../ui/DeleteDialog.js";
import { MenuGroupLabel, MenuItem, MenuSeparator } from "../../ui/Menu.js";
import { RowGlyph } from "../../ui/RowGlyph.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { RecapDialog } from "../research/RecapDialog.js";
import { ReceivedInvites } from "../sharing/ReceivedInvites.js";
import { IconMenuItem } from "../sidebar/menuRows.js";

import { CardBody, CardQuestion } from "./CardBody.js";
import { FeedCard, feedCardControl, type FeedCardGroup } from "./FeedCard.js";
import { FeedEmpty, FeedTray, placeEmptyText } from "./FeedTray.js";
import { useFolderDialogStore, useRequestFolderDelete } from "./FolderDialogsHost.js";
import { FEED_BUTTON, TrashList } from "./TrashList.js";
import {
  MoveToItems,
  TreeLifecycleItems,
  TreeRenameDialog,
  treeDeleteDialogProps,
} from "./TreeMenu.js";
import { feedText, shortName } from "./feedText.js";
import { countNewAbove, feedScrollBehavior, FEED_TOP_THRESHOLD } from "./useActivityFeedState.js";
import { useCardDrag } from "./useCardDrag.js";
import { commitFolderState, ownTree, useFiling } from "./useFiling.js";
import { useGroupActions } from "./useGroupActions.js";

/** The lists of the feed column. `shared` is the web's Shared with me. */
export type FeedPlaceView =
  | { kind: "home" }
  | { kind: "folder"; folderId: string }
  | { kind: "drafts" }
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "shared" };

/** Web only: the place id of Shared with me (cards' `data-research-place`;
 * it takes no drops). */
export const SHARED_PLACE_ID = "system:shared";

const EMPTY_DRAFTS: ResearchDraft[] = [];
const EMPTY_TREES: ResearchTreeSummary[] = [];

/** Each thread once, the first listing kept: a shared thread the reader
 * filed in a folder is in both the workspace's list and a shared list. */
function uniqueTrees(...lists: readonly (readonly ResearchTreeSummary[])[]): ResearchTreeSummary[] {
  const seen = new Set<string>();
  const out: ResearchTreeSummary[] = [];
  for (const list of lists) {
    for (const tree of list) {
      if (seen.has(tree.id)) continue;
      seen.add(tree.id);
      out.push(tree);
    }
  }
  return out;
}
/** The feed's rows: the open buttons of its cards. */
const FEED_ROW_SELECTOR = "[data-research-card-hit]";

/** What a key does on a focused card: Enter and → open its thread, as a
 * click does. Null for other keys and modified keys. Enter does not move
 * focus into the thread's follow-ups. */
export function feedRowOpenKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): "select" | "enter-thread" | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === "Enter") return "select";
  if (event.key === "ArrowRight") return "enter-thread";
  return null;
}

/** A roving tab stop over the feed's rows: one row is in the Tab order (the
 * last focused row while it is listed, else the first), and the … buttons
 * are reached from their row. */
function applyFeedRoving(root: HTMLElement | null, last: HTMLElement | null) {
  if (!root) return;
  const rows = [...root.querySelectorAll<HTMLElement>(FEED_ROW_SELECTOR)];
  const current = (last && rows.includes(last) ? last : null) ?? rows[0];
  for (const row of rows) row.tabIndex = row === current ? 0 : -1;
}

/** Archived threads newest-archived first, for the Archive. */
export function archivedFeedTrees(trees: readonly ResearchTreeSummary[]): ResearchTreeSummary[] {
  return trees
    .filter((tree) => tree.archivedAt != null)
    .sort(
      (left, right) =>
        (right.archivedAt ?? 0) - (left.archivedAt ?? 0) || left.id.localeCompare(right.id),
    );
}

function archivedTooltip(archivedAt: number | null | undefined): string | undefined {
  if (archivedAt == null) return undefined;
  return `Archived ${new Date(archivedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

export function feedViewTitle(view: FeedPlaceView, folders: ResearchFolder[]): string {
  switch (view.kind) {
    case "home":
      return "Home";
    case "drafts":
      return "Drafts";
    case "archive":
      return "Archive";
    case "trash":
      return "Trash";
    case "shared":
      return "Shared with me";
    case "folder":
      return researchPlaceName(view.folderId, folders);
  }
}

/** The place a view lists alone, or null for Home. */
function soloPlaceOf(view: FeedPlaceView): string | null {
  switch (view.kind) {
    case "drafts":
      return RESEARCH_DRAFTS_FOLDER_ID;
    case "archive":
      return RESEARCH_ARCHIVE_FOLDER_ID;
    case "trash":
      return RESEARCH_TRASH_FOLDER_ID;
    case "shared":
      return SHARED_PLACE_ID;
    case "folder":
      return view.folderId;
    default:
      return null;
  }
}

/** An open feed menu: a card's (`queryNodeId` names its root, for Generate
 * recap) or a draft's. `mode: "nest"` lists the parents for Make child of…. */
type FeedMenu =
  | { kind: "tree"; treeId: string; anchor: MenuAnchor; button: HTMLElement; mode?: "nest" }
  | { kind: "draft"; draftId: string; anchor: MenuAnchor; button: HTMLElement };

export interface FeedViewProps {
  view: FeedPlaceView;
  workspaceId: string;
  /** The ask box: at the top of Home, at the end of a folder or Drafts. */
  composer?: ReactNode;
  /** Header controls after the title (Home's feed switcher and import). */
  headerActions?: ReactNode;
  /** The draft open in its own view. */
  selectedDraftId?: string | null;
}

export function FeedView({
  view,
  workspaceId,
  composer,
  headerActions,
  selectedDraftId = null,
}: FeedViewProps) {
  // Opted out of the React Compiler: `useVirtualizer` returns functions that
  // cannot be memoized without going stale.
  "use no memo";

  const navigate = useNavigate();
  const filing = useFiling(workspaceId);
  const { folderState, folders, trees } = filing;
  const draftsQuery = useResearchDrafts(workspaceId);
  const drafts = draftsQuery.data ?? EMPTY_DRAFTS;
  const trashQuery = useResearchTrash(workspaceId);
  const trashTrees = trashQuery.data ?? EMPTY_TREES;
  // Web only: the threads shared with the reader, outside their Archive and
  // Trash, in their Archive, and in their Trash.
  const sharedTrees = useSharedTrees("shared").data ?? EMPTY_TREES;
  const sharedArchive = useSharedTrees("archive").data ?? EMPTY_TREES;
  const sharedTrash = useSharedTrees("trash").data ?? EMPTY_TREES;
  const group = useGroupActions(filing, trashTrees);
  const queryClient = useQueryClient();
  const archiveTree = useArchiveResearchTree();
  const renameTree = useRenameResearchTree();
  const deleteDraft = useDeleteResearchDraft();
  const moveDraftMutation = useMoveResearchDraft();
  const emptyTrash = useEmptyResearchTrash();
  const requestFolderDelete = useRequestFolderDelete();
  const openNewFolder = useFolderDialogStore((state) => state.openNew);
  const openRenameFolder = useFolderDialogStore((state) => state.openRename);

  const [menu, setMenu] = useState<FeedMenu | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announce = (message: string) =>
    setAnnouncement((current) => (current === message ? `${message}\u00a0` : message));
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  // Home's Trash tray starts collapsed; opening it is not saved, as on the
  // desktop (`ResearchActivityFeed`'s `trashTrayOpen`).
  const [trashTrayOpen, setTrashTrayOpen] = useState(false);
  const [deletingTrashEntry, setDeletingTrashEntry] = useState<ResearchTrashEntry | null>(null);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [recapContent, setRecapContent] = useState<ResearchNodeContent | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rovingRowRef = useRef<HTMLElement | null>(null);
  // After every render: rows come and go with views, trays and pages.
  useLayoutEffect(() => applyFeedRoving(scrollRef.current, rovingRowRef.current));

  const treeById = useMemo(
    () =>
      new Map(
        uniqueTrees(trees, sharedTrees, sharedArchive, sharedTrash).map((tree) => [tree.id, tree]),
      ),
    [sharedArchive, sharedTrash, sharedTrees, trees],
  );
  const archivedTrees = useMemo(
    () => archivedFeedTrees(uniqueTrees(trees, sharedArchive)),
    [sharedArchive, trees],
  );
  const activeTrees = useMemo(() => trees.filter((tree) => tree.archivedAt == null), [trees]);
  const parents = folderState.parents;
  const collapsedGroups = useMemo(
    () => new Set(folderState.collapsedGroups),
    [folderState.collapsedGroups],
  );
  const placeOf = useCallback(
    (tree: ResearchTreeSummary) => researchTreePlace(tree, folderState),
    [folderState],
  );
  // A shared thread's nesting is its owner's: it neither holds nor joins a
  // group of the reader's.
  const treeHoldsChildren = (treeId: string) => {
    const tree = treeById.get(treeId);
    return researchTreeHoldsChildren(tree?.type) && (!tree || ownTree(tree));
  };

  /** A place's threads in the flat order (not the Archive's). */
  const treesIn = useCallback(
    (place: string) => activeTrees.filter((tree) => placeOf(tree) === place),
    [activeTrees, placeOf],
  );
  const groupsIn = (place: string) => researchTreeGroups(treesIn(place), parents);

  // Home's Unfiled list, virtualized: one row per top-level thread with its
  // children.
  const listed = view.kind === "home";
  const rows = useMemo(
    () =>
      listed
        ? researchTreeGroups(
            activeTrees.filter((tree) => placeOf(tree) === RESEARCH_UNFILED_FOLDER_ID),
            parents,
          )
        : [],
    [activeTrees, listed, parents, placeOf],
  );
  // "N new activities": threads that arrived above the list's first row
  // while the reader was scrolled away from the top (the desktop's
  // `newActivityCount`); scrolling back to the top or the button clears it.
  const [newActivityCount, setNewActivityCount] = useState(0);
  const knownRowIdsRef = useRef<ReadonlySet<string> | null>(null);
  const previousTopRowRef = useRef<string | null>(null);
  useEffect(() => {
    const ids = rows.map((row) => row.tree.id);
    const known = knownRowIdsRef.current;
    if (known) {
      const added = countNewAbove(previousTopRowRef.current, ids, known);
      if (added > 0 && (scrollRef.current?.scrollTop ?? 0) > FEED_TOP_THRESHOLD) {
        setNewActivityCount((count) => count + added);
      }
    }
    knownRowIdsRef.current = new Set(ids);
    previousTopRowRef.current = ids[0] ?? null;
  }, [rows]);
  const topLevelIdsIn = (place: string): string[] =>
    place === RESEARCH_UNFILED_FOLDER_ID
      ? rows.map((row) => row.tree.id)
      : groupsIn(place).map((entry) => entry.tree.id);

  // A member's Trash also holds the shared threads they moved there, from
  // any workspace: Empty Trash leaves them all.
  const trashEntries = useMemo(() => {
    const own = researchTrashEntries(trashTrees, folderState.folders, workspaceId);
    const ownIds = new Set(own.map((entry) => entry.id));
    const shared: ResearchTrashEntry[] = sharedTrash
      .filter((tree) => !ownIds.has(tree.id))
      .map((tree) => ({
        kind: "tree",
        id: tree.id,
        title: tree.title,
        trashedAt: tree.trashedAt ?? 0,
        tree,
      }));
    return [...own, ...shared].sort(
      (left, right) => right.trashedAt - left.trashedAt || left.id.localeCompare(right.id),
    );
  }, [folderState.folders, sharedTrash, trashTrees, workspaceId]);

  /* ---------------------------------------------------------------------
   * Navigation
   * ------------------------------------------------------------------ */

  const wsSearch = (previous: Record<string, unknown>) => ({
    ws: (previous["ws"] as string | undefined) ?? workspaceId,
  });
  const openTree = (treeId: string) =>
    void navigate({ to: "/r/$treeId", params: { treeId }, search: wsSearch });
  // A double-click on a note's card opens the thread with the note in the
  // editor (the desktop's researchNoteDoubleClick).
  const editNote = (treeId: string, nodeId: string) =>
    void navigate({
      to: "/r/$treeId",
      params: { treeId },
      search: { ...wsSearch, node: nodeId, edit: nodeId },
    });
  const openDraft = (draft: ResearchDraft) =>
    void navigate({ to: "/drafts/$draftId", params: { draftId: draft.id }, search: wsSearch });
  const openPlace = (place: string) => {
    if (place === RESEARCH_DRAFTS_FOLDER_ID) void navigate({ to: "/drafts", search: wsSearch });
    else if (place === RESEARCH_ARCHIVE_FOLDER_ID)
      void navigate({ to: "/archive", search: wsSearch });
    else if (place === RESEARCH_TRASH_FOLDER_ID) void navigate({ to: "/trash", search: wsSearch });
    else void navigate({ to: "/f/$folderId", params: { folderId: place }, search: wsSearch });
  };
  const goHome = () => void navigate({ to: "/", search: wsSearch });

  /* ---------------------------------------------------------------------
   * Drag and drop
   * ------------------------------------------------------------------ */

  const onDragStart = useCardDrag({
    onMoveTree: (treeId, place, position) => moveTreeFromDrop(treeId, place, position),
    onMoveDraft: (draftId, beforeId) => moveDraft(draftId, beforeId),
    onNestTree: (treeId, parentId, beforeId) => {
      const tree = treeById.get(treeId);
      const parent = treeById.get(parentId);
      if ((tree && !ownTree(tree)) || (parent && !ownTree(parent))) {
        announce("Shared threads can’t be nested.");
        return;
      }
      group.nestTree(treeId, parentId, beforeId);
    },
    onSpringOpen: (place) => {
      if (place === RESEARCH_TRASH_FOLDER_ID) return;
      filing.setTrayCollapsed(place, false);
    },
    onSpringOpenGroup: (parentId) => filing.setGroupsCollapsed([parentId], false),
  });

  /** A drop between cards may name a card after the last rendered one
   * (`afterId`, a virtualized list); the place's own list resolves it. */
  function moveTreeFromDrop(treeId: string, place: string, position: ResearchDropPosition | null) {
    const tree = treeById.get(treeId);
    if (tree && !ownTree(tree)) {
      void fileSharedTree(tree, place);
      return;
    }
    group.moveTree(treeId, place, position);
  }

  /** Web only: files a shared thread in one of the reader's folders, takes
   * it out of them (back to Shared with me alone), or moves it to their
   * Archive. Its order among the owner's threads is not the reader's. */
  async function fileSharedTree(tree: ResearchTreeSummary, place: string) {
    const current = sharedPlaceOf(tree);
    if (place === current) return;
    if (place === RESEARCH_DRAFTS_FOLDER_ID) {
      pushToast({ title: "Shared threads can’t be filed in Drafts.", tone: "info" });
      return;
    }
    try {
      if (place === RESEARCH_ARCHIVE_FOLDER_ID) {
        await archiveTree.mutateAsync({ treeId: tree.id, archived: true });
      } else {
        if (tree.archivedAt != null) {
          await archiveTree.mutateAsync({ treeId: tree.id, archived: false });
        }
        const target = place === SHARED_PLACE_ID ? RESEARCH_UNFILED_FOLDER_ID : place;
        await commitFolderState(queryClient, workspaceId, (state) =>
          researchFolderStateWithMembership(state, tree.id, target),
        );
      }
      invalidateKeys(queryClient, ["trees"], ["shared"]);
      const name =
        place === SHARED_PLACE_ID || place === RESEARCH_UNFILED_FOLDER_ID
          ? "Shared with me"
          : researchPlaceName(place, folders);
      pushToast({ title: `Moved to ${name}.` });
    } catch (failure) {
      pushErrorToast("Couldn’t move the question", failure);
    }
  }

  /** Where a shared thread is for its card's Move to: the reader's folder,
   * their Archive, or Shared with me. */
  function sharedPlaceOf(tree: ResearchTreeSummary): string {
    if (tree.archivedAt != null) return RESEARCH_ARCHIVE_FOLDER_ID;
    const place = researchTreePlace(tree, folderState);
    return place === RESEARCH_UNFILED_FOLDER_ID ? SHARED_PLACE_ID : place;
  }

  function moveDraft(draftId: string, beforeId: string | null) {
    const ids = drafts.map((draft) => draft.id).filter((id) => id !== draftId);
    const index = beforeId ? ids.indexOf(beforeId) : -1;
    const next =
      index < 0 ? [...ids, draftId] : [...ids.slice(0, index), draftId, ...ids.slice(index)];
    if (next.every((id, at) => drafts[at]?.id === id)) return;
    moveDraftMutation.mutate(
      { workspaceId, draftIds: next },
      { onError: (failure) => pushErrorToast("Couldn’t move the draft", failure) },
    );
  }

  /* ---------------------------------------------------------------------
   * Keyboard moves
   * ------------------------------------------------------------------ */

  /** Keeps focus on a card moved by ⌥↑/⌥↓ once it re-renders in place. */
  const movedCardRef = useRef<{ cardId: string; until: number } | null>(null);
  const keepCardFocus = (cardId: string) => {
    movedCardRef.current = { cardId, until: performance.now() + 2000 };
  };
  useLayoutEffect(() => {
    const moved = movedCardRef.current;
    if (!moved) return;
    if (performance.now() > moved.until) {
      movedCardRef.current = null;
      return;
    }
    const hit = feedCardControl(moved.cardId, "open");
    const active = document.activeElement;
    if (!hit || active === hit) return;
    if (active !== null && active !== document.body) return;
    hit.focus({ preventScroll: true });
    hit.scrollIntoView({ block: "nearest" });
  });

  function moveFocusedCard(control: HTMLElement, step: -1 | 1) {
    const card = control.closest<HTMLElement>("[data-research-card]");
    const cardId = card?.dataset["researchCard"];
    const place = card?.dataset["researchPlace"];
    const zonePlace = card?.closest<HTMLElement>("[data-research-drop]")?.dataset["researchDrop"];
    if (!card || !cardId || !place || place !== zonePlace || !researchPlaceIsReorderable(place)) {
      return;
    }
    const kind = card.dataset["researchCardKind"] === "draft" ? "draft" : "tree";
    // A shared thread's position is its owner's; the order sent is the
    // reader's own threads only (`useFiling`).
    const cardTree = kind === "tree" ? treeById.get(cardId) : undefined;
    if (cardTree && !ownTree(cardTree)) {
      announce("Shared threads keep their owner’s order.");
      return;
    }
    const parentId = card.dataset["researchParent"];
    const ids =
      kind === "draft"
        ? drafts.map((draft) => draft.id)
        : parentId
          ? [
              ...(card.parentElement?.querySelectorAll<HTMLElement>(
                ":scope > [data-research-card][data-research-parent]",
              ) ?? []),
            ].flatMap((sibling) => sibling.dataset["researchCard"] ?? [])
          : topLevelIdsIn(place);
    const target = stepReorderTarget(ids, cardId, step);
    if (!target) {
      announce(step < 0 ? "Already first." : "Already last.");
      return;
    }
    if (kind === "draft") moveDraft(cardId, target.beforeId);
    else if (parentId) group.nestTree(cardId, parentId, target.beforeId);
    else group.moveTree(cardId, place, target);
    const index = ids.indexOf(cardId) + step;
    announce(`Moved to position ${index + 1} of ${ids.length}.`);
    keepCardFocus(cardId);
  }

  function focusedTreeCard(control: HTMLElement) {
    const card = control.closest<HTMLElement>("[data-research-card]");
    const tree = treeById.get(card?.dataset["researchCard"] ?? "");
    const place = card?.dataset["researchPlace"];
    const zonePlace = card?.closest<HTMLElement>("[data-research-drop]")?.dataset["researchDrop"];
    if (!card || !tree || card.dataset["researchCardKind"] !== "tree" || !place) return null;
    if (place !== zonePlace || !researchPlaceIsReorderable(place)) return null;
    return { card, tree, place };
  }

  /** The parent a tree is listed under, or null when it is listed on its
   * own. */
  function listedParentOf(tree: ResearchTreeSummary): ResearchTreeSummary | null {
    const parent = treeById.get(parents[tree.id] ?? "");
    return parent &&
      parent.archivedAt == null &&
      parents[parent.id] === undefined &&
      placeOf(parent) === placeOf(tree)
      ? parent
      : null;
  }

  /** ⌥→: lists the focused card under the question, document or post above
   * it. */
  function nestFocusedCard(control: HTMLElement) {
    const focused = focusedTreeCard(control);
    if (!focused) return;
    const { card, tree, place } = focused;
    if (!ownTree(tree)) {
      announce("Shared threads can’t be nested.");
      return;
    }
    if (card.dataset["researchParent"]) {
      announce("Already in a group. Nesting is one level deep.");
      return;
    }
    const ids = topLevelIdsIn(place);
    const above = treeById.get(ids[ids.indexOf(tree.id) - 1] ?? "");
    if (!above) {
      announce("No question, document or post above to nest under.");
      return;
    }
    if (!treeHoldsChildren(above.id)) {
      announce(`“${shortName(above.title)}” can’t hold children.`);
      return;
    }
    group.nestTree(tree.id, above.id, null);
    // Nesting a card that has children opens a confirmation first.
    if (!card.dataset["researchChildren"]) {
      announce(`Moved under “${shortName(above.title)}”.`);
      keepCardFocus(tree.id);
    }
  }

  /** ⌥←: lists the focused child on its own, after its former group. */
  function moveFocusedCardOut(control: HTMLElement) {
    const focused = focusedTreeCard(control);
    if (!focused) return;
    const parent = listedParentOf(focused.tree);
    if (!parent) {
      announce("Not in a group.");
      return;
    }
    keepCardFocus(focused.tree.id);
    void filing.moveOutOfGroup(focused.tree.id).then((moved) => {
      if (moved) announce(`Moved out of “${shortName(parent.title)}”.`);
    });
  }

  function onScrollKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.matches(FEED_ROW_SELECTOR)) return;
    // Enter and → open the focused card as a click does.
    if (feedRowOpenKey(event)) {
      event.preventDefault();
      target.click();
      return;
    }
    const plainAlt = event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
    if (plainAlt && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      if (event.key === "ArrowRight") nestFocusedCard(target);
      else moveFocusedCardOut(target);
      return;
    }
    if (plainAlt && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveFocusedCard(target, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    // ↑ and ↓ move between the cards, a group's children included.
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const all = [...event.currentTarget.querySelectorAll<HTMLElement>(FEED_ROW_SELECTOR)];
    const next = all[all.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  }

  /* ---------------------------------------------------------------------
   * Groups
   * ------------------------------------------------------------------ */

  /** Collapses or expands a group; with `all` (Alt+click), every group. */
  function toggleGroup(parentId: string, name: string, all: boolean) {
    const collapse = !collapsedGroups.has(parentId);
    const ids = all ? [...new Set(Object.values(parents))] : [parentId];
    filing.setGroupsCollapsed(ids, collapse);
    announce(
      all
        ? collapse
          ? "Collapsed every group."
          : "Expanded every group."
        : `${collapse ? "Collapsed" : "Expanded"} “${shortName(name)}”.`,
    );
  }

  /* ---------------------------------------------------------------------
   * Menus
   * ------------------------------------------------------------------ */

  const closeMenu = () => setMenu(null);
  const menuTree = menu?.kind === "tree" ? (treeById.get(menu.treeId) ?? null) : null;
  const menuDraft =
    menu?.kind === "draft" ? (drafts.find((draft) => draft.id === menu.draftId) ?? null) : null;

  const menuShared = menuTree !== null && !ownTree(menuTree);
  const menuGroupTree = menuTree && menuTree.archivedAt == null && !menuShared ? menuTree : null;
  const menuGroupParent = menuGroupTree ? listedParentOf(menuGroupTree) : null;
  const menuGroupPlace = menuGroupTree ? placeOf(menuGroupTree) : null;
  const menuGroupChildCount =
    menuGroupTree && !menuGroupParent
      ? activeTrees.filter(
          (tree) => parents[tree.id] === menuGroupTree.id && placeOf(tree) === menuGroupPlace,
        ).length
      : 0;
  const nestCandidates =
    menuGroupTree && menuGroupPlace && researchPlaceIsReorderable(menuGroupPlace)
      ? researchNestCandidates(
          topLevelIdsIn(menuGroupPlace),
          menuGroupParent?.id ?? menuGroupTree.id,
          (id) => id !== menuGroupTree.id && id !== menuGroupParent?.id && treeHoldsChildren(id),
        ).flatMap((id) => treeById.get(id) ?? [])
      : [];
  const menuGroupCollapsed = menuGroupTree ? collapsedGroups.has(menuGroupTree.id) : false;

  function openRecapDialog(nodeId: string) {
    void getResearchNodeContent(nodeId)
      .then(setRecapContent)
      .catch((failure: unknown) => pushErrorToast("Couldn’t read the answer", failure));
  }

  const openTreeMenu = (treeId: string, button: HTMLElement) =>
    setMenu((current) =>
      current?.kind === "tree" && current.button === button
        ? null
        : { kind: "tree", treeId, anchor: button, button },
    );
  const openDraftMenu = (draftId: string, button: HTMLElement) =>
    setMenu((current) =>
      current?.kind === "draft" && current.button === button
        ? null
        : { kind: "draft", draftId, anchor: button, button },
    );
  const menuTreeId = menu?.kind === "tree" ? menu.treeId : null;

  /* ---------------------------------------------------------------------
   * Cards
   * ------------------------------------------------------------------ */

  /** A thread's card, its root loaded per card. */
  function treeCard(
    tree: ResearchTreeSummary,
    {
      virtual = false,
      parentId,
      parentName,
      childTrees = [],
      place: listedPlace,
    }: {
      virtual?: boolean;
      parentId?: string;
      parentName?: string;
      childTrees?: readonly ResearchTreeSummary[];
      /** The place the card is listed in, when it is not the thread's own. */
      place?: string;
    } = {},
  ) {
    const place =
      listedPlace ?? (tree.archivedAt != null ? RESEARCH_ARCHIVE_FOLDER_ID : placeOf(tree));
    const groupCollapsed = collapsedGroups.has(tree.id);
    return (
      <TreeCard
        key={tree.id}
        tree={tree}
        place={place}
        virtual={virtual}
        parentId={parentId}
        parentName={parentName}
        holdsChildren={
          parentId === undefined && tree.archivedAt == null && treeHoldsChildren(tree.id)
        }
        menuOpen={menuTreeId === tree.id}
        onOpen={() => openTree(tree.id)}
        onEditNote={(nodeId) => editNote(tree.id, nodeId)}
        onMenu={(button) => openTreeMenu(tree.id, button)}
        onContextMenu={(anchor, button) =>
          setMenu({ kind: "tree", treeId: tree.id, anchor, button })
        }
        onDragStart={onDragStart}
        childCount={childTrees.length}
        groupFor={(name, summary) =>
          childTrees.length > 0
            ? {
                count: childTrees.length,
                collapsed: groupCollapsed,
                summary,
                label: `${groupCollapsed ? "Show" : "Hide"} ${researchItemCount(childTrees.length)} under “${shortName(name)}”`,
                onToggle: (all) => toggleGroup(tree.id, name, all),
              }
            : undefined
        }
        childSummaries={childTrees}
        nested={(name) =>
          childTrees.length > 0 && !groupCollapsed
            ? childTrees.map((child) => (
                <Fragment key={child.id}>
                  {treeCard(child, { virtual, parentId: tree.id, parentName: name })}
                </Fragment>
              ))
            : null
        }
      />
    );
  }

  function draftCard(draft: ResearchDraft) {
    const prompt = draft.prompt.trim();
    return (
      <FeedCard
        key={draft.id}
        cardId={draft.id}
        dragKind="draft"
        place={RESEARCH_DRAFTS_FOLDER_ID}
        label={`Draft: ${prompt}`}
        kind="draft"
        body={<CardQuestion>{feedText(prompt)}</CardQuestion>}
        selected={draft.id === selectedDraftId}
        menuOpen={menu?.kind === "draft" && menu.draftId === draft.id}
        menuLabel="Draft actions"
        onOpen={() => openDraft(draft)}
        onMenu={(button) => openDraftMenu(draft.id, button)}
        onContextMenu={(anchor, button) =>
          setMenu({ kind: "draft", draftId: draft.id, anchor, button })
        }
        onDragStart={onDragStart}
      />
    );
  }

  function archivedCard(tree: ResearchTreeSummary) {
    return (
      <FeedCard
        key={tree.id}
        cardId={tree.id}
        place={RESEARCH_ARCHIVE_FOLDER_ID}
        body={<CardQuestion>{tree.title}</CardQuestion>}
        label={tree.title}
        tooltip={archivedTooltip(tree.archivedAt)}
        kind={researchThreadKind(tree, undefined)}
        state={researchThreadState(tree, undefined)}
        statusLabel={tree.hasUnseenFailure ? "Failed since last viewed" : undefined}
        unread={tree.hasUnseenUpdate}
        menuOpen={menuTreeId === tree.id}
        onOpen={() => openTree(tree.id)}
        onMenu={(button) => openTreeMenu(tree.id, button)}
        onContextMenu={(anchor, button) =>
          setMenu({ kind: "tree", treeId: tree.id, anchor, button })
        }
        onDragStart={onDragStart}
      />
    );
  }

  function placeCards(place: string) {
    if (place === RESEARCH_TRASH_FOLDER_ID) {
      return (
        <TrashList
          entries={trashEntries}
          onRestore={(entry) => void restoreTrashEntry(entry)}
          onDeleteNow={(entry) => setDeletingTrashEntry(entry)}
        />
      );
    }
    if (place === RESEARCH_ARCHIVE_FOLDER_ID) {
      return archivedTrees.length === 0 ? (
        <FeedEmpty>{placeEmptyText(RESEARCH_ARCHIVE_FOLDER_ID)}</FeedEmpty>
      ) : (
        archivedTrees.map((tree) => archivedCard(tree))
      );
    }
    if (place === SHARED_PLACE_ID) {
      return (
        <>
          <ReceivedInvites />
          {sharedTrees.length === 0 ? (
            <FeedEmpty>
              Threads other people share with you appear here. Open an invite link to join one.
            </FeedEmpty>
          ) : (
            sharedTrees.map((tree) => (
              <div key={tree.id} data-research-unit="">
                {treeCard(tree, { place: SHARED_PLACE_ID })}
              </div>
            ))
          )}
        </>
      );
    }
    const placeTrees = treesIn(place);
    const placeDrafts = place === RESEARCH_DRAFTS_FOLDER_ID ? drafts : EMPTY_DRAFTS;
    if (placeTrees.length === 0 && placeDrafts.length === 0) {
      return <FeedEmpty>{placeEmptyText(place)}</FeedEmpty>;
    }
    return (
      <>
        {placeDrafts.map((draft) => draftCard(draft))}
        {researchTreeGroups(placeTrees, parents).map(({ tree, children }) => (
          <div key={tree.id} data-research-unit="">
            {treeCard(tree, { childTrees: children })}
          </div>
        ))}
      </>
    );
  }

  function placeCount(place: string): number {
    if (place === RESEARCH_ARCHIVE_FOLDER_ID) return archivedTrees.length;
    if (place === RESEARCH_TRASH_FOLDER_ID) return trashEntries.length;
    return treesIn(place).length + (place === RESEARCH_DRAFTS_FOLDER_ID ? drafts.length : 0);
  }

  /* ---------------------------------------------------------------------
   * The Trash
   * ------------------------------------------------------------------ */

  async function restoreTrashEntry(entry: ResearchTrashEntry) {
    try {
      if (entry.kind === "tree") await group.restoreGroupFromTrash(entry.id);
      else await filing.setFolderTrashed(entry.id, false);
      pushToast({ title: "Restored." });
    } catch (failure) {
      pushErrorToast("Couldn’t restore", failure);
    }
  }

  async function deleteTrashEntry(entry: ResearchTrashEntry) {
    if (entry.kind === "tree") {
      await group.removeGroup(entry.id);
      return;
    }
    if (!(await filing.deleteFolder(entry.id))) throw new Error("The folder wasn't deleted.");
  }

  const deletingTrashChildCount =
    deletingTrashEntry?.kind === "tree" ? group.groupChildren(deletingTrashEntry.id).length : 0;

  /* ---------------------------------------------------------------------
   * The virtualized Unfiled list
   * ------------------------------------------------------------------ */

  const anchorKey = `home:${workspaceId}`;
  const initialScrollOffset = useRef<number | undefined>(undefined);
  if (initialScrollOffset.current === undefined && listed) {
    initialScrollOffset.current = useNavigationStore.getState().feedAnchorFor(anchorKey)?.top ?? 0;
  }
  const [scrollMargin, setScrollMargin] = useState(0);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row || row.children.length === 0) return 92;
      return 116 + (collapsedGroups.has(row.tree.id) ? 0 : row.children.length * 80);
    },
    getItemKey: (index) => rows[index]?.tree.id ?? index,
    overscan: 6,
    scrollMargin,
    initialOffset: initialScrollOffset.current,
    initialRect: { width: 0, height: 800 },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const listSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const next =
      list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next));
  }, [listSize, rows.length, listed, view.kind]);
  // The position is saved as a scroll offset per workspace, and restored
  // once the list has its height.
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    if (!listed || restoredRef.current) return;
    const scroller = scrollRef.current;
    const target = initialScrollOffset.current ?? 0;
    if (!scroller || rows.length === 0) return;
    if (scroller.scrollHeight - scroller.clientHeight >= target) {
      scroller.scrollTop = target;
      restoredRef.current = true;
    }
  }, [listSize, listed, rows.length]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !listed) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        useNavigationStore
          .getState()
          .recordFeedAnchor(anchorKey, { key: "", offset: 0, top: scroller.scrollTop });
      }, 200);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (timer !== null) clearTimeout(timer);
    };
  }, [anchorKey, listed]);

  // A different list starts at its top.
  const viewKey = view.kind === "folder" ? `folder:${view.folderId}` : view.kind;
  const previousViewKey = useRef(viewKey);
  useLayoutEffect(() => {
    if (previousViewKey.current === viewKey) return;
    previousViewKey.current = viewKey;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [viewKey]);

  /* ---------------------------------------------------------------------
   * Render
   * ------------------------------------------------------------------ */

  const title = feedViewTitle(view, folders);
  const soloPlace = soloPlaceOf(view);
  const userFolder =
    view.kind === "folder" ? (folders.find((folder) => folder.id === view.folderId) ?? null) : null;
  const trayPlaces = [
    RESEARCH_DRAFTS_FOLDER_ID,
    ...folders.map((folder) => folder.id),
    RESEARCH_ARCHIVE_FOLDER_ID,
  ];
  const collapsedTrays = new Set(folderState.collapsed);
  const homeHasNothing =
    view.kind === "home" && trees.length === 0 && drafts.length === 0 && rows.length === 0;
  const loading = filing.trees === EMPTY_TREES && listed;

  const composerBlock = composer ? <div className="mx-2 mt-3 mb-2.5">{composer}</div> : null;
  const headerButtons =
    userFolder !== null ? (
      <>
        <IconButton
          label="Rename folder"
          onClick={(event) => openRenameFolder(userFolder.id, userFolder.name, event.currentTarget)}
        >
          <Pencil size={15} aria-hidden="true" />
        </IconButton>
        <IconButton label="Delete folder" onClick={() => requestFolderDelete(userFolder.id)}>
          <Trash2 size={15} aria-hidden="true" />
        </IconButton>
      </>
    ) : view.kind === "trash" ? (
      <button
        type="button"
        className={FEED_BUTTON}
        disabled={trashEntries.length === 0}
        onClick={() => setEmptyingTrash(true)}
      >
        Empty Trash
      </button>
    ) : null;
  const emptyingLeaves = trashEntries.filter(
    (entry) => entry.kind === "tree" && !ownTree(entry.tree),
  ).length;

  return (
    <div className="bg-surface-feed relative flex h-full min-h-0 flex-col" data-research-feed="">
      <header className="border-border-divider flex min-h-11 shrink-0 items-center gap-1 border-b py-2 pr-3 pl-4">
        {soloPlace ? (
          <IconButton label="Back to Home" className="-ml-1.5" onClick={goHome}>
            <ArrowLeft size={15} aria-hidden="true" />
          </IconButton>
        ) : null}
        <h1
          className="text-fg-heading m-0 line-clamp-4 min-w-0 flex-1 text-[length:calc(var(--fs-base)+1px)] font-semibold [overflow-wrap:anywhere]"
          tabIndex={-1}
          data-research-feed-title=""
        >
          {title}
        </h1>
        {headerButtons}
        {headerActions}
      </header>
      {/* The rows are the keyboard targets: ↑/↓, Enter and the ⌥ moves are
          handled here for whichever card has focus. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={scrollRef}
        className="research-reading-surface min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain"
        data-research-scroll=""
        onScroll={(event) => {
          if (event.currentTarget.scrollTop <= FEED_TOP_THRESHOLD) setNewActivityCount(0);
        }}
        onFocus={(event) => {
          const target = event.target as HTMLElement;
          if (!target.matches(FEED_ROW_SELECTOR)) return;
          rovingRowRef.current = target;
          applyFeedRoving(event.currentTarget, target);
        }}
        onKeyDown={onScrollKeyDown}
      >
        <div className="max-w-feed relative mx-auto flex min-h-full w-full flex-col pb-6">
          {view.kind === "home" ? composerBlock : null}
          {newActivityCount > 0 && listed ? (
            <div
              className="pointer-events-none sticky top-2.5 z-2 flex h-0 justify-center"
              role="status"
              aria-live="polite"
            >
              <ControlButton
                size="sm"
                className="bg-surface-feed-popover text-fg-interactive pointer-events-auto rounded-full shadow-sm"
                onClick={() => {
                  setNewActivityCount(0);
                  scrollRef.current?.scrollTo({ top: 0, behavior: feedScrollBehavior() });
                }}
              >
                {newActivityCount} new {newActivityCount === 1 ? "activity" : "activities"}
              </ControlButton>
            </div>
          ) : null}
          {listed ? (
            <section
              className="mb-2.5 rounded-[10px] border border-transparent"
              aria-label="Unfiled"
              data-research-drop={RESEARCH_UNFILED_FOLDER_ID}
              data-research-list=""
            >
              <div ref={listRef} className="py-1.5" role="feed" aria-label="Recent activity">
                <div className="relative w-full" style={{ height: listSize }}>
                  {virtualItems.map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    if (!row) return null;
                    return (
                      <div
                        key={virtualRow.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualRow.index}
                        className="absolute top-0 left-0 w-full"
                        style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
                      >
                        <div
                          data-research-unit=""
                          role="article"
                          aria-posinset={virtualRow.index + 1}
                          aria-setsize={rows.length}
                        >
                          {treeCard(row.tree, { virtual: true, childTrees: row.children })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {rows.length === 0 && !loading ? (
                  <FeedEmpty>
                    {homeHasNothing
                      ? "Research, notes, and saved links appear here. New ones start at the top."
                      : placeEmptyText(RESEARCH_UNFILED_FOLDER_ID)}
                  </FeedEmpty>
                ) : null}
              </div>
            </section>
          ) : null}
          {view.kind === "home"
            ? trayPlaces.map((place) => (
                <FeedTray
                  key={place}
                  place={place}
                  name={researchPlaceName(place, folders)}
                  count={placeCount(place)}
                  collapsed={collapsedTrays.has(place)}
                  onToggle={() => filing.setTrayCollapsed(place, !collapsedTrays.has(place))}
                  onOpen={() => openPlace(place)}
                >
                  {placeCards(place)}
                </FeedTray>
              ))
            : null}
          {view.kind === "home" ? (
            // Trash ends Home, collapsed until opened; it takes no drops.
            <FeedTray
              place={RESEARCH_TRASH_FOLDER_ID}
              name="Trash"
              count={trashEntries.length}
              countNoun={["item", "items"]}
              drop={false}
              collapsed={!trashTrayOpen}
              onToggle={() => setTrashTrayOpen((open) => !open)}
              onOpen={() => openPlace(RESEARCH_TRASH_FOLDER_ID)}
            >
              {placeCards(RESEARCH_TRASH_FOLDER_ID)}
            </FeedTray>
          ) : null}
          {view.kind === "home" ? (
            // The sidebar's New folder, below the trays.
            <button
              type="button"
              className={cn(
                "text-fg-faint hover:text-fg-secondary mt-0 mr-2.5 mb-3 ml-6 block cursor-pointer self-start border-0 bg-transparent px-0 py-0.5 text-sm underline-offset-2 hover:underline",
                FOCUS_RING,
              )}
              onClick={(event) => openNewFolder(null, event.currentTarget)}
            >
              + New folder
            </button>
          ) : null}
          {soloPlace ? (
            <section
              className="min-h-[50%] rounded-[10px] border border-transparent pt-1.5"
              aria-label={title}
              data-research-drop={
                soloPlace === RESEARCH_TRASH_FOLDER_ID || soloPlace === SHARED_PLACE_ID
                  ? undefined
                  : soloPlace
              }
            >
              {placeCards(soloPlace)}
            </section>
          ) : null}
          {soloPlace && view.kind !== "archive" && view.kind !== "trash" && view.kind !== "shared"
            ? composerBlock
            : null}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {menu?.kind === "tree" && menuTree && menu.mode === "nest" && menuGroupTree ? (
        <AnchoredMenu
          anchor={menu.anchor}
          label={`Make “${shortName(menuGroupTree.title)}” a child of`}
          onClose={closeMenu}
        >
          <BaseMenu.Group>
            <MenuGroupLabel>Make child of</MenuGroupLabel>
            {nestCandidates.map((parent) => (
              <MenuItem
                key={parent.id}
                onClick={() => {
                  group.nestTree(menuGroupTree.id, parent.id, null);
                  if (menuGroupChildCount === 0) {
                    announce(`Moved under “${shortName(parent.title)}”.`);
                    keepCardFocus(menuGroupTree.id);
                  }
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <RowGlyph kind={researchThreadKind(parent, undefined)} />
                  <span className="truncate">{parent.title}</span>
                </span>
              </MenuItem>
            ))}
          </BaseMenu.Group>
        </AnchoredMenu>
      ) : null}
      {menu?.kind === "tree" && menuTree && menu.mode !== "nest" ? (
        <AnchoredMenu
          anchor={menu.anchor}
          label={`Actions for ${menuTree.title}`}
          onClose={closeMenu}
        >
          {menuGroupTree ? (
            <>
              <IconMenuItem
                icon={<IndentIncrease size={15} aria-hidden="true" />}
                disabled={nestCandidates.length === 0}
                title={
                  nestCandidates.length === 0
                    ? "No question, document or post to nest under"
                    : undefined
                }
                closeOnClick={false}
                onClick={() => setMenu({ ...menu, mode: "nest" })}
              >
                Make child of…
              </IconMenuItem>
              {menuGroupParent ? (
                <IconMenuItem
                  icon={<IndentDecrease size={15} aria-hidden="true" />}
                  onClick={() => {
                    const parent = menuGroupParent;
                    keepCardFocus(menuGroupTree.id);
                    void filing.moveOutOfGroup(menuGroupTree.id).then((moved) => {
                      if (moved) announce(`Moved out of “${shortName(parent.title)}”.`);
                    });
                  }}
                >
                  Move out of group
                </IconMenuItem>
              ) : null}
              {menuGroupChildCount > 0 ? (
                <IconMenuItem
                  icon={
                    menuGroupCollapsed ? (
                      <ChevronRight size={15} aria-hidden="true" />
                    ) : (
                      <ChevronDown size={15} aria-hidden="true" />
                    )
                  }
                  onClick={() => toggleGroup(menuGroupTree.id, menuGroupTree.title, false)}
                >
                  {menuGroupCollapsed ? "Expand" : "Collapse"}
                </IconMenuItem>
              ) : null}
              <MenuSeparator />
            </>
          ) : null}
          {menuShared ? (
            <MoveToItems
              currentPlace={sharedPlaceOf(menuTree)}
              folders={folders}
              shared
              onMove={(place) => void fileSharedTree(menuTree, place)}
            />
          ) : (
            <MoveToItems
              currentPlace={placeOf(menuTree)}
              folders={folders}
              archiveShortcut={view.kind === "home"}
              onMove={(place) => group.moveTree(menuTree.id, place)}
              onNewFolder={() => openNewFolder(menuTree.id, menu.button)}
            />
          )}
          <MenuSeparator />
          <MenuTreeLifecycle
            tree={menuTree}
            onRename={menuShared ? undefined : setRenamingTree}
            onRestore={(treeId) => void group.unarchiveGroup(treeId)}
            onDelete={setDeletingTree}
            onRecap={openRecapDialog}
          />
        </AnchoredMenu>
      ) : null}
      {menu?.kind === "draft" && menuDraft ? (
        <AnchoredMenu anchor={menu.anchor} label="Draft actions" onClose={closeMenu}>
          <IconMenuItem
            icon={<FilePen size={15} aria-hidden="true" />}
            onClick={() => openDraft(menuDraft)}
          >
            Open
          </IconMenuItem>
          <IconMenuItem
            icon={<Trash2 size={15} aria-hidden="true" />}
            onClick={() =>
              deleteDraft.mutate(menuDraft, {
                onSuccess: () => pushToast({ title: "Draft deleted." }),
                onError: (failure) => pushErrorToast("Couldn’t delete the draft", failure),
              })
            }
          >
            Delete
          </IconMenuItem>
        </AnchoredMenu>
      ) : null}

      {renamingTree ? (
        <TreeRenameDialog
          tree={renamingTree}
          onClose={() => setRenamingTree(null)}
          onRename={(treeId, title) => renameTree.mutateAsync({ treeId, title })}
        />
      ) : null}
      {deletingTree ? (
        <DeleteDialog
          {...treeDeleteDialogProps({
            tree: deletingTree,
            shared: !ownTree(deletingTree),
            groupChildren: group.groupChildren(deletingTree.id),
            onClose: () => setDeletingTree(null),
            onTrash: group.trashGroup,
            onRemove: group.removeGroup,
          })}
        />
      ) : null}
      {deletingTrashEntry?.kind === "tree" && !ownTree(deletingTrashEntry.tree) ? (
        <DeleteDialog
          remove={{
            title: `Leave “${deletingTrashEntry.title}”?`,
            body: (
              <p className="m-0">
                It is shared with you. Deleting it removes you from it; its owner and the other
                people in it keep it.
              </p>
            ),
            label: "Leave",
            pendingLabel: "Leaving…",
            onConfirm: () => deleteTrashEntry(deletingTrashEntry),
          }}
          onClose={() => setDeletingTrashEntry(null)}
        />
      ) : deletingTrashEntry ? (
        <DeleteDialog
          remove={{
            body: (
              <p className="m-0">
                “{deletingTrashEntry.title}”
                {deletingTrashChildCount > 0
                  ? ` and its ${researchChildCount(deletingTrashChildCount)}`
                  : ""}{" "}
                will be deleted. This can’t be undone.
              </p>
            ),
            onConfirm: () => deleteTrashEntry(deletingTrashEntry),
          }}
          onClose={() => setDeletingTrashEntry(null)}
        />
      ) : null}
      {emptyingTrash ? (
        <DeleteDialog
          remove={{
            title: "Empty the Trash?",
            body: (
              <p className="m-0">
                {researchTrashCount(trashEntries.length)} will be deleted. This can’t be undone.
                {emptyingLeaves > 0
                  ? ` You’ll leave the ${emptyingLeaves === 1 ? "thread" : `${emptyingLeaves} threads`} shared with you; their owners keep them.`
                  : ""}
              </p>
            ),
            label: "Empty Trash",
            pendingLabel: "Emptying…",
            onConfirm: async () => {
              await emptyTrash.mutateAsync(workspaceId);
            },
          }}
          onClose={() => setEmptyingTrash(false)}
        />
      ) : null}
      {recapContent ? (
        <RecapDialog
          content={recapContent}
          open
          onClose={() => setRecapContent(null)}
          onApplied={(updated) =>
            setRecapContent((current) =>
              current && current.node.id === updated.id ? { ...current, node: updated } : current,
            )
          }
        />
      ) : null}
      {group.dialog}
    </div>
  );
}

/** The thread actions of a card's menu, with Generate recap when the root
 * answer is complete and has a recap. */
function MenuTreeLifecycle({
  tree,
  onRename,
  onRestore,
  onDelete,
  onRecap,
}: {
  tree: ResearchTreeSummary;
  onRename: ((tree: ResearchTreeSummary) => void) | undefined;
  onRestore: (treeId: string) => void;
  onDelete: (tree: ResearchTreeSummary) => void;
  onRecap: (nodeId: string) => void;
}) {
  const archived = tree.archivedAt != null;
  const root = useFeedRoot(tree.id, !archived).data ?? undefined;
  // A viewer of a shared thread cannot generate its recap.
  const recaps = tree.role === undefined || tree.role === "owner" || tree.role === "commenter";
  return (
    <TreeLifecycleItems
      tree={tree}
      archived={archived}
      onRename={onRename}
      onRestore={onRestore}
      onDelete={onDelete}
      onRegenerateRecap={
        recaps && root && !archived && root.status === "complete" && root.recap?.trim()
          ? () => onRecap(root.nodeId)
          : undefined
      }
    />
  );
}

/** A thread's card: its root entry when loaded, else its title. A parent
 * lists its children after it unless the group is collapsed; a child names
 * its parent in its label. */
function TreeCard({
  tree,
  place,
  virtual,
  parentId,
  parentName,
  holdsChildren,
  menuOpen,
  onOpen,
  onEditNote,
  onMenu,
  onContextMenu,
  onDragStart,
  groupFor,
  childSummaries,
  nested,
}: {
  tree: ResearchTreeSummary;
  place: string;
  virtual: boolean;
  parentId: string | undefined;
  parentName: string | undefined;
  holdsChildren: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  /** Opens the root note in the editor. */
  onEditNote: (nodeId: string) => void;
  onMenu: (button: HTMLElement) => void;
  onContextMenu: (anchor: MenuAnchor, button: HTMLElement) => void;
  onDragStart: ReturnType<typeof useCardDrag>;
  childCount: number;
  groupFor: (name: string, summary: FeedCardGroup["summary"]) => FeedCardGroup | undefined;
  childSummaries: readonly ResearchTreeSummary[];
  nested: (name: string) => ReactNode;
}) {
  const archived = tree.archivedAt != null;
  const query = useFeedRoot(tree.id, !archived).data ?? undefined;
  const isPost = query ? nodeType(query) === "post" : tree.type === "post";
  const question = query?.prompt ?? tree.title;
  const title = isPost ? null : researchCardTitle(tree.title || query?.title, question);
  const awaitingTitle = !isPost && !(tree.title || query?.title)?.trim();
  const state = researchThreadState(tree, query);
  const name = title ?? question;
  const cardLabel = title ? `${title}. ${question}` : question;
  const summary = researchGroupSummary(
    childSummaries.map((child) => ({
      state: researchThreadState(child, undefined),
      unread: child.hasUnseenUpdate,
    })),
  );
  return (
    <FeedCard
      cardId={tree.id}
      place={place}
      title={title}
      label={parentName ? `${cardLabel}, in “${shortName(parentName)}”` : cardLabel}
      holdsChildren={holdsChildren}
      parentId={parentId}
      group={groupFor(name, summary)}
      nested={nested(name)}
      body={
        <CardBody
          query={query}
          fallback={question}
          isPost={isPost}
          awaitingTitle={awaitingTitle}
          underTitle={Boolean(title)}
        />
      }
      kind={researchThreadKind(tree, query)}
      state={state}
      statusLabel={
        state === "failed" && tree.hasUnseenFailure ? "Failed since last viewed" : undefined
      }
      // Unread shows on an answered card only (researchRowGlyph).
      unread={tree.hasUnseenUpdate}
      menuOpen={menuOpen}
      onOpen={onOpen}
      // A double-click on a note's card edits the note, unless the thread is
      // archived (researchNoteEditable).
      onEdit={
        // A shared thread's note is its author's to edit, not this reader's.
        query && ownTree(tree) && researchNoteEditable(query, archived)
          ? () => onEditNote(query.nodeId)
          : undefined
      }
      onMenu={onMenu}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      virtual={virtual}
    />
  );
}

/** Home's header control for the web's feeds other than the workspace's own:
 * All Users and My Workspaces. */
export function FeedHeaderButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <ControlButton size="sm" onClick={onClick}>
      {children}
    </ControlButton>
  );
}
