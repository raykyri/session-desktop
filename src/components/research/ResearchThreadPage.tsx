import { researchBranchBlocker } from "../../lib/researchThreadView";
import { WidgetChangeContext, widgetChangePrompt } from "../../lib/sessionWidgetActions";
import {
  useResearchComposerDrafts,
  useResearchThreadNavigation,
} from "../../hooks/useResearchThreadNavigation";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { IS_MAC } from "../../lib/appHelpers";
import {
  getResearchNodeContent,
  removeResearchHighlights,
  renameResearchNode,
  setResearchChainOrder,
  setResearchNodeStarred,
} from "../../lib/api";
import { useResearchCardDrag } from "../../hooks/useResearchCardDrag";
import { useResearchAnnotations, type ResearchBranchMarker } from "../../hooks/useResearchAnnotations";
import { useResearchContentLoader } from "../../hooks/useResearchContentLoader";
import { useResearchFocusRequests } from "../../hooks/useResearchFocusRequests";
import { useResearchPairsKeyboard } from "../../hooks/useResearchPairsKeyboard";
import { useResearchChainQueue } from "../../hooks/useResearchChainQueue";
import { useResearchColumnScroll, type ResearchThreadPersistence } from "../../hooks/useResearchColumnScroll";
import { useResearchRunControls } from "../../hooks/useResearchRunControls";
import { useResearchTextSelection } from "../../hooks/useResearchTextSelection";
import { useStableValue } from "../../hooks/useStableValue";
import { reorderedIds, stepReorderTarget } from "../../lib/researchFolders";
import { writeClipboardText } from "../../lib/clipboard";
import type { ResearchPostThreadHandle } from "./ResearchPostThread";
import type { PostActions } from "./ResearchPost";
import { useResearchSwipeNavigation } from "../../hooks/useResearchSwipeNavigation";
import { documentHoldsMarkdown, documentSource, nodeMessage, nodePrompt, nodeRecap, nodeStatus, nodeType, passageAnchor } from "../../lib/researchNodeTypes";
import {
  COLUMN_ROW_SELECTOR,
  columnIdOf,
  columnKey,
  columnLevelIndex,
  columnSelector,
  researchStrip,
  sameResearchLevels,
  sameResearchStrip,
  type ResearchColumn,
  type ResearchColumnId,
  type ResearchPendingColumn,
} from "../../lib/researchColumns";
import { listenToResearchNodeOpen } from "../../lib/researchShortcuts";
import {
  researchBranchesByParent,
  researchEditedQuestionFork,
  researchLevelPath,
  researchQueueStep,
  researchSurvivingAncestor,
} from "../../lib/researchBranchView";
import {
  canContinueChain,
  canFollowUpFrom,
  chainDisplayOrder,
  inlineChainFor,
} from "../../lib/researchChains";
import { buildSegmentView, type SegmentView } from "../../lib/researchSegmentView";
import {
  researchEditorCanSave,
  researchEditorStats,
  researchNodeLabel,
  researchQuoteText,
  researchSubtreeBusy,
  researchSubtreeIds,
  sameIds,
  withoutKeys,
} from "../../lib/researchThreadView";
import {
  pruneResearchNavigationNodes,
  type QueuedResearchFollowup,
} from "../../lib/researchNavigation";
import type {
  ResearchBranchRemoval,
  NodeAnchor,
  ResearchNodeType,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
  UpdateResearchDocumentResult,
  UpdateResearchPostResult,
} from "../../types";
import DomSearchBar from "../DomSearchBar";
import ResearchRecapDialog from "./ResearchRecapDialog";
import { TranscriptLinkActionsProvider, type LinkActions } from "../TranscriptMarkdown";
import { ResearchEditorSessionColumn, type EditorSession } from "./ResearchEditorSessionColumn";
import { ResearchThreadPlaceholder } from "./ResearchColumnChrome";
import { rangeForTextOffsets } from "./researchTextRanges";
import { ResearchDeleteBranchDialog, ResearchRenameDialog } from "./ResearchThreadDialogs";
import { ResearchSelectionToolbar } from "./ResearchSelectionToolbar";
import {
  ResearchChainComposer,
  ResearchMessagesColumn,
  ResearchNewBranchColumn,
  type ResearchBranchSourceProps,
  type ResearchMessageRowActions,
  type ResearchQueueProps,
} from "./ResearchMessagesColumn";
import { ResearchFollowUpsColumn, ResearchNoteColumn } from "./ResearchNoteColumns";
import {
  ResearchAnswerColumn,
  ResearchMarkerTip,
  type ResearchAnswerPaneHandlers,
  type ResearchMarkerActions,
} from "./ResearchAnswerColumn";
import { ResearchThreadMenu, type ResearchThreadTreeMenu, type ThreadMenuState } from "./ResearchThreadMenu";
import type { ResearchComposerHandle } from "./ResearchConversationComposer";
import {
  ResearchColumnsContext,
  revealResearchColumns,
  scrollIntoColumn,
  settleResearchStrip,
} from "./ResearchColumns";
import type { ResearchUnitMenuPlacement } from "./researchUnitMenu";

const EMPTY_RECAP_PENDING_NODE_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_MARKERS: ResearchBranchMarker[] = [];
const EMPTY_QUEUE: QueuedResearchFollowup[] = [];
/** How long a node created a moment ago is shown before it appears in the
 * tree detail. */
const PENDING_NODE_TTL_MS = 30_000;

interface ResearchThreadPageProps {
  detail: ResearchTreeDetail | null;
  /** Durable sidebar title shown in the header while tree detail is loading. */
  treeTitle?: string;
  /** The root's kind from the sidebar summary, known before the detail
   * loads. A note's loading header reads "Note", as its note column's does,
   * rather than the note's text. */
  treeType?: ResearchNodeType;
  /** Archived trees remain browsable, but cannot be branched. */
  archived: boolean;
  /** Why `detail` is null, when the tree fetch itself failed. */
  detailError?: string | null;
  /** Refetches the active tree's detail after a failed load. */
  onRetryDetail?: () => void;
  onFork: (
    parentNodeId: string,
    prompt: string,
    anchor?: NodeAnchor | null,
    inline?: boolean,
    replacesNodeId?: string | null,
  ) => Promise<ResearchNode>;
  /** Follow-ups in a note's follow-ups column (see ResearchPostThread). */
  postActions: PostActions;
  onRemoveBranch: (nodeId: string) => Promise<ResearchBranchRemoval>;
  onRemoveTree: (treeId: string) => Promise<void>;
  onRenameTree: (treeId: string, title: string) => Promise<void>;
  onUpdateDocument: (input: {
    nodeId: string;
    markdown: string;
    title: string | null;
    expectedResponseRevision: string;
    expectedTitle: string;
    expectedHighlightIds: string[];
  }) => Promise<UpdateResearchDocumentResult>;
  /** Replaces a post's text and marks it edited (update_research_post). */
  onUpdatePost: (input: {
    nodeId: string;
    text: string;
    expectedText: string;
  }) => Promise<UpdateResearchPostResult>;
  /** "Ask as a question" in the editor: starts a new thread with `prompt`
   * using the Home ask box's model, and opens it. */
  onAskAsQuestion: (prompt: string) => Promise<void>;
  /** The model a question is asked with ("Claude Opus"), or null when no
   * research agent is ready. Read when the editor renders. */
  readQuestionModel: () => string | null;
  onCancel: (nodeId: string) => Promise<void>;
  /** Relaunches a failed or cancelled run in place (same node id, same
   * inputs). The refreshed tree detail flows back through the caller's
   * reconciliation, so the turn re-renders as Queued. */
  onRetryNode: (nodeId: string) => Promise<void>;
  /** Reruns a settled question in place, replacing a complete answer (see
   * onRetryNode). */
  onRerunNode: (nodeId: string) => Promise<void>;
  linkActions: LinkActions;
  onError: (message: string) => void;
  onToast: (message: string, tone?: "normal" | "warning") => void;
  /** Show held-⌘ shortcut badges (the ⌘J composer hint). */
  shortcutHintsShown: boolean;
  /** The "Require ⌘↵ to send" setting, for every composer in the thread. */
  requireCmdEnterToSend: boolean;
  /** Runs whose background recap job is in flight; each renders a spinner in
   * its recap slot until the recap arrives. */
  recapPendingNodeIds?: ReadonlySet<string>;
  /** Back and forward through the research visit history, which the app
   * shell holds for every thread (see researchHistory.ts). */
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  /** Reports the deepest selected message for the visit history: "push" for
   * the reader's own navigation, "replace" for a selection the page made
   * itself (the message it restored on opening). */
  onNavigate?: (treeId: string, nodeId: string, mode: "push" | "replace") => void;
  /** Removes visits to this tree's messages that `keepNode` rejects (removed
   * messages). With `selection`, that message is on screen afterwards. */
  onPruneVisits?: (treeId: string, keepNode: (nodeId: string) => boolean, selection: string | null) => void;
  /** Called with the open nodes whenever they change: the message selected
   * in the root pair, then the head of each open branch. Empty on unmount. */
  onOpenNodesChange?: (nodeIds: string[]) => void;
  /** The whole question's Bookmark and Move to actions, which the
   * root level's answer menus list below their own actions. */
  treeMenu?: ResearchThreadTreeMenu;
}

export type { ResearchThreadTreeMenu };

/** A new branch being written: the pair after its parent's level shows the
 * passage and an ask box; the branch is created when its first question is
 * sent. `anchor` is null for a branch from the whole answer. */
interface PendingBranch {
  parentNodeId: string;
  anchor: ResearchHighlightAnchor | null;
}

