// The research document (`09-research-document-view.md`).
//
// One page renders one *spine*: the chain of inline follow-ups containing the
// selected node. Branches hang off it as cards in the margin. The page owns
// what crosses segments — selection, navigation, the composer, the dialogs —
// while each `ThreadSegment` owns its own content query, so a chain that grows
// a segment does not change the number of hooks this component calls.
//
// What the desktop needed and this does not: mirror refs, `useStableValue`, a
// per-node segment view cache, and custom prop comparators. The tree detail is
// patched in place by the event bridge rather than replaced wholesale, and
// `response_preview` updates are coalesced server-side to two a second, so a
// segment's props change only when its own node does (09 §4, §9).

import {
  canContinueThread,
  canFollowUpFrom,
  canRetryResearchNode,
  inlineChainFor,
  isActiveResearchStatus,
  researchSelectionActionPlacement,
} from "@session/shared";
import type { ResearchHighlightAnchor, ResearchNode } from "@session/shared";
import { useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  useCancelResearchNode,
  useForkResearchNode,
  useMarkTreeViewed,
  useMe,
  useRemoveResearchBranch,
  useRemoveResearchTree,
  useRetryResearchNode,
  useRuntimeConfig,
  useSetTreeBookmarked,
  useSetTreeFollowed,
  useSettings,
  useTreeDetail,
} from "../../api/queries.js";
import { writeClipboardText } from "../../lib/clipboard.js";
import { cn } from "../../lib/cn.js";
import { pushErrorToast, pushToast } from "../../lib/toast.js";
import { nodeDraftKey, useDraftsStore } from "../../stores/drafts.js";
import { useNavigationStore } from "../../stores/navigation.js";
import { useRecapPendingStore } from "../../stores/recapPending.js";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "../../ui/ContextMenu.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { DomSearchBar } from "../../ui/DomSearchBar.js";
import { MenuItem, MenuSeparator } from "../../ui/Menu.js";
import { launchableModels } from "../composer/ResearchQueryComposer.js";

import { DeleteBranchDialog } from "./DeleteBranchDialog.js";
import { DocumentEditor } from "./DocumentEditor.js";
import type { DocumentEditSession } from "./DocumentEditor.js";
import { DocumentHeader } from "./DocumentHeader.js";
import { FollowupComposer } from "./FollowupComposer.js";
import type { FollowupMode } from "./FollowupComposer.js";
import { RecapDialog } from "./RecapDialog.js";
import { SelectionPopover } from "./SelectionPopover.js";
import { ThreadSegment } from "./ThreadSegment.js";
import type { PublishedSegment, SegmentElementKind } from "./ThreadSegment.js";
import { RESEARCH_COLUMNS_CLASS } from "./layout.js";
import type { SegmentConnector } from "./layout.js";
import { useHighlightMutations, useUpdateResearchDocument } from "./mutations.js";
import type { CapturedResearchSelection } from "./selection/capture.js";
import { isEditableEventTarget, rangeForTextOffsets } from "./selection/dom.js";
import { durationLabel } from "./timeline.js";
import { ASK_ENTRY_ID, useResearchAnnotations } from "./useResearchAnnotations.js";
import type { AnchoredEntry } from "./useResearchAnnotations.js";
import { useResearchSelectionDrag } from "./useResearchSelectionDrag.js";

const SCROLL_RECORD_DEBOUNCE_MS = 250;
/** One identity for "the tree has not arrived yet", so the memos below do not
 * rebuild on every render while it is loading. */
const NO_NODES: ResearchNode[] = [];
/** One identity for "this segment has nothing unread", for the same reason:
 * `ThreadSegment` and its rail are memoized on their props. */
const NO_UNREAD: ReadonlySet<string> = new Set<string>();
/** Same again for the two "nothing here" lists a segment can be handed. A `??
 * []` in the render would be a new array per render and per segment, which is
 * all it takes for a memo to never hold. */
const NO_CONNECTORS: SegmentConnector[] = [];
const NO_CHILDREN: ResearchNode[] = [];

/**
 * What one node's menu renders, reduced to the seven answers that decide it.
 *
 * The rows are a prop of a memoized pane, and they are built from this rather
 * than from the node and segment objects on purpose: those are replaced by
 * every research event — up to twice a second while a run streams — while
 * these answers change perhaps twice in a whole run. Encoding them as a string
 * is what lets the memo below take one primitive dependency and still be a
 * pure function of everything it reads (09 §4).
 *
 * Everything the rows need at *click* time — the document's markdown, the
 * tree's current title, the node's highlight ids — is deliberately absent:
 * those are read from the latest-values ref when the row is pressed, so a menu
 * that was built a commit ago cannot act on a stale title.
 */
interface NodeMenuRowSpec {
  nodeId: string;
  copyThread: boolean;
  retry: boolean;
  retryDisabled: boolean;
  regenerate: boolean;
  editDocument: boolean;
  editDisabled: boolean;
  isRoot: boolean;
}

const MENU_ROW_SEPARATOR = "\u0001";

function encodeNodeMenuRow(nodeId: string, flags: readonly boolean[]): string {
  return `${nodeId}${MENU_ROW_SEPARATOR}${flags.map((flag) => (flag ? "1" : "0")).join("")}`;
}

function decodeNodeMenuRow(encoded: string): NodeMenuRowSpec | null {
  const separator = encoded.lastIndexOf(MENU_ROW_SEPARATOR);
  if (separator < 0) return null;
  const flags = encoded.slice(separator + 1);
  const at = (index: number) => flags[index] === "1";
  return {
    nodeId: encoded.slice(0, separator),
    copyThread: at(0),
    retry: at(1),
    retryDisabled: at(2),
    regenerate: at(3),
    editDocument: at(4),
    editDisabled: at(5),
    isRoot: at(6),
  };
}
/** Reserved width for the selection popover; the Expand action makes it wider. */
const POPOVER_WIDTH = 260;
const POPOVER_WIDTH_WITH_EXPAND = 340;

interface SelectionAction extends CapturedResearchSelection {
  left: number;
  top: number;
  offscreen: boolean;
}

