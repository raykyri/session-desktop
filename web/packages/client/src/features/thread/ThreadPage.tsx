// A research thread as paired columns (`09-research-document-view.md`),
// ported from the desktop `ResearchThreadPage.tsx`. The strip is the shared
// `researchStrip` of the tree's nodes, each column's selection (the `?sel=`
// search parameter, `useThreadHistory`), the unsent branch and the editor:
// a level's messages column and its answer column, the branches column after
// a level, a note's column and its follow-ups column, and the editor.
//
// The page owns what crosses columns: the selection and history, the unsent
// branch, the ask boxes, the editor session, menus and dialogs. Each answer
// column loads its own content and reports it (`PublishedAnswer`), which the
// annotations, the menus and the editor read.

import type {
  ResearchFollowupQueueItem,
  ResearchHighlightAnchor,
  ResearchImageAttachment,
  ResearchNode,
  ReasoningEffort,
} from "@session/shared";
import { findModel, nodeModelId } from "@session/shared";
import {
  researchBranchesByParent,
  researchBranchesInPassageOrder,
  researchEditedQuestionFork,
  researchLevelPath,
  researchQueueStep,
  researchSurvivingAncestor,
} from "@session/shared/lib/researchBranchView";
import {
  canFollowUpFrom,
  chainDisplayOrder,
  inlineChainFor,
  researchRerunConfirms,
} from "@session/shared/lib/researchChains";
import {
  columnKey,
  columnLevelIndex,
  columnSelector,
  researchSelectionAfterRemoval,
  researchSelectionPath,
  researchSelectionWith,
  researchStrip,
  type ResearchColumn,
  type ResearchColumnId,
  type ResearchStackGroup,
} from "@session/shared/lib/researchColumns";
import { reorderedIds, stepReorderTarget } from "@session/shared/lib/researchFolders";
import {
  documentSource,
  nodeAgent,
  nodeMessage,
  nodePrompt,
  nodeStatus,
  nodeType,
  passageAnchor,
} from "@session/shared/lib/researchNodeTypes";
import { researchNoteEditable } from "@session/shared/lib/researchNoteEdit";
import {
  researchBranchBlocker,
  researchBranchStates,
  researchEditorSessionSaved,
  researchEditorStats,
  researchNodeLabel,
  researchQuoteText,
  researchSubtreeIds,
  withoutKeys,
} from "@session/shared/lib/researchThreadView";
import { toggleResearchTile } from "@session/shared/lib/researchTileClamp";
import { widgetChangePrompt } from "@session/shared/lib/sessionWidgetActions";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import {
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";

import { getResearchNodeContent, getResearchTree, renameResearchNode } from "../../api/api.js";
import {
  queryKeys,
  useSetThreadFollowed,
  useThreadInterest,
  useThreadPresence,
  useAskResearchFollowup,
  useCancelResearchNode,
  useCreateResearchPostFollowUp,
  useCreateResearchTree,
  useForkResearchNode,
  useMarkTreeViewed,
  useMe,
  useQueuedFollowupAction,
  useRemoveResearchBranch,
  useRemoveResearchTree,
  useRenameResearchTree,
  useRetryResearchNode,
  useSettings,
  useTrashResearchTree,
  useTreeDetail,
  useUpdateResearchPost,
  useNodeContent,
} from "../../api/queries.js";
import { writeClipboardText } from "../../lib/clipboard.js";
import { pushErrorToast, pushToast } from "../../lib/toast.js";
import { nodeDraftKey, useDraftsStore } from "../../stores/drafts.js";
import { useRecapPendingStore } from "../../stores/recapPending.js";
import { DomSearchBar } from "../../ui/DomSearchBar.js";
import { RecapDialog } from "../research/RecapDialog.js";
import { PresenceAvatars } from "../sharing/PresenceAvatars.js";
import { ShareDialog } from "../sharing/ShareDialog.js";
import {
  StaleEditDialog,
  isConflictError,
  type StaleEditSubject,
} from "../sharing/StaleEditDialog.js";
import { ThreadCollaborationContext, threadPeople } from "../sharing/context.js";
import {
  mayCancelQueued,
  mayChangeHighlights,
  mayEditText,
  mayRetryQueued,
  threadPermissions,
} from "../sharing/permissions.js";
import { WidgetChangeContext, type WidgetChangeHandler } from "../widgets/context.js";

import {
  AnswerColumn,
  MarkerTip,
  QueuedAnswerColumn,
  type MarkerActions,
  type PublishedAnswer,
} from "./AnswerColumn.js";
import { BranchesColumn } from "./BranchesColumn.js";
import { ThreadPlaceholder, type ThreadHistoryNav } from "./ColumnChrome.js";
import { Columns, ColumnsLayoutContext } from "./Columns.js";
import { ConversationComposer, type ComposerHandle } from "./ConversationComposer.js";
import { EditorColumn, type EditorSession } from "./EditorColumn.js";
import {
  MessagesColumn,
  type BranchSourceProps,
  type ChainRowsShared,
  type QueueProps,
} from "./MessagesColumn.js";
import { useUsableModels, type ModelChoice } from "./ModelPicker.js";
import { FollowUpsColumn, NoteColumn } from "./NoteColumns.js";
import type { PostActions, PostThreadHandle } from "./PostThread.js";
import { SelectionToolbar } from "./SelectionToolbar.js";
import { DeleteDialog, RenameDialog, RerunDialog } from "./ThreadDialogs.js";
import { ThreadMenu, type ThreadMenuState } from "./ThreadMenu.js";
import type { AnswerPaneHandlers, MessageRowActions } from "./Turn.js";
import {
  useHighlightMutations,
  useRerunResearchNode,
  useSetChainOrder,
  useUpdateResearchDocument,
} from "./mutations.js";
import {
  clearPendingBranch,
  expandedNodes as savedExpandedNodes,
  forgetThread,
  pruneThreadNavigation,
  recordExpanded,
  recordPendingBranch,
  requestHighlightFocus,
  savedPendingBranch,
} from "./persistence.js";
import { runActive } from "./runState.js";
import { buildSegmentView, type SegmentView } from "./segmentView.js";
import { columnIdOf, rowSelector, scrollIntoColumn, settleStrip } from "./stripDom.js";
import { rangeForTextOffsets } from "./textRanges.js";
import { useColumnScroll } from "./useColumnScroll.js";
import { useFocusRequests } from "./useFocusRequests.js";
import { useLatest } from "./useLatest.js";
import { useMessageDrag } from "./useMessageDrag.js";
import { useTextSelection, isTranscript } from "./useTextSelection.js";
import { useThreadAnnotations } from "./useThreadAnnotations.js";
import { encodeSelection, useThreadHistory } from "./useThreadHistory.js";
import { useThreadKeyboard } from "./useThreadKeyboard.js";

const NO_NODES: ResearchNode[] = [];
const NO_QUEUE: ResearchFollowupQueueItem[] = [];
const NO_IMAGES: ResearchImageAttachment[] = [];
const NO_MARKERS: never[] = [];

/** The unsent branch: a group in the branches column after its parent's
 * level. `selectionKey` is the selection it was opened with: any other
 * selection (navigation, Back, Forward) discards it. */
interface PendingBranch {
  parentNodeId: string;
  anchor: ResearchHighlightAnchor | null;
  selectionKey: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The route entry. The thread view is keyed per tree: everything it holds
 * belongs to one tree. */
export function ThreadPage() {
  const { treeId } = useParams({ from: "/_shell/r/$treeId" });
  return (
    <Columns>
      <ThreadView key={treeId} treeId={treeId} />
    </Columns>
  );
}

function ThreadView({ treeId }: { treeId: string }) {
  const layout = useContext(ColumnsLayoutContext);
  const routerNavigate = useNavigate();
  const search = useSearch({ strict: false });
  const detailQuery = useTreeDetail(treeId);
  const detail = detailQuery.data;
  const me = useMe().data ?? null;
  const settings = useSettings().data;
  const models = useUsableModels();
  const nodes = detail?.nodes ?? NO_NODES;
  const rootNodeId = detail?.tree.rootNodeId ?? null;
  const archived = Boolean(detail?.tree.archivedAt);

  // Collaboration (web only): what the reader may do here, who wrote what,
  // and who else has the thread open. A viewer or a guest reads only.
  const queryClient = useQueryClient();
  const meId = me?.id ?? null;
  const detailTree = detail?.tree;
  const permissions = useMemo(() => threadPermissions(detailTree, meId), [detailTree, meId]);
  const participants = detail?.participants;
  const people = useMemo(() => threadPeople({ participants }, meId), [participants, meId]);
  const collaboration = useMemo(() => ({ permissions, people }), [people, permissions]);
  const permissionsRef = useLatest(permissions);
  const readOnly = !permissions.canContribute;
  useThreadInterest(treeId, me !== null);
  const viewers = useThreadPresence(treeId);
  const setFollowed = useSetThreadFollowed();
  const [sharing, setSharing] = useState(false);
  const [staleEdit, setStaleEdit] = useState<{ subject: StaleEditSubject } | null>(null);
  const [staleReloading, setStaleReloading] = useState(false);
  const treeTitle = detail?.tree.title ?? "";
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const nodesRef = useLatest(nodes);
  const detailRef = useLatest(detail);

  const fork = useForkResearchNode();
  const ask = useAskResearchFollowup();
  const queuedAction = useQueuedFollowupAction();
  const cancelNode = useCancelResearchNode();
  const retryNode = useRetryResearchNode();
  const rerunNode = useRerunResearchNode();
  const removeBranch = useRemoveResearchBranch();
  const removeTree = useRemoveResearchTree();
  const trashTree = useTrashResearchTree();
  const renameTree = useRenameResearchTree();
  const markViewed = useMarkTreeViewed();
  const createTree = useCreateResearchTree();
  const updateDocument = useUpdateResearchDocument();
  const updatePost = useUpdateResearchPost();
  const createPostFollowUp = useCreateResearchPostFollowUp();
  const setChainOrder = useSetChainOrder(treeId);
  const highlightActions = useHighlightMutations(treeId);
  const recapPendingNodeIds = useRecapPendingStore((state) => state.nodeIds);

  const toast = useCallback((title: string) => pushToast({ title, tone: "info" }), []);
  const fail = useCallback((title: string, error: unknown) => pushErrorToast(title, error), []);

  /* --------------------------------------------------------- selection */

  const history = useThreadHistory({ treeId, nodes, rootNodeId });
  const historyRef = useLatest(history);
  const [pending, setPending] = useState<PendingBranch | null>(null);
  const pendingRef = useLatest(pending);
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const editorRef = useLatest(editor);

  const strip = useMemo(
    () => researchStrip(nodes, history.selection, pending, editor?.nodeId ?? null),
    [editor?.nodeId, history.selection, nodes, pending],
  );
  const stripRef = useLatest(strip);
  // The levels keep their identity while they show the same chains and
  // selections, so what depends on them is not recomputed on every update.
  const levelsKey = strip.levels
    .map((level) =>
      [
        level.headId,
        level.selectedId,
        level.sourceId,
        level.kind,
        level.chainIds.join(","),
        level.displayIds.join(","),
      ].join(":"),
    )
    .join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const levels = useMemo(() => strip.levels, [levelsKey]);
  const levelPathKey = levels.map((level) => level.selectedId).join("\n");
  const levelPath = useMemo(() => (levelPathKey ? levelPathKey.split("\n") : []), [levelPathKey]);
  const levelPathRef = useLatest(levelPath);
  const selectionKey = levelPath.length > 0 ? encodeSelection(levelPath) : "";
  const activePending = strip.pending ? pending : null;

  const branchesByParent = useMemo(() => researchBranchesByParent(nodes), [nodes]);
  const branchesByParentRef = useLatest(branchesByParent);
  const branchStates = useMemo(
    () => researchBranchStates(nodes, branchesByParent),
    [branchesByParent, nodes],
  );

  // Every node's parent as last seen, kept after it is removed, so a removed
  // selection can fall back to the message its branch came from.
  const parentByIdRef = useRef(new Map<string, string | null>());
  useEffect(() => {
    for (const node of nodes) parentByIdRef.current.set(node.id, node.parentNodeId ?? null);
  }, [nodes]);

  // Unread branches: complete since the thread opened, not opened since.
  const firstSeenCompleteRef = useRef(new Map<string, boolean>());
  const [openedNodeIds, setOpenedNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const seen = firstSeenCompleteRef.current;
    for (const level of levels) {
      for (const id of level.chainIds) {
        for (const child of branchesByParent.get(id) ?? []) {
          if (!seen.has(child.id)) seen.set(child.id, nodeStatus(child) === "complete");
        }
      }
    }
  }, [branchesByParent, levels]);
  const markOpened = useCallback((ids: readonly string[]) => {
    setOpenedNodeIds((current) => {
      const added = ids.filter((id) => !current.has(id));
      return added.length === 0 ? current : new Set([...current, ...added]);
    });
  }, []);

  /* --------------------------------------------------- per-visit state */

  const [composerText, setComposerText] = useState<Record<string, string>>({});
  const composerTextRef = useLatest(composerText);
  const [composerImages, setComposerImages] = useState<Record<string, ResearchImageAttachment[]>>(
    {},
  );
  const composerImagesRef = useLatest(composerImages);
  const [composerModels, setComposerModels] = useState<Record<string, ModelChoice>>({});
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const submittingKeyRef = useLatest(submittingKey);
  const [editingByHead, setEditingByHead] = useState<Record<string, string>>({});
  const editingByHeadRef = useLatest(editingByHead);
  const [queuedView, setQueuedView] = useState<{ headId: string; itemId: string } | null>(null);
  const [menu, setMenu] = useState<ThreadMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [deletingNodeId, setDeletingNodeId] = useState<string | null>(null);
  const [rerunNodeId, setRerunNodeId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ nodeId: string; value: string } | null>(null);
  const [recapNodeId, setRecapNodeId] = useState<string | null>(null);
  const [markerTip, setMarkerTip] = useState<{
    element: HTMLElement;
    branchIds: string[];
    level: number;
  } | null>(null);
  const dismissMarkerTip = useCallback(() => setMarkerTip(null), []);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, true>>(() =>
    savedExpandedNodes(treeId),
  );
  const [fullTraceNodes, setFullTraceNodes] = useState<Record<string, boolean>>({});
  const [expandedTiles, setExpandedTiles] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelling, setCancelling] = useState(false);
  const [retryingNodeId, setRetryingNodeId] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorAsking, setEditorAsking] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback(
    (message: string) =>
      setAnnouncement((current) => (current === message ? `${message} ` : message)),
    [],
  );
  const editorFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const setEditorField = useCallback((element: HTMLTextAreaElement | null) => {
    editorFieldRef.current = element;
  }, []);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const composerRefs = useRef(new Map<string, ComposerHandle>());
  const threadHandlesRef = useRef(new Map<number, PostThreadHandle>());
  const rowRef = useLatest<HTMLElement | null>(layout?.row ?? null);

  // The root composer's text is a draft that follows the person across
  // reloads and devices (`stores/drafts.ts`).
  const rootDraftKey = nodeDraftKey(`tree:${treeId}`);
  const setDraft = useDraftsStore((state) => state.setDraft);
  const clearDraft = useDraftsStore((state) => state.clearDraft);
  useEffect(() => {
    if (!rootNodeId) return;
    const saved = useDraftsStore.getState().byKey[rootDraftKey]?.text;
    if (!saved) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setComposerText((current) =>
      current[rootNodeId] ? current : { ...current, [rootNodeId]: saved },
    );
  }, [rootDraftKey, rootNodeId]);
  const setComposerValue = useCallback(
    (key: string, value: string) => {
      setComposerText((current) =>
        current[key] === value ? current : { ...current, [key]: value },
      );
      if (key === rootNodeId) {
        if (value) setDraft(rootDraftKey, { text: value });
        else clearDraft(rootDraftKey);
      }
      const pendingNow = pendingRef.current;
      if (pendingNow?.anchor && key === `pending:${pendingNow.parentNodeId}`) {
        recordPendingBranch(treeId, pendingNow.parentNodeId, pendingNow.anchor, value);
      }
    },
    [pendingRef, clearDraft, rootDraftKey, rootNodeId, setDraft, treeId],
  );

  /* ------------------------------------------------- answers on screen */

  const [answers, setAnswers] = useState<Record<string, PublishedAnswer>>({});
  const answersRef = useLatest(answers);
  const publishAnswer = useCallback((answer: PublishedAnswer) => {
    setAnswers((current) =>
      current[answer.nodeId] === answer ? current : { ...current, [answer.nodeId]: answer },
    );
  }, []);
  useEffect(() => {
    // Answers that left the screen are forgotten.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnswers((current) => {
      const stale = Object.keys(current).filter((id) => !levelPath.includes(id));
      return stale.length === 0 ? current : withoutKeys(current, stale);
    });
  }, [levelPath]);
  const revisionByNode = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const id of levelPath) map[id] = answers[id]?.content?.responseRevision;
    return map;
  }, [answers, levelPath]);
  const settledAnswers = useMemo(
    () => new Set(levelPath.filter((id) => answers[id]?.settled)),
    [answers, levelPath],
  );
  const viewKey = levelPath
    .map((id) => `${id}:${expandedNodes[id] ? 1 : 0}${fullTraceNodes[id] ? 1 : 0}`)
    .join("|");

  /* --------------------------------------------- scroll, annotations */

  const shownQueued =
    queuedView &&
    (detail?.queues?.[queuedView.headId] ?? NO_QUEUE).some((item) => item.id === queuedView.itemId)
      ? queuedView
      : null;
  const { restoredAnswers, onColumnScroll } = useColumnScroll({
    treeId,
    columns: strip.columns,
    levelPath,
    queuedAnswerId: shownQueued
      ? (levels.find((level) => level.headId === shownQueued.headId)?.selectedId ?? null)
      : null,
    settledAnswers,
    workspaceRef,
  });
  const {
    registerSegmentElement,
    segmentRoot,
    domNonce,
    painter,
    resolvedHighlightsRef,
    branchRangesRef,
    resolvedBranchIds,
    markersByNode,
    hiddenHighlightsByNode,
    openBranchIds,
    pointerAnnotationNodeId,
    annotationsAtPoint,
    trackAnnotationUnderPointer,
    clearAnnotationPointer,
    revealFocusHighlight,
  } = useThreadAnnotations({
    treeId,
    levelPath,
    levels,
    activePending,
    branchesByParent,
    nodeById,
    revisionByNode,
    viewKey,
    restoredAnswers,
  });

  /* ------------------------------------------------------------ focus */

  // The column holding keyboard focus makes its level current.
  const [focusedColumnId, setFocusedColumnId] = useState<ResearchColumnId | null>(null);
  useEffect(() => {
    const row = layout?.row;
    if (!row) return;
    const onFocusIn = (event: FocusEvent) => {
      const id = columnIdOf(event.target instanceof Element ? event.target : null);
      if (columnLevelIndex(id) !== null) setFocusedColumnId(id);
    };
    row.addEventListener("focusin", onFocusIn);
    return () => row.removeEventListener("focusin", onFocusIn);
  }, [layout?.row]);

  const composerField = useCallback(
    (key: string) => composerRefs.current.get(key)?.element()?.querySelector("textarea") ?? null,
    [],
  );
  const editorField = useCallback(
    () => (editorFieldRef.current?.isConnected ? editorFieldRef.current : null),
    [],
  );
  const requestFocus = useFocusRequests({ rowRef, workspaceRef, composerField, editorField });

  /* ------------------------------------------------------- navigation */

  /** Discards the unsent branch (its stored text too). */
  const dropPending = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    setPending(null);
    clearPendingBranch(treeId, current.parentNodeId);
    setComposerText((text) => withoutKeys(text, [`pending:${current.parentNodeId}`]));
  }, [pendingRef, treeId]);

  /** User navigation: shows `target` (a path, or one message's source path)
   * and records it in history. */
  const navigate = useCallback(
    (target: string | readonly string[], mode: "push" | "replace" = "push") => {
      const shown = historyRef.current.visit(target, mode);
      if (!shown) return null;
      setQueuedView(null);
      setMenu(null);
      if (pendingRef.current && pendingRef.current.selectionKey !== encodeSelection(shown.path)) {
        dropPending();
      }
      const nodesNow = nodesRef.current;
      markOpened([shown.nodeId, ...shown.path.map((id) => inlineChainFor(nodesNow, id)[0] ?? id)]);
      return shown;
    },
    [historyRef, nodesRef, pendingRef, dropPending, markOpened],
  );

  // Back and Forward change the selection without this page navigating: an
  // unsent branch opened under another selection is discarded.
  useEffect(() => {
    const current = pendingRef.current;
    if (current && selectionKey && current.selectionKey !== selectionKey) dropPending();
  }, [pendingRef, dropPending, selectionKey]);

  /** The selection with `nodeId` selected in the column that lists it. */
  const selectionWith = useCallback(
    (nodeId: string, created?: ResearchNode) => {
      const nodesNow = nodesRef.current;
      const withCreated =
        created && !nodesNow.some((node) => node.id === created.id)
          ? [...nodesNow, created]
          : nodesNow;
      return researchSelectionWith(withCreated, levelPathRef.current, nodeId);
    },
    [levelPathRef, nodesRef],
  );

  // Per chain head: the message last selected in it.
  const chainMemoryRef = useRef(new Map<string, string>());
  useEffect(() => {
    for (const level of levels) chainMemoryRef.current.set(level.headId, level.selectedId);
  }, [levels]);

  const selectMessage = useCallback(
    (level: number, nodeId: string) => {
      const path = levelPathRef.current;
      if (path[level] === nodeId) {
        setQueuedView(null);
        return;
      }
      const next =
        level <= path.length
          ? researchSelectionPath(nodesRef.current, [
              ...path.slice(0, level),
              nodeId,
              ...path.slice(level + 1),
            ])
          : [];
      navigate(next[level] === nodeId ? next : selectionWith(nodeId));
    },
    [levelPathRef, nodesRef, navigate, selectionWith],
  );

  const openBranch = useCallback(
    (level: number, headId: string, end?: "first" | "last", selectParent = false) => {
      const nodesNow = nodesRef.current;
      const chain = inlineChainFor(nodesNow, headId);
      const path = levelPathRef.current;
      const parentId = nodesNow.find((node) => node.id === chain[0])?.parentNodeId ?? null;
      const open = path[level + 1];
      if (!end && open && chain.includes(open) && (!selectParent || path[level] === parentId))
        return;
      const remembered = chainMemoryRef.current.get(headId);
      const listed = end
        ? chainDisplayOrder(chain, nodesNow.find((node) => node.id === chain[0])?.chainOrder)
        : chain;
      const message =
        end === "first"
          ? listed[0]
          : end === "last" || !remembered || !chain.includes(remembered)
            ? listed[listed.length - 1]
            : remembered;
      if (!message) return;
      markOpened([headId]);
      const base =
        (path.length > level && !selectParent) || !parentId
          ? path
          : [...path.slice(0, level), parentId, ...path.slice(level + 1)];
      const next = researchSelectionPath(nodesNow, [
        ...base.slice(0, level + 1),
        message,
        ...base.slice(level + 2),
      ]);
      navigate(next[level + 1] === message ? next : selectionWith(message));
    },
    [levelPathRef, nodesRef, markOpened, navigate, selectionWith],
  );

  const closeAfter = useCallback(
    (level: number) => {
      const path = levelPathRef.current;
      if (path.length > level + 1) navigate(path.slice(0, level + 1));
    },
    [levelPathRef, navigate],
  );

  /** Opens branch `headId` from level `level`, focuses its selected message
   * and brings the passage it came from into view. */
  const goBranch = useCallback(
    (level: number, headId: string, end?: "first" | "last") => {
      openBranch(level, headId, end);
      requestFocus({ kind: "row", level: level + 1 }, "settle");
      requestAnimationFrame(() => {
        const entry = branchRangesRef.current.find((candidate) => candidate.id === headId);
        const root = entry ? segmentRoot(entry.segmentId) : null;
        const range = entry && root ? rangeForTextOffsets(root, entry.start, entry.end) : null;
        const scroller = root?.closest<HTMLElement>("[data-research-scroll]");
        if (!range || !scroller) return;
        const rect = range.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
          scroller.scrollTop += rect.top - bounds.top - bounds.height / 3;
        }
      });
    },
    [branchRangesRef, openBranch, requestFocus, segmentRoot],
  );

  /** Opens a new branch on `anchor` (a passage) or on the whole answer of
   * `parentNodeId`, as a group in the branches column after the parent's
   * level; its ask box takes focus. */
  const openPendingBranch = useCallback(
    (parentNodeId: string, anchor: ResearchHighlightAnchor | null, text = "") => {
      if (readOnly) return;
      const previous = pendingRef.current;
      if (previous && previous.parentNodeId !== parentNodeId) {
        clearPendingBranch(treeId, previous.parentNodeId);
        setComposerText((current) => withoutKeys(current, [`pending:${previous.parentNodeId}`]));
      }
      setMenu(null);
      setQueuedView(null);
      const path = levelPathRef.current;
      let next = path;
      if (path[path.length - 1] !== parentNodeId) {
        const withParent = path.includes(parentNodeId) ? path : selectionWith(parentNodeId);
        const at = withParent.indexOf(parentNodeId);
        next =
          at >= 0 ? withParent.slice(0, at + 1) : researchLevelPath(nodesRef.current, parentNodeId);
        historyRef.current.visit(next, "replace");
      }
      const key = encodeSelection(next);
      setPending({ parentNodeId, anchor, selectionKey: key });
      pendingRef.current = { parentNodeId, anchor, selectionKey: key };
      if (anchor) recordPendingBranch(treeId, parentNodeId, anchor, text);
      if (text) setComposerText((current) => ({ ...current, [`pending:${parentNodeId}`]: text }));
      requestFocus({ kind: "composer", key: `pending:${parentNodeId}` }, "settle");
    },
    [historyRef, levelPathRef, nodesRef, pendingRef, readOnly, requestFocus, selectionWith, treeId],
  );

  // A widget's "Ask for changes" opens a branch from its answer with the
  // change request in the branch's composer, as on the desktop.
  const widgetChange = useMemo<WidgetChangeHandler | null>(
    () =>
      readOnly
        ? null
        : {
            ask: (answer, html) => {
              if (
                researchBranchBlocker(
                  nodesRef.current.find((n) => n.id === answer.nodeId),
                  false,
                )
              )
                return;
              openPendingBranch(answer.nodeId, null);
              const key = `pending:${answer.nodeId}`;
              setComposerText((current) => ({
                ...current,
                [key]: widgetChangePrompt(answer, html, current[key] ?? ""),
              }));
            },
          },
    [readOnly, nodesRef, openPendingBranch],
  );

  const cancelPending = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    dropPending();
    const level = levelPathRef.current.indexOf(current.parentNodeId);
    if (level >= 0) requestFocus({ kind: "answer", level }, "settle");
  }, [levelPathRef, pendingRef, dropPending, requestFocus]);

  // A passage branch saved on a previous visit reopens on its answer once
  // that answer is on screen, if the deepest selection is its parent.
  const restoredPendingRef = useRef(false);
  useEffect(() => {
    if (restoredPendingRef.current || levelPath.length === 0) return;
    const deepest = levelPath[levelPath.length - 1] ?? "";
    const saved = savedPendingBranch(treeId, deepest);
    if (!saved) {
      restoredPendingRef.current = true;
      return;
    }
    if (!revisionByNode[deepest]) return;
    restoredPendingRef.current = true;
    if (!pendingRef.current) openPendingBranch(deepest, saved.anchor, saved.text);
  }, [pendingRef, levelPath, openPendingBranch, revisionByNode, treeId]);

  // The URL's `?highlight=` (from the Highlights view): the reveal runs once
  // the highlight's answer is on screen, and the parameter goes.
  useEffect(() => {
    const highlightId = search.highlight;
    if (!highlightId || !detail) return;
    const owner = detail.nodes.find((node) =>
      node.highlights.some((highlight) => highlight.id === highlightId),
    );
    if (owner) {
      requestHighlightFocus(treeId, owner.id, highlightId);
      revealFocusHighlight();
    }
    void routerNavigate({
      to: "/r/$treeId",
      params: { treeId },
      replace: true,
      search: (previous: Record<string, unknown>) => ({ ...previous, highlight: undefined }),
    } as never);
    // Runs when the parameter or the detail's presence changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.highlight, Boolean(detail)]);

  // Removed messages: the selection falls back to the nearest surviving
  // source or preceding message (replacing the history entry), a removed
  // parent discards the unsent branch, and stored per-node state goes.
  useEffect(() => {
    if (!detail || levelPath.length === 0) return;
    const valid = new Set(detail.nodes.map((node) => node.id));
    pruneThreadNavigation(treeId, valid);
    const current = pendingRef.current;
    if (current && !valid.has(current.parentNodeId)) dropPending();
    if (editorRef.current && !valid.has(editorRef.current.nodeId)) setEditor(null);
    const requested = history.selection;
    const ids = requested === null ? [] : typeof requested === "string" ? [requested] : requested;
    if (!ids.some((id) => !valid.has(id))) return;
    const survivor = (nodeId: string) =>
      researchSurvivingAncestor(parentByIdRef.current, nodeId, valid);
    const path = researchSelectionAfterRemoval(detail.nodes, ids, survivor);
    const fallback = path.length > 0 ? path : [detail.tree.rootNodeId];
    historyRef.current.visit(fallback, "replace");
    requestFocus({ kind: "row", level: fallback.length - 1 }, "settle", true);
  }, [
    editorRef,
    historyRef,
    pendingRef,
    detail,
    dropPending,
    history.selection,
    levelPath.length,
    requestFocus,
    treeId,
  ]);

  // Clear unread status on arrival and when a run completes while open.
  const completedCount = nodes.filter((node) => nodeStatus(node) === "complete").length;
  const viewedMutate = markViewed.mutate;
  useEffect(() => {
    if (!detail || !me) return;
    viewedMutate(treeId);
  }, [Boolean(detail), completedCount, me, treeId, viewedMutate]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------ run controls */

  const cancelMutate = cancelNode.mutateAsync;
  const handleCancel = useCallback(
    (nodeId: string) => {
      if (cancelling) return;
      setCancelling(true);
      cancelMutate(nodeId)
        .catch((error: unknown) => fail("The run could not be stopped", error))
        .finally(() => setCancelling(false));
    },
    [cancelMutate, cancelling, fail],
  );
  const retryMutate = retryNode.mutateAsync;
  const rerunMutate = rerunNode.mutateAsync;
  /** Relaunches a settled node in place: a retry of a failed or stopped run,
   * a rerun (which replaces the answer) of a complete one. */
  const handleRetry = useCallback(
    (nodeId: string) => {
      if (retryingNodeId !== null) return;
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      setRetryingNodeId(nodeId);
      const relaunch =
        node && nodeStatus(node) === "complete" ? rerunMutate(nodeId) : retryMutate({ nodeId });
      relaunch
        .catch((error: unknown) => fail("The answer could not be run again", error))
        .finally(() => setRetryingNodeId((current) => (current === nodeId ? null : current)));
    },
    [nodesRef, fail, rerunMutate, retryMutate, retryingNodeId],
  );

  /* ----------------------------------------------------------- tiles */

  const toggleTile = useCallback(
    (id: string) => setExpandedTiles((current) => toggleResearchTile(current, id)),
    [],
  );
  const expandAllTurns = useCallback(
    (nodeId: string) => {
      setExpandedNodes((current) => (current[nodeId] ? current : { ...current, [nodeId]: true }));
      recordExpanded(treeId, nodeId);
    },
    [treeId],
  );
  const toggleFullTrace = useCallback(
    (nodeId: string) =>
      setFullTraceNodes((current) => ({ ...current, [nodeId]: !current[nodeId] })),
    [],
  );

  /* ----------------------------------------------------- reordering */

  const chainOrderMutate = setChainOrder.mutate;
  const chainDisplayIds = useCallback(
    (headId: string): readonly string[] => {
      const nodesNow = nodesRef.current;
      const chain = inlineChainFor(nodesNow, headId);
      return chain[0] === headId
        ? chainDisplayOrder(chain, nodesNow.find((node) => node.id === headId)?.chainOrder)
        : [];
    },
    [nodesRef],
  );
  const reorderChain = useCallback(
    (headId: string, nodeId: string, beforeId: string | null): string[] | null => {
      const displayIds = chainDisplayIds(headId);
      if (!permissionsRef.current.canReorder || !displayIds.includes(nodeId)) return null;
      const next = reorderedIds([...displayIds], nodeId, beforeId);
      if (next.length === displayIds.length && next.every((id, index) => id === displayIds[index]))
        return null;
      chainOrderMutate(
        // The order the column showed: a change made since is refused.
        { headNodeId: headId, nodeIds: next, expectedOrder: [...displayIds] },
        {
          onError: (error) => {
            if (isConflictError(error)) setStaleEdit({ subject: "order" });
            else fail("The messages could not be reordered", error);
          },
        },
      );
      return next;
    },
    [permissionsRef, chainDisplayIds, chainOrderMutate, fail],
  );
  const startMessageDrag = useMessageDrag({
    onMove: (nodeId, place, beforeId) => {
      if (place.startsWith("chain:")) reorderChain(place.slice("chain:".length), nodeId, beforeId);
    },
  });
  const moveFocusedMessage = useCallback(
    (row: HTMLElement, level: number, step: -1 | 1) => {
      const nodeId = row.dataset["nodeId"];
      if (!nodeId || !permissionsRef.current.canReorder) return;
      const headId = inlineChainFor(nodesRef.current, nodeId)[0] ?? nodeId;
      const ids = chainDisplayIds(headId);
      const target = stepReorderTarget([...ids], nodeId, step);
      if (!target) {
        announce(
          ids.length > 1 ? (step < 0 ? "Already first." : "Already last.") : "Only message.",
        );
        return;
      }
      if (!reorderChain(headId, nodeId, target.beforeId)) return;
      announce(`Moved to position ${ids.indexOf(nodeId) + step + 1} of ${ids.length}.`);
      const started = performance.now();
      const refocus = () => {
        const current = workspaceRef.current
          ?.querySelector(columnSelector(`T${level}`))
          ?.querySelector<HTMLElement>(rowSelector(nodeId));
        if (current && document.activeElement !== current) {
          current.tabIndex = 0;
          current.focus({ preventScroll: true });
        }
        if (current) scrollIntoColumn(current);
        if (performance.now() - started < 300) requestAnimationFrame(refocus);
      };
      requestAnimationFrame(refocus);
    },
    [nodesRef, permissionsRef, announce, chainDisplayIds, reorderChain],
  );

  /* ------------------------------------------------------- selection */

  const revisionOf = useCallback(
    (nodeId: string) => answersRef.current[nodeId]?.content?.responseRevision,
    [answersRef],
  );
  const transcriptOf = useCallback(
    (nodeId: string) => isTranscript(nodesRef.current.find((node) => node.id === nodeId)),
    [nodesRef],
  );
  const textSelection = useTextSelection({
    viewKey: `${levelPathKey}|${viewKey}|${Object.values(revisionByNode).join(",")}`,
    revisionOf,
    transcriptOf,
    resolvedHighlightsRef,
    painter,
    segmentRoot,
    domNonce,
    nodeById,
    archived,
    highlights: highlightActions,
    openPendingBranch,
    onToast: toast,
    onError: (message) => pushToast({ title: message, tone: "error" }),
  });

  /** A plain click on a tinted passage selects its branch in the next
   * column (or clears that column when it is the branch open there); with
   * several branches or a highlight, it opens the passage menu. */
  const clearSelectionAction = textSelection.clearAction;
  const openAnnotationAtPoint = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const selection = window.getSelection();
      if (!selection || !selection.isCollapsed) return;
      if (event.target instanceof Element && event.target.closest("a")) return;
      const hit = annotationsAtPoint(event.currentTarget, event.clientX, event.clientY);
      if (!hit || (hit.branchIds.length === 0 && !hit.highlight)) return;
      const level = levelPathRef.current.indexOf(hit.nodeId);
      if (hit.branchIds.length === 1 && !hit.highlight) {
        const only = hit.branchIds[0] as string;
        if (level >= 0 && stripRef.current.levels[level + 1]?.headId === only) closeAfter(level);
        else if (level >= 0) goBranch(level, only);
        return;
      }
      clearSelectionAction();
      setMenu({
        kind: "mark",
        nodeId: hit.nodeId,
        branchIds: hit.branchIds,
        highlightId: hit.highlight?.highlight.id ?? null,
        anchor: { kind: "point", x: event.clientX, y: event.clientY + 10 },
      });
    },
    [levelPathRef, stripRef, annotationsAtPoint, clearSelectionAction, closeAfter, goBranch],
  );

  /* --------------------------------------------------------- keyboard */

  const anyOverlayOpen = Boolean(
    menu || textSelection.action || renameTarget || deletingNodeId || rerunNodeId || recapNodeId,
  );
  const anyOverlayOpenRef = useLatest(anyOverlayOpen);
  const onKeyDown = useThreadKeyboard({
    workspaceRef,
    stripRef,
    levelPathRef,
    branchesByParentRef,
    editorRef,
    threadHandlesRef,
    anyOverlayOpenRef,
    pendingRef,
    closeAfter,
    requestFocus,
    selectMessage,
    openBranch,
    goBranch,
    moveFocusedMessage,
  });

  /** A row's branch indicator: selects the message's first branch in the
   * next column, or clears that column when one of its branches is open. */
  const toggleBranches = useCallback(
    (nodeId: string, level: number) => {
      const current = stripRef.current;
      if (current.levels[level + 1]?.sourceId === nodeId) {
        closeAfter(level);
        return;
      }
      const column = current.columns.find(
        (candidate) => candidate.role === "branches" && candidate.levelIndex === level + 1,
      );
      const listed =
        column?.role === "branches"
          ? column.groups.find((group) => group.kind === "branch" && group.sourceId === nodeId)
          : undefined;
      const headId =
        listed?.kind === "branch"
          ? listed.headId
          : researchBranchesInPassageOrder(branchesByParentRef.current.get(nodeId) ?? [])[0]?.id;
      if (headId) goBranch(level, headId);
    },
    [branchesByParentRef, stripRef, closeAfter, goBranch],
  );

  /* -------------------------------------------------------- composers */

  /** The model a chain's ask box sends with until its picker chooses
   * another: the chain's last message's model and effort, else the
   * account's default. */
  const defaultChoiceFor = useCallback(
    (node: ResearchNode | undefined): ModelChoice | null => {
      const own = node ? nodeModelId(node) : "";
      const usable = (id: string | undefined) =>
        Boolean(id) && models.some((model) => model.id === id && model.available);
      const model = usable(own)
        ? own
        : usable(settings?.defaultModel)
          ? (settings?.defaultModel as string)
          : models.find((candidate) => candidate.available)?.id;
      if (!model) return null;
      const effort =
        node && model === own
          ? ((nodeAgent(node)?.effort ?? null) as ReasoningEffort | null)
          : null;
      const accepted = findModel(model)?.efforts ?? [];
      return { model, effort: effort && accepted.includes(effort) ? effort : null };
    },
    [models, settings?.defaultModel],
  );
  const choiceFor = useCallback(
    (key: string, node: ResearchNode | undefined) => composerModels[key] ?? defaultChoiceFor(node),
    [composerModels, defaultChoiceFor],
  );
  const choiceRef = useLatest(choiceFor);

  const navigationSeqRef = useRef(0);
  useEffect(() => {
    navigationSeqRef.current += 1;
  }, [selectionKey]);

  const clearComposer = useCallback(
    (key: string, sent: readonly ResearchImageAttachment[]) => {
      setComposerValue(key, "");
      const sentIds = new Set(sent.map((image) => image.id));
      setComposerImages((current) => {
        const kept = (current[key] ?? []).filter((image) => !sentIds.has(image.id));
        return kept.length === 0 ? withoutKeys(current, [key]) : { ...current, [key]: kept };
      });
    },
    [setComposerValue],
  );

  const forkMutate = fork.mutateAsync;
  const askMutate = ask.mutateAsync;
  /** Sends a chain's ask box: continues the chain through the server's
   * follow-up queue (sent now, or queued behind the running answer), forks
   * a new branch with ⇧⌘↵, or replaces the failed question being edited. A
   * sent question becomes its column's selection. */
  const submitComposer = useCallback(
    async (headId: string, { branch = false }: { branch?: boolean } = {}) => {
      const currentDetail = detailRef.current;
      const prompt = (composerTextRef.current[headId] ?? "").trim();
      const images = composerImagesRef.current[headId] ?? NO_IMAGES;
      if (!currentDetail || !prompt || readOnly || submittingKeyRef.current) return;
      const chain = inlineChainFor(currentDetail.nodes, headId)
        .map((id) => currentDetail.nodes.find((node) => node.id === id))
        .filter((node): node is ResearchNode => Boolean(node));
      const tail = chain[chain.length - 1];
      const choice = choiceRef.current(headId, tail);
      const agent = choice ? { model: choice.model, effort: choice.effort } : undefined;
      const imageIds = images.length > 0 ? images.map((image) => image.id) : undefined;
      const seq = navigationSeqRef.current;
      const stillShown = (replacedId?: string) =>
        navigationSeqRef.current === seq &&
        (headId === replacedId || stripRef.current.levels.some((level) => level.headId === headId));
      setSubmittingKey(headId);
      try {
        if (branch) {
          const source = [...chain].reverse().find((node) => canFollowUpFrom(node));
          if (!source) return;
          const child = await forkMutate({
            parentNodeId: source.id,
            prompt,
            inline: false,
            ...(agent ? { agent } : {}),
            ...(imageIds ? { images: imageIds } : {}),
          });
          clearComposer(headId, images);
          if (stillShown()) {
            navigate(selectionWith(child.id, child));
            requestFocus({ kind: "composer", key: child.id }, "settle");
          }
          return;
        }
        const editingId = editingByHeadRef.current[headId];
        if (editingId) {
          const failed = currentDetail.nodes.find((node) => node.id === editingId);
          const request = failed ? researchEditedQuestionFork(failed, prompt) : null;
          if (!failed || !request) {
            setEditingByHead((current) => withoutKeys(current, [headId]));
            return;
          }
          const child = await forkMutate({
            parentNodeId: request.parentNodeId,
            prompt: request.prompt,
            anchor: request.anchor,
            inline: request.inline,
            replacesNodeId: request.replacesNodeId,
            ...(agent ? { agent } : {}),
            ...(imageIds ? { images: imageIds } : {}),
          });
          clearComposer(headId, images);
          setEditingByHead((current) => withoutKeys(current, [headId]));
          if (stillShown(failed.id)) {
            navigate(selectionWith(child.id, child));
            requestFocus(
              { kind: "composer", key: failed.id === headId ? child.id : headId },
              "none",
            );
          }
          return;
        }
        const result = await askMutate({
          headNodeId: headId,
          prompt,
          ...(choice ? { model: choice.model, effort: choice.effort } : {}),
          ...(imageIds ? { images: imageIds } : {}),
        });
        clearComposer(headId, images);
        if (result.kind === "sent" && stillShown())
          navigate(selectionWith(result.node.id, result.node));
      } catch (error) {
        fail("The question could not be sent", error);
      } finally {
        setSubmittingKey(null);
      }
    },
    [
      choiceRef,
      composerImagesRef,
      composerTextRef,
      detailRef,
      editingByHeadRef,
      stripRef,
      submittingKeyRef,
      readOnly,
      askMutate,
      clearComposer,
      fail,
      forkMutate,
      navigate,
      requestFocus,
      selectionWith,
    ],
  );

  /** Sends the unsent branch's first question: the branch is created with
   * it and becomes the next level. */
  const submitPendingBranch = useCallback(async () => {
    const current = pendingRef.current;
    if (!current) return;
    const key = `pending:${current.parentNodeId}`;
    const prompt = (composerTextRef.current[key] ?? "").trim();
    const images = composerImagesRef.current[key] ?? NO_IMAGES;
    if (!prompt || submittingKeyRef.current || readOnly) return;
    const parent = nodesRef.current.find((node) => node.id === current.parentNodeId);
    const choice = choiceRef.current(key, parent);
    setSubmittingKey(key);
    try {
      const child = await forkMutate({
        parentNodeId: current.parentNodeId,
        prompt,
        anchor: current.anchor ? { kind: "passage", anchor: current.anchor } : null,
        inline: false,
        ...(choice ? { agent: { model: choice.model, effort: choice.effort } } : {}),
        ...(images.length > 0 ? { images: images.map((image) => image.id) } : {}),
      });
      clearPendingBranch(treeId, current.parentNodeId);
      clearComposer(key, images);
      if (pendingRef.current === current) {
        setPending(null);
        pendingRef.current = null;
        navigate(selectionWith(child.id, child));
        requestFocus({ kind: "composer", key: child.id }, "settle");
      }
    } catch (error) {
      fail("The branch could not be created", error);
    } finally {
      setSubmittingKey(null);
    }
  }, [
    choiceRef,
    composerImagesRef,
    composerTextRef,
    nodesRef,
    pendingRef,
    submittingKeyRef,
    readOnly,
    clearComposer,
    fail,
    forkMutate,
    navigate,
    requestFocus,
    selectionWith,
    treeId,
  ]);

  const handleEditQuestion = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      const headId = inlineChainFor(nodesRef.current, nodeId)[0] ?? nodeId;
      setEditingByHead((current) => ({ ...current, [headId]: nodeId }));
      setComposerValue(headId, nodePrompt(node));
      requestFocus({ kind: "composer", key: headId }, "reveal");
    },
    [nodesRef, requestFocus, setComposerValue],
  );

  /* ------------------------------------------------------------ queue */

  const queuedMutate = queuedAction.mutate;
  const cancelQueued = useCallback(
    (headId: string, item: ResearchFollowupQueueItem) => {
      queuedMutate(
        { action: "cancel", treeId, headNodeId: headId, itemId: item.id },
        { onError: (error) => fail("The follow-up could not be cancelled", error) },
      );
      setQueuedView((current) => (current?.itemId === item.id ? null : current));
      requestFocus({ kind: "composer", key: headId }, "none");
    },
    [fail, queuedMutate, requestFocus, treeId],
  );

  /* ----------------------------------------------------------- menus */

  const openAnswerMenu = useCallback((trigger: HTMLButtonElement, nodeId: string) => {
    setMenu((current) =>
      current?.kind === "answer" &&
      current.nodeId === nodeId &&
      current.anchor.kind === "element" &&
      current.anchor.element === trigger
        ? null
        : { kind: "answer", nodeId, anchor: { kind: "element", element: trigger } },
    );
  }, []);
  const openContextMenu = useCallback((nodeId: string, point: { x: number; y: number }) => {
    setMenu({ kind: "answer", nodeId, anchor: { kind: "point", x: point.x, y: point.y } });
  }, []);

  const copyAnswer = useCallback(
    (view: SegmentView) => {
      const text = view.conversationCopyText ?? view.rawAnswer;
      if (!text) return;
      writeClipboardText(text)
        .then(() => toast(view.conversationCopyText ? "Conversation copied." : "Answer copied."))
        .catch(() => toast("Couldn't copy."));
    },
    [toast],
  );
  const copyNote = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      const text = node ? nodePrompt(node) : "";
      if (!text) return;
      writeClipboardText(text)
        .then(() => toast("Note copied."))
        .catch(() => toast("Couldn't copy."));
    },
    [nodesRef, toast],
  );
  const copyThread = useCallback(
    async (chainIds: string[]) => {
      const parts: string[] = [];
      try {
        for (const id of chainIds) {
          const node = nodesRef.current.find((candidate) => candidate.id === id);
          if (!node) continue;
          const published = answersRef.current[id];
          const content = published?.content ?? (await getResearchNodeContent(id));
          const view =
            published?.view ??
            buildSegmentView({
              node,
              content,
              turns: content.turns,
              showAllTurns: true,
              showFullTrace: false,
            });
          const body = (view.conversationCopyText ?? view.rawAnswer).trim();
          const prompt = nodeMessage(node)?.text.trim() || null;
          if (!prompt && !body) continue;
          parts.push(
            [prompt ? `**Question:** ${prompt}` : null, body || "_No response available._"]
              .filter(Boolean)
              .join("\n\n"),
          );
        }
      } catch (error) {
        fail("The thread could not be copied", error);
        return;
      }
      if (parts.length === 0) return;
      writeClipboardText(parts.join("\n\n---\n\n"))
        .then(() => toast("Thread copied."))
        .catch(() => toast("Couldn't copy."));
    },
    [answersRef, nodesRef, fail, toast],
  );

  /* ----------------------------------------------------------- editor */

  const editorText = useDeferredValue(editor?.text ?? "");
  const editorStats = useMemo(
    () => (editor ? researchEditorStats(editor, editorText) : null),
    // Only the text and the session's fixed inputs count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor?.nodeId, editor?.kind, editor?.initialText, editorText],
  );

  /** Opens the editor column for the root's document or for a note. A
   * document's editor follows the root level's columns; a note's editor
   * takes its note column's place. */
  const startEditing = useCallback(
    (nodeId: string, returnFocus: HTMLElement | null) => {
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      const currentDetail = detailRef.current;
      if (!node || !currentDetail || archived) return;
      const isRoot = nodeId === currentDetail.tree.rootNodeId;
      if (!isRoot && nodeType(node) !== "post") return;
      // A document is the owner's to edit; a note its author's (web only).
      const allowed =
        nodeType(node) === "post"
          ? mayEditText(permissionsRef.current, nodesRef.current, node)
          : permissionsRef.current.isOwner;
      if (!allowed) return;
      let session: EditorSession;
      if (isRoot && node.type === "document") {
        const published = answersRef.current[nodeId];
        const markdown = published?.view.editableDocumentMarkdown ?? null;
        const revision = published?.content?.responseRevision;
        if (!revision || markdown == null) {
          pushToast({ title: "The document content is unavailable.", tone: "error" });
          return;
        }
        session = {
          nodeId,
          kind: "document",
          initialText: markdown,
          text: markdown,
          initialTitle: currentDetail.tree.title,
          title: currentDetail.tree.title,
          expectedText: markdown,
          expectedTitle: currentDetail.tree.title,
          responseRevision: revision,
          highlightIds: node.highlights.map((highlight) => highlight.id),
          highlightAnchors: node.highlights.map((highlight) => highlight.anchor),
          branchAnchors: nodesRef.current.flatMap((child) => {
            const anchor = child.parentNodeId === nodeId ? passageAnchor(child) : null;
            return anchor ? [anchor] : [];
          }),
          imported: documentSource(node) === "imported",
          returnFocus,
        };
      } else if (nodeType(node) === "post") {
        session = {
          nodeId,
          kind: "post",
          initialText: nodePrompt(node),
          text: nodePrompt(node),
          initialTitle: "",
          title: "",
          expectedText: nodePrompt(node),
          expectedTitle: "",
          responseRevision: null,
          highlightIds: [],
          highlightAnchors: node.highlights.map((highlight) => highlight.anchor),
          branchAnchors: [],
          imported: false,
          returnFocus,
        };
      } else {
        return;
      }
      dropPending();
      setMenu(null);
      setEditorError(null);
      setEditor(session);
      const path = levelPathRef.current;
      if (
        session.kind === "document"
          ? path[0] !== nodeId || path.length !== 1
          : !path.includes(nodeId)
      ) {
        navigate(session.kind === "document" ? [nodeId] : nodeId);
      }
      requestFocus({ kind: "editor" }, "settle");
    },
    [
      answersRef,
      detailRef,
      levelPathRef,
      nodesRef,
      permissionsRef,
      archived,
      dropPending,
      navigate,
      requestFocus,
    ],
  );

  /** A double-click on a note edits it, unless the editor is busy or the
   * note is already in it. */
  const editNoteOnDoubleClick = useCallback(
    (nodeId: string, returnFocus: HTMLElement | null) => {
      if (editorSaving || editorAsking || editorRef.current?.nodeId === nodeId) return;
      startEditing(nodeId, returnFocus);
    },
    [editorRef, editorAsking, editorSaving, startEditing],
  );

  // The URL's `?edit=` (a double-click on a note's card on Home): the note
  // opens in the editor once the tree has loaded, and the parameter goes.
  const startEditingRef = useLatest(startEditing);
  useEffect(() => {
    const nodeId = search.edit;
    if (!nodeId || !detail) return;
    const node = detail.nodes.find((candidate) => candidate.id === nodeId);
    const editable = researchNoteEditable(node, detail.tree.archivedAt != null);
    void routerNavigate({
      to: "/r/$treeId",
      params: { treeId },
      replace: true,
      search: (previous: Record<string, unknown>) => ({ ...previous, edit: undefined }),
    } as never).then(() => {
      if (editable) startEditingRef.current(nodeId, null);
    });
    // Runs when the parameter or the detail's presence changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.edit, Boolean(detail)]);

  const closeEditor = useCallback(() => {
    const session = editorRef.current;
    const level =
      stripRef.current.columns.find((column) => column.role === "editor")?.levelIndex ?? 0;
    setEditor(null);
    setEditorError(null);
    setEditorSaving(false);
    const target = session?.returnFocus;
    if (session?.kind === "post" && !target?.isConnected) {
      requestFocus({ kind: "note", level, menu: false }, "settle");
      return;
    }
    requestAnimationFrame(() => {
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        settleStrip(rowRef.current, columnIdOf(target));
        return;
      }
      requestFocus({ kind: "row", level: 0 }, "settle");
    });
  }, [editorRef, rowRef, stripRef, requestFocus]);

  const updateDocumentMutate = updateDocument.mutateAsync;
  const updatePostMutate = updatePost.mutateAsync;
  /** Saves the editor (Save, ⌘↵), then closes it; with `keepOpen` (⌘S) it
   * stays open with the saved text as the one the field is compared with,
   * and a toast says it saved. A refusal (a stale edit) keeps the editor
   * open with the server's message. */
  const saveEditor = useCallback(
    async ({ keepOpen = false }: { keepOpen?: boolean } = {}) => {
      const session = editorRef.current;
      if (!session || editorSaving) return;
      setEditorSaving(true);
      setEditorError(null);
      try {
        let stored: Parameters<typeof researchEditorSessionSaved>[2];
        if (session.kind === "document") {
          const result = await updateDocumentMutate({
            nodeId: session.nodeId,
            markdown: session.text,
            title: session.title.trim() || null,
            expectedResponseRevision: session.responseRevision ?? "",
            expectedTitle: session.expectedTitle,
            expectedHighlightIds: session.highlightIds,
          });
          stored = result;
          const removed = result.removedHighlightCount;
          toast(
            removed > 0
              ? `Document saved · ${removed.toLocaleString()} highlight${removed === 1 ? "" : "s"} removed`
              : "Document saved",
          );
        } else {
          const result = await updatePostMutate({
            nodeId: session.nodeId,
            text: session.text,
            expectedText: session.expectedText,
          });
          stored = result;
          const removed = result.removedHighlightCount;
          toast(
            removed > 0
              ? `Note saved · ${removed.toLocaleString()} highlight${removed === 1 ? "" : "s"} removed`
              : "Note saved",
          );
        }
        if (!keepOpen) {
          closeEditor();
          return;
        }
        const saved = { text: session.text, title: session.title };
        setEditor((current) =>
          current && current.nodeId === session.nodeId
            ? researchEditorSessionSaved(current, saved, stored)
            : current,
        );
        setEditorSaving(false);
      } catch (error) {
        setEditorError(errorText(error));
        setEditorSaving(false);
        // Someone saved a newer version first: offer to reload it, keeping
        // the text in the field.
        if (isConflictError(error)) {
          setStaleEdit({ subject: session.kind === "post" ? "note" : "document" });
        }
      }
    },
    [editorRef, closeEditor, editorSaving, toast, updateDocumentMutate, updatePostMutate],
  );

  /** After a stale-edit refusal: the editor's base becomes the latest saved
   * version (what the next save expects the server to hold, and what the
   * preview compares with); the field keeps the reader's text. A refused
   * reorder refetches the thread. */
  const reloadLatest = useCallback(async () => {
    const subject = staleEdit?.subject;
    const session = editorRef.current;
    setStaleReloading(true);
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: queryKeys.tree(treeId),
        queryFn: () => getResearchTree(treeId),
        staleTime: 0,
      });
      if ((subject === "note" || subject === "document") && session) {
        const node = fresh.nodes.find((candidate) => candidate.id === session.nodeId);
        if (!node) {
          setEditorError("This was deleted while you were editing it.");
        } else if (session.kind === "post") {
          const latest = nodePrompt(node);
          setEditor((current) =>
            current && current.nodeId === session.nodeId
              ? {
                  ...current,
                  initialText: latest,
                  expectedText: latest,
                  highlightAnchors: node.highlights.map((highlight) => highlight.anchor),
                }
              : current,
          );
          setEditorError(null);
        } else {
          const content = await queryClient.fetchQuery({
            queryKey: queryKeys.nodeContent(node.id),
            queryFn: () => getResearchNodeContent(node.id),
            staleTime: 0,
          });
          const markdown = buildSegmentView({
            node,
            content,
            turns: content.turns,
            showAllTurns: true,
            showFullTrace: false,
          }).editableDocumentMarkdown;
          const revision = content.responseRevision;
          if (markdown == null || !revision) {
            setEditorError("The document content is unavailable.");
          } else {
            setEditor((current) =>
              current && current.nodeId === session.nodeId
                ? {
                    ...current,
                    initialText: markdown,
                    expectedText: markdown,
                    initialTitle: fresh.tree.title,
                    expectedTitle: fresh.tree.title,
                    responseRevision: revision,
                    highlightIds: node.highlights.map((highlight) => highlight.id),
                    highlightAnchors: node.highlights.map((highlight) => highlight.anchor),
                    branchAnchors: fresh.nodes.flatMap((child) => {
                      const anchor = child.parentNodeId === node.id ? passageAnchor(child) : null;
                      return anchor ? [anchor] : [];
                    }),
                  }
                : current,
            );
            setEditorError(null);
          }
        }
      }
      setStaleEdit(null);
    } catch (error) {
      fail("The latest version could not be loaded", error);
    } finally {
      setStaleReloading(false);
    }
  }, [editorRef, fail, queryClient, staleEdit?.subject, treeId]);

  const createTreeMutate = createTree.mutateAsync;
  const askEditorAsQuestion = useCallback(
    async (choice: ModelChoice) => {
      const session = editorRef.current;
      const workspaceId = detailRef.current?.tree.workspaceId;
      if (!session || editorAsking || !workspaceId) return;
      setEditorAsking(true);
      setEditorError(null);
      try {
        const created = await createTreeMutate({
          prompt: session.text.trim(),
          model: choice.model,
          workspaceId,
        });
        setEditor(null);
        void routerNavigate({ to: "/r/$treeId", params: { treeId: created.tree.id } });
      } catch (error) {
        setEditorError(errorText(error));
      } finally {
        setEditorAsking(false);
      }
    },
    [detailRef, editorRef, createTreeMutate, editorAsking, routerNavigate],
  );

  /* ------------------------------------------------- rename, delete */

  const renameTreeMutate = renameTree.mutateAsync;
  const renameNode = useCallback(
    async (nodeId: string, title: string) => {
      const currentDetail = detailRef.current;
      if (!currentDetail) return;
      if (nodeId === currentDetail.tree.rootNodeId) {
        await renameTreeMutate({ treeId: currentDetail.tree.id, title });
      } else {
        await renameResearchNode(nodeId, title);
      }
    },
    [detailRef, renameTreeMutate],
  );

  const removeBranchMutate = removeBranch.mutateAsync;
  const removeTreeMutate = removeTree.mutateAsync;
  const trashTreeMutate = trashTree.mutateAsync;
  const leaveTree = useCallback(() => {
    forgetThread(treeId);
    void routerNavigate({ to: "/" });
  }, [routerNavigate, treeId]);
  const removeNode = useCallback(
    async (node: ResearchNode) => {
      const currentDetail = detailRef.current;
      if (!currentDetail) return;
      if (node.id === currentDetail.tree.rootNodeId) {
        await removeTreeMutate(currentDetail.tree.id);
        leaveTree();
        return;
      }
      const subtree = researchSubtreeIds(nodesRef.current, node.id);
      const wasOnPath = levelPathRef.current.some((id) => subtree.has(id));
      const removal = await removeBranchMutate(node.id);
      if (!wasOnPath) return;
      const removed = new Set(removal.removedNodeIds);
      const remaining = nodesRef.current.filter((candidate) => !removed.has(candidate.id));
      const valid = new Set(remaining.map((candidate) => candidate.id));
      const kept = researchSelectionAfterRemoval(remaining, levelPathRef.current, (id) =>
        researchSurvivingAncestor(parentByIdRef.current, id, valid),
      );
      const path = kept.length > 0 ? kept : researchLevelPath(remaining, removal.parentNodeId);
      historyRef.current.visit(path, "replace");
      requestFocus({ kind: "row", level: Math.max(0, path.length - 1) }, "settle");
    },
    [
      detailRef,
      historyRef,
      levelPathRef,
      nodesRef,
      leaveTree,
      removeBranchMutate,
      removeTreeMutate,
      requestFocus,
    ],
  );
  const trashRoot = useCallback(async () => {
    await trashTreeMutate(treeId);
    leaveTree();
  }, [leaveTree, trashTreeMutate, treeId]);

  /* --------------------------------------------------- note actions */

  const createPostFollowUpMutate = createPostFollowUp.mutateAsync;
  const postActions = useMemo<PostActions>(
    () => ({
      onAskFollowUp: async ({ parentNodeId, prompt, asNote, images, choice }) => {
        if (asNote) {
          await createPostFollowUpMutate({ parentNodeId, body: prompt });
          return;
        }
        await forkMutate({
          parentNodeId,
          prompt,
          inline: false,
          ...(choice ? { agent: { model: choice.model, effort: choice.effort } } : {}),
          ...(images.length > 0 ? { images: images.map((image) => image.id) } : {}),
        });
      },
      onRetry: async (nodeId) => {
        await retryMutate({ nodeId });
      },
    }),
    [createPostFollowUpMutate, forkMutate, retryMutate],
  );

  /* ----------------------------------------------- shared callbacks */

  const answerHandlers = useMemo<AnswerPaneHandlers>(
    () => ({
      registerSegmentElement,
      onExpandTurns: expandAllTurns,
      onRetryContentLoad: () => {},
      onToggleFullTrace: toggleFullTrace,
      onCancelNode: handleCancel,
      onRetryNode: handleRetry,
      onEditQuestion: handleEditQuestion,
      onRootKeyUp: textSelection.captureSelection,
      onRootClick: openAnnotationAtPoint,
      onRootMouseMove: trackAnnotationUnderPointer,
      onRootMouseLeave: clearAnnotationPointer,
    }),
    [
      clearAnnotationPointer,
      registerSegmentElement,
      trackAnnotationUnderPointer,
      expandAllTurns,
      handleCancel,
      handleEditQuestion,
      handleRetry,
      openAnnotationAtPoint,
      textSelection.captureSelection,
      toggleFullTrace,
    ],
  );
  const selectRow = useCallback(
    (nodeId: string, level: number) => {
      selectMessage(level, nodeId);
      requestFocus({ kind: "row", level }, "reveal");
    },
    [requestFocus, selectMessage],
  );
  const rowActions = useMemo<MessageRowActions>(
    () => ({
      registerSegmentElement,
      onSelect: selectRow,
      onToggleBranches: toggleBranches,
      onOpenAnswerMenu: openAnswerMenu,
      onOpenContextMenu: openContextMenu,
      onToggleExpanded: toggleTile,
      onDragStart: startMessageDrag,
    }),
    [
      registerSegmentElement,
      openAnswerMenu,
      openContextMenu,
      selectRow,
      startMessageDrag,
      toggleBranches,
      toggleTile,
    ],
  );
  const markerActions = useMemo<MarkerActions>(
    () => ({
      nodeById,
      branchState: branchStates.ofBranch,
      onTip: setMarkerTip,
      onCloseBranch: (level, key) => {
        closeAfter(level);
        requestFocus({ kind: "marker", level, key }, "settle");
      },
      onOpenBranch: goBranch,
    }),
    [branchStates, closeAfter, goBranch, nodeById, requestFocus],
  );

  const historyNav: ThreadHistoryNav = {
    canGoBack: history.canGoBack,
    canGoForward: history.canGoForward,
    onBack: history.goBack,
    onForward: history.goForward,
  };

  /* ---------------------------------------------------------- render */

  if (!detail || !rootNodeId || levelPath.length === 0) {
    const rootType = detail?.nodes.find((node) => node.id === detail.tree.rootNodeId)?.type;
    const title = rootType === "post" ? "Note" : detail?.tree.title || "Loading research…";
    return (
      <ThreadPlaceholder title={title} history={historyNav}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {detailQuery.isError ? (
            <>
              <h1 className="text-fg-heading m-0 text-base font-semibold">Research unavailable</h1>
              <p className="text-fg-muted m-0 text-sm" role="alert">
                {errorText(detailQuery.error)}
              </p>
              <button
                type="button"
                className="border-border-control bg-control text-fg-control hover:bg-control-hover min-h-control-md rounded-md border px-3"
                onClick={() => void detailQuery.refetch()}
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="session-spin text-fg-muted" size={24} aria-hidden="true" />
              <h1 className="text-fg-muted m-0 text-base font-normal">Loading research…</h1>
            </>
          )}
        </div>
      </ThreadPlaceholder>
    );
  }

  const rootNode = nodeById.get(rootNodeId) ?? null;
  const lastLevel = strip.pending?.levelIndex ?? levelPath.length - 1;
  const currentLevel = focusedLevel(focusedColumnId, lastLevel);

  const isUnread = (branch: ResearchNode) =>
    nodeStatus(branch) === "complete" &&
    firstSeenCompleteRef.current.get(branch.id) === false &&
    !openedNodeIds.has(branch.id);
  const registerComposer = (key: string) => (handle: ComposerHandle | null) => {
    if (handle) composerRefs.current.set(key, handle);
    else composerRefs.current.delete(key);
  };
  const registerThread = (level: number) => (handle: PostThreadHandle | null) => {
    if (handle) threadHandlesRef.current.set(level, handle);
    else threadHandlesRef.current.delete(level);
  };
  const branchSource = (
    anchor: ResearchHighlightAnchor | null,
    parentId: string,
    branch: ResearchNode | null,
  ): BranchSourceProps => ({
    anchor,
    parent: nodeById.get(parentId),
    created: branch !== null,
    resolves: branch ? resolvedBranchIds.has(branch.id) : Boolean(anchor),
    parentLoaded: Boolean(revisionByNode[parentId]) && levelPath.includes(parentId),
  });
  const chainQueue = (headId: string, chainIds: readonly string[]): QueueProps => {
    const tail = nodeById.get(chainIds[chainIds.length - 1] ?? "") ?? null;
    return {
      items: detail.queues?.[headId] ?? NO_QUEUE,
      selectedId: shownQueued?.headId === headId ? shownQueued.itemId : null,
      tailStalled: researchQueueStep(tail) === "stalled",
      busy: queuedAction.isPending,
      onSelect: (item) => {
        if (!tail) return;
        const path = selectionWith(tail.id);
        navigate(path);
        setQueuedView({ headId, itemId: item.id });
        requestFocus({ kind: "row", level: Math.max(0, path.indexOf(tail.id)) }, "reveal");
      },
      canCancel: (item) => mayCancelQueued(permissions, item),
      canRetry: (item) => mayRetryQueued(permissions, item),
      onCancel: (item) => cancelQueued(headId, item),
      onRetry: (item, row) => {
        queuedMutate(
          { action: "retry", treeId, headNodeId: headId, itemId: item.id },
          { onError: (error) => fail("The follow-up could not be sent", error) },
        );
        requestAnimationFrame(() =>
          row?.querySelector<HTMLElement>("[data-research-queue-cancel]")?.focus(),
        );
      },
    };
  };
  const rowsShared: ChainRowsShared = {
    archived,
    reorderable: permissions.canReorder,
    treeTitle,
    nodeById,
    branchesByParent,
    answerMenuOpenId:
      menu?.kind === "answer" &&
      menu.anchor.kind === "element" &&
      menu.anchor.element.hasAttribute("data-research-row-menu")
        ? menu.nodeId
        : null,
    isUnread,
    branchStateOf: (nodeId) => branchStates.ofMessage.get(nodeId) ?? null,
    expandedTiles,
    rowActions,
  };
  const headMenu = (headId: string, label: string) => ({
    label,
    open:
      menu?.kind === "answer" &&
      menu.nodeId === headId &&
      menu.anchor.kind === "element" &&
      menu.anchor.element.hasAttribute("data-research-head-menu"),
    onOpen: (trigger: HTMLButtonElement) => openAnswerMenu(trigger, headId),
  });
  // The root header shows who else has the thread open.
  const presence = <PresenceAvatars viewers={viewers} meId={meId} />;
  const modelControl = (key: string, node: ResearchNode | undefined) => {
    const choice = choiceFor(key, node);
    return choice
      ? {
          choice,
          models,
          onChange: (next: ModelChoice) =>
            setComposerModels((current) => ({ ...current, [key]: next })),
        }
      : null;
  };
  const imagesUpdate =
    (key: string) => (update: (current: ResearchImageAttachment[]) => ResearchImageAttachment[]) =>
      setComposerImages((current) => {
        const next = update(current[key] ?? []);
        return next.length === 0 ? withoutKeys(current, [key]) : { ...current, [key]: next };
      });

  /** The ask box of the chain headed by `headId` (none for a note's chain). */
  const chainComposer = (headId: string, level: number) => {
    const chain = inlineChainFor(nodes, headId)
      .map((id) => nodeById.get(id))
      .filter((node): node is ResearchNode => Boolean(node));
    const head = chain[0];
    const tail = chain[chain.length - 1];
    // A viewer or a guest has no ask boxes.
    if (!head || !tail || nodeType(head) === "post" || !me || !permissions.contributor) return null;
    const editing = Boolean(editingByHead[headId]);
    const queued = (detail.queues?.[headId] ?? NO_QUEUE).length > 0;
    const step = researchQueueStep(tail);
    const tailActive = runActive(tail);
    const canSend =
      permissions.canContribute &&
      (editing || step === "wait" || queued || (step === "send" && canFollowUpFrom(tail)));
    const stalled = step === "stalled" && !editing && !queued;
    const note = editing
      ? null
      : archived
        ? "Archived questions are read-only. Move the question out of Archive to continue."
        : stalled
          ? nodeStatus(tail) === "failed"
            ? "The last answer stopped with an error. Retry it or edit its question to continue."
            : "The last answer was stopped. Run it again to continue."
          : null;
    const waiting = tailActive || queued;
    const placeholder = editing
      ? "Edit the question"
      : documentSource(head) !== null && chain.length === 1
        ? documentSource(head) === "transcript"
          ? "Ask about this conversation"
          : "Ask about this document"
        : waiting
          ? "Queue a follow-up"
          : "Ask a follow-up";
    return (
      <ConversationComposer
        ref={registerComposer(headId)}
        value={composerText[headId] ?? ""}
        placeholder={placeholder}
        ariaLabel={
          editing
            ? "Edit the failed question"
            : level === 0
              ? "Follow-up in this conversation"
              : "Follow-up in this branch"
        }
        mode={
          editing
            ? {
                label: (
                  <>
                    <b>Editing</b> the failed question. Sending replaces the failed attempt.
                  </>
                ),
                cancelLabel: "Cancel editing",
                onCancel: () => {
                  setEditingByHead((current) => withoutKeys(current, [headId]));
                  setComposerValue(headId, "");
                  requestFocus({ kind: "composer", key: headId }, "none");
                },
              }
            : null
        }
        disabled={archived || stalled}
        canSubmit={canSend}
        submitting={submittingKey === headId}
        note={note}
        images={composerImages[headId]}
        onImagesChange={imagesUpdate(headId)}
        model={modelControl(headId, tail)}
        sendLabel={waiting && !editing ? "Queue" : "Send"}
        onChange={(value) => setComposerValue(headId, value)}
        onSubmit={() => void submitComposer(headId)}
        onSubmitBranch={() => void submitComposer(headId, { branch: true })}
      />
    );
  };
  const groupComposer = (group: ResearchStackGroup, level: number) => {
    if (group.kind === "branch") return chainComposer(group.headId, level);
    const key = `pending:${group.parentNodeId}`;
    return (
      <ConversationComposer
        ref={registerComposer(key)}
        value={composerText[key] ?? ""}
        placeholder={group.anchor ? "Ask about this passage" : "Ask about this answer"}
        ariaLabel="New branch question"
        mode={{ label: <b>New branch</b>, cancelLabel: "Cancel branch", onCancel: cancelPending }}
        disabled={archived}
        canSubmit={!archived}
        submitting={submittingKey === key}
        images={composerImages[key]}
        onImagesChange={imagesUpdate(key)}
        model={modelControl(key, nodeById.get(group.parentNodeId))}
        onChange={(value) => setComposerValue(key, value)}
        onSubmit={() => void submitPendingBranch()}
      />
    );
  };

  const renderColumn = (column: ResearchColumn) => {
    switch (column.role) {
      case "post": {
        const level = column.level.index;
        const post = nodeById.get(column.level.headId);
        if (!post) return null;
        return (
          <NoteColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === level}
            detail={detail}
            post={post}
            title={level === 0 ? treeTitle : researchNodeLabel(post, "Note")}
            history={level === 0 ? historyNav : null}
            archived={archived}
            menu={{
              open:
                menu?.kind === "post" && menu.nodeId === post.id && menu.anchor.kind === "element",
              onOpen: (trigger) =>
                setMenu({
                  kind: "post",
                  nodeId: post.id,
                  anchor: { kind: "element", element: trigger },
                }),
              onContextMenu: (point) =>
                setMenu({ kind: "post", nodeId: post.id, anchor: { kind: "point", ...point } }),
            }}
            scrollRef={undefined}
            onSelectNode={(nodeId) => navigate(nodeId)}
            onEdit={
              researchNoteEditable(post, archived) && mayEditText(permissions, nodes, post)
                ? () => editNoteOnDoubleClick(post.id, null)
                : undefined
            }
            headerExtra={level === 0 ? presence : null}
          />
        );
      }
      case "thread": {
        const level = column.level.index;
        const post = nodeById.get(column.level.headId);
        if (!post) return null;
        return (
          <FollowUpsColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === level}
            nodes={nodes}
            post={post}
            archived={archived}
            postActions={postActions}
            models={models}
            defaultChoice={defaultChoiceFor(undefined)}
            openNodeId={levels[level + 1]?.headId ?? null}
            composerRef={registerComposer(post.id)}
            threadRef={registerThread(level)}
            onOpenFollowUp={(nodeId) => {
              openBranch(level, nodeId);
              requestFocus({ kind: "row", level }, "settle");
            }}
            onOpenContextMenu={(node, point) =>
              setMenu({
                kind: nodeType(node) === "post" ? "post" : "answer",
                nodeId: node.id,
                anchor: { kind: "point", ...point },
              })
            }
            onEditNote={editNoteOnDoubleClick}
          />
        );
      }
      case "messages": {
        const { index: level, headId } = column.level;
        const head = nodeById.get(headId);
        return (
          <MessagesColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === level}
            title={level === 0 ? treeTitle : researchNodeLabel(head, "Branch")}
            history={level === 0 ? historyNav : null}
            imported={
              level === 0 &&
              rootNode?.type === "document" &&
              documentSource(rootNode) === "transcript"
            }
            shared={rowsShared}
            openSourceId={levels[level + 1]?.sourceId ?? null}
            menu={head ? headMenu(headId, level === 0 ? "Thread actions" : "Branch actions") : null}
            source={
              level > 0 && head?.parentNodeId
                ? branchSource(passageAnchor(head), head.parentNodeId, head)
                : null
            }
            composer={chainComposer(headId, level)}
            queue={chainQueue(headId, column.level.chainIds)}
            onScroll={onColumnScroll(column)}
            headerExtra={level === 0 ? presence : null}
          />
        );
      }
      case "branches": {
        const level = column.levelIndex;
        return (
          <BranchesColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === level}
            shared={rowsShared}
            openSourceId={levels[level + 1]?.sourceId ?? null}
            sourceOf={(group) => ({
              ...(group.kind === "branch"
                ? branchSource(group.anchor, group.sourceId, nodeById.get(group.headId) ?? null)
                : branchSource(group.anchor, group.parentNodeId, null)),
              from: researchNodeLabel(
                nodeById.get(group.kind === "branch" ? group.sourceId : group.parentNodeId),
                treeTitle,
              ),
            })}
            composerOf={(group) => groupComposer(group, level)}
            queueOf={chainQueue}
            onClear={() => {
              closeAfter(level - 1);
              requestFocus({ kind: "branches", level }, "settle");
            }}
            onScroll={onColumnScroll(column)}
          />
        );
      }
      case "answer": {
        const queuedHead =
          shownQueued && column.level.headId === shownQueued.headId ? shownQueued.headId : null;
        const queuedItem = queuedHead
          ? (detail.queues?.[queuedHead] ?? NO_QUEUE).find(
              (item) => item.id === shownQueued?.itemId,
            )
          : undefined;
        if (queuedHead && queuedItem) {
          return (
            <QueuedAnswerColumn
              key={`${column.id}:queued:${queuedItem.id}`}
              column={column}
              prompt={queuedItem.message.text}
              failedReason={queuedItem.failedReason}
              current={currentLevel === column.level.index}
              onCancel={() => cancelQueued(queuedHead, queuedItem)}
            />
          );
        }
        const node = nodeById.get(column.nodeId);
        if (!node) return null;
        const documentEditing =
          editor?.kind === "document" && editor.nodeId === node.id ? editor : null;
        return (
          <AnswerColumn
            key={columnKey(column)}
            column={column}
            node={node}
            label={researchNodeLabel(node, treeTitle)}
            current={currentLevel === column.level.index}
            archived={archived}
            markers={markersByNode[node.id] ?? NO_MARKERS}
            openBranchHeadId={levels[column.level.index + 1]?.headId ?? null}
            preview={
              documentEditing && documentEditing.text !== documentEditing.initialText
                ? {
                    original: documentEditing.initialText,
                    next: editorText,
                    imported: documentEditing.imported,
                  }
                : null
            }
            editing={documentEditing !== null}
            expanded={Boolean(expandedNodes[node.id])}
            fullTrace={Boolean(fullTraceNodes[node.id])}
            cancelling={cancelling}
            recapPending={recapPendingNodeIds.has(node.id)}
            pointerOverAnnotation={pointerAnnotationNodeId === node.id}
            retrying={retryingNodeId === node.id}
            handlers={answerHandlers}
            markerActions={markerActions}
            onPublish={publishAnswer}
            onOpenContextMenu={openContextMenu}
            onScroll={onColumnScroll(column)}
          />
        );
      }
      case "editor": {
        if (!editor || editor.nodeId !== column.nodeId) return null;
        const editedNode = nodeById.get(editor.nodeId);
        return (
          <EditorColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === column.levelIndex}
            session={editor}
            stats={editorStats}
            saving={editorSaving}
            asking={editorAsking}
            error={editorError}
            models={models}
            defaultChoice={defaultChoiceFor(
              editedNode?.type === "exchange" ? editedNode : undefined,
            )}
            textareaRef={setEditorField}
            history={editor.kind === "post" && column.levelIndex === 0 ? historyNav : null}
            onChange={(patch) =>
              setEditor((current) =>
                current && current.nodeId === editor.nodeId ? { ...current, ...patch } : current,
              )
            }
            onCancel={closeEditor}
            onSave={() => void saveEditor()}
            onSaveInPlace={() => void saveEditor({ keepOpen: true })}
            onAskAsQuestion={(choice) => void askEditorAsQuestion(choice)}
          />
        );
      }
      default:
        return null;
    }
  };

  // ⌘F searches every open column, left to right.
  const searchBar = (
    <DomSearchBar active placeholder="Find in research" rootRef={workspaceRef} resetKey={treeId} />
  );

  const menuNode = menu ? nodeById.get(menu.nodeId) : undefined;
  const rerunTarget = rerunNodeId && !archived ? (nodeById.get(rerunNodeId) ?? null) : null;

  const followed = detail.tree.followed === true;
  return (
    <ThreadCollaborationContext.Provider value={collaboration}>
      <WidgetChangeContext.Provider value={widgetChange}>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div ref={workspaceRef} className="research-thread-page contents" onKeyDown={onKeyDown}>
          {strip.columns.map(renderColumn)}
          <div
            className="text-fg-faint flex min-w-60 flex-1 items-center justify-center px-8 text-center text-sm"
            aria-hidden={!strip.endsWithAnswer || undefined}
          >
            {strip.endsWithAnswer ? (
              <p className="max-w-64">
                Select a passage or a branch marker beside the answer to open it as the next pair.
              </p>
            ) : null}
          </div>
        </div>
        {layout?.overlay ? createPortal(searchBar, layout.overlay) : searchBar}
        <div className="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
        {menu && menuNode ? (
          <ThreadMenu
            menu={menu}
            nodes={nodes}
            nodeById={nodeById}
            rootNodeId={rootNodeId}
            treeTitle={treeTitle}
            archived={archived || !me}
            hiddenHighlights={hiddenHighlightsByNode[menu.nodeId] ?? 0}
            fullTrace={Boolean(fullTraceNodes[menu.nodeId])}
            openBranchIds={openBranchIds}
            relaunchPending={retryingNodeId !== null}
            followed={followed}
            actions={{
              onClose: closeMenu,
              ...(me
                ? {
                    onShare: () => setSharing(true),
                    onToggleFollow: () =>
                      setFollowed.mutate(
                        { treeId, value: !followed },
                        {
                          onSuccess: (tree) =>
                            toast(
                              tree.followed
                                ? "You’ll get a notification for new questions and notes here."
                                : "Notifications for this thread are off.",
                            ),
                          onError: (error) => fail("Notifications could not be changed", error),
                        },
                      ),
                  }
                : {}),
              onOpenBranch: (parentNodeId, branchId) => {
                const level = levelPathRef.current.indexOf(parentNodeId);
                if (level >= 0) goBranch(level, branchId);
              },
              onBranch: (parentNodeId, anchor) => openPendingBranch(parentNodeId, anchor),
              onRemoveHighlight: (nodeId, highlightId) =>
                void highlightActions
                  .remove(nodeId, [highlightId])
                  .catch((error: unknown) => fail("The highlight could not be removed", error)),
              onEdit: startEditing,
              onToggleFullTrace: toggleFullTrace,
              onCopyAnswer: copyAnswer,
              onCopyNote: copyNote,
              onCopyThread: (chainIds) => void copyThread(chainIds),
              onRerun: (nodeId) => {
                const target = nodeById.get(nodeId);
                if (target && researchRerunConfirms(target)) setRerunNodeId(nodeId);
                else handleRetry(nodeId);
              },
              onGenerateRecap: setRecapNodeId,
              onRename: (nodeId, value) => setRenameTarget({ nodeId, value }),
              onDelete: setDeletingNodeId,
            }}
          />
        ) : null}
        {markerTip ? (
          <MarkerTip
            anchor={markerTip.element}
            items={markerTip.branchIds.flatMap((branchId) => {
              const branch = nodeById.get(branchId);
              if (!branch) return [];
              const anchor = passageAnchor(branch);
              return [
                {
                  id: branchId,
                  question: nodePrompt(branch),
                  source: anchor ? `“${researchQuoteText(anchor.exact)}”` : "Whole answer",
                  messages: inlineChainFor(nodes, branchId).length,
                  state:
                    levels[markerTip.level + 1]?.headId === branchId
                      ? ("open" as const)
                      : branchStates.ofBranch(branchId),
                },
              ];
            })}
            opensNext={markerTip.branchIds.includes(levels[markerTip.level + 1]?.headId ?? "")}
            onDismiss={dismissMarkerTip}
          />
        ) : null}
        {textSelection.action ? (
          <SelectionToolbar
            action={textSelection.action}
            saving={textSelection.saving}
            canAnnotate={permissions.canContribute}
            canChangeHighlights={mayChangeHighlights(
              permissions,
              nodeById.get(textSelection.action.nodeId)?.highlights ?? [],
              textSelection.action.highlightIds,
            )}
            branchBlocker={textSelection.branchBlocker}
            onBranch={textSelection.branchFromSelection}
            onHighlight={() => void textSelection.applyHighlight()}
            onCopy={() => void textSelection.copySelection()}
            onDismiss={textSelection.clearAction}
          />
        ) : null}
        {rerunTarget ? (
          <RerunDialog
            node={rerunTarget}
            parent={
              rerunTarget.parentNodeId ? (nodeById.get(rerunTarget.parentNodeId) ?? null) : null
            }
            pending={retryingNodeId !== null}
            onConfirm={() => {
              setRerunNodeId(null);
              handleRetry(rerunTarget.id);
            }}
            onClose={() => setRerunNodeId(null)}
          />
        ) : null}
        {renameTarget ? (
          <RenameDialog
            key={renameTarget.nodeId}
            initialValue={renameTarget.value}
            isRoot={renameTarget.nodeId === rootNodeId}
            onRename={(title) => renameNode(renameTarget.nodeId, title)}
            onClose={() => setRenameTarget(null)}
          />
        ) : null}
        {recapNodeId ? (
          <ThreadRecapDialog
            nodeId={recapNodeId}
            onClose={() => setRecapNodeId(null)}
            onApplied={() => toast("Recap updated")}
          />
        ) : null}
        {deletingNodeId ? (
          <DeleteDialog
            key={deletingNodeId}
            nodes={nodes}
            nodeId={deletingNodeId}
            rootNodeId={rootNodeId}
            treeTitle={treeTitle}
            onTrashRoot={trashRoot}
            onRemove={removeNode}
            onClose={() => setDeletingNodeId(null)}
          />
        ) : null}
        {sharing ? (
          <ShareDialog
            tree={detail.tree}
            meId={meId}
            onClose={() => setSharing(false)}
            onLeft={leaveTree}
          />
        ) : null}
        {staleEdit ? (
          <StaleEditDialog
            subject={staleEdit.subject}
            keptText={
              staleEdit.subject === "note" || staleEdit.subject === "document"
                ? (editor?.text ?? null)
                : null
            }
            pending={staleReloading}
            onReload={() => void reloadLatest()}
            onClose={() => setStaleEdit(null)}
          />
        ) : null}
      </WidgetChangeContext.Provider>
    </ThreadCollaborationContext.Provider>
  );
}

/** The recap dialog for an answer, once its content has loaded. */
function ThreadRecapDialog({
  nodeId,
  onClose,
  onApplied,
}: {
  nodeId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const content = useNodeContent(nodeId).content;
  if (!content) return null;
  return <RecapDialog open content={content} onClose={onClose} onApplied={onApplied} />;
}

/** The level whose column holds focus reads as current; until something is
 * focused, the deepest level does. */
function focusedLevel(id: ResearchColumnId | null, lastLevel: number): number {
  const level = columnLevelIndex(id);
  return level !== null && level <= lastLevel ? level : lastLevel;
}