function ResearchThreadPage({
  detail,
  treeTitle,
  treeType,
  archived,
  detailError,
  onRetryDetail,
  onFork,
  postActions,
  onRemoveBranch,
  onRemoveTree,
  onRenameTree,
  onUpdateDocument,
  onUpdatePost,
  onAskAsQuestion,
  readQuestionModel,
  onCancel,
  onRetryNode,
  onRerunNode,
  linkActions,
  onError,
  onToast,
  shortcutHintsShown,
  requireCmdEnterToSend,
  recapPendingNodeIds = EMPTY_RECAP_PENDING_NODE_IDS,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  onNavigate,
  onPruneVisits,
  onOpenNodesChange,
  treeMenu,
}: ResearchThreadPageProps) {
  const columnsLayout = useContext(ResearchColumnsContext);
  const treeId = detail?.tree.id ?? null;
  const rootNodeId = detail?.tree.rootNodeId ?? null;
  // The deepest open level's selected message. It determines every level
  // before it (see researchLevelPath). Back/forward walk these visits.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingBranch | null>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onPruneVisitsRef = useRef(onPruneVisits);
  onPruneVisitsRef.current = onPruneVisits;
  // Show newly created question nodes until the refreshed tree detail
  // includes them.
  const [createdNodes, setCreatedNodes] = useState<{ node: ResearchNode; at: number }[]>([]);
  // Record ids synchronously so the event that creates a node can select it.
  const createdNodeIdsRef = useRef(new Set<string>());
  // The column that holds keyboard focus ("feed" for the feed). Its level's
  // header title is at full strength; null until something is focused,
  // which makes the deepest level current.
  const [focusedColumnId, setFocusedColumnId] = useState<ResearchColumnId | null>(null);
  const [composerText, setComposerText] = useState<Record<string, string>>({});
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  // Per chain head: the failed node whose question the composer is editing.
  const [editingByHead, setEditingByHead] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<ThreadMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // The message whose delete confirmation is open, and the message (or the
  // root) being renamed, with the title the Rename dialog starts from.
  const [deletingBranchId, setDeletingBranchId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ nodeId: string; value: string } | null>(null);
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorAsking, setEditorAsking] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const editorFieldRef = useRef<HTMLTextAreaElement | null>(null);
  // The root note column's scroll offset from before its editor took its
  // place, applied once when the note column mounts again.
  const noteScrollRestoreRef = useRef<number | null>(null);
  const restoreNoteScroll = useCallback((element: HTMLDivElement | null) => {
    const top = noteScrollRestoreRef.current;
    if (element && top !== null) {
      noteScrollRestoreRef.current = null;
      element.scrollTop = top;
    }
  }, []);
  // Counting and matching scan the whole text (up to the 10 MB document
  // cap), so they follow the field at a lower priority than typing.
  const editorText = useDeferredValue(editor?.text ?? "");
  const editorStats = useMemo(
    () => (editor ? researchEditorStats(editor, editorText) : null),
    // Only the text and the session's fixed inputs count; the title does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor?.nodeId, editor?.kind, editor?.initialText, editorText],
  );
  const [recapDialogNodeId, setRecapDialogNodeId] = useState<string | null>(null);
  // Per-node reading state: which answers show their full item window
  // (persisted per tree) and which show the full transcript (per visit).
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [fullTraceNodes, setFullTraceNodes] = useState<Record<string, boolean>>({});
  // Branches whose answer finished while this thread was open and that
  // the reader has not opened carry an unread dot on their branch count.
  // `firstSeenComplete` records each branch's status the first time it is
  // seen, so a branch that was already complete when the tree loaded is read.
  const firstSeenCompleteRef = useRef<Map<string, boolean>>(new Map());
  const [openedNodeIds, setOpenedNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [markerTip, setMarkerTip] = useState<{ element: HTMLElement; branchIds: string[]; level: number } | null>(null);
  const dismissMarkerTip = useCallback(() => setMarkerTip(null), []);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const composerRefs = useRef(new Map<string, ResearchComposerHandle>());
  const treeIdRef = useRef(treeId);
  const detailRef = useRef(detail);
  const menuRef = useRef(menu);
  const pendingRef = useRef(pending);
  // Live mirrors for stable callbacks that must read current state.
  const composerTextRef = useRef(composerText);
  const submittingKeyRef = useRef(submittingKey);
  const editingByHeadRef = useRef(editingByHead);
  treeIdRef.current = treeId;
  detailRef.current = detail;
  menuRef.current = menu;
  pendingRef.current = pending;
  composerTextRef.current = composerText;
  submittingKeyRef.current = submittingKey;
  editingByHeadRef.current = editingByHead;

  // The column scroll offsets are recorded when the page unmounts (see
  // useResearchColumnScroll).
  const captureScrollRef = useRef<(persistence: ResearchThreadPersistence) => void>(() => {});
  const navigationPersistence = useResearchThreadNavigation((persistence) => captureScrollRef.current(persistence));

  // A messages column's new order, by chain head, until the head's update
  // event brings the stored one.
  const [pendingChainOrders, setPendingChainOrders] = useState<Record<string, string[]>>({});
  // The tree's nodes, with nodes created a moment ago that the detail has
  // not delivered yet, and pending chain orders.
  const nodes = useMemo(() => {
    const base = detail?.nodes ?? [];
    const extra = createdNodes
      .map((entry) => entry.node)
      .filter((node) => node.treeId === detail?.tree.id && !base.some((candidate) => candidate.id === node.id));
    const merged = extra.length > 0 ? [...base, ...extra] : base;
    if (Object.keys(pendingChainOrders).length === 0) {
      return merged;
    }
    return merged.map((node) =>
      pendingChainOrders[node.id] ? { ...node, chainOrder: pendingChainOrders[node.id] } : node,
    );
  }, [createdNodes, detail, pendingChainOrders]);
  // A pending order is dropped once the detail holds it.
  useEffect(() => {
    setPendingChainOrders((current) => {
      const settled = Object.keys(current).filter((headId) => {
        const head = detail?.nodes.find((node) => node.id === headId);
        return !head || sameIds(head.chainOrder ?? [], current[headId]);
      });
      return settled.length > 0 ? withoutKeys(current, settled) : current;
    });
  }, [detail]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // Every node's parent as last seen, kept after the node is removed, so a
  // removed selection can fall back to the message its branch came from.
  const parentByIdRef = useRef(new Map<string, string | null>());
  useEffect(() => {
    for (const node of nodes) {
      parentByIdRef.current.set(node.id, node.parentNodeId ?? null);
    }
  }, [nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  // The open columns: one level per open conversation (its messages and its
  // answer; a post root is its post and its thread), then the unsent
  // branch's column. The strip, its levels and the selected path keep their
  // identity while they show the same columns.
  const strip = useStableValue(
    useMemo(
      () => researchStrip(nodes, selectedNodeId, pending, editor?.nodeId ?? null),
      [editor?.nodeId, nodes, pending, selectedNodeId],
    ),
    sameResearchStrip,
  );
  const stripRef = useRef(strip);
  stripRef.current = strip;
  const levels = useStableValue(strip.levels, sameResearchLevels);
  // The selected message of each open level, root level first.
  const levelPath = useStableValue(
    useMemo(() => levels.map((level) => level.selectedId), [levels]),
    sameIds,
  );
  const levelPathRef = useRef(levelPath);
  levelPathRef.current = levelPath;
  const deepestSelection = useMemo(() => levelPath.slice(-1), [levelPath]);
  // A pending branch belongs after the level that shows its parent selected.
  const pendingColumn =
    strip.columns.find((column): column is ResearchPendingColumn => column.role === "pending") ?? null;
  const activePending = pendingColumn ? pending : null;

  // Answers on screen: each level's selected message, plus the message whose
  // … menu is open (its details need the answer).
  const menuNodeId = menu?.kind === "answer" ? menu.nodeId : null;
  const chainNodeIds = useStableValue(
    useMemo(
      () => (menuNodeId && !levelPath.includes(menuNodeId) ? [...levelPath, menuNodeId] : levelPath),
      [levelPath, menuNodeId],
    ),
    sameIds,
  );
  const chainKey = chainNodeIds.join("\n");
  const chainNodes = useMemo(
    () =>
      chainNodeIds
        .map((id) => nodeById.get(id))
        .filter((node): node is ResearchNode => Boolean(node)),
    [chainNodeIds, nodeById],
  );
  const {
    contentByNode,
    contentErrorByNode,
    contentByNodeRef,
    retryContentLoad,
    reloadContent,
    patchNodeHighlights,
    replaceContentNode,
  } = useResearchContentLoader({ detail, levels, chainNodeIds, chainNodes });
  const removeHighlights = useCallback(
    async (nodeId: string, highlightIds: string[]) => {
      const removed = await removeResearchHighlights(nodeId, highlightIds);
      const removedIds = new Set(removed.map(({ id }) => id));
      patchNodeHighlights(nodeId, (highlights) =>
        highlights.filter(({ id }) => !removedIds.has(id)),
      );
    },
    [patchNodeHighlights],
  );
  const branchesByParent = useMemo(() => researchBranchesByParent(nodes), [nodes]);
  const branchesByParentRef = useRef(branchesByParent);
  branchesByParentRef.current = branchesByParent;

  // Columns of the open pairs, found by level.
  const pairColumn = useCallback(
    (kind: "messages" | "answer", level: number) =>
      workspaceRef.current?.querySelector<HTMLElement>(
        columnSelector(kind === "messages" ? `T${level}` : `A${level}`),
      ) ?? null,
    [],
  );
  const selectedRow = useCallback(
    (level: number) =>
      pairColumn("messages", level)?.querySelector<HTMLElement>(COLUMN_ROW_SELECTOR) ?? null,
    [pairColumn],
  );

  // Recompute annotations when an answer's revision or transcript view
  // changes, since either can change its flat-text offsets.
  const revisionsKey = chainNodeIds
    .map((id) => contentByNode[id]?.responseRevision ?? "")
    .join("\n");
  const highlightsKey = chainNodeIds
    .map((id) =>
      (contentByNode[id]?.node.highlights ?? []).map((highlight) => highlight.id).join(","),
    )
    .join("\n");
  const expandedKey = chainNodeIds.map((id) => (expandedNodes[id] ? "1" : "0")).join("");
  const fullTraceKey = chainNodeIds.map((id) => (fullTraceNodes[id] ? "1" : "0")).join("");

  // Record whether each branch was complete when first displayed. This
  // determines whether a later completion gets an unread dot. Record after
  // commit so aborted renders do not mark branches as seen.
  useEffect(() => {
    const seen = firstSeenCompleteRef.current;
    for (const level of levels) {
      for (const id of level.chainIds) {
        for (const child of branchesByParent.get(id) ?? []) {
          if (!seen.has(child.id)) {
            seen.set(child.id, nodeStatus(child) === "complete");
          }
        }
      }
    }
  }, [branchesByParent, levels]);

  const persistSelection = useCallback(
    (nodeId: string | null) => {
      const currentTreeId = treeIdRef.current;
      if (!currentTreeId || !nodeId) {
        return;
      }
      const navigation = (navigationPersistence.store[currentTreeId] ??= { scrollByNode: {} });
      if (navigation.selectedNodeId !== nodeId) {
        navigation.selectedNodeId = nodeId;
        navigationPersistence.flush();
      }
    },
    [navigationPersistence],
  );

  // ---- focus requests and the strip ----------------------------------------

  const columnsLayoutRef = useRef(columnsLayout);
  columnsLayoutRef.current = columnsLayout;
  const composerField = useCallback(
    (key: string) => composerRefs.current.get(key)?.element()?.querySelector("textarea") ?? null,
    [],
  );
  const editorField = useCallback(
    () => (editorFieldRef.current?.isConnected ? editorFieldRef.current : null),
    [],
  );
  const requestFocus = useResearchFocusRequests({
    row: columnsLayout?.row ?? null,
    columnsLayoutRef,
    workspaceRef,
    pairColumn,
    selectedRow,
    composerField,
    editorField,
  });

  // ---- queued follow-ups ----------------------------------------------------

  const focusComposer = useCallback((headId: string) => composerRefs.current.get(headId)?.focus(), []);
  const { queues, queuesRef, restoreQueues, updateQueue, retryQueued, awaitChainChild, chainSendInFlight } =
    useResearchChainQueue({ treeId, navigationPersistence, detail, archived, nodeById, onFork, focusComposer });

  // ---- levels --------------------------------------------------------------

  // Per message: the deepest node that was open while it was on the path,
  // so reselecting it reopens its branches. Per chain head: the message last
  // selected in it, so reopening a branch shows that message.
  const levelMemoryRef = useRef(new Map<string, string>());
  const chainMemoryRef = useRef(new Map<string, string>());
  useEffect(() => {
    const deepest = levelPath[levelPath.length - 1];
    if (!deepest) {
      return;
    }
    for (const level of levels) {
      levelMemoryRef.current.set(level.selectedId, deepest);
      chainMemoryRef.current.set(level.headId, level.selectedId);
    }
  }, [levelPath, levels]);

  /** The deepest node remembered under `nodeId`, when it still descends
   * from it; otherwise the node itself. */
  const rememberedUnder = useCallback((nodeId: string) => {
    const remembered = levelMemoryRef.current.get(nodeId);
    if (!remembered || remembered === nodeId) {
      return nodeId;
    }
    return researchLevelPath(nodesRef.current, remembered).includes(nodeId) ? remembered : nodeId;
  }, []);

  const markOpened = useCallback((nodeId: string) => {
    setOpenedNodeIds((prev) => (prev.has(nodeId) ? prev : new Set(prev).add(nodeId)));
  }, []);

  /** Moves the deepest selection to `nodeId` without touching history.
   * False when the node is not in this tree. */
  const applyVisit = useCallback(
    (nodeId: string): boolean => {
      if (!nodesRef.current.some((node) => node.id === nodeId) && !createdNodeIdsRef.current.has(nodeId)) {
        return false;
      }
      setSelectedNodeId(nodeId);
      persistSelection(nodeId);
      // Leaving a new branch unsent discards it, as Esc does: its stored text
      // must not reopen it (and close these levels) on the next mount.
      const dropped = pendingRef.current;
      if (dropped) {
        setPending(null);
        const currentTreeId = treeIdRef.current;
        if (currentTreeId) {
          navigationPersistence.clearPendingBranch(currentTreeId, dropped.parentNodeId);
        }
        setComposerText((text) => withoutKeys(text, [`pending:${dropped.parentNodeId}`]));
      }
      setMenu(null);
      markOpened(nodeId);
      return true;
    },
    [markOpened, navigationPersistence, persistSelection],
  );

  /** User navigation: applies the visit and records it in the visit
   * history. */
  const navigate = useCallback(
    (nodeId: string) => {
      const currentTreeId = treeIdRef.current;
      if (applyVisit(nodeId) && currentTreeId) {
        onNavigateRef.current?.(currentTreeId, nodeId, "push");
      }
    },
    [applyVisit],
  );

  /** Selects a message in level `level`'s column. Its answer replaces the
   * one shown, and the levels after it close, unless it is already selected;
   * a message selected before reopens the branches that were open under it. */
  const selectMessage = useCallback(
    (level: number, nodeId: string) => {
      if (levelPathRef.current[level] === nodeId) {
        return;
      }
      navigate(rememberedUnder(nodeId));
    },
    [navigate, rememberedUnder],
  );

  /** Opens branch `headId` of level `level`'s selected answer as the next
   * level, showing the message last selected in it (its last message the
   * first time). Opening the branch already open there changes nothing. */
  const openBranch = useCallback(
    (level: number, headId: string, end?: "first" | "last") => {
      const nodesNow = nodesRef.current;
      const chain = inlineChainFor(nodesNow, headId);
      const open = levelPathRef.current[level + 1];
      if (!end && open && chain.includes(open)) {
        return;
      }
      // `end` is the top or bottom row as listed; without one, the message
      // last selected in the branch, else its newest.
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
      if (!message) {
        return;
      }
      markOpened(headId);
      navigate(end ? message : rememberedUnder(message));
    },
    [markOpened, navigate, rememberedUnder],
  );

  /** Closes the levels after `level`. */
  const closeAfter = useCallback(
    (level: number) => {
      const keep = levelPathRef.current[level];
      if (keep) {
        navigate(keep);
      }
    },
    [navigate],
  );

  // Tree switch (the thread page is keyed per tree, so this is its mount):
  // restore the open levels, queued follow-ups, and reading state.
  useEffect(() => {
    if (!treeId || !rootNodeId || !detail) {
      return;
    }
    const navigation = navigationPersistence.store[treeId];
    const nodeIds = new Set(detail.nodes.map((node) => node.id));
    const saved = navigation?.selectedNodeId;
    const main = inlineChainFor(detail.nodes, rootNodeId);
    const selected = saved && nodeIds.has(saved) ? saved : (main[main.length - 1] ?? rootNodeId);
    restoreQueues(navigation?.queuedFollowups ?? {});
    setSelectedNodeId(selected);
    // The restored message is this thread's visit on screen: it fills in a
    // visit recorded before the thread loaded, or corrects one whose message
    // is gone.
    onNavigateRef.current?.(treeId, selected, "replace");
    setExpandedNodes({ ...navigation?.expandedByNode });
    setFullTraceNodes({});
    // Restoring reopens the levels without animation: the strip shows the
    // deepest level (and, when the feed and the first pair don't fit, the
    // answer rather than the feed).
    // Keyboard focus already in the pairs (→ from the feed) stays in view.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const row = columnsLayoutRef.current?.row ?? null;
        const focused = row?.contains(document.activeElement) ? columnIdOf(document.activeElement) : null;
        settleResearchStrip(row, columnLevelIndex(focused) !== null ? focused : null, "auto");
      }),
    );
    // Runs once per tree: the thread page remounts on tree switches, and the
    // first detail to arrive carries the root and the nodes to restore.
  }, [treeId, rootNodeId, Boolean(detail)]);

  const mainComposerKey = rootNodeId ?? "main";
  const pendingComposerKey = activePending ? `pending:${activePending.parentNodeId}` : null;
  useResearchComposerDrafts({
    persistence: navigationPersistence,
    treeId,
    mainText: composerText[mainComposerKey] ?? "",
    pendingBranch: activePending?.anchor ? { nodeId: activePending.parentNodeId, anchor: activePending.anchor } : null,
    pendingBranchText: pendingComposerKey ? composerText[pendingComposerKey] ?? "" : "",
    pendingBranchOpen: activePending !== null,
    // Only the deepest selection's saved new branch reopens: one saved under
    // a shallower message would close the levels the path restored.
    chainNodeIds: deepestSelection,
    contentByNode,
    setMainText: (text) =>
      setComposerText((current) =>
        (current[mainComposerKey] ?? "") === text ? current : { ...current, [mainComposerKey]: text },
      ),
    restorePendingBranch: (nodeId, anchor, text) => {
      // A saved new branch reopens after its parent, without taking focus.
      setSelectedNodeId(nodeId);
      setPending({ parentNodeId: nodeId, anchor });
      if (text) {
        setComposerText((current) => ({ ...current, [`pending:${nodeId}`]: text }));
      }
    },
  });

  // Deleted nodes: prune persisted state, history, created nodes, and a
  // selection or pending branch that named a removed node.
  useEffect(() => {
    if (!treeId || !detail) {
      return;
    }
    const validNodeIds = new Set(detail.nodes.map((node) => node.id));
    // Keep created nodes for their full TTL, even after a refresh includes
    // them. An older refresh without the node may complete afterward.
    const now = Date.now();
    setCreatedNodes((current) => {
      const next = current.filter((entry) => now - entry.at < PENDING_NODE_TTL_MS);
      return next.length === current.length ? current : next;
    });
    for (const entry of createdNodes) {
      if (now - entry.at < PENDING_NODE_TTL_MS) {
        validNodeIds.add(entry.node.id);
      } else {
        createdNodeIdsRef.current.delete(entry.node.id);
      }
    }
    pruneResearchNavigationNodes(treeId, [...validNodeIds]);
    const current = pendingRef.current;
    if (current && !validNodeIds.has(current.parentNodeId)) {
      setPending(null);
    }
    if (selectedNodeId && !validNodeIds.has(selectedNodeId)) {
      // If a message on the open path was removed, select its nearest surviving
      // ancestor. Move focus there if the removed columns contained focus.
      const fallback =
        researchSurvivingAncestor(parentByIdRef.current, selectedNodeId, validNodeIds) ?? detail.tree.rootNodeId;
      setSelectedNodeId(fallback);
      persistSelection(fallback);
      onPruneVisitsRef.current?.(treeId, (nodeId) => validNodeIds.has(nodeId), fallback);
      const level = researchLevelPath(detail.nodes, fallback).length - 1;
      requestFocus({ kind: "row", level: Math.max(0, level) }, "settle", true);
    } else {
      onPruneVisitsRef.current?.(treeId, (nodeId) => validNodeIds.has(nodeId), null);
    }
  }, [createdNodes, detail, persistSelection, requestFocus, selectedNodeId, treeId]);

  /** Opens a new branch on `anchor` (a passage) or on the whole answer of
   * `parentNodeId`, as the pair after the parent's level. Its ask box takes
   * focus. */
  const openPendingBranch = useCallback(
    (parentNodeId: string, anchor: ResearchHighlightAnchor | null) => {
      if (archived) {
        return;
      }
      const previous = pendingRef.current;
      if (previous && previous.parentNodeId !== parentNodeId) {
        setComposerText((text) => withoutKeys(text, [`pending:${previous.parentNodeId}`]));
        const currentTreeId = treeIdRef.current;
        if (currentTreeId) {
          navigationPersistence.clearPendingBranch(currentTreeId, previous.parentNodeId);
        }
      }
      setMenu(null);
      if (levelPathRef.current[levelPathRef.current.length - 1] !== parentNodeId) {
        setSelectedNodeId(parentNodeId);
        persistSelection(parentNodeId);
      }
      setPending({ parentNodeId, anchor });
      requestFocus({ kind: "composer", key: `pending:${parentNodeId}` }, "settle");
    },
    [archived, navigationPersistence, persistSelection, requestFocus],
  );

  /** Discards the new branch being written; focus returns to the answer it
   * was asked from. */
  const cancelPending = useCallback(() => {
    const current = pendingRef.current;
    if (!current) {
      return;
    }
    setPending(null);
    const currentTreeId = treeIdRef.current;
    if (currentTreeId) {
      navigationPersistence.clearPendingBranch(currentTreeId, current.parentNodeId);
    }
    setComposerText((text) => withoutKeys(text, [`pending:${current.parentNodeId}`]));
    const level = levelPathRef.current.indexOf(current.parentNodeId);
    if (level >= 0) {
      requestFocus({ kind: "answer", level }, "settle");
    }
  }, [navigationPersistence, requestFocus]);

  // ---- history -------------------------------------------------------------

  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onForwardRef = useRef(onForward);
  onForwardRef.current = onForward;
  const goBack = useCallback(() => onBackRef.current?.(), []);
  const goForward = useCallback(() => onForwardRef.current?.(), []);

  // The current pair follows keyboard focus.
  useEffect(() => {
    const row = columnsLayout?.row;
    if (!row) return;
    const onFocusIn = (event: FocusEvent) => {
      const id = columnIdOf(event.target instanceof Element ? event.target : null);
      if (id === "feed" || columnLevelIndex(id) !== null) {
        setFocusedColumnId(id);
      }
    };
    row.addEventListener("focusin", onFocusIn);
    return () => row.removeEventListener("focusin", onFocusIn);
  }, [columnsLayout?.row]);

  // The follow-ups column of each note level, by level index.
  const threadHandlesRef = useRef(new Map<number, ResearchPostThreadHandle>());
  const registerThread = (level: number) => (handle: ResearchPostThreadHandle | null) => {
    if (handle) {
      threadHandlesRef.current.set(level, handle);
    } else {
      threadHandlesRef.current.delete(level);
    }
  };

  // The column (and with it the scroller that carries swipe navigation)
  // renders once there is a detail, a root and a selection. A thread page
  // mounted for a new tree first renders the placeholder, so the swipe
  // listeners attach when this turns true.
  const hasColumn = Boolean(detail && rootNodeId && selectedNodeId);
  useResearchSwipeNavigation(workspaceRef, goBack, goForward, hasColumn);

  // Dialogs return focus to the control that opened them (the … menu's
  // button). A deleted message takes its button along: focus then goes to the
  // row of the message it was asked from, else to the root's ask box.
  const deletedParentIdRef = useRef<string | null>(null);
  const deleteReturnFocus = useCallback(() => {
    const parentId = deletedParentIdRef.current;
    const previous = parentId
      ? document.querySelector<HTMLElement>(`[data-research-row][data-node-id="${CSS.escape(parentId)}"]`)
      : null;
    const composer = composerRefs.current.get(mainComposerKey)?.element()?.querySelector("textarea");
    // Deleting the research closes the thread: the feed's composer.
    return (
      previous ??
      (composer?.isConnected ? composer : document.querySelector<HTMLElement>(".new-research-input"))
    );
  }, [mainComposerKey]);

  const expandAllTurns = useCallback(
    (nodeId: string) => {
      setExpandedNodes((current) =>
        current[nodeId] ? current : { ...current, [nodeId]: true },
      );
      if (treeId) {
        const navigation = (navigationPersistence.store[treeId] ??= { scrollByNode: {} });
        (navigation.expandedByNode ??= {})[nodeId] = true;
        navigationPersistence.flush();
      }
    },
    [navigationPersistence, treeId],
  );

  const { restoredAnswerScrollRef, onColumnScroll, captureScroll } = useResearchColumnScroll({
    treeId,
    navigationPersistence,
    levels,
    levelPath,
    contentByNode,
    contentErrorByNode,
    pairColumn,
    selectedRow,
  });
  captureScrollRef.current = captureScroll;

  // Per-answer content-derived view state. Recomputed only for answers
  // whose content or view toggles changed: node metadata stays live while
  // the parsed timeline keeps its identity, which is what keeps the memoized
  // markdown renderer's cache effective.
  const segmentViewCacheRef = useRef(
    new Map<
      string,
      {
        content: ResearchNodeContent | null;
        showAllTurns: boolean;
        showFullTrace: boolean;
        view: SegmentView;
      }
    >(),
  );
  const segmentViews = useMemo(() => {
    const cache = segmentViewCacheRef.current;
    const views = new Map<string, SegmentView>();
    for (const node of chainNodes) {
      const content = contentByNode[node.id] ?? null;
      const showAllTurns = Boolean(expandedNodes[node.id]);
      const showFullTrace = Boolean(fullTraceNodes[node.id]);
      const cached = cache.get(node.id);
      if (
        cached &&
        cached.content === content &&
        cached.showAllTurns === showAllTurns &&
        cached.showFullTrace === showFullTrace
      ) {
        views.set(node.id, cached.view);
        continue;
      }
      const view = buildSegmentView(node, content, showAllTurns, showFullTrace);
      cache.set(node.id, { content, showAllTurns, showFullTrace, view });
      views.set(node.id, view);
    }
    for (const key of [...cache.keys()]) {
      if (!views.has(key)) {
        cache.delete(key);
      }
    }
    return views;
  }, [chainNodes, contentByNode, expandedNodes, fullTraceNodes]);

  // ---- annotations ----------------------------------------------------------

  const {
    registerSegmentElement,
    segmentRoot,
    highlightDomNonce,
    resolvedHighlightsRef,
    branchRangeOffsetsRef,
    selectedHighlightPaintRef,
    markersByNode,
    hiddenHighlightsByNode,
    openBranchIds,
    pointerAnnotationNodeId,
    annotationsAtPoint,
    trackAnnotationUnderPointer,
    clearAnnotationPointer,
    revealFocusHighlight,
  } = useResearchAnnotations({
    treeId,
    navigationPersistence,
    restoredAnswerScrollRef,
    chainNodeIds,
    chainKey,
    levelPath,
    levels,
    activePending,
    branchesByParent,
    nodeById,
    contentByNode,
    revisionsKey,
    highlightsKey,
    expandedKey,
    fullTraceKey,
  });

  // Node-open requests from the app shell (feed rows, child rows, the
  // Highlights view) while this tree's thread page is already mounted. Focus
  // stays where the request came from; the strip shows the opened level.
  useEffect(
    () =>
      listenToResearchNodeOpen((request) => {
        if (request.treeId !== treeIdRef.current) {
          return false;
        }
        if (!applyVisit(request.nodeId)) {
          return false;
        }
        // Back/forward replaying a recorded visit selects the node without
        // recording it again.
        if (request.record) {
          onNavigateRef.current?.(request.treeId, request.nodeId, "push");
        }
        // A highlight opened from the Highlights feed in this thread: the
        // reveal effect runs again for it (the page does not remount).
        if (navigationPersistence.store[request.treeId]?.focusHighlight) {
          revealFocusHighlight();
        }
        window.requestAnimationFrame(() => {
          const level = stripRef.current.levels.length - 1;
          const row = selectedRow(level);
          if (row) {
            scrollIntoColumn(row);
          }
          settleResearchStrip(columnsLayoutRef.current?.row ?? null, `T${level}`);
        });
        return true;
      }),
    [applyVisit, navigationPersistence, revealFocusHighlight, selectedRow],
  );

  /** Opens branch `headId` from level `level` and puts focus on its selected
   * message; the passage it came from is underlined in the answer. */
  const goBranch = useCallback(
    (level: number, headId: string, end?: "first" | "last") => {
      openBranch(level, headId, end);
      requestFocus({ kind: "row", level: level + 1 }, "settle");
      window.requestAnimationFrame(() => {
        const entry = branchRangeOffsetsRef.current.find((candidate) => candidate.id === headId);
        const root = entry ? segmentRoot(entry.segmentId) : null;
        const range = entry && root ? rangeForTextOffsets(root, entry.start, entry.end) : null;
        const scroller = root?.closest<HTMLElement>(".research-column-scroll");
        if (!range || !scroller) {
          return;
        }
        const rect = range.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
          scroller.scrollTop += rect.top - bounds.top - bounds.height / 3;
        }
      });
    },
    [openBranch, requestFocus, segmentRoot],
  );

  // The pair ⌘J focuses the ask box of (see useResearchPairsKeyboard): the
  // current level, set while rendering.
  const currentLevelRef = useRef<number>(0);

  // ---- selection, highlights, and passage clicks ----------------------------

  const {
    highlightAction,
    clearHighlightAction,
    savingHighlight,
    selectionBranchBlocker,
    captureHighlightSelection,
    beginHighlightSelectionDrag,
    finishHighlightSelectionDrag,
    applyHighlightAction,
    branchFromSelection,
    copySelection,
  } = useResearchTextSelection({
    viewKey: JSON.stringify([treeId, chainKey, revisionsKey, expandedKey, fullTraceKey]),
    detailRef,
    contentByNodeRef,
    resolvedHighlightsRef,
    selectedHighlightPaintRef,
    segmentRoot,
    highlightDomNonce,
    nodeById,
    archived,
    patchNodeHighlights,
    removeHighlights,
    openPendingBranch,
    onToast,
    onError,
  });

  // A plain click on a tinted passage opens its branch; with several
  // branches there, or a highlight, it opens a menu instead.
  const openAnnotationAtPoint = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const root = event.currentTarget;
      const selection = window.getSelection();
      if (!root || !selection || !selection.isCollapsed) {
        return;
      }
      // Links keep their own click behavior.
      if (event.target instanceof Element && event.target.closest("a")) {
        return;
      }
      const hit = annotationsAtPoint(root, event.clientX, event.clientY);
      if (!hit) {
        return;
      }
      const { nodeId, branchIds, highlight } = hit;
      if (branchIds.length === 0 && !highlight) {
        return;
      }
      if (branchIds.length === 1 && !highlight) {
        const level = levelPathRef.current.indexOf(nodeId);
        if (level >= 0) {
          goBranch(level, branchIds[0]);
        }
        return;
      }
      clearHighlightAction();
      setMenu({
        kind: "mark",
        nodeId,
        branchIds,
        highlightId: highlight?.highlight.id ?? null,
        anchor: {
          left: event.clientX - 20,
          right: event.clientX - 20,
          top: event.clientY - 10,
          bottom: event.clientY + 10,
        },
        align: "point",
      });
    },
    [annotationsAtPoint, clearHighlightAction, goBranch],
  );

  /** Whether a press or click lands on the passage whose menu is open: the
   * same branches and highlight at the same turn. Such a click closes the
   * menu rather than opening it again. */
  const pressOnMenuPassage = (
    event: MouseEvent,
    passage: { nodeId: string; branchIds: string[]; highlightId: string | null },
  ) => {
    const root =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(".research-response-content-root")
        : null;
    if (!root || root.dataset.nodeId !== passage.nodeId) {
      return false;
    }
    const hit = annotationsAtPoint(root, event.clientX, event.clientY);
    return Boolean(
      hit &&
        (hit.highlight?.highlight.id ?? null) === passage.highlightId &&
        hit.branchIds.length === passage.branchIds.length &&
        hit.branchIds.every((id) => passage.branchIds.includes(id)),
    );
  };

  // ---- run controls and composers -------------------------------------------

  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;
  const { cancelling, retryingNodeId, queuedRetries, handleCancelNode, handleRetryNode, removeQueuedRetry } =
    useResearchRunControls({ nodes, nodeById, onCancel, onRetryNode, onRerunNode, onToast, onError });
  /** A click on a message row: selects it and brings its pair into view. */
  const selectRow = useCallback(
    (nodeId: string, level: number) => {
      selectMessage(level, nodeId);
      requestFocus({ kind: "row", level }, "reveal");
    },
    [requestFocus, selectMessage],
  );
  const showFullTraceFor = useCallback(
    (nodeId: string) =>
      setFullTraceNodes((current) =>
        current[nodeId] ? current : { ...current, [nodeId]: true },
      ),
    [],
  );
  const toggleFullTrace = useCallback(
    (nodeId: string) => setFullTraceNodes((current) => ({ ...current, [nodeId]: !current[nodeId] })),
    [],
  );
  const toggleStarred = useCallback((nodeId: string) => {
    const node = detailRef.current?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return;
    }
    const starred = !node.starredAt;
    setResearchNodeStarred(nodeId, starred)
      .then(() =>
        onToastRef.current(
          starred
            ? node.inline
              ? "Starred. It's listed under its question in the feed."
              : "Starred. The branch is listed under its question in the feed."
            : node.inline
              ? "Unstarred."
              : "Branch unstarred.",
        ),
      )
      .catch((err) => onErrorRef.current(err instanceof Error ? err.message : String(err)));
  }, []);

  const copyAnswer = useCallback(async (view: SegmentView) => {
    const text = view.conversationCopyText ?? view.rawAnswer;
    if (!text) {
      return;
    }
    try {
      await writeClipboardText(text);
      onToastRef.current(
        view.conversationCopyText ? "Conversation copied." : "Answer copied.",
      );
    } catch {
      onToastRef.current("Couldn't copy.", "warning");
    }
  }, []);
  const handleCopyAnswer = useCallback(
    (view: SegmentView) => void copyAnswer(view),
    [copyAnswer],
  );

  const openAnswerMenu = useCallback((trigger: HTMLButtonElement, nodeId: string) => {
    if (menuRef.current?.kind === "answer" && menuRef.current.nodeId === nodeId) {
      setMenu(null);
      return;
    }
    // Opens below the button in the row's top-right corner, aligned to its
    // right edge, as a feed row's menu does.
    setMenu({ kind: "answer", nodeId, anchor: trigger, align: "end", trigger });
  }, []);
  // A context menu (see researchUnitMenuProps) is the … menu at another
  // placement, with no trigger: focus returns to what had it.
  const openContextMenu = useCallback((nodeId: string, placement: ResearchUnitMenuPlacement) => {
    setMenu({ kind: "answer", nodeId, ...placement });
  }, []);

  const handleEditQuestion = useCallback((nodeId: string) => {
    const currentDetail = detailRef.current;
    const node = currentDetail?.nodes.find((candidate) => candidate.id === nodeId);
    if (!currentDetail || !node) {
      return;
    }
    const headId = inlineChainFor(currentDetail.nodes, nodeId)[0] ?? nodeId;
    setEditingByHead((current) => ({ ...current, [headId]: nodeId }));
    setComposerText((current) => ({ ...current, [headId]: nodePrompt(node) }));
    requestFocus({ kind: "composer", key: headId }, "reveal");
  }, [requestFocus]);

  // ---- reordering a messages column ----------------------------------------

  // Read by screen readers after a keyboard move.
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((message: string) => {
    setAnnouncement((current) => (current === message ? `${message}\u00a0` : message));
  }, []);

  /** Moves `nodeId` before `beforeId` (the end for null) in the column whose
   * chain starts at `headId`, and stores the new order. Display only: the
   * next follow-up still continues the chain's last message. Returns the
   * new order, or null when nothing changed. */
  const reorderChain = useCallback(
    (headId: string, nodeId: string, beforeId: string | null): string[] | null => {
      const level = stripRef.current.levels.find((candidate) => candidate.headId === headId);
      if (!level || archived || !level.displayIds.includes(nodeId)) {
        return null;
      }
      const next = reorderedIds([...level.displayIds], nodeId, beforeId);
      if (sameIds(next, level.displayIds)) {
        return null;
      }
      setPendingChainOrders((current) => ({ ...current, [headId]: next }));
      setResearchChainOrder(headId, next).catch((err: unknown) => {
        setPendingChainOrders((current) => (current[headId] === next ? withoutKeys(current, [headId]) : current));
        onErrorRef.current(err instanceof Error ? err.message : String(err));
      });
      return next;
    },
    [archived],
  );
  const startMessageDrag = useResearchCardDrag({
    onMoveMessage: (nodeId, place, beforeId) => {
      if (place.startsWith("chain:")) {
        reorderChain(place.slice("chain:".length), nodeId, beforeId);
      }
    },
  });

  /** ⌥↑/⌥↓ on a message row: moves it one row up or down its column; the
   * row keeps focus and the new position is announced. */
  const moveFocusedMessage = useCallback(
    (row: HTMLElement, level: number, step: -1 | 1) => {
      const levelNow = stripRef.current.levels[level];
      const nodeId = row.dataset.nodeId;
      if (!levelNow || !nodeId || archived) {
        return;
      }
      const ids = levelNow.displayIds;
      const target = stepReorderTarget(ids, nodeId, step);
      if (!target) {
        announce(ids.length > 1 ? (step < 0 ? "Already first." : "Already last.") : "Only message.");
        return;
      }
      if (!reorderChain(levelNow.headId, nodeId, target.beforeId)) {
        return;
      }
      announce(`Moved to position ${ids.indexOf(nodeId) + step + 1} of ${ids.length}.`);
      // The row's element moves with the new order; focus follows it.
      const started = performance.now();
      const refocus = () => {
        const current = pairColumn("messages", level)?.querySelector<HTMLElement>(
          `[data-research-row][data-node-id="${CSS.escape(nodeId)}"]`,
        );
        if (current && document.activeElement !== current) {
          current.tabIndex = 0;
          current.focus({ preventScroll: true });
        }
        if (current) {
          scrollIntoColumn(current);
        }
        if (performance.now() - started < 300) {
          window.requestAnimationFrame(refocus);
        }
      };
      window.requestAnimationFrame(refocus);
    },
    [announce, archived, pairColumn, reorderChain],
  );

  const anyOverlayOpen =
    Boolean(menu) ||
    Boolean(highlightAction) ||
    Boolean(renameTarget) ||
    Boolean(deletingBranchId) ||
    Boolean(recapDialogNodeId);
  const anyOverlayOpenRef = useRef(anyOverlayOpen);
  anyOverlayOpenRef.current = anyOverlayOpen;
  const onPairsKeyDown = useResearchPairsKeyboard({
    columnsLayout,
    columnsLayoutRef,
    workspaceRef,
    stripRef,
    levelPathRef,
    nodesRef,
    branchesByParentRef,
    branchRangeOffsetsRef,
    levelMemoryRef,
    pendingRef,
    editorRef,
    currentLevelRef,
    threadHandlesRef,
    anyOverlayOpenRef,
    goBack,
    goForward,
    closeAfter,
    requestFocus,
    selectMessage,
    openBranch,
    goBranch,
    selectedRow,
    moveFocusedMessage,
  });

  // The branch count beside a message: selects the message and moves focus to
  // its answer's margin markers (the open one, else the first).
  const showBranches = useCallback(
    (nodeId: string, level: number) => {
      selectMessage(level, nodeId);
      window.requestAnimationFrame(() => {
        const column = pairColumn("answer", level);
        const marker =
          column?.querySelector<HTMLElement>(".research-marker.is-open") ??
          column?.querySelector<HTMLElement>(".research-marker");
        if (marker) {
          requestFocus({ kind: "marker", level, key: marker.dataset.researchMarker ?? "" }, "reveal");
        }
      });
    },
    [pairColumn, requestFocus, selectMessage],
  );

  /** Shows a newly forked node until the refreshed tree detail includes it. */
  const addCreatedNode = useCallback((node: ResearchNode) => {
    createdNodeIdsRef.current.add(node.id);
    setCreatedNodes((current) => [...current.filter((entry) => entry.node.id !== node.id), { node, at: Date.now() }]);
  }, []);

  /** Sends a column's ask box. Editing a failed question forks the new
   * question from the same parent in place of the failed node (removed by the
   * backend after creating the new node). While the tail is running the
   * question joins the chain's client-side queue. A sent question becomes
   * the level's selected message. */
  const submitComposer = useCallback(
    async (headId: string, { branch = false }: { branch?: boolean } = {}) => {
      const currentDetail = detailRef.current;
      const prompt = (composerTextRef.current[headId] ?? "").trim();
      if (!currentDetail || !prompt || archived || submittingKeyRef.current) {
        return;
      }
      const chain = inlineChainFor(currentDetail.nodes, headId)
        .map((id) => currentDetail.nodes.find((node) => node.id === id))
        .filter((node): node is ResearchNode => Boolean(node));
      const tail = chain[chain.length - 1] ?? null;
      const editingId = editingByHeadRef.current[headId];
      const clearComposer = () => {
        setComposerText((current) => ({ ...current, [headId]: "" }));
        if (headId === mainComposerKey && treeIdRef.current) {
          navigationPersistence.recordDraft(treeIdRef.current, "");
          navigationPersistence.flush();
        }
      };
      if (branch) {
        const source = [...chain].reverse().find((node) => canFollowUpFrom(node));
        if (!source) {
          return;
        }
        setSubmittingKey(headId);
        try {
          const child = await onForkRef.current(source.id, prompt, null, false);
          clearComposer();
          addCreatedNode(child);
          navigate(child.id);
          requestFocus({ kind: "composer", key: child.id }, "settle");
        } catch (err) {
          onErrorRef.current(err instanceof Error ? err.message : String(err));
        } finally {
          setSubmittingKey(null);
        }
        return;
      }
      if (editingId) {
        const failed = currentDetail.nodes.find((node) => node.id === editingId);
        const request = failed ? researchEditedQuestionFork(failed, prompt) : null;
        if (!failed || !request) {
          setEditingByHead((current) => withoutKeys(current, [headId]));
          return;
        }
        setSubmittingKey(headId);
        try {
          const child = await onForkRef.current(
            request.parentNodeId,
            request.prompt,
            request.anchor,
            request.inline,
            request.replacesNodeId,
          );
          clearComposer();
          setEditingByHead((current) => withoutKeys(current, [headId]));
          addCreatedNode(child);
          navigate(child.id);
          requestFocus({ kind: "composer", key: failed.id === headId ? child.id : headId }, "none");
        } catch (err) {
          onErrorRef.current(err instanceof Error ? err.message : String(err));
        } finally {
          setSubmittingKey(null);
        }
        return;
      }
      if (!tail) {
        return;
      }
      const step = researchQueueStep(tail);
      const queued = queuesRef.current[headId] ?? EMPTY_QUEUE;
      if (step === "wait" || queued.length > 0 || chainSendInFlight(headId)) {
        updateQueue(headId, (queue) => [
          ...queue,
          { id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, prompt, createdAt: Date.now() },
        ]);
        clearComposer();
        return;
      }
      if (step === "stalled" || !canContinueChain(currentDetail.nodes, tail)) {
        return;
      }
      setSubmittingKey(headId);
      try {
        const child = await onForkRef.current(tail.id, prompt, null, true);
        awaitChainChild(headId, child.id);
        clearComposer();
        addCreatedNode(child);
        navigate(child.id);
      } catch (err) {
        onErrorRef.current(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmittingKey(null);
      }
    },
    [addCreatedNode, archived, awaitChainChild, chainSendInFlight, mainComposerKey, navigate, navigationPersistence, queuesRef, requestFocus, updateQueue],
  );

  /** Sends the new branch's first question: the branch is created with it
   * and becomes the next level, with its ask box focused. */
  const submitPendingBranch = useCallback(async () => {
    const current = pendingRef.current;
    if (!current) {
      return;
    }
    const key = `pending:${current.parentNodeId}`;
    const prompt = (composerTextRef.current[key] ?? "").trim();
    if (!prompt || submittingKeyRef.current || archived) {
      return;
    }
    setSubmittingKey(key);
    try {
      const child = await onForkRef.current(
        current.parentNodeId,
        prompt,
        current.anchor ? { kind: "passage", anchor: current.anchor } : null,
        false,
      );
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.clearPendingBranch(currentTreeId, current.parentNodeId);
      }
      setComposerText((text) => withoutKeys(text, [key]));
      if (pendingRef.current === current) {
        addCreatedNode(child);
        navigate(child.id);
        requestFocus({ kind: "composer", key: child.id }, "settle");
      }
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingKey(null);
    }
  }, [addCreatedNode, archived, navigate, navigationPersistence, requestFocus]);

  const onOpenNodesChangeRef = useRef(onOpenNodesChange);
  onOpenNodesChangeRef.current = onOpenNodesChange;
  const openNodesKey = strip.openNodeIds.join("\n");
  useEffect(() => {
    onOpenNodesChangeRef.current?.(openNodesKey.split("\n").filter(Boolean));
  }, [openNodesKey]);
  useEffect(() => () => onOpenNodesChangeRef.current?.([]), []);

  // The whole chain as one Markdown document: each message and its answer in
  // order, separated by rules. Answers not loaded yet are fetched first.
  async function copyThread(chainIds: string[]) {
    const parts: string[] = [];
    try {
      for (const id of chainIds) {
        const chainNode = nodeById.get(id);
        if (!chainNode) {
          continue;
        }
        const content = contentByNodeRef.current[id] ?? (await getResearchNodeContent(id));
        const view = buildSegmentView(chainNode, content, true, false);
        const body = (view.conversationCopyText ?? view.rawAnswer).trim();
        const prompt = nodeMessage(chainNode)?.text.trim() || null;
        if (!prompt && !body) {
          continue;
        }
        parts.push(
          [prompt ? `**Question:** ${prompt}` : null, body || "_No response available._"]
            .filter(Boolean)
            .join("\n\n"),
        );
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (parts.length === 0) {
      return;
    }
    try {
      await writeClipboardText(parts.join("\n\n---\n\n"));
      onToast("Thread copied.");
    } catch {
      onToast("Couldn't copy.", "warning");
    }
  }

  /** Opens the editor column for the root's document or post; focus moves
   * into the field. A document's editor follows the root level's columns, so
   * the strip closes any branch level and the editor is the last column. A
   * note's editor takes the note column's place, and an open follow-up stays
   * open, so editing a note changes no selection and adds no history
   * visit. */
  function startEditing(nodeId: string, returnFocus: HTMLElement | null) {
    const node = nodeById.get(nodeId);
    if (!node || nodeId !== rootNodeId || archived) {
      return;
    }
    let session: EditorSession;
    if (documentHoldsMarkdown(node)) {
      const content = contentByNode[nodeId];
      const markdown = segmentViews.get(nodeId)?.editableDocumentMarkdown ?? null;
      if (!content?.responseRevision || markdown == null) {
        onError("The document content is unavailable.");
        return;
      }
      const highlights = content.node.highlights ?? [];
      session = {
        nodeId,
        kind: "document",
        initialText: markdown,
        text: markdown,
        initialTitle: detail?.tree.title ?? "",
        title: detail?.tree.title ?? "",
        responseRevision: content.responseRevision,
        highlightIds: highlights.map((highlight) => highlight.id),
        highlightAnchors: highlights.map((highlight) => highlight.anchor),
        branchAnchors: nodes.flatMap((child) => {
          const anchor = child.parentNodeId === nodeId ? passageAnchor(child) : null;
          return anchor ? [anchor] : [];
        }),
        imported: documentSource(node) === "imported",
        returnFocus,
        noteScrollTop: 0,
      };
    } else if (nodeType(node) === "post") {
      session = {
        nodeId,
        kind: "post",
        initialText: nodePrompt(node),
        text: nodePrompt(node),
        initialTitle: "",
        title: "",
        responseRevision: null,
        highlightIds: [],
        highlightAnchors: node.highlights.map((highlight) => highlight.anchor),
        branchAnchors: [],
        imported: false,
        returnFocus,
        noteScrollTop:
          workspaceRef.current?.querySelector<HTMLElement>(`${columnSelector("N0")} > .research-column-scroll`)
            ?.scrollTop ?? 0,
      };
    } else {
      return;
    }
    cancelPending();
    setMenu(null);
    setEditorError(null);
    setEditor(session);
    const path = levelPathRef.current;
    if (path[0] !== nodeId || (session.kind === "document" && path.length !== 1)) {
      navigate(nodeId);
    }
    requestFocus({ kind: "editor" }, "settle");
  }

  /** Closes the editor column; focus returns to the control that opened it,
   * else to the root's row (a document) or the note's column. The note
   * column returns in the editor's place as a new element, so the … button
   * that opened a note's editor is gone: focus goes to the new column's …
   * button, and the column gets back its scroll offset. */
  function closeEditor() {
    const session = editorRef.current;
    setEditor(null);
    setEditorError(null);
    setEditorSaving(false);
    const target = session?.returnFocus;
    if (session?.kind === "post") {
      noteScrollRestoreRef.current = session.noteScrollTop;
      if (!target?.isConnected) {
        requestFocus({ kind: "note", menu: Boolean(target?.matches(".research-head-menu")) }, "settle");
        return;
      }
    }
    window.requestAnimationFrame(() => {
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        settleResearchStrip(columnsLayoutRef.current?.row ?? null, columnIdOf(target));
        return;
      }
      const post = workspaceRef.current?.querySelector<HTMLElement>(
        `${columnSelector("N0")} > .research-column-scroll`,
      );
      if (post) {
        post.focus({ preventScroll: true });
        settleResearchStrip(columnsLayoutRef.current?.row ?? null, "N0");
      } else {
        requestFocus({ kind: "row", level: 0 }, "settle");
      }
    });
  }

  async function saveEditor() {
    const session = editorRef.current;
    if (!session || editorSaving || !researchEditorCanSave(session, editorStats)) {
      return;
    }
    setEditorSaving(true);
    setEditorError(null);
    try {
      if (session.kind === "document") {
        const result = await onUpdateDocument({
          nodeId: session.nodeId,
          markdown: session.text,
          title: session.title.trim() || null,
          expectedResponseRevision: session.responseRevision ?? "",
          expectedTitle: session.initialTitle,
          expectedHighlightIds: session.highlightIds,
        });
        if (treeIdRef.current === result.tree.id && result.markdownChanged) {
          // The loader refetches the replaced snapshot; the old revision is
          // not shown once the editor closes.
          reloadContent(session.nodeId);
        }
        const removed = result.removedHighlightCount;
        onToast(
          removed > 0
            ? `Document saved · ${removed.toLocaleString()} highlight${removed === 1 ? "" : "s"} removed`
            : "Document saved",
        );
      } else {
        const result = await onUpdatePost({
          nodeId: session.nodeId,
          text: session.text,
          expectedText: session.initialText,
        });
        const removed = result.removedHighlightCount;
        onToast(
          removed > 0
            ? `Note saved · ${removed.toLocaleString()} highlight${removed === 1 ? "" : "s"} removed`
            : "Note saved",
        );
      }
      closeEditor();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
      setEditorSaving(false);
    }
  }

  /** Starts a new question thread with the editor's text. The edited
   * document or post is not changed: the editor closes without saving. */
  async function askEditorAsQuestion() {
    const session = editorRef.current;
    if (!session || editorAsking) {
      return;
    }
    setEditorAsking(true);
    setEditorError(null);
    try {
      await onAskAsQuestion(session.text.trim());
      setEditor(null);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditorAsking(false);
    }
  }

  /** Renames the research (the root) or a branch; the Rename dialog's save. */
  async function renameNode(nodeId: string, title: string) {
    if (!detail) {
      return;
    }
    if (nodeId === detail.tree.rootNodeId) {
      await onRenameTree(detail.tree.id, title);
    } else {
      await renameResearchNode(nodeId, title);
    }
  }

  /** Deletes `node` and what follows it (the delete dialog's confirmation),
   * or the whole research for the root, and closes the dialog. */
  async function removeBranch(node: ResearchNode) {
    if (node.id === detail?.tree.rootNodeId) {
      await onRemoveTree(detail.tree.id);
      setDeletingBranchId(null);
      return;
    }
    deletedParentIdRef.current = node.parentNodeId ?? null;
    // Whether the open path runs through what is removed, checked before the
    // call: the caller prunes the detail before the call resolves.
    const subtree = researchSubtreeIds(nodesRef.current, node.id);
    const wasOnPath = levelPathRef.current.some((id) => subtree.has(id));
    const removal = await onRemoveBranch(node.id);
    // The backend call and detail refresh can outlive this thread page's tree.
    if (treeIdRef.current !== removal.treeId) {
      setDeletingBranchId(null);
      return;
    }
    const removedNodeIds = new Set(removal.removedNodeIds);
    setCreatedNodes((current) => current.filter((entry) => !removedNodeIds.has(entry.node.id)));
    for (const id of removedNodeIds) {
      createdNodeIdsRef.current.delete(id);
    }
    // A removed message on the open path: the message it was asked from
    // becomes the deepest selection, which closes the levels after it.
    if (wasOnPath && removal.parentNodeId) {
      const parentId = removal.parentNodeId;
      setSelectedNodeId(parentId);
      persistSelection(parentId);
      onPruneVisitsRef.current?.(removal.treeId, (nodeId) => !removedNodeIds.has(nodeId), parentId);
    } else {
      onPruneVisitsRef.current?.(removal.treeId, (nodeId) => !removedNodeIds.has(nodeId), null);
    }
    setDeletingBranchId(null);
  }

  // Callbacks every answer column shares.
  const answerPaneHandlers = useMemo<ResearchAnswerPaneHandlers>(
    () => ({
      registerSegmentElement,
      onExpandTurns: expandAllTurns,
      onRetryContentLoad: retryContentLoad,
      onToggleFullTrace: toggleFullTrace,
      onCancelNode: handleCancelNode,
      onRetryNode: handleRetryNode,
      onRemoveQueuedRetry: removeQueuedRetry,
      onEditQuestion: handleEditQuestion,
      onRootMouseDown: beginHighlightSelectionDrag,
      onRootMouseUp: finishHighlightSelectionDrag,
      onRootKeyUp: captureHighlightSelection,
      onRootClick: openAnnotationAtPoint,
      onRootMouseMove: trackAnnotationUnderPointer,
      onRootMouseLeave: clearAnnotationPointer,
    }),
    [
      beginHighlightSelectionDrag,
      captureHighlightSelection,
      clearAnnotationPointer,
      expandAllTurns,
      finishHighlightSelectionDrag,
      handleCancelNode,
      handleEditQuestion,
      handleRetryNode,
      openAnnotationAtPoint,
      registerSegmentElement,
      removeQueuedRetry,
      retryContentLoad,
      toggleFullTrace,
      trackAnnotationUnderPointer,
    ],
  );
  const branchBusy = useCallback((headId: string) => researchSubtreeBusy(nodes, headId), [nodes]);
  // Callbacks every messages column's rows share.
  const messageRowActions = useMemo<ResearchMessageRowActions>(
    () => ({
      registerSegmentElement,
      onSelect: selectRow,
      onShowBranches: showBranches,
      onOpenAnswerMenu: openAnswerMenu,
      onOpenContextMenu: openContextMenu,
      onDragStart: startMessageDrag,
    }),
    [openAnswerMenu, openContextMenu, registerSegmentElement, selectRow, showBranches, startMessageDrag],
  );
  const markerActions = useMemo<ResearchMarkerActions>(
    () => ({
      nodeById,
      branchBusy,
      onTip: setMarkerTip,
      onCloseBranch: (level, markerKey) => {
        closeAfter(level);
        requestFocus({ kind: "marker", level, key: markerKey }, "settle");
      },
      onOpenBranch: goBranch,
    }),
    [branchBusy, closeAfter, goBranch, nodeById, requestFocus],
  );

  // Back and forward, in the root level's header and in the loading
  // placeholder's, so they stay in place while a thread loads.
  const historyNav = {
    canGoBack,
    canGoForward,
    backTitle: `Back (${IS_MAC ? "⌘[" : "Ctrl+["})`,
    forwardTitle: `Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`,
    onBack: goBack,
    onForward: goForward,
  };

  if (!detail || !rootNodeId || !selectedNodeId || levelPath.length === 0) {
    // A failed *tree* fetch retries through the app shell — without detail
    // there is no node to load, so no in-page retry can recover.
    const placeholderError = detailError ?? null;
    const rootKind = detail
      ? detail.nodes.find((node) => node.id === detail.tree.rootNodeId)?.type
      : treeType;
    const headerTitle =
      rootKind === "post" ? "Note" : (detail?.tree.title ?? treeTitle ?? "Loading research…");
    return (
      <ResearchThreadPlaceholder title={headerTitle} history={historyNav}>
        <div className="research-placeholder">
          {placeholderError ? null : (
            <LoaderCircle className="research-spinner" size={24} aria-hidden="true" />
          )}
          <h1>{placeholderError ? "Research unavailable" : "Loading research…"}</h1>
          {placeholderError ? (
            <>
              <p role="alert">{placeholderError}</p>
              {onRetryDetail ? (
                <button className="control-button" type="button" onClick={onRetryDetail}>
                  Retry
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </ResearchThreadPlaceholder>
    );
  }

  const rootNode = nodeById.get(rootNodeId) ?? null;
  const treeTitleText = detail.tree.title;
  const lastLevel = pendingColumn?.levelIndex ?? levelPath.length - 1;
  // The feed holding focus leaves no level current.
  const focusedLevel = focusedColumnId === "feed" ? -1 : columnLevelIndex(focusedColumnId);
  const currentLevel =
    focusedLevel !== null && focusedLevel <= lastLevel ? focusedLevel : lastLevel;
  currentLevelRef.current = currentLevel < 0 ? lastLevel : currentLevel;

  // ---- rendering -------------------------------------------------------------

  const isUnread = (branch: ResearchNode) =>
    nodeStatus(branch) === "complete" &&
    firstSeenCompleteRef.current.get(branch.id) === false &&
    !openedNodeIds.has(branch.id);

  const registerComposer = (key: string) => (handle: ResearchComposerHandle | null) => {
    if (handle) {
      composerRefs.current.set(key, handle);
    } else {
      composerRefs.current.delete(key);
    }
  };

  /** What the branch headed by `branch` (or the unsent one, null) was asked
   * about. */
  const branchSource = (
    anchor: ResearchHighlightAnchor | null,
    parentId: string,
    branch: ResearchNode | null,
  ): ResearchBranchSourceProps => ({
    anchor,
    parent: nodeById.get(parentId),
    created: branch !== null,
    resolves: branch
      ? branchRangeOffsetsRef.current.some((entry) => entry.id === branch.id)
      : Boolean(anchor),
    parentLoaded: Boolean(contentByNode[parentId]),
  });

  /** The queue of the chain headed by `headId` and its items' actions. */
  const chainQueue = (headId: string): ResearchQueueProps => {
    const chain = inlineChainFor(nodes, headId);
    const tail = nodeById.get(chain[chain.length - 1] ?? "") ?? null;
    return {
      items: queues[headId] ?? EMPTY_QUEUE,
      tailStalled: researchQueueStep(tail) === "stalled",
      onRemove: (item) => {
        updateQueue(headId, (queue) => queue.filter((entry) => entry.id !== item.id));
        window.requestAnimationFrame(() => composerRefs.current.get(headId)?.focus());
      },
      // Retry removes the Retry button: focus moves to the item's Remove
      // button, and to the ask box once the question has been sent (see
      // useResearchChainQueue).
      onRetry: (item, row) => {
        retryQueued(headId, item.id);
        window.requestAnimationFrame(() => {
          if (row?.isConnected) {
            row.querySelector<HTMLButtonElement>(".research-queue-remove")?.focus();
          }
        });
      },
      // Editing moves the question into the ask box. Text already there is
      // never replaced or merged into it: the reader clears it first.
      onEdit: (item) => {
        if ((composerTextRef.current[headId] ?? "").trim()) {
          onToast("Clear the ask box to edit this question.");
          return;
        }
        updateQueue(headId, (queue) => queue.filter((entry) => entry.id !== item.id));
        setComposerText((current) => ({ ...current, [headId]: item.prompt }));
        window.requestAnimationFrame(() => composerRefs.current.get(headId)?.focus());
      },
    };
  };

  /** One column of the strip. A post root (a note) is its note column and
   * its follow-ups column; a level's messages and answer are two; the unsent
   * branch is the pending column. */
  const renderColumn = (column: ResearchColumn) => {
    switch (column.role) {
      case "post": {
        const level = column.level.index;
        const post = nodeById.get(column.level.headId);
        if (!post) {
          return null;
        }
        // Only the thread's root post has a … menu (in the column header);
        // the column's context menu is the same menu.
        const hasPostMenu = level === 0 && post.id === rootNodeId;
        return (
          <ResearchNoteColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === level}
            detail={detail}
            post={post}
            title={level === 0 ? treeTitleText : researchNodeLabel(post, "Note")}
            history={level === 0 ? historyNav : null}
            archived={archived}
            menu={
              hasPostMenu
                ? {
                    open: menu?.kind === "post" && Boolean(menu.trigger),
                    onOpen: (trigger) =>
                      setMenu({ kind: "post", nodeId: post.id, anchor: trigger, align: "end", trigger }),
                    onContextMenu: (placement) => setMenu({ kind: "post", nodeId: post.id, ...placement }),
                  }
                : null
            }
            scrollRef={level === 0 ? restoreNoteScroll : undefined}
            onSelectNode={navigate}
          />
        );
      }
      case "thread": {
        const level = column.level.index;
        const post = nodeById.get(column.level.headId);
        if (!post) {
          return null;
        }
        return (
          <ResearchFollowUpsColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === level}
            nodes={nodes}
            post={post}
            archived={archived}
            postActions={postActions}
            requireCmdEnterToSend={requireCmdEnterToSend}
            openNodeId={levels[level + 1]?.headId ?? null}
            composerRef={registerComposer(post.id)}
            threadRef={registerThread(level)}
            onOpenFollowUp={(nodeId) => {
              openBranch(level, nodeId);
              requestFocus({ kind: "row", level }, "settle");
            }}
          />
        );
      }
      case "messages": {
        const { index: level, chainIds, headId } = column.level;
        const head = nodeById.get(headId);
        const chain = chainIds
          .map((id) => nodeById.get(id))
          .filter((node): node is ResearchNode => Boolean(node));
        const editingId = editingByHead[headId];
        const cancelEditing = () => {
          setEditingByHead((current) => withoutKeys(current, [headId]));
          setComposerText((current) => ({ ...current, [headId]: "" }));
          requestFocus({ kind: "composer", key: headId }, "none");
        };
        return (
          <ResearchMessagesColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === level}
            title={level === 0 ? treeTitleText : researchNodeLabel(head, "Branch")}
            history={level === 0 ? historyNav : null}
            // Provenance: a transcript came from a terminal session.
            imported={level === 0 && rootNode?.type === "document" && rootNode.source === "transcript"}
            archived={archived}
            treeTitle={treeTitleText}
            nodeById={nodeById}
            branchesByParent={branchesByParent}
            branchOpen={levelPath.length > level + 1 || activePending?.parentNodeId === column.level.selectedId}
            queuedRetries={queuedRetries}
            answerMenuOpenId={menu?.kind === "answer" && menu.trigger ? menu.nodeId : null}
            isUnread={isUnread}
            rowActions={messageRowActions}
            source={level > 0 && head?.parentNodeId ? branchSource(passageAnchor(head), head.parentNodeId, head) : null}
            composer={
              chain.length > 0 && nodeType(chain[0]) !== "post" ? (
                <ResearchChainComposer
                  nodes={nodes}
                  chain={chain}
                  level={level}
                  editing={Boolean(editingId)}
                  queued={(queues[headId] ?? EMPTY_QUEUE).length > 0}
                  archived={archived}
                  value={composerText[headId] ?? ""}
                  submitting={submittingKey === headId}
                  shortcutHint={shortcutHintsShown && currentLevel === level ? "⌘J" : null}
                  requireCmdEnter={requireCmdEnterToSend}
                  composerRef={registerComposer(headId)}
                  onChange={(value) => setComposerText((current) => ({ ...current, [headId]: value }))}
                  onSubmit={() => void submitComposer(headId)}
                  onSubmitBranch={() => void submitComposer(headId, { branch: true })}
                  onCancelEditing={cancelEditing}
                />
              ) : null
            }
            queue={chainQueue(headId)}
            onScroll={onColumnScroll(column)}
          />
        );
      }
      case "answer": {
        const node = nodeById.get(column.nodeId);
        const view = segmentViews.get(column.nodeId);
        if (!node || !view) {
          return null;
        }
        const documentEditing = editor?.kind === "document" && editor.nodeId === node.id ? editor : null;
        return (
          <ResearchAnswerColumn
            key={columnKey(column)}
            column={column}
            node={node}
            parent={node.parentNodeId ? nodeById.get(node.parentNodeId) : undefined}
            view={view}
            label={researchNodeLabel(node, treeTitleText)}
            current={currentLevel === column.level.index}
            archived={archived}
            markers={markersByNode[node.id] ?? EMPTY_MARKERS}
            openBranchHeadId={levels[column.level.index + 1]?.headId ?? null}
            preview={
              documentEditing && documentEditing.text !== documentEditing.initialText
                ? { original: documentEditing.initialText, next: editorText, imported: documentEditing.imported }
                : null
            }
            editing={documentEditing !== null}
            contentError={contentErrorByNode[node.id] ?? null}
            cancelling={cancelling}
            recapPending={recapPendingNodeIds.has(node.id)}
            pointerOverAnnotation={pointerAnnotationNodeId === node.id}
            retrying={retryingNodeId === node.id}
            retryQueued={queuedRetries.has(node.id)}
            paneHandlers={answerPaneHandlers}
            markerActions={markerActions}
            onOpenContextMenu={openContextMenu}
            onScroll={onColumnScroll(column)}
          />
        );
      }
      case "editor": {
        if (!editor || editor.nodeId !== column.nodeId) {
          return null;
        }
        const sessionNodeId = editor.nodeId;
        return (
          <ResearchEditorSessionColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === column.levelIndex}
            session={editor}
            stats={editorStats}
            saving={editorSaving}
            asking={editorAsking}
            error={editorError}
            questionModel={readQuestionModel()}
            textareaRef={editorFieldRef}
            history={editor.kind === "post" ? historyNav : null}
            onChange={(patch) =>
              setEditor((current) => (current && current.nodeId === sessionNodeId ? { ...current, ...patch } : current))
            }
            onCancel={closeEditor}
            onSave={() => void saveEditor()}
            onAskAsQuestion={() => void askEditorAsQuestion()}
          />
        );
      }
      case "pending": {
        const pendingKey = `pending:${column.parentNodeId}`;
        return (
          <ResearchNewBranchColumn
            key={columnKey(column)}
            column={column}
            current={currentLevel === column.levelIndex}
            archived={archived}
            source={branchSource(column.anchor, column.parentNodeId, null)}
            value={composerText[pendingKey] ?? ""}
            submitting={submittingKey === pendingKey}
            shortcutHint={shortcutHintsShown && currentLevel === column.levelIndex ? "⌘J" : null}
            requireCmdEnter={requireCmdEnterToSend}
            composerRef={registerComposer(pendingKey)}
            onChange={(value) => setComposerText((current) => ({ ...current, [pendingKey]: value }))}
            onSubmit={() => void submitPendingBranch()}
            onCancel={cancelPending}
          />
        );
      }
      default:
        // The feed, a draft and the placeholder are rendered outside the
        // thread's strip.
        return null;
    }
  };

  // ⌘F searches every open column, left to right.
  const searchRoots = () => [
    ...(workspaceRef.current?.querySelectorAll<HTMLElement>(
      "[data-research-pair] .research-column-content, [data-research-pair] .research-answer",
    ) ?? []),
  ];
  // A match in a column scrolled out of the strip's view scrolls the strip to it.
  const revealSearchMatch = (range: Range) => {
    const element =
      range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const column = element?.closest<HTMLElement>(columnSelector()) ?? null;
    revealResearchColumns(columnsLayout?.row ?? null, column, column, "auto");
    return false;
  };
  const searchBar = (
    <DomSearchBar
      active
      placeholder="Find in research"
      rootRef={workspaceRef}
      getRoots={searchRoots}
      rootsKey={`${levelPath.join(",")}:${activePending?.parentNodeId ?? ""}`}
      scopeContains={(target) => Boolean(workspaceRef.current?.contains(target))}
      viewportFor={(range) =>
        (range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement
        )?.closest<HTMLElement>(".research-column-scroll") ?? null
      }
      revealRange={revealSearchMatch}
    />
  );

  return (
    <WidgetChangeContext.Provider value={archived ? null : (answer, html) => {
      if (researchBranchBlocker(detail.nodes.find((node) => node.id === answer.nodeId), archived)) return;
      openPendingBranch(answer.nodeId, null);
      const key = `pending:${answer.nodeId}`;
      setComposerText((current) => ({ ...current, [key]: [current[key], widgetChangePrompt(answer, html)].filter(Boolean).join("\n\n") }));
    }}>
    <TranscriptLinkActionsProvider actions={linkActions}>
      <div
        ref={workspaceRef}
        className="research-thread-page research-pairs"
        onKeyDown={onPairsKeyDown}
      >
        {strip.columns.map(renderColumn)}
        <div className="research-columns-filler" aria-hidden={!strip.endsWithAnswer || undefined}>
          {strip.endsWithAnswer ? (
            <p>Select a passage or a branch marker beside the answer to open it as the next pair.</p>
          ) : null}
        </div>
      </div>
      {columnsLayout?.overlay ? createPortal(searchBar, columnsLayout.overlay) : searchBar}
      <div className="research-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {menu ? (
        <ResearchThreadMenu
          menu={menu}
          nodes={nodes}
          nodeById={nodeById}
          treeNodes={detail.nodes}
          rootNodeId={rootNodeId}
          treeTitle={treeTitleText}
          archived={archived}
          treeMenu={treeMenu}
          content={contentByNode[menu.nodeId] ?? null}
          view={segmentViews.get(menu.nodeId) ?? null}
          hiddenHighlights={hiddenHighlightsByNode[menu.nodeId] ?? 0}
          fullTrace={Boolean(fullTraceNodes[menu.nodeId])}
          openBranchIds={openBranchIds}
          relaunchPending={retryingNodeId !== null}
          isPassagePress={pressOnMenuPassage}
          onClose={closeMenu}
          onOpenBranch={(parentNodeId, branchId) => {
            const level = levelPathRef.current.indexOf(parentNodeId);
            if (level >= 0) {
              goBranch(level, branchId);
            }
          }}
          onBranch={openPendingBranch}
          onRemoveHighlight={(nodeId, highlightId) =>
            removeHighlights(nodeId, [highlightId]).catch((err) =>
              onError(err instanceof Error ? err.message : String(err)),
            )
          }
          onEdit={startEditing}
          onShowFullTrace={showFullTraceFor}
          onToggleFullTrace={toggleFullTrace}
          onToggleStar={toggleStarred}
          onCopyAnswer={handleCopyAnswer}
          onCopyThread={(chainIds) => void copyThread(chainIds)}
          onRerun={handleRetryNode}
          onGenerateRecap={setRecapDialogNodeId}
          onRename={(nodeId, value) => setRenameTarget({ nodeId, value })}
          onDelete={setDeletingBranchId}
        />
      ) : null}
      {markerTip ? (
        <ResearchMarkerTip
          anchor={markerTip.element}
          items={markerTip.branchIds.flatMap((branchId) => {
            const branch = nodeById.get(branchId);
            if (!branch) return [];
            const chain = inlineChainFor(nodes, branchId);
            return [
              {
                id: branchId,
                question: nodePrompt(branch),
                source: passageAnchor(branch) ? `“${researchQuoteText(passageAnchor(branch)!.exact)}”` : "Whole answer",
                messages: chain.length,
                state: levels[markerTip.level + 1]?.headId === branchId ? ("open" as const) : branchBusy(branchId) ? ("running" as const) : null,
              },
            ];
          })}
          opensNext={markerTip.branchIds.includes(levels[markerTip.level + 1]?.headId ?? "")}
          onDismiss={dismissMarkerTip}
        />
      ) : null}
      {highlightAction ? (
        <ResearchSelectionToolbar
          action={highlightAction}
          saving={savingHighlight}
          branchBlocker={selectionBranchBlocker}
          onBranch={branchFromSelection}
          onHighlight={() => void applyHighlightAction()}
          onCopy={() => void copySelection()}
          onDismiss={clearHighlightAction}
        />
      ) : null}
      {renameTarget ? (
        <ResearchRenameDialog
          key={renameTarget.nodeId}
          initialValue={renameTarget.value}
          isRoot={renameTarget.nodeId === rootNodeId}
          onRename={(title) => renameNode(renameTarget.nodeId, title)}
          onClose={() => setRenameTarget(null)}
        />
      ) : null}
      {recapDialogNodeId && contentByNode[recapDialogNodeId] && nodeRecap(contentByNode[recapDialogNodeId].node)
        ? createPortal(
            <ResearchRecapDialog
              content={contentByNode[recapDialogNodeId]}
              onClose={() => setRecapDialogNodeId(null)}
              onApplied={(updatedNode) => {
                replaceContentNode(updatedNode);
                onToast("Recap updated");
              }}
            />,
            document.body,
          )
        : null}
      {deletingBranchId ? (
        <ResearchDeleteBranchDialog
          key={deletingBranchId}
          nodes={detail.nodes}
          nodeId={deletingBranchId}
          rootNodeId={rootNodeId}
          treeTitle={treeTitleText}
          onRemove={removeBranch}
          onClose={() => setDeletingBranchId(null)}
          returnFocusFallback={deleteReturnFocus}
        />
      ) : null}
    </TranscriptLinkActionsProvider>
    </WidgetChangeContext.Provider>
  );
}

export default memo(ResearchThreadPage);