function placementFor(range: Range, withExpand: boolean) {
  return researchSelectionActionPlacement({
    fragments: Array.from(range.getClientRects()),
    boundingRect: range.getBoundingClientRect(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    reservedWidth: withExpand ? POPOVER_WIDTH_WITH_EXPAND : POPOVER_WIDTH,
  });
}

/**
 * The route entry. `key` is what remounts the whole document on a tree switch:
 * every per-visit coordinate below (the scroll latch, the full-trace choices,
 * an open ask) belongs to one tree, and unmounting is both cheaper and safer
 * than resetting them one by one.
 */
export function ResearchPage() {
  const { treeId } = useParams({ from: "/_shell/r/$treeId" });
  return <ResearchDocument key={treeId} treeId={treeId} />;
}

function ResearchDocument({ treeId }: { treeId: string }) {
  const search = useSearch({ from: "/_shell/r/$treeId" });
  const navigate = useNavigate();
  const router = useRouter();

  const detailQuery = useTreeDetail(treeId);
  const detail = detailQuery.data;
  const me = useMe().data ?? null;
  const settings = useSettings().data;
  const runtimeConfig = useRuntimeConfig().data;

  const fork = useForkResearchNode();
  const cancelNode = useCancelResearchNode();
  const retryNode = useRetryResearchNode();
  const removeBranch = useRemoveResearchBranch();
  const removeTree = useRemoveResearchTree();
  const setFollowed = useSetTreeFollowed();
  const setBookmarked = useSetTreeBookmarked();
  const markViewed = useMarkTreeViewed();
  const updateDocument = useUpdateResearchDocument();
  const highlights = useHighlightMutations(treeId);
  const toast = useCallback((title: string) => pushToast({ title, tone: "info" }), []);
  // Retrying a completed answer discards it; the dialog stands between the
  // click and the run. Failed or cancelled nodes retry at once.
  const [confirmingRetry, setConfirmingRetry] = useState<string | null>(null);

  /* ------------------------------------------------------------------ refs */

  const scrollerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const elementsRef = useRef({
    anchor: new Map<string, HTMLElement>(),
    grid: new Map<string, HTMLElement>(),
    root: new Map<string, HTMLElement>(),
    aside: new Map<string, HTMLElement>(),
  });

  const registerElement = useCallback(
    (nodeId: string, kind: SegmentElementKind, element: HTMLElement | null) => {
      const map = elementsRef.current[kind];
      if (element) map.set(nodeId, element);
      else map.delete(nodeId);
    },
    [],
  );
  const segmentElement = useCallback(
    (nodeId: string, kind: SegmentElementKind) => elementsRef.current[kind].get(nodeId) ?? null,
    [],
  );
  const scrollToSegment = useCallback((nodeId: string, behavior: ScrollBehavior = "smooth") => {
    elementsRef.current.anchor.get(nodeId)?.scrollIntoView({ behavior, block: "start" });
  }, []);

  /* ------------------------------------------------------------- selection */

  const nodes = detail?.nodes ?? NO_NODES;
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const storedNodeId = useNavigationStore((state) => {
    const history = state.historyByTree[treeId];
    return history ? (history.entries[history.index] ?? null) : null;
  });
  const visitNode = useNavigationStore((state) => state.visitNode);
  const recordScroll = useNavigationStore((state) => state.recordScroll);
  const restoreScroll = useNavigationStore((state) => state.restoreScroll);
  const setExpanded = useNavigationStore((state) => state.setExpanded);
  const expandedByNode = useNavigationStore((state) => state.expandedByNode);
  const recapPendingNodeIds = useRecapPendingStore((state) => state.nodeIds);

  // The URL wins, the store is the fallback for a reload with no params, and
  // the root is the floor (ADR-7, 09 §4).
  const selectedNodeId =
    search.node && nodesById.has(search.node)
      ? search.node
      : storedNodeId && nodesById.has(storedNodeId)
        ? storedNodeId
        : (detail?.tree.rootNodeId ?? null);

  const chainNodeIds = useMemo(
    () => (detail && selectedNodeId ? inlineChainFor(detail.nodes, selectedNodeId) : []),
    [detail, selectedNodeId],
  );
  const chainKey = chainNodeIds.join("\n");
  const chainNodes = useMemo(
    () =>
      chainNodeIds
        .map((id) => nodesById.get(id))
        .filter((node): node is ResearchNode => node !== undefined),
    [chainNodeIds, nodesById],
  );
  const tailNode = chainNodes[chainNodes.length - 1] ?? null;
  const archived = Boolean(detail?.tree.archivedAt);

  const childrenBySegment = useMemo(() => {
    const chain = new Set(chainNodeIds);
    const map = new Map<string, ResearchNode[]>();
    for (const node of nodes) {
      if (!node.parentNodeId || !chain.has(node.parentNodeId)) continue;
      // An inline child is a segment of this page, not a card — unless a
      // corrupted store produced a second one for the same slot, which falls
      // back to a card rather than vanishing from the interface.
      if (node.inline && chain.has(node.id)) continue;
      const list = map.get(node.parentNodeId);
      if (list) list.push(node);
      else map.set(node.parentNodeId, [node]);
    }
    return map;
  }, [nodes, chainNodeIds]);

  /* -------------------------------------------------------- per-visit state */

  const [fullTraceNodes, setFullTraceNodes] = useState<Record<string, boolean>>({});
  const [segments, setSegments] = useState<Record<string, PublishedSegment>>({});
  const [ask, setAsk] = useState<{ nodeId: string; anchor: ResearchHighlightAnchor } | null>(null);
  const [mode, setMode] = useState<FollowupMode>("thread");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retryingNodeId, setRetryingNodeId] = useState<string | null>(null);
  const [action, setAction] = useState<SelectionAction | null>(null);
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [openedFollowupIds, setOpenedFollowupIds] = useState<ReadonlySet<string>>(new Set());
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const [deletingNodeId, setDeletingNodeId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [recapNodeId, setRecapNodeId] = useState<string | null>(null);
  const [editSession, setEditSession] = useState<DocumentEditSession | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const publish = useCallback((segment: PublishedSegment) => {
    setSegments((current) =>
      current[segment.nodeId] === segment ? current : { ...current, [segment.nodeId]: segment },
    );
  }, []);

  // Bound the published map to the rendered chain, matching the memory profile
  // of a single-node view.
  useEffect(() => {
    const keep = new Set(chainNodeIds);
    // Collapses to the previous identity when nothing is stale, so this cannot
    // cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSegments((current) => {
      const stale = Object.keys(current).filter((id) => !keep.has(id));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [chainKey, chainNodeIds]);

  const revisionByNode = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const id of chainNodeIds) map[id] = segments[id]?.responseRevision;
    return map;
  }, [chainNodeIds, segments]);
  const highlightsByNode = useMemo(() => {
    const map: Record<string, ResearchNode["highlights"]> = {};
    for (const id of chainNodeIds) map[id] = nodesById.get(id)?.highlights ?? [];
    return map;
  }, [chainNodeIds, nodesById]);

  // Built once per chain rather than per render: a fresh `Set` per segment per
  // render would defeat the rail's memo, and the rail re-renders every card —
  // each with a Markdown preview — when it is not memoized.
  const unreadIdsBySegment = useMemo(() => {
    const map = new Map<string, ReadonlySet<string>>();
    for (const segmentId of chainNodeIds) {
      const unread = (childrenBySegment.get(segmentId) ?? [])
        .filter((child) => child.status === "complete" && !openedFollowupIds.has(child.id))
        .map((child) => child.id);
      map.set(segmentId, unread.length === 0 ? NO_UNREAD : new Set(unread));
    }
    return map;
  }, [chainNodeIds, childrenBySegment, openedFollowupIds]);

  const anchoredEntries = useMemo<AnchoredEntry[]>(() => {
    const entries: AnchoredEntry[] = [];
    for (const segmentId of chainNodeIds) {
      for (const child of childrenBySegment.get(segmentId) ?? []) {
        if (child.queryAnchor) {
          entries.push({ segmentId, id: child.id, anchor: child.queryAnchor });
        }
      }
      if (ask?.nodeId === segmentId) {
        entries.push({ segmentId, id: ASK_ENTRY_ID, anchor: ask.anchor });
      }
    }
    return entries;
  }, [chainNodeIds, childrenBySegment, ask]);

  /* ---------------------------------------------------------------- composer */

  const draftKey = nodeDraftKey(`tree:${treeId}`);
  const setDraft = useDraftsStore((state) => state.setDraft);
  const clearDraft = useDraftsStore((state) => state.clearDraft);
  const [followup, setFollowupState] = useState(
    () => useDraftsStore.getState().byKey[draftKey]?.text ?? "",
  );
  const setFollowup = useCallback(
    (text: string) => {
      setFollowupState(text);
      if (text) setDraft(draftKey, { text, ...(selectedModel ? { model: selectedModel } : {}) });
      else clearDraft(draftKey);
    },
    [clearDraft, draftKey, selectedModel, setDraft],
  );

  const usableModels = useMemo(
    () =>
      launchableModels(
        (runtimeConfig?.models ?? []).filter((model) => !model.adminOnly || me?.isAdmin),
      ),
    [runtimeConfig, me],
  );

  const lastCompleteChainNode =
    [...chainNodes].reverse().find((node) => node.status === "complete") ?? null;
  const composerTarget = ask
    ? (nodesById.get(ask.nodeId) ?? null)
    : mode === "branch"
      ? lastCompleteChainNode
      : tailNode;
  const composerModel =
    selectedModel ?? composerTarget?.model ?? settings?.defaultModel ?? usableModels[0]?.id ?? "";
  const composerDisabled = archived || !composerTarget || composerTarget.status !== "complete";
  const canSubmit = Boolean(
    composerTarget &&
    !archived &&
    followup.trim() &&
    !submitting &&
    canFollowUpFrom(composerTarget) &&
    (ask || mode === "branch" || canContinueThread(nodes, composerTarget)),
  );
  const tailActive = Boolean(tailNode && isActiveResearchStatus(tailNode.status));
  const tailUnusable = Boolean(tailNode && canRetryResearchNode(tailNode));
  const canRetryTail = Boolean(
    tailNode && tailNode.inline && tailNode.parentNodeId && !archived && tailUnusable,
  );
  const composerHint = archived
    ? "This thread is archived."
    : !ask && mode === "thread" && tailUnusable
      ? `The last follow-up ${
          tailNode?.status === "failed"
            ? "failed"
            : tailNode?.status === "interrupted"
              ? "was interrupted"
              : "was cancelled"
        } — ${
          canRetryTail
            ? "retry it, delete it, or branch instead."
            : "delete it to continue the thread, or branch instead."
        }`
      : !ask && mode === "branch" && composerTarget && composerTarget.id !== tailNode?.id
        ? "Branches from the last completed answer in this thread."
        : null;
  const submitLabel = submitting
    ? "Sending…"
    : !ask && mode === "thread" && tailActive
      ? "Waiting…"
      : !ask && mode === "branch"
        ? "New branch"
        : "Send";
  const placeholder = ask
    ? "Ask about the highlighted text…"
    : mode === "branch"
      ? "Start a new branch from the answer above…"
      : (composerTarget?.kind ?? "run") === "document"
        ? "Ask about this document…"
        : chainNodes.length > 1
          ? "Continue this thread…"
          : "Ask a follow-up…";

  /* ------------------------------------------------------------- annotations */

  const expandedKey = chainNodeIds.map((id) => (expandedByNode[id] ? "1" : "0")).join("");
  const fullTraceKey = chainNodeIds.map((id) => (fullTraceNodes[id] ? "1" : "0")).join("");
  const viewKey = `${chainKey}|${expandedKey}|${fullTraceKey}`;

  const annotations = useResearchAnnotations({
    chainNodeIds,
    highlightsByNode,
    revisionByNode,
    anchoredEntries,
    segmentElement,
    contentContainerRef: contentRef,
    composerRef,
    viewKey,
    askText: followup,
    selectedHighlightIds: action?.highlightIds ?? [],
    selectedHighlightNodeId: action?.nodeId ?? null,
  });

  const onCapture = useCallback((captured: CapturedResearchSelection | null) => {
    const selection = window.getSelection();
    if (!captured || !selection || selection.rangeCount === 0) {
      setAction(null);
      return;
    }
    setAction({
      ...captured,
      ...placementFor(selection.getRangeAt(0), captured.expandAnchor !== null),
    });
  }, []);

  const drag = useResearchSelectionDrag({
    revisionByNode,
    resolvedHighlights: annotations.resolvedHighlights,
    annotationAtPoint: annotations.annotationAtPoint,
    onCapture,
  });

  // The popover follows the selection through scroll and resize rather than
  // dismissing: the selection stays valid while the page moves under it. It is
  // dropped only when the selection itself goes away.
  useEffect(() => {
    if (!action) return;
    const withExpand = action.expandAnchor !== null;
    let frame: number | null = null;
    const reposition = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setAction(null);
          return;
        }
        const placement = placementFor(selection.getRangeAt(0), withExpand);
        setAction((current) =>
          !current ||
          (current.left === placement.left &&
            current.top === placement.top &&
            current.offscreen === placement.offscreen)
            ? current
            : { ...current, ...placement },
        );
      });
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [action]);

  // A changed revision, a page change or a transcript toggle moves every offset
  // the popover cached, so it is dropped rather than left pointing at content
  // that has shifted (09 §4).
  const revisionsKey = chainNodeIds.map((id) => revisionByNode[id] ?? "").join("\n");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAction(null);
    window.getSelection()?.removeAllRanges();
  }, [chainKey, revisionsKey, viewKey]);

  // The ask holds no cached geometry — it re-resolves its passage against
  // whatever is on screen — so only a page or revision change invalidates it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAsk(null);
  }, [chainKey, revisionsKey]);

  /* -------------------------------------------------------------- highlights */

  const runHighlightAction = useCallback(
    (work: () => Promise<void>) => {
      if (savingHighlight) return;
      setSavingHighlight(true);
      work()
        .then(() => {
          window.getSelection()?.removeAllRanges();
          setAction(null);
        })
        .catch((error: unknown) => pushErrorToast("The highlight could not be saved", error))
        .finally(() => setSavingHighlight(false));
    },
    [savingHighlight, toast],
  );

  const applyHighlight = useCallback(() => {
    if (!action) return;
    const { nodeId, highlightIds, anchor } = action;
    runHighlightAction(() =>
      highlightIds.length > 0
        ? highlights.remove(nodeId, highlightIds)
        : highlights.create(nodeId, anchor),
    );
  }, [action, highlights, runHighlightAction]);

  const applyExpand = useCallback(() => {
    if (!action?.expandAnchor) return;
    const { nodeId, highlightIds, expandAnchor } = action;
    runHighlightAction(() => highlights.expand(nodeId, expandAnchor, highlightIds));
  }, [action, highlights, runHighlightAction]);

  const enterAskMode = useCallback(() => {
    if (!action?.anchor.exact.trim() || archived) return;
    if (nodesById.get(action.nodeId)?.status !== "complete") return;
    setAsk({ nodeId: action.nodeId, anchor: action.anchor });
    setFollowup("");
    setAction(null);
    window.getSelection()?.removeAllRanges();
    // Focus once the composer has mounted beside the passage. `preventScroll`
    // matters: the passage is already in view, and a scrolling focus would jump
    // the page away from what the reader just selected.
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, [action, archived, nodesById, setFollowup]);

  const canAsk = Boolean(
    action?.anchor.exact.trim() &&
    !archived &&
    nodesById.get(action?.nodeId ?? "")?.status === "complete",
  );

  /* -------------------------------------------------------------- navigation */

  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Scroll offsets are only meaningful once every chain node has content or a
  // terminal error: while one segment is still a short placeholder the page is
  // not at its real height, and the browser's clamp would overwrite the saved
  // offset with the clamped value.
  const chainSettled =
    chainNodeIds.length > 0 && chainNodeIds.every((id) => segments[id]?.settled === true);
  // The callbacks below run outside render (a scroll handler, an unmount
  // flush), so they read the latest value through a ref rather than closing
  // over a stale one.
  const settledRef = useRef(chainSettled);
  useEffect(() => {
    settledRef.current = chainSettled;
  }, [chainSettled]);
  const restoredRef = useRef<string | null>(null);
  const pendingScrollNodeIdRef = useRef<string | null>(null);
  // Which focus request has already been honored. Clearing the param is a
  // navigation, so it lands a render or two later; without the latch the pass
  // runs again in between and scrolls a second time.
  const focusedHighlightRef = useRef<string | null>(null);

  // `useMutation` builds a fresh result object on every render, so a callback
  // that depends on one is a callback with a new identity on every render — and
  // every such callback handed to a memoized segment defeats its memo. The
  // entry points themselves are bound once per observer, so they are what the
  // callbacks below depend on.
  const forkMutate = fork.mutateAsync;
  const cancelMutate = cancelNode.mutateAsync;
  const retryMutate = retryNode.mutateAsync;
  const removeBranchMutate = removeBranch.mutateAsync;
  const removeTreeMutate = removeTree.mutateAsync;
  const setFollowedMutate = setFollowed.mutate;
  const setBookmarkedMutate = setBookmarked.mutate;

  // What a click acts on is what is on screen when it happens, not what was on
  // screen when its callback was created. Reading these through a ref is what
  // lets every handler below be created once: the alternative is a new closure
  // per streamed delta, which is the same memo break by another route (09 §4).
  const latestRef = useRef({ detail, segments, chainNodes, nodesById });
  useEffect(() => {
    latestRef.current = { detail, segments, chainNodes, nodesById };
  });

  const recordScrollNow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !selectedNodeId || !settledRef.current) return;
    recordScroll(selectedNodeId, scroller.scrollTop);
  }, [recordScroll, selectedNodeId]);

  const beginPageVisit = useCallback(() => {
    restoredRef.current = null;
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, []);

  const applySelection = useCallback(
    (nodeId: string) => {
      recordScrollNow();
      const sameChain = chainNodeIds.includes(nodeId);
      if (!sameChain) {
        // A page swap: the per-visit trace choice and the composer mode belong
        // to the answer they were made for, not to whatever tail comes next.
        setFullTraceNodes({});
        setMode("thread");
        setSelectedModel(null);
        beginPageVisit();
      }
      void navigate({
        to: "/r/$treeId",
        params: { treeId },
        search: (previous) => ({ ...previous, node: nodeId, highlight: undefined }),
      });
      if (sameChain) requestAnimationFrame(() => scrollToSegment(nodeId));
    },
    [beginPageVisit, chainNodeIds, navigate, recordScrollNow, scrollToSegment, treeId],
  );

  const selectNode = useCallback(
    (nodeId: string) => {
      setOpenedFollowupIds((current) =>
        current.has(nodeId) ? current : new Set(current).add(nodeId),
      );
      if (nodeId === selectedNodeId) return;
      applySelection(nodeId);
      visitNode(treeId, nodeId);
    },
    [applySelection, selectedNodeId, treeId, visitNode],
  );

  // Seed the per-tree stack on the first visit, so Back has somewhere to return
  // from once the reader opens a branch.
  useEffect(() => {
    if (!selectedNodeId) return;
    const history = useNavigationStore.getState().historyByTree[treeId];
    if (!history || history.entries.length === 0) visitNode(treeId, selectedNodeId);
  }, [selectedNodeId, treeId, visitNode]);

  const goBack = useCallback(() => {
    const nodeId = useNavigationStore.getState().goBack(treeId);
    if (nodeId) applySelection(nodeId);
    else router.history.back();
  }, [applySelection, router, treeId]);
  const goForward = useCallback(() => {
    const nodeId = useNavigationStore.getState().goForward(treeId);
    if (nodeId) applySelection(nodeId);
    else router.history.forward();
  }, [applySelection, router, treeId]);

  // Cmd-[ / Cmd-] and Alt-arrows mirror the header pair; the dedicated mouse
  // back/forward buttons do too. All are ignored while typing, so the composer
  // keeps word-wise motion.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableEventTarget(event.target)) return;
      const primary = event.metaKey || event.ctrlKey;
      const plain = !event.altKey && !event.shiftKey;
      const altOnly = event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
      const handler =
        primary && plain && event.code === "BracketLeft"
          ? goBack
          : primary && plain && event.code === "BracketRight"
            ? goForward
            : altOnly && event.key === "ArrowLeft"
              ? goBack
              : altOnly && event.key === "ArrowRight"
                ? goForward
                : null;
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        goBack();
      } else if (event.button === 4) {
        event.preventDefault();
        goForward();
      }
    };
    const scroller = scrollerRef.current;
    window.addEventListener("keydown", onKeyDown);
    scroller?.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      scroller?.removeEventListener("mouseup", onMouseUp);
    };
  }, [goBack, goForward]);

  // Cmd-J, re-dispatched by the shell (07 §5): bring the composer into view and
  // hand it the caret. The scroll happens even when the field is disabled, so
  // the chord always lands on the follow-ups area.
  useEffect(() => {
    const onShortcut = (event: Event) => {
      const command = (event as CustomEvent<{ type?: string }>).detail;
      if (command?.type !== "focusFollowups") return;
      const textarea = textareaRef.current;
      if (textarea && !textarea.disabled) textarea.focus({ preventScroll: true });
      composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener("session:shortcut", onShortcut);
    return () => window.removeEventListener("session:shortcut", onShortcut);
  }, []);

  // Escape leaves ask mode from anywhere, including from inside the field.
  useEffect(() => {
    if (!ask) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setAsk(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ask]);

  /* ------------------------------------------------------- scroll restoration */

  // Restore once per visit, and only once the WHOLE chain has settled: restoring
  // against a partially loaded page clamps the offset, and the clamp would then
  // be recorded over the saved one.
  useLayoutEffect(() => {
    if (!selectedNodeId || !chainSettled || !scrollerRef.current) return;
    if (restoredRef.current !== null) return;
    restoredRef.current = `${treeId}:${chainKey}`;
    const saved = restoreScroll(selectedNodeId) ?? 0;
    if (saved === 0 && chainNodeIds[0] !== selectedNodeId) {
      // When an intermediate segment has no saved scroll position, scroll to
      // that answer instead of defaulting to the root.
      scrollToSegment(selectedNodeId, "auto");
      return;
    }
    scrollerRef.current.scrollTop = saved;
  }, [
    chainSettled,
    chainKey,
    chainNodeIds,
    restoreScroll,
    scrollToSegment,
    selectedNodeId,
    treeId,
  ]);

  const onScroll = useCallback(() => {
    // Do not record scroll position during loading or before restoration;
    // either value would overwrite the saved offset.
    if (!settledRef.current || restoredRef.current === null) return;
    if (scrollTimerRef.current !== null) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      recordScrollNow();
    }, SCROLL_RECORD_DEBOUNCE_MS);
  }, [recordScrollNow]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current !== null) clearTimeout(scrollTimerRef.current);
      recordScrollNow();
    },
    [recordScrollNow],
  );

  // Bring a just-submitted inline follow-up into view once the refreshed detail
  // delivers it into the chain.
  useEffect(() => {
    const target = pendingScrollNodeIdRef.current;
    if (!target || !chainNodeIds.includes(target)) return;
    pendingScrollNodeIdRef.current = null;
    requestAnimationFrame(() => scrollToSegment(target));
  }, [chainKey, chainNodeIds, scrollToSegment]);

  // `?highlight=` from the Highlights feed: once the visit has restored and the
  // passage has painted, put it a third of the way down the viewport and clear
  // the param. A highlight that no longer resolves clears it too, leaving the
  // segment itself in view.
  const focusHighlightId = search.highlight;
  const paintVersion = annotations.paintVersion;
  const resolvedHighlights = annotations.resolvedHighlights;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!focusHighlightId || restoredRef.current === null || !scroller) return;
    if (focusedHighlightRef.current === focusHighlightId) return;
    const clear = () => {
      focusedHighlightRef.current = focusHighlightId;
      void navigate({
        to: "/r/$treeId",
        params: { treeId },
        replace: true,
        search: (previous) => ({ ...previous, highlight: undefined }),
      });
    };
    const owner = chainNodeIds.find((id) =>
      resolvedHighlights(id).some((entry) => entry.id === focusHighlightId),
    );
    if (!owner) {
      // Keep waiting while the chain is still settling; give up once it has.
      if (chainSettled) clear();
      return;
    }
    const root = segmentElement(owner, "root");
    const resolved = resolvedHighlights(owner).find((entry) => entry.id === focusHighlightId);
    if (root && resolved) {
      const range = rangeForTextOffsets(root, resolved.start, resolved.end);
      const rect = range?.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (rect) {
        scroller.scrollTop += rect.top - scrollerRect.top - Math.max(72, scrollerRect.height / 3);
      }
    }
    clear();
  }, [
    chainNodeIds,
    chainSettled,
    focusHighlightId,
    navigate,
    paintVersion,
    resolvedHighlights,
    segmentElement,
    treeId,
  ]);

  /* ----------------------------------------------------------------- actions */

  const submit = useCallback(
    (modeOverride?: FollowupMode) => {
      const prompt = followup.trim();
      if (!prompt || submitting || archived || !detail) return;
      const submissionMode = modeOverride ?? mode;
      const target = ask
        ? (nodesById.get(ask.nodeId) ?? null)
        : submissionMode === "branch"
          ? lastCompleteChainNode
          : tailNode;
      // The same predicates the button's disabled state came from: Cmd-Enter
      // must not reach the server from a state the composer presents as
      // unavailable.
      if (!target || !canFollowUpFrom(target)) return;
      const inline = !ask && submissionMode === "thread";
      if (inline && !canContinueThread(nodes, target)) return;
      setSubmitting(true);
      forkMutate({
        parentNodeId: target.id,
        prompt,
        model: composerModel,
        queryAnchor: ask?.anchor ?? null,
        inline,
      })
        .then((child) => {
          setFollowup("");
          setAsk(null);
          // Preserve the current scroll position until refreshed detail includes
          // the new segment.
          if (inline) pendingScrollNodeIdRef.current = child.id;
        })
        .catch((error: unknown) => pushErrorToast("The follow-up could not be sent", error))
        .finally(() => setSubmitting(false));
    },
    [
      archived,
      ask,
      composerModel,
      detail,
      followup,
      forkMutate,
      lastCompleteChainNode,
      mode,
      nodes,
      nodesById,
      setFollowup,
      submitting,
      tailNode,
      toast,
    ],
  );

  const handleCancel = useCallback(
    (nodeId: string) => {
      setCancelling(true);
      cancelMutate(nodeId)
        .catch((error: unknown) => pushErrorToast("The run could not be cancelled", error))
        .finally(() => setCancelling(false));
    },
    [cancelMutate, toast],
  );

  const handleRetry = useCallback(
    (nodeId: string) => {
      // The clicked control disables itself, but a second control for the same
      // node (the composer's Retry beside the menu's) fires before that lands.
      // This identity changes when a retry starts or settles, which is also
      // when the menu rows' own `retryDisabled` flips — one re-render, not one
      // per delta.
      if (retryingNodeId !== null) return;
      setRetryingNodeId(nodeId);
      retryMutate({ nodeId })
        .catch((error: unknown) => pushErrorToast("The answer could not be retried", error))
        .finally(() => setRetryingNodeId((current) => (current === nodeId ? null : current)));
    },
    [retryMutate, retryingNodeId],
  );
  const requestRetry = useCallback(
    (nodeId: string) => {
      if (nodesById.get(nodeId)?.status === "complete") setConfirmingRetry(nodeId);
      else handleRetry(nodeId);
    },
    [handleRetry, nodesById],
  );

  const copyAnswer = useCallback(
    (nodeId: string) => {
      const text = latestRef.current.segments[nodeId]?.rawAnswer ?? "";
      if (!text) return;
      writeClipboardText(text)
        .then(() => toast("Answer copied to clipboard"))
        .catch((error: unknown) => pushErrorToast("The answer could not be copied", error));
    },
    [toast],
  );

  const copyThread = useCallback(() => {
    const { chainNodes, segments } = latestRef.current;
    const parts: string[] = [];
    for (const node of chainNodes) {
      const body = (segments[node.id]?.rawAnswer ?? "").trim();
      const prompt = (node.kind ?? "run") === "document" ? null : node.prompt.trim() || null;
      if (!prompt && !body) continue;
      parts.push(
        [prompt ? `**Question:** ${prompt}` : null, body || "_No response available._"]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    if (parts.length === 0) return;
    writeClipboardText(parts.join("\n\n---\n\n"))
      .then(() => toast("Thread copied to clipboard"))
      .catch((error: unknown) => pushErrorToast("The thread could not be copied", error));
  }, [toast]);

  const confirmDelete = useCallback(() => {
    if (!deletingNodeId || !detail) return;
    setDeleteError(null);
    const failed = (error: unknown) =>
      setDeleteError(error instanceof Error ? error.message : String(error));
    if (deletingNodeId === detail.tree.rootNodeId) {
      removeTreeMutate(detail.tree.id)
        .then(() => {
          setDeletingNodeId(null);
          void navigate({ to: "/" });
        })
        .catch(failed);
      return;
    }
    removeBranchMutate(deletingNodeId)
      .then((removal) => {
        setDeletingNodeId(null);
        applySelection(removal.parentNodeId);
      })
      .catch(failed);
  }, [applySelection, deletingNodeId, detail, navigate, removeBranchMutate, removeTreeMutate]);

  /* --------------------------------------------------------------- lifecycle */

  // Clear unread status on arrival and whenever a run completes while the
  // thread is open.
  const completedCount = nodes.filter((node) => node.status === "complete").length;
  const detailLoaded = detail !== undefined;
  const viewedMutate = markViewed.mutate;
  useEffect(() => {
    if (!detailLoaded) return;
    viewedMutate(treeId);
  }, [detailLoaded, completedCount, treeId, viewedMutate]);

  const anyActive = chainNodes.some((node) => isActiveResearchStatus(node.status));
  useEffect(() => {
    // Update elapsed run durations periodically; entering a segment restarts its
    // timer from the current time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    if (!anyActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [anyActive, chainKey]);

  /* ------------------------------------------------------------------ render */

  // The detail object is replaced by every research event, so the toggles read
  // the flag they invert at click time rather than closing over it.
  const handleToggleFollow = useCallback(() => {
    const tree = latestRef.current.detail?.tree;
    if (tree) setFollowedMutate({ treeId, value: !tree.followed });
  }, [setFollowedMutate, treeId]);
  const handleToggleBookmark = useCallback(() => {
    const tree = latestRef.current.detail?.tree;
    if (tree) setBookmarkedMutate({ treeId, value: !tree.bookmarked });
  }, [setBookmarkedMutate, treeId]);
  const handleExpandTurns = useCallback(
    (nodeId: string) => setExpanded(nodeId, true),
    [setExpanded],
  );
  const handleShowFullTrace = useCallback(
    (nodeId: string) => setFullTraceNodes((current) => ({ ...current, [nodeId]: true })),
    [],
  );
  const setLinkedAnchorId = annotations.setLinkedAnchorId;
  const handleCardHover = useCallback(
    (childId: string, entering: boolean) => setLinkedAnchorId(entering ? childId : null),
    [setLinkedAnchorId],
  );

  /* ------------------------------------------------------------- node menu */

  const openEditSession = useCallback((nodeId: string) => {
    // Read at click time: the markdown, the revision the edit is stamped
    // against and the title the server checks are all values that may have
    // moved since these rows were built.
    const { detail, segments, nodesById } = latestRef.current;
    const segment = segments[nodeId];
    const node = nodesById.get(nodeId);
    if (!detail || !node || !segment?.responseRevision) return;
    if (segment.editableDocumentMarkdown === null) return;
    setEditSession({
      nodeId,
      markdown: segment.editableDocumentMarkdown,
      title: detail.tree.title,
      responseRevision: segment.responseRevision,
      highlightIds: node.highlights.map((highlight) => highlight.id),
    });
  }, []);

  const renderNodeMenu = useCallback(
    (spec: NodeMenuRowSpec, asContextMenu: boolean): ReactNode => {
      const Item = asContextMenu ? ContextMenuItem : MenuItem;
      const Separator = asContextMenu ? ContextMenuSeparator : MenuSeparator;
      return (
        <>
          {spec.copyThread ? <Item onClick={copyThread}>Copy thread as Markdown</Item> : null}
          {spec.retry ? (
            <Item disabled={spec.retryDisabled} onClick={() => requestRetry(spec.nodeId)}>
              Retry run
            </Item>
          ) : null}
          {spec.regenerate ? (
            <Item onClick={() => setRecapNodeId(spec.nodeId)}>Summary…</Item>
          ) : null}
          {spec.editDocument ? (
            <Item disabled={spec.editDisabled} onClick={() => openEditSession(spec.nodeId)}>
              Edit document
            </Item>
          ) : null}
          <Separator />
          <Item tone="danger" onClick={() => setDeletingNodeId(spec.nodeId)}>
            {spec.isRoot ? "Delete thread" : "Delete"}
          </Item>
        </>
      );
    },
    [copyThread, requestRetry, openEditSession],
  );

  // One node's rows, as the string the memo below is keyed on. Encoding is the
  // whole point: this is the only thing the rows are built from, so a delta
  // that leaves all seven answers alone leaves the rows' identity alone too.
  const encodeNodeMenu = useCallback(
    (nodeId: string): string | null => {
      const node = nodesById.get(nodeId);
      if (!node) return null;
      const segment = segments[nodeId];
      const hasRevision = Boolean(segment?.responseRevision);
      const isRoot = nodeId === detail?.tree.rootNodeId;
      return encodeNodeMenuRow(nodeId, [
        chainNodeIds.includes(nodeId) && chainNodes.length > 1,
        !archived && canRetryResearchNode(node),
        retryingNodeId !== null,
        !archived && hasRevision,
        isRoot && (node.kind ?? "run") === "document",
        archived || !hasRevision || segment?.editableDocumentMarkdown == null,
        isRoot,
      ]);
    },
    [archived, chainNodeIds, chainNodes.length, detail, nodesById, retryingNodeId, segments],
  );

  const answerMenuSignature = chainNodeIds
    .map((nodeId) => encodeNodeMenu(nodeId) ?? "")
    .filter((row) => row !== "")
    .join("\n");

  // Answer pane menu rows depend only on the signature and stable renderer, so
  // a memoized pane retains its menu across streamed deltas (`09` §4).
  const answerMenuByNode = useMemo(() => {
    const map = new Map<string, ReactNode>();
    for (const row of answerMenuSignature.split("\n")) {
      const spec = decodeNodeMenuRow(row);
      if (spec) map.set(spec.nodeId, renderNodeMenu(spec, false));
    }
    return map;
  }, [answerMenuSignature, renderNodeMenu]);

  if (!detail || !selectedNodeId) {
    return (
      <div className="research-reading-surface flex h-full items-center justify-center">
        {detailQuery.isError ? (
          <p className="text-fg-muted text-sm" role="alert">
            This research could not be loaded.
          </p>
        ) : (
          <LoaderCircle className="session-spin text-fg-muted" size={24} aria-hidden="true" />
        )}
      </div>
    );
  }

  const selectedNode = nodesById.get(selectedNodeId) ?? null;
  const selectedSegment = segments[selectedNodeId];
  const branchCount = chainNodeIds.reduce(
    (total, id) => total + (childrenBySegment.get(id)?.length ?? 0),
    0,
  );

  // The right-click menu can address a branch card, which is not on this page's
  // chain, so it builds its rows on demand rather than reading the map above.
  // Nothing memoized takes them as a prop, so there is nothing to keep stable.
  const contextMenuRows = (nodeId: string): ReactNode => {
    const encoded = encodeNodeMenu(nodeId);
    const spec = encoded === null ? null : decodeNodeMenuRow(encoded);
    return spec ? renderNodeMenu(spec, true) : null;
  };

  const composer = (docked: boolean) => (
    <FollowupComposer
      docked={docked}
      quote={ask?.anchor.exact}
      dockedTop={docked ? annotations.askComposerTop : null}
      onDismissAsk={() => setAsk(null)}
      value={followup}
      onChange={setFollowup}
      mode={mode}
      onModeChange={setMode}
      model={composerModel}
      onModelChange={setSelectedModel}
      models={usableModels}
      placeholder={placeholder}
      submitLabel={submitLabel}
      disabled={composerDisabled}
      canSubmit={canSubmit}
      submitting={submitting}
      hint={composerHint}
      retry={
        !docked && canRetryTail && tailNode
          ? { busy: retryingNodeId === tailNode.id, onRetry: () => requestRetry(tailNode.id) }
          : null
      }
      textareaRef={textareaRef}
      composerRef={composerRef}
      onSubmit={submit}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* The header names the thread and counts its turns; both change as
          segments land, so it waits for the chain to settle rather than
          repainting on each arrival. */}
      {chainSettled ? (
        <DocumentHeader
          detail={detail}
          selectedNodeId={selectedNodeId}
          threadLength={chainNodes.length}
          branchCount={branchCount}
          onSelectNode={selectNode}
          fullTrace={
            selectedSegment && selectedSegment.turns.length > 0
              ? {
                  active: Boolean(fullTraceNodes[selectedNodeId]),
                  onToggle: () =>
                    setFullTraceNodes((current) => ({
                      ...current,
                      [selectedNodeId]: !current[selectedNodeId],
                    })),
                }
              : null
          }
          cancel={
            selectedNode && isActiveResearchStatus(selectedNode.status)
              ? { busy: cancelling, onCancel: () => handleCancel(selectedNode.id) }
              : null
          }
        />
      ) : null}
      <DomSearchBar
        active
        placeholder="Find in research"
        rootRef={contentRef}
        viewportRef={scrollerRef}
        resetKey={treeId}
      />
      <article
        ref={scrollerRef}
        className="research-reading-surface relative min-h-0 flex-1 overflow-x-clip overflow-y-auto px-8 py-8 max-[900px]:px-7"
        aria-busy={!chainSettled}
        onScroll={onScroll}
      >
        {!chainSettled ? (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            role="status"
            aria-label="Loading research"
          >
            <LoaderCircle className="session-spin text-fg-muted" size={24} aria-hidden="true" />
          </div>
        ) : null}
        <div
          ref={contentRef}
          className={cn("research-document-frame min-w-0", !chainSettled && "invisible")}
          aria-hidden={!chainSettled}
        >
          {chainNodes.map((node, index) => {
            const previous = chainNodes[index - 1];
            const linked = annotations.linkedAnchorId;
            return (
              <ContextMenu
                key={node.id}
                label="Research actions"
                items={contextMenuRows(menuNodeId ?? node.id)}
              >
                <div
                  onContextMenuCapture={(event) => {
                    const card =
                      event.target instanceof Element
                        ? event.target.closest<HTMLElement>("[data-research-card-node-id]")
                        : null;
                    setMenuNodeId(card?.dataset["researchCardNodeId"] ?? node.id);
                  }}
                >
                  <ThreadSegment
                    node={node}
                    index={index}
                    treeId={treeId}
                    workspaceId={detail.tree.workspaceId}
                    isSelected={node.id === selectedNodeId}
                    replyToAnswer={
                      previous
                        ? (segments[previous.id]?.rawAnswer.trim() ??
                          previous.responsePreview?.trim() ??
                          null)
                        : null
                    }
                    followed={Boolean(detail.tree.followed)}
                    bookmarked={Boolean(detail.tree.bookmarked)}
                    showAllTurns={Boolean(expandedByNode[node.id])}
                    showFullTrace={Boolean(fullTraceNodes[node.id])}
                    durationText={durationLabel(node, now)}
                    hiddenHighlightCount={annotations.hiddenHighlightsByNode[node.id] ?? 0}
                    recapPending={recapPendingNodeIds.has(node.id)}
                    pointerOverHighlight={annotations.pointerHighlightNodeId === node.id}
                    linkedAnchorId={
                      linked &&
                      (childrenBySegment.get(node.id) ?? []).some((child) => child.id === linked)
                        ? linked
                        : null
                    }
                    connectors={annotations.connectorsBySegment.get(node.id) ?? NO_CONNECTORS}
                    segmentChildren={childrenBySegment.get(node.id) ?? NO_CHILDREN}
                    unreadIds={unreadIdsBySegment.get(node.id) ?? NO_UNREAD}
                    anchoredCardTops={annotations.anchoredCardTops}
                    resolvedCardTops={annotations.resolvedCardTops}
                    showRunControls={
                      isActiveResearchStatus(node.status) && node.id !== selectedNodeId
                    }
                    cancelling={cancelling}
                    canRetryNode={!archived && canRetryResearchNode(node)}
                    retryingNode={retryingNodeId === node.id}
                    askComposer={ask?.nodeId === node.id ? composer(true) : null}
                    answerMenuItems={answerMenuByNode.get(node.id) ?? null}
                    registerElement={registerElement}
                    publish={publish}
                    onToggleFollow={handleToggleFollow}
                    onToggleBookmark={handleToggleBookmark}
                    actionsBusy={setFollowed.isPending || setBookmarked.isPending}
                    onSelectNode={selectNode}
                    onExpandTurns={handleExpandTurns}
                    onShowFullTrace={handleShowFullTrace}
                    onCopyAnswer={copyAnswer}
                    onCancelNode={handleCancel}
                    onRetryNode={requestRetry}
                    onCardHover={handleCardHover}
                    onRootMouseDown={drag.onRootMouseDown}
                    onRootMouseUp={drag.onRootMouseUp}
                    onRootKeyUp={drag.onRootKeyUp}
                    onRootClick={drag.onRootClick}
                    onRootMouseMove={annotations.onPointerMove}
                    onRootMouseLeave={annotations.onPointerLeave}
                  />
                </div>
              </ContextMenu>
            );
          })}
          {ask ? null : (
            <div className={cn(RESEARCH_COLUMNS_CLASS, "mt-8")}>
              <div className="min-w-0">{composer(false)}</div>
              <div aria-hidden="true" />
            </div>
          )}
        </div>
      </article>

      {action ? (
        <SelectionPopover
          left={action.left}
          top={action.top}
          offscreen={action.offscreen}
          removeCount={action.highlightIds.length}
          canExpand={action.expandAnchor !== null}
          canAsk={canAsk}
          saving={savingHighlight}
          onHighlight={applyHighlight}
          onExpand={applyExpand}
          onAsk={enterAskMode}
          onDismiss={() => setAction(null)}
        />
      ) : null}

      {deletingNodeId ? (
        <DeleteBranchDialog
          detail={detail}
          nodeId={deletingNodeId}
          busy={removeBranch.isPending || removeTree.isPending}
          error={deleteError}
          onCancel={() => setDeletingNodeId(null)}
          onConfirm={confirmDelete}
        />
      ) : null}

      {recapNodeId && segments[recapNodeId]?.content ? (
        <RecapDialog
          open
          content={segments[recapNodeId].content}
          onClose={() => setRecapNodeId(null)}
          onApplied={() => toast("Summary updated")}
        />
      ) : null}

      {editSession ? (
        <DocumentEditor
          session={editSession}
          onClose={() => setEditSession(null)}
          onSubmit={async ({ markdown, title }) => {
            const result = await updateDocument.mutateAsync({
              nodeId: editSession.nodeId,
              markdown,
              title,
              expectedTitle: editSession.title,
              expectedResponseRevision: editSession.responseRevision,
              expectedHighlightIds: editSession.highlightIds,
            });
            toast(
              result.removedHighlightCount > 0
                ? `Document updated · ${result.removedHighlightCount} highlight${
                    result.removedHighlightCount === 1 ? "" : "s"
                  } removed`
                : "Document updated",
            );
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmingRetry !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmingRetry(null);
        }}
        title="Retry this answer?"
        description="The current answer and its summary are replaced by a new run."
        confirmLabel="Retry answer"
        onConfirm={() => {
          const nodeId = confirmingRetry;
          setConfirmingRetry(null);
          if (nodeId) handleRetry(nodeId);
        }}
      />
    </div>
  );
}
