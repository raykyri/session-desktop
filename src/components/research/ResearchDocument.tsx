import {
  useResearchComposerDrafts,
  useResearchDocumentNavigation,
} from "../../hooks/useResearchDocumentNavigation";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Copy,
  CornerDownRight,
  Files,
  Highlighter,
  LoaderCircle,
  Pencil,
  RefreshCw,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
import { ResearchBranchIcon } from "./ResearchIcons";
import { IS_MAC, isEditableTarget } from "../../lib/appHelpers";
import {
  createResearchHighlight,
  getResearchNodeContent,
  removeResearchHighlights,
  renameResearchNode,
  setResearchNodePromoted,
} from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import ResearchNoteDocument from "./ResearchNoteDocument";
import { ResearchTreeMenuItems, type ResearchTreeMenuProps } from "./ResearchMoveMenu";
import type { NoteActions } from "./ResearchNote";
import {
  EMPTY_RESEARCH_HISTORY,
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
  initResearchHistory,
  pushResearchHistory,
  pruneResearchHistory,
  researchHistoryAfterRemoval,
  researchHistoryBack,
  researchHistoryForward,
} from "../../lib/researchHistory";
import { useResearchSwipeNavigation } from "../../hooks/useResearchSwipeNavigation";
import { researchBranchInfo } from "../../lib/researchBranches";
import {
  listenToResearchFollowupsFocus,
  listenToResearchNodeOpen,
} from "../../lib/researchShortcuts";
import {
  researchBranchesByParent,
  researchBranchesInReadingOrder,
  researchDocumentHasColumn,
  researchEditedQuestionFork,
  researchLevelPath,
  researchPairLabel,
  researchQueueAction,
  researchQueueStep,
  researchSurvivingAncestor,
} from "../../lib/researchBranchView";
import {
  canContinueThread,
  canFollowUpFrom,
  canRetryResearchNode,
  inlineChainFor,
  isActiveResearchStatus,
} from "../../lib/researchThreads";
import { countResearchDocumentWords } from "../../lib/researchDocuments";
import {
  expandedResearchHighlightOffsets,
  RESEARCH_HIGHLIGHT_CONTEXT_LENGTH,
  intersectingResearchHighlightIds,
  isResearchAskActionShortcut,
  isResearchExpandActionShortcut,
  isResearchHighlightActionShortcut,
  overlappingResearchHighlightRegions,
  researchAnchorContextBounds,
  resolveResearchHighlightOffset,
} from "../../lib/researchHighlights";
import {
  pruneResearchNavigationNodes,
  restoreResearchScrollPosition,
  type QueuedResearchFollowup,
} from "../../lib/researchNavigation";
import {
  clipResearchSelectionToParagraph,
  createResearchSelectionSnapper,
  isLiveResearchSelection,
  researchSelectionActionPlacement,
  type ResearchSelectionSnapper,
} from "../../lib/researchSelection";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import { formatElapsedClock, formatRunDuration, shortWhen } from "../../lib/shortTime";
import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  formatPlainTextTranscript,
  timelineItemsAfterLastToolCall,
  timelineItemsContainTranscriptActivity,
} from "../../lib/turnTimeline";
import type {
  ResearchBranchRemoval,
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
  UpdateResearchDocumentResult,
} from "../../types";
import DomSearchBar from "../DomSearchBar";
import ResearchRecapDialog from "./ResearchRecapDialog";
import { TranscriptLinkActionsProvider, type LinkActions } from "../TranscriptMarkdown";
import DocumentComposer from "./DocumentComposer";
import { ResearchDocumentFrame, ResearchPairHeader } from "./ResearchDocumentChrome";
import {
  ResearchAnswerPane,
  ResearchMessageRow,
  type SegmentDomKind,
  type SegmentView,
} from "./ResearchTurn";
import { trapResearchDialogTab, useResearchDialogReturnFocus } from "./researchFocus";
import ResearchConversationComposer, {
  type ResearchComposerHandle,
} from "./ResearchConversationComposer";
import {
  ResearchColumnsContext,
  researchScrollBehavior,
  revealResearchColumns,
  settleResearchStrip,
} from "./ResearchColumns";
import {
  ResearchMenu,
  ResearchMenuItem,
  ResearchMenuMeta,
  ResearchMenuSeparator,
  researchMenuPoint,
  type ResearchMenuAlign,
  type ResearchMenuRect,
} from "./ResearchMenu";

const EMPTY_RECAP_PENDING_NODE_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_BRANCHES: ResearchNode[] = [];
const EMPTY_QUEUE: QueuedResearchFollowup[] = [];
/** How long a sent queued follow-up keeps its chain blocked while waiting
 * for the new node to appear in the tree detail. */
const QUEUE_CHILD_WAIT_MS = 15_000;
/** How long a node created a moment ago is shown before it appears in the
 * tree detail. */
const PENDING_NODE_TTL_MS = 30_000;
/** How long a focus request waits for its element to render. */
const FOCUS_REQUEST_TTL_MS = 2_000;

interface ResearchDocumentProps {
  detail: ResearchTreeDetail | null;
  /** Durable sidebar title shown in the header while tree detail is loading. */
  treeTitle?: string;
  /** Archived trees remain browsable, but cannot be branched. */
  archived: boolean;
  /** Why `detail` is null, when the tree fetch itself failed. */
  detailError?: string | null;
  /** Refetches the active tree's detail after a failed load. */
  onRetryDetail?: () => void;
  onFork: (
    parentNodeId: string,
    prompt: string,
    queryAnchor?: ResearchHighlightAnchor | null,
    inline?: boolean,
    replyAnchor?: string | null,
    replacesNodeId?: string | null,
  ) => Promise<ResearchNode>;
  /** Replies and follow-ups on a note page (see ResearchNoteDocument). */
  noteActions: NoteActions;
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
  onCancel: (nodeId: string) => Promise<void>;
  /** Relaunches a failed or cancelled run in place (same node id, same
   * inputs). The refreshed tree detail flows back through the caller's
   * reconciliation, so the turn re-renders as Queued. */
  onRetryNode: (nodeId: string) => Promise<void>;
  linkActions: LinkActions;
  onError: (message: string) => void;
  onToast: (message: string, tone?: "normal" | "warning") => void;
  /** Show held-⌘ shortcut badges (the ⌘J composer hint). */
  shortcutHintsShown: boolean;
  /** The "Require ⌘↵ to send" setting, for every composer in the document. */
  requireCmdEnterToSend: boolean;
  /** Runs whose background summary job is in flight; each renders a spinner in
   * its recap slot until the summary arrives. */
  recapPendingNodeIds?: ReadonlySet<string>;
  /** Workspace-level back/forward (Recent Activity ↔ documents). Used when
   * this tree's own visit stack has nowhere left to go. */
  workspaceCanGoBack?: boolean;
  workspaceCanGoForward?: boolean;
  onWorkspaceBack?: () => void;
  onWorkspaceForward?: () => void;
  /** Called with the open nodes whenever they change: the message selected
   * in the root pair, then the head of each open branch. Empty on unmount. */
  onOpenNodesChange?: (nodeIds: string[]) => void;
  /** The whole question's Follow, Bookmark and Move to actions, which the
   * root conversation's answer menus list below their own actions. */
  treeMenu?: ResearchDocumentTreeMenu;
}

export interface ResearchDocumentTreeMenu
  extends Omit<ResearchTreeMenuProps, "onToggleBookmark" | "onToggleFollow" | "onNewFolder"> {
  bookmarked: boolean;
  followed: boolean;
  onSetBookmarked: (bookmarked: boolean) => void;
  onSetFollowed: (followed: boolean) => void;
  /** `trigger` is where focus returns when the folder dialog closes. */
  onNewFolder: (trigger: HTMLElement | undefined) => void;
}

const TIMELINE_ITEM_RENDER_WINDOW = 100;
const FLASH_MS = 1600;

interface HighlightAction {
  /** The turn (node) the selection landed in. */
  nodeId: string;
  /** A selection in an answer that is still streaming: it can be copied, but
   * not highlighted or branched from until the answer has a revision. */
  live: boolean;
  /** The selection crossed into a later paragraph; the anchor stops at the
   * end of the first one. */
  crossed: boolean;
  /** The whole selection, for Copy. */
  copyText: string;
  anchor: ResearchHighlightAnchor;
  highlightIds: string[];
  /** The merged annotation Highlight saves when the selection overlaps
   * existing highlights — the union of the selection and every highlight it
   * intersects. Null when there is nothing to merge. */
  expandAnchor: ResearchHighlightAnchor | null;
  left: number;
  top: number;
  /** The selection has scrolled out of the viewport: keep the action alive
   * but stop drawing a bar over unrelated content. */
  offscreen: boolean;
}

interface ResolvedHighlight {
  highlight: ResearchHighlight;
  start: number;
  end: number;
}

interface DocumentEditSession {
  nodeId: string;
  markdown: string;
  title: string;
  responseRevision: string;
  highlightIds: string[];
  highlightCount: number;
}


/** A new branch being written: the pair after its parent's level shows the
 * passage and an ask box; the branch is created when its first question is
 * sent. `anchor` is null for a branch from the whole answer. */
interface PendingBranch {
  parentNodeId: string;
  anchor: ResearchHighlightAnchor | null;
}

/** Where focus goes once the next render has committed, and how the strip
 * follows it: `reveal` shows the level's pair by the least scroll, `settle`
 * shows the strip's last column with the target's column in view. */
type FocusRequest = {
  target:
    | { kind: "row"; level: number }
    | { kind: "answer"; level: number }
    | { kind: "marker"; level: number; key: string }
    | { kind: "composer"; key: string };
  strip: "reveal" | "settle" | "none";
  /** Only when focus was lost (it sat in a column that went away). */
  onlyIfLost: boolean;
  at: number;
};

/** A margin marker: the branches from one paragraph of an answer (`top`, in
 * px from the top of the answer), or from the whole answer (`top` null). */
interface BranchMarker {
  key: string;
  top: number | null;
  branchIds: string[];
}

interface DocumentMenuPlacement {
  anchor: HTMLElement | ResearchMenuRect;
  align: ResearchMenuAlign;
  /** The button that opened the menu: focus returns to it when it closes. */
  trigger?: HTMLElement | null;
}

type DocumentMenuState =
  | ({ kind: "answer"; nodeId: string } & DocumentMenuPlacement)
  | ({
      kind: "mark";
      nodeId: string;
      branchIds: string[];
      highlightId: string | null;
    } & DocumentMenuPlacement);

interface ResearchHighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface ResearchNativeHighlight {
  add(range: Range): void;
  clear(): void;
  priority: number;
}

interface ResearchHighlightApi {
  registry: ResearchHighlightRegistry;
  Highlight: new () => ResearchNativeHighlight;
}

const RESEARCH_HIGHLIGHT_NAME = "session-research-highlights";
const RESEARCH_BRANCH_NAME = "session-research-branch-passages";
const RESEARCH_OPEN_BRANCH_NAME = "session-research-open-branch";
const RESEARCH_PENDING_BRANCH_NAME = "session-research-pending-branch";
const PENDING_BRANCH_ID = "__draft__";
const RESEARCH_OVERLAP_NAME = "session-research-highlight-overlaps";
const RESEARCH_HOVER_HIGHLIGHT_NAME = "session-research-highlight-hover";
const RESEARCH_HOVER_BRANCH_NAME = "session-research-branch-hover";
const RESEARCH_SELECTED_NAME = "session-research-selected-highlights";
const RESEARCH_FLASH_NAME = "session-research-flash";
// Stacking order for the layers that repaint over the shared base tones:
// overlaps above the base paint, hover above overlaps, the underline of an
// open branch's passage above that, and the selection tone above everything.
const RESEARCH_OVERLAP_PRIORITY = 1;
const RESEARCH_HOVER_PRIORITY = 2;
const RESEARCH_OPEN_PRIORITY = 3;
const RESEARCH_FLASH_PRIORITY = 4;
const RESEARCH_SELECTED_PRIORITY = 5;
// Match the platform's small click-versus-drag tolerance: a click should keep
// link, annotation, and native double-click behavior, while a deliberate drag
// switches to live whole-word selection quickly.
const RESEARCH_SELECTION_DRAG_THRESHOLD = 3;

interface ResearchSelectionDrag {
  root: HTMLDivElement;
  anchorOffset: number | null;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  snapEligible: boolean;
  /** Undefined until the drag crosses the click threshold, null when word
   * segmentation is unavailable, otherwise cached for every live frame. */
  snapper: ResearchSelectionSnapper | null | undefined;
  frame: number | null;
}

function researchHighlightApi(): ResearchHighlightApi | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: ResearchHighlightRegistry } }).CSS;
  const Highlight = (globalThis as unknown as { Highlight?: unknown }).Highlight;
  if (!css?.highlights || typeof Highlight !== "function") {
    return null;
  }
  return {
    registry: css.highlights,
    Highlight: Highlight as new () => ResearchNativeHighlight,
  };
}

function textNodesWithin(root: HTMLElement) {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function rangeForTextOffsets(root: HTMLElement, start: number, end: number) {
  if (start < 0 || end <= start) {
    return null;
  }
  const nodes = textNodesWithin(root);
  let consumed = 0;
  let startPoint: { node: Text; offset: number } | null = null;
  let endPoint: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const next = consumed + node.data.length;
    if (!startPoint && start <= next) {
      startPoint = { node, offset: start - consumed };
    }
    if (end <= next) {
      endPoint = { node, offset: end - consumed };
      break;
    }
    consumed = next;
  }
  if (!startPoint || !endPoint) {
    return null;
  }
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function applyDirectionalSelectionRange(
  range: Range,
  direction: "forward" | "backward",
) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  if (selection.rangeCount > 0 && !selection.isCollapsed) {
    const current = selection.getRangeAt(0);
    const sameRange =
      current.startContainer === range.startContainer &&
      current.startOffset === range.startOffset &&
      current.endContainer === range.endContainer &&
      current.endOffset === range.endOffset;
    const expectedAnchor =
      direction === "forward" ? range.startContainer : range.endContainer;
    const expectedAnchorOffset =
      direction === "forward" ? range.startOffset : range.endOffset;
    const expectedFocus =
      direction === "forward" ? range.endContainer : range.startContainer;
    const expectedFocusOffset =
      direction === "forward" ? range.endOffset : range.startOffset;
    if (
      sameRange &&
      (typeof selection.setBaseAndExtent !== "function" ||
        (selection.anchorNode === expectedAnchor &&
          selection.anchorOffset === expectedAnchorOffset &&
          selection.focusNode === expectedFocus &&
          selection.focusOffset === expectedFocusOffset))
    ) {
      return;
    }
  }
  if (typeof selection.setBaseAndExtent === "function") {
    if (direction === "forward") {
      selection.setBaseAndExtent(
        range.startContainer,
        range.startOffset,
        range.endContainer,
        range.endOffset,
      );
    } else {
      selection.setBaseAndExtent(
        range.endContainer,
        range.endOffset,
        range.startContainer,
        range.startOffset,
      );
    }
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

// Exclude tool calls and payloads, Raw disclosures, collapsed thinking, and
// grouped activity from selections used for highlights or branches. Raw
// disclosures use `.tool-block` and can be nested inside a message.
const NON_TEXT_ROW_SELECTOR =
  ".tool-block, .thinking-block, .activity-group-block, .research-conversation-activity";

/** True when the range starts, ends, or spans across any non-text row. Because
 * `.tool-block` disclosures can sit inside a `.research-response-message`, this
 * intersection test — not a positive "is inside a message" check — is what
 * keeps highlights confined to prose. */
function selectionTouchesNonTextRow(root: HTMLElement, range: Range) {
  for (const row of root.querySelectorAll(NON_TEXT_ROW_SELECTOR)) {
    if (range.intersectsNode(row)) {
      return true;
    }
  }
  return false;
}

function selectionOffsets(root: HTMLElement, range: Range) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(root);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const throughSelectionRange = document.createRange();
  throughSelectionRange.selectNodeContents(root);
  throughSelectionRange.setEnd(range.endContainer, range.endOffset);
  const start = prefixRange.cloneContents().textContent?.length ?? 0;
  const end = throughSelectionRange.cloneContents().textContent?.length ?? 0;
  return end > start ? { start, end } : null;
}

/** The flat rendered-text offset of a caret position, or null when the
 * position sits outside `root`. Text-node positions take the cheap walking
 * path; element positions (rare — clicks on gaps between blocks) fall back to
 * the same clone-and-measure approach as `selectionOffsets`. */
function flatTextOffsetAt(root: HTMLElement, node: Node, offsetInNode: number) {
  if (!root.contains(node)) {
    return null;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    let consumed = 0;
    for (const textNode of textNodesWithin(root)) {
      if (textNode === node) {
        return consumed + Math.min(offsetInNode, textNode.data.length);
      }
      consumed += textNode.data.length;
    }
    return null;
  }
  const probe = document.createRange();
  probe.selectNodeContents(root);
  try {
    probe.setEnd(node, offsetInNode);
  } catch {
    return null;
  }
  return probe.cloneContents().textContent?.length ?? 0;
}

/** Hit-tests a viewport point against the rendered text: the flat offset the
 * point falls on, or null off-text. caretRangeFromPoint is the WebKit spelling,
 * caretPositionFromPoint the standard one. */
function flatOffsetAtPoint(root: HTMLElement, clientX: number, clientY: number) {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    return range ? flatTextOffsetAt(root, range.startContainer, range.startOffset) : null;
  }
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(clientX, clientY);
    return position ? flatTextOffsetAt(root, position.offsetNode, position.offset) : null;
  }
  return null;
}

/** Flat offsets where the enclosing `.research-response-message` changes —
 * every seam between one message and the next, or between a message and the
 * tool/thinking rows around it. The projection concatenates these with no
 * separating whitespace, so word snapping needs them to avoid fusing a
 * message's last word to its neighbour's first (see
 * `createResearchSelectionSnapper`). */
function messageFlatBoundaries(root: HTMLElement) {
  const boundaries: number[] = [];
  let consumed = 0;
  let previous: HTMLElement | null = null;
  let first = true;
  for (const node of textNodesWithin(root)) {
    const message =
      node.parentElement?.closest<HTMLElement>(".research-response-message") ?? null;
    if (!first && message !== previous) {
      boundaries.push(consumed);
    }
    first = false;
    previous = message;
    consumed += node.data.length;
  }
  return boundaries;
}

/** Flat-offset span of the `.research-response-message` that encloses the
 * whole selection, or null when the selection is not confined to a single
 * message. A message renders the same text in every transcript view, but the
 * rows around it do not, so anchoring context taken near a message edge is
 * clamped to this span — otherwise a prefix/suffix that reached into an
 * adjacent tool or thinking row would only resolve in the view it was taken
 * in, and the highlight would vanish on toggle. */
function enclosingMessageFlatBounds(root: HTMLElement, range: Range) {
  const messageOf = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      ".research-response-message",
    ) ?? null;
  const message = messageOf(range.startContainer);
  if (!message || message !== messageOf(range.endContainer)) {
    return null;
  }
  const start = flatTextOffsetAt(root, message, 0);
  const end = flatTextOffsetAt(root, message, message.childNodes.length);
  return start !== null && end !== null ? { start, end } : null;
}

function textContextSlice(text: string, start: number, end: number) {
  let safeStart = Math.max(0, start);
  let safeEnd = Math.min(text.length, end);
  if (
    safeStart > 0 &&
    safeStart < text.length &&
    /[\uDC00-\uDFFF]/.test(text[safeStart]) &&
    /[\uD800-\uDBFF]/.test(text[safeStart - 1])
  ) {
    safeStart -= 1;
  }
  if (
    safeEnd > 0 &&
    safeEnd < text.length &&
    /[\uD800-\uDBFF]/.test(text[safeEnd - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[safeEnd])
  ) {
    safeEnd += 1;
  }
  return text.slice(safeStart, safeEnd);
}

/** The quoted selection as a single line: block structure and inline markdown
 * are already absent from the rendered-text projection, so collapsing
 * whitespace is all that quoting requires. */
function quoteDisplayText(exact: string) {
  return exact.split(/\s+/).join(" ").trim();
}

// The paragraph-level blocks a highlight or branch passage stays within.
const PASSAGE_BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption";

/** The block (paragraph, list item, heading, ...) a position sits in, inside
 * `root`, or null outside any. */
function passageBlockAt(root: HTMLElement, node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>(PASSAGE_BLOCK_SELECTOR) ?? null;
  return block && root.contains(block) ? block : null;
}

// The selection actions' size before they have rendered once (three inline
// items, plus the note line when one shows).
const SELECTION_ACTIONS_SIZE = { width: 290, height: 40 };

/** Where the action bar sits for a selection: centred 8px above it. */
function highlightActionPlacement(range: Range, size = SELECTION_ACTIONS_SIZE) {
  return researchSelectionActionPlacement({
    boundingRect: range.getBoundingClientRect(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    width: size.width,
    height: size.height,
  });
}

/** Why no branch can start from `node`, or null when one can. */
function branchBlockerFor(node: ResearchNode | null | undefined, archived: boolean) {
  if (archived) {
    return "Move this question out of Archive to branch from it";
  }
  if (!node || isActiveResearchStatus(node.status)) {
    return "Wait for the answer to finish";
  }
  if (node.status === "failed") {
    return "This answer stopped with an error. Retry it to branch from it";
  }
  if (node.status === "cancelled") {
    return "This answer was stopped. Run it again to branch from it";
  }
  return canFollowUpFrom(node) ? null : "Waiting for the native session checkpoint";
}

function sameNumberRecord(a: Record<string, number>, b: Record<string, number>) {
  const aKeys = Object.keys(a);
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((key) => a[key] === b[key])
  );
}

/** Removes the given keys from a record, keeping the identity when none are
 * present — the shape every per-node cache invalidation here needs. */
function withoutKeys<T>(record: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const stale = [...keys].filter((key) => key in record);
  if (stale.length === 0) {
    return record;
  }
  const next = { ...record };
  for (const key of stale) {
    delete next[key];
  }
  return next;
}

function sameIds(previous: readonly string[], candidate: readonly string[]) {
  return (
    previous.length === candidate.length &&
    previous.every((id, index) => id === candidate[index])
  );
}

/** Keeps the previous identity of a derived value while an equality check
 * says nothing changed. Chain ids are recomputed on every research event
 * (4×/s while any run streams); without this, each recomputation's fresh
 * identity would rerun every effect that depends on them. */
function useStableValue<T>(next: T, isEqual: (previous: T, candidate: T) => boolean): T {
  const ref = useRef(next);
  if (ref.current !== next && !isEqual(ref.current, next)) {
    ref.current = next;
  }
  return ref.current;
}

/** Brings `element` (a row, or the row it sits in) fully into its column; a
 * row taller than the column scrolls its top to the column's top. */
function scrollIntoColumn(element: Element, behavior: ScrollBehavior = "auto") {
  const scroller = element.closest<HTMLElement>(".research-column-scroll");
  if (!scroller) {
    return;
  }
  const target = element.closest(".research-msg-row") ?? element;
  const rect = target.getBoundingClientRect();
  const bounds = scroller.getBoundingClientRect();
  let delta = 0;
  if (rect.height > bounds.height || rect.top < bounds.top) {
    delta = rect.top - bounds.top;
  } else if (rect.bottom > bounds.bottom) {
    delta = rect.bottom - bounds.bottom;
  }
  if (delta) {
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
  }
}

function nodeLabel(node: ResearchNode | null | undefined, fallback: string) {
  return (node?.title ?? node?.prompt ?? "").trim() || fallback;
}

/** Content-derived render state for one answer. */
function buildSegmentView(
  node: ResearchNode,
  content: ResearchNodeContent | null,
  showAllTurns: boolean,
  showFullTrace: boolean,
): SegmentView {
  // A conversation node's whole timeline is the document: there is no
  // "answer" fold to collapse to and no fuller trace to reveal.
  const isConversation = node.kind === "conversation" || content?.node.kind === "conversation";
  const isDocument = node.kind === "document";
  const timelineItems = buildTimelineItems(content?.turns ?? []);
  const answerTimelineItems = timelineItemsAfterLastToolCall(timelineItems);
  const hasTranscriptActivity = !isConversation && timelineItemsContainTranscriptActivity(timelineItems);
  const displayedTimelineItems = isConversation || showFullTrace ? timelineItems : answerTimelineItems;
  // A run trace reads bottom-up (the answer is the tail), so its window
  // keeps the newest items; a conversation reads top-down from its opening
  // question, so its window keeps the head.
  const visibleTimelineItems =
    showAllTurns || displayedTimelineItems.length <= TIMELINE_ITEM_RENDER_WINDOW
      ? displayedTimelineItems
      : isConversation
        ? displayedTimelineItems.slice(0, TIMELINE_ITEM_RENDER_WINDOW)
        : displayedTimelineItems.slice(-TIMELINE_ITEM_RENDER_WINDOW);
  const rawAnswer = assistantTextFromTimelineItems(answerTimelineItems);
  const conversationCopyText =
    isConversation && content ? formatPlainTextTranscript(content.turns, "Assistant") : null;
  let editableDocumentMarkdown: string | null = null;
  if (content?.node.kind === "document") {
    for (const turn of content.turns) {
      const block = turn.blocks.find((candidate) => candidate.type === "text");
      if (block?.type === "text") {
        editableDocumentMarkdown = block.text;
        break;
      }
    }
  }
  return {
    node,
    content,
    isDocument,
    isConversation,
    showAllTurns,
    showFullTrace,
    timelineItems,
    displayedTimelineItems,
    visibleTimelineItems,
    hiddenTimelineItemCount: displayedTimelineItems.length - visibleTimelineItems.length,
    hasTranscriptActivity,
    rawAnswer,
    conversationCopyText,
    answerWordCount: countResearchDocumentWords(conversationCopyText ?? rawAnswer),
    editableDocumentMarkdown,
  };
}

/** The branch questions behind a margin marker, shown beside it on hover
 * or keyboard focus. Not interactive; Esc hides it. */
function ResearchMarkerTip({
  anchor,
  items,
  opensNext,
  onDismiss,
}: {
  anchor: HTMLElement;
  items: { id: string; question: string; source: string; messages: number; state: "open" | "running" | null }[];
  /** One of the marker's branches is open: a click opens the next one. */
  opensNext: boolean;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const tip = ref.current;
      if (!tip || !anchor.isConnected) return;
      const rect = anchor.getBoundingClientRect();
      const width = tip.offsetWidth;
      const height = tip.offsetHeight;
      let left = rect.left - 8 - width;
      let top = rect.top - 6;
      if (left < 8) {
        left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
        top = rect.bottom + 6;
      }
      top = Math.max(8, Math.min(window.innerHeight - height - 8, top));
      setPosition((current) => (current?.left === left && current.top === top ? current : { left, top }));
    };
    place();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, items, onDismiss]);
  const clip = (text: string, length: number) => {
    const flat = text.split(/\s+/).join(" ").trim();
    return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
  };
  return createPortal(
    <div
      ref={ref}
      className="research-marker-tip"
      role="tooltip"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? undefined : "hidden" }}
    >
      {items.map((item) => (
        <div key={item.id} className="research-marker-tip-item">
          <span className="research-marker-tip-question">{clip(item.question, 160)}</span>
          <span className="research-marker-tip-meta">
            <span className="research-marker-tip-source">{clip(item.source, 62)}</span>
            <span>
              {item.messages} {item.messages === 1 ? "message" : "messages"}
            </span>
            {item.state === "open" ? <span className="is-open">Open</span> : null}
            {item.state === "running" ? <span className="is-running">Running</span> : null}
          </span>
        </div>
      ))}
      {items.length > 1 ? (
        <div className="research-marker-tip-item">
          <span className="research-marker-tip-meta">Click opens the {opensNext ? "next" : "first"} branch.</span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/** The open path as columns: one [messages | answer] pair per level, keyed
 * so a column keeps its element (and focus) while its level shows the same
 * conversation and message. */
function pairColumnKey(kind: "turns" | "answer", level: number, id: string) {
  return `${kind === "turns" ? "T" : "A"}${level}`.concat(":", id);
}

function ResearchDocument({
  detail,
  treeTitle,
  archived,
  detailError,
  onRetryDetail,
  onFork,
  noteActions,
  onRemoveBranch,
  onRemoveTree,
  onRenameTree,
  onUpdateDocument,
  onCancel,
  onRetryNode,
  linkActions,
  onError,
  onToast,
  shortcutHintsShown,
  requireCmdEnterToSend,
  recapPendingNodeIds = EMPTY_RECAP_PENDING_NODE_IDS,
  workspaceCanGoBack = false,
  workspaceCanGoForward = false,
  onWorkspaceBack,
  onWorkspaceForward,
  onOpenNodesChange,
  treeMenu,
}: ResearchDocumentProps) {
  const columnsLayout = useContext(ResearchColumnsContext);
  const treeId = detail?.tree.id ?? null;
  const rootNodeId = detail?.tree.rootNodeId ?? null;
  // The deepest open level's selected message. It determines every level
  // before it (see researchLevelPath). Back/forward walk these visits.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingBranch | null>(null);
  const [history, setHistory] = useState(EMPTY_RESEARCH_HISTORY);
  // Show newly created question nodes until the refreshed tree detail
  // includes them.
  const [createdNodes, setCreatedNodes] = useState<{ node: ResearchNode; at: number }[]>([]);
  // Record ids synchronously so the event that creates a node can select it.
  const createdNodeIdsRef = useRef(new Set<string>());
  // The level whose pair holds keyboard focus (-1: the feed). Its header
  // title is at full strength; null until something is focused, which makes
  // the deepest level current.
  const [focusedLevel, setFocusedLevel] = useState<number | null>(null);
  // Loaded answers, keyed by node id. Pruned to the open levels' chains.
  const [contentByNode, setContentByNode] = useState<Record<string, ResearchNodeContent>>({});
  const [contentErrorByNode, setContentErrorByNode] = useState<Record<string, string>>({});
  const [contentLoadNonce, setContentLoadNonce] = useState(0);
  const [composerText, setComposerText] = useState<Record<string, string>>({});
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [queues, setQueues] = useState<Record<string, QueuedResearchFollowup[]>>({});
  // Per chain head: the failed node whose question the composer is editing.
  const [editingByHead, setEditingByHead] = useState<Record<string, string>>({});
  // Retries waiting for the running answer in their conversation.
  const [queuedRetries, setQueuedRetries] = useState<ReadonlySet<string>>(() => new Set());
  const [retryingNodeId, setRetryingNodeId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequestInFlightRef = useRef(false);
  const [menu, setMenu] = useState<DocumentMenuState | null>(null);
  const [deletingBranchId, setDeletingBranchId] = useState<string | null>(null);
  const [removingBranch, setRemovingBranch] = useState(false);
  const [branchRemovalError, setBranchRemovalError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ nodeId: string; value: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [documentEditSession, setDocumentEditSession] = useState<DocumentEditSession | null>(null);
  const [recapDialogNodeId, setRecapDialogNodeId] = useState<string | null>(null);
  // Per-node reading state: which answers show their full item window
  // (persisted per tree) and which show the full transcript (per visit).
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [fullTraceNodes, setFullTraceNodes] = useState<Record<string, boolean>>({});
  const [highlightAction, setHighlightAction] = useState<HighlightAction | null>(null);
  const [savingHighlight, setSavingHighlight] = useState(false);
  // Count saved highlights whose anchors cannot be located in the rendered
  // answer. The answer's … menu reports these unresolved highlights.
  const [hiddenHighlightsByNode, setHiddenHighlightsByNode] = useState<Record<string, number>>({});
  // Branches whose answer finished while this document was open and that
  // the reader has not opened carry an unread dot on their branch count.
  // `firstSeenComplete` records each branch's status the first time it is
  // seen, so a branch that was already complete when the tree loaded is read.
  const firstSeenCompleteRef = useRef<Map<string, boolean>>(new Map());
  const [openedNodeIds, setOpenedNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [highlightDomNonce, setHighlightDomNonce] = useState(0);
  const [markerLayoutNonce, setMarkerLayoutNonce] = useState(0);
  const [markersByNode, setMarkersByNode] = useState<Record<string, BranchMarker[]>>({});
  const [markerTip, setMarkerTip] = useState<{ element: HTMLElement; branchIds: string[]; level: number } | null>(null);
  const dismissMarkerTip = useCallback(() => setMarkerTip(null), []);
  const [pointerAnnotationNodeId, setPointerAnnotationNodeId] = useState<string | null>(null);
  const [hoveredAnnotation, setHoveredAnnotation] = useState<{
    nodeId: string;
    start: number;
    end: number;
    kind: "branch" | "highlight";
  } | null>(null);
  const [flashRange, setFlashRange] = useState<{ nodeId: string; start: number; end: number } | null>(null);
  const [metadataNow, setMetadataNow] = useState(() => Date.now());
  const [minuteNow, setMinuteNow] = useState(() => Date.now());

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  // The selection actions' measured size, for centring them.
  const selectionActionsSizeRef = useRef(SELECTION_ACTIONS_SIZE);
  const composerRefs = useRef(new Map<string, ResearchComposerHandle>());
  // Resolved highlight ranges per answer, refreshed by the paint effect.
  const resolvedHighlightsRef = useRef(new Map<string, ResolvedHighlight[]>());
  // Bumped after each highlight paint so the focus-highlight effect below
  // observes freshly resolved ranges.
  const [highlightPaintVersion, setHighlightPaintVersion] = useState(0);
  // Flat-offset ranges of the branch passages that resolved, tagged with the
  // answer they sit in. Consulted by passage clicks, hover, markers and order.
  const branchRangeOffsetsRef = useRef<
    { segmentId: string; id: string; start: number; end: number }[]
  >([]);
  const savedHighlightPaintRef = useRef<ResearchNativeHighlight | null>(null);
  const selectedHighlightPaintRef = useRef<ResearchNativeHighlight | null>(null);
  const selectionDragRef = useRef<ResearchSelectionDrag | null>(null);
  const annotationHoverFrameRef = useRef<number | null>(null);
  const annotationHoverPointerRef = useRef<{
    root: HTMLDivElement;
    nodeId: string | null;
    clientX: number;
    clientY: number;
  } | null>(null);
  const treeIdRef = useRef(treeId);
  // The content-loading effect reads the tree through this ref so a routine
  // detail replacement (every research event rebuilds the object) does not
  // restart the effect and refetch content that has not changed.
  const detailRef = useRef(detail);
  const contentByNodeRef = useRef(contentByNode);
  const contentErrorByNodeRef = useRef(contentErrorByNode);
  const menuRef = useRef(menu);
  const pendingRef = useRef(pending);
  // The (status, snapshot) stamp each cached content was fetched under, so
  // the loader can tell a cache hit from a stale entry without refetching
  // unchanged answers every time the open levels recompute.
  const fetchStampByNodeRef = useRef(new Map<string, string>());
  // Answer scroll offsets, per node, for this mount; the persisted store
  // carries them across mounts.
  const answerScrollRef = useRef(new Map<string, number>());
  // Answers whose scroll offset has been restored since their column mounted.
  const restoredAnswerScrollRef = useRef(new Set<string>());
  // The same for each level's messages column, keyed by its head node.
  const turnsScrollRef = useRef(new Map<string, number>());
  const restoredTurnsScrollRef = useRef(new Set<string>());
  // Live mirrors for stable callbacks that must read current state.
  const composerTextRef = useRef(composerText);
  const submittingKeyRef = useRef(submittingKey);
  const editingByHeadRef = useRef(editingByHead);
  const queuesRef = useRef(queues);
  treeIdRef.current = treeId;
  detailRef.current = detail;
  contentByNodeRef.current = contentByNode;
  contentErrorByNodeRef.current = contentErrorByNode;
  menuRef.current = menu;
  pendingRef.current = pending;
  composerTextRef.current = composerText;
  submittingKeyRef.current = submittingKey;
  editingByHeadRef.current = editingByHead;
  queuesRef.current = queues;

  const navigationPersistence = useResearchDocumentNavigation((persistence) => {
    const currentTreeId = treeIdRef.current;
    if (!currentTreeId) {
      return;
    }
    for (const [nodeId, top] of answerScrollRef.current) {
      if (restoredAnswerScrollRef.current.has(nodeId)) {
        persistence.recordScroll(currentTreeId, nodeId, top);
      }
    }
    for (const [headId, top] of turnsScrollRef.current) {
      if (restoredTurnsScrollRef.current.has(headId)) {
        persistence.recordScroll(currentTreeId, headId, top, "turns");
      }
    }
  });

  // The tree's nodes, with nodes created a moment ago that the detail has
  // not delivered yet.
  const nodes = useMemo(() => {
    const base = detail?.nodes ?? [];
    const extra = createdNodes
      .map((entry) => entry.node)
      .filter((node) => node.treeId === detail?.tree.id && !base.some((candidate) => candidate.id === node.id));
    return extra.length > 0 ? [...base, ...extra] : base;
  }, [createdNodes, detail]);
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

  // The selected message of each open level, root conversation first.
  const levelPath = useStableValue(
    useMemo(
      () => (selectedNodeId && nodeById.has(selectedNodeId) ? researchLevelPath(nodes, selectedNodeId) : []),
      [nodeById, nodes, selectedNodeId],
    ),
    sameIds,
  );
  const levelPathRef = useRef(levelPath);
  levelPathRef.current = levelPath;
  const deepestSelection = useMemo(() => levelPath.slice(-1), [levelPath]);
  // Each level's chain (its messages), as one stable key per level.
  const levelChainsKey = useMemo(
    () => levelPath.map((id) => inlineChainFor(nodes, id).join(",")).join("\n"),
    [levelPath, nodes],
  );
  const levelChains = useMemo(
    () => (levelChainsKey ? levelChainsKey.split("\n").map((chain) => chain.split(",")) : []),
    [levelChainsKey],
  );
  // A pending branch belongs after the level that shows its parent selected.
  const pendingLevel =
    pending && levelPath.length > 0 && levelPath[levelPath.length - 1] === pending.parentNodeId
      ? levelPath.length
      : null;
  const activePending = pendingLevel !== null ? pending : null;

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
  // Refetch when a run finishes, its snapshot is saved, or its recap is available.
  // Other detail updates do not need to restart the content loaders.
  const chainStatusKey = chainNodes
    .map((node) => `${node.id}:${node.status}:${node.responseSnapshotAt ?? 0}:${node.recap?.id ?? node.recap?.responseRevision ?? ""}`)
    .join("\n");
  const branchesByParent = useMemo(() => researchBranchesByParent(nodes), [nodes]);
  const branchesByParentRef = useRef(branchesByParent);
  branchesByParentRef.current = branchesByParent;

  // Answer- and row-scoped DOM lookups. Each message row registers itself
  // ("anchor") and each answer its response root as it mounts; measurement
  // effects read the maps instead of scanning the whole subtree.
  const segmentDomRef = useRef({
    anchor: new Map<string, HTMLElement>(),
    root: new Map<string, HTMLElement>(),
  });
  const registerSegmentElement = useCallback(
    (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => {
      const map = segmentDomRef.current[kind];
      if ((map.get(nodeId) ?? null) === element) {
        return;
      }
      if (element) {
        map.set(nodeId, element);
      } else {
        map.delete(nodeId);
      }
      // An answer's text moved to new DOM: ranges painted into the old DOM
      // are gone.
      if (kind === "root") {
        setHighlightDomNonce((value) => value + 1);
      }
    },
    [],
  );
  const segmentRoot = useCallback(
    (nodeId: string) =>
      (segmentDomRef.current.root.get(nodeId) as HTMLDivElement | undefined) ?? null,
    [],
  );

  // Columns of the open pairs, found by level.
  const pairColumn = useCallback(
    (kind: "turns" | "answer", level: number) =>
      workspaceRef.current?.querySelector<HTMLElement>(
        `[data-research-pair="${kind}"][data-research-level="${level}"]`,
      ) ?? null,
    [],
  );
  const selectedRow = useCallback(
    (level: number) =>
      pairColumn("turns", level)?.querySelector<HTMLElement>(".research-msg-row.is-selected .research-msg-hit") ??
      null,
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

  // Clear the action bar and selection when the view changes. Transcript
  // visibility and loaded content can invalidate their cached positions.
  useEffect(() => {
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
  }, [treeId, chainKey, revisionsKey, expandedKey, fullTraceKey]);

  // Highlight mutations are announced as research events but do not replace
  // the response snapshot. Mirror their refreshed node metadata into each
  // loaded answer so another window's changes reach the document. Bail on
  // unchanged id lists: every research event rebuilds the highlights arrays,
  // and adopting each fresh identity re-ran the paint effect's text walk.
  useEffect(() => {
    if (!detail) {
      return;
    }
    setContentByNode((current) => {
      let changed = false;
      const next: Record<string, ResearchNodeContent> = { ...current };
      for (const node of detail.nodes) {
        const entry = current[node.id];
        if (!entry) {
          continue;
        }
        const previous = entry.node.highlights ?? [];
        const fresh = node.highlights ?? [];
        if (
          previous.length === fresh.length &&
          previous.every((highlight, index) => highlight.id === fresh[index].id)
        ) {
          continue;
        }
        next[node.id] = {
          ...entry,
          node: { ...entry.node, highlights: node.highlights },
        };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [detail]);

  // Record whether each branch was complete when first displayed. This
  // determines whether a later completion gets an unread dot. Record after
  // commit so aborted renders do not mark branches as seen.
  useEffect(() => {
    const seen = firstSeenCompleteRef.current;
    for (const chain of levelChains) {
      for (const id of chain) {
        for (const child of branchesByParent.get(id) ?? []) {
          if (!seen.has(child.id)) {
            seen.set(child.id, child.status === "complete");
          }
        }
      }
    }
  }, [branchesByParent, levelChains]);

  // Branch passages per open answer: the anchors of each answer's branches,
  // plus the pending new branch's passage. Immutable per id, so the stable
  // identity only changes when the (answer, id) list does.
  const branchEntries = useStableValue(
    useMemo(() => {
      const next: { segmentId: string; id: string; anchor: ResearchHighlightAnchor }[] = [];
      for (const segmentId of levelPath) {
        for (const child of branchesByParent.get(segmentId) ?? []) {
          if (child.queryAnchor) {
            next.push({ segmentId, id: child.id, anchor: child.queryAnchor });
          }
        }
      }
      if (activePending?.anchor) {
        next.push({ segmentId: activePending.parentNodeId, id: PENDING_BRANCH_ID, anchor: activePending.anchor });
      }
      return next;
    }, [activePending, branchesByParent, levelPath]),
    (previous, candidate) =>
      previous.length === candidate.length &&
      previous.every(
        (entry, index) =>
          entry.id === candidate[index].id &&
          entry.segmentId === candidate[index].segmentId &&
          entry.anchor === candidate[index].anchor,
      ),
  );
  // Branch heads open as levels (and the pending branch): their passages are
  // underlined and their markers drawn in the accent colour.
  const openBranchIds = useMemo(() => {
    const open = new Set<string>(levelChains.slice(1).map((chain) => chain[0]));
    if (activePending) {
      open.add(PENDING_BRANCH_ID);
    }
    return open;
  }, [activePending, levelChains]);
  const openBranchKey = [...openBranchIds].sort().join(",");

  const deletingBranch = useMemo(
    () =>
      deletingBranchId && detail
        ? {
            node: detail.nodes.find((node) => node.id === deletingBranchId) ?? null,
            info: researchBranchInfo(detail.nodes, deletingBranchId),
          }
        : null,
    [deletingBranchId, detail],
  );

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

  const focusRequestRef = useRef<FocusRequest | null>(null);
  // The strip's horizontal position as of the last render: a re-render
  // never moves it; only an explicit reveal or settle does.
  const stripLeftRef = useRef<number | null>(null);
  stripLeftRef.current = columnsLayout?.row?.scrollLeft ?? null;
  const columnsLayoutRef = useRef(columnsLayout);
  columnsLayoutRef.current = columnsLayout;

  const resolveFocusTarget = useCallback(
    (target: FocusRequest["target"]): HTMLElement | null => {
      switch (target.kind) {
        case "row":
          return selectedRow(target.level);
        case "answer":
          return (
            pairColumn("answer", target.level)?.querySelector<HTMLElement>(":scope > .research-column-scroll") ??
            null
          );
        case "marker":
          return (
            pairColumn("answer", target.level)?.querySelector<HTMLElement>(
              `[data-research-marker="${CSS.escape(target.key)}"]`,
            ) ?? null
          );
        case "composer":
          return composerRefs.current.get(target.key)?.element()?.querySelector("textarea") ?? null;
      }
    },
    [pairColumn, selectedRow],
  );

  const processFocusRequest = useCallback(() => {
    const request = focusRequestRef.current;
    if (!request) {
      return;
    }
    const active = document.activeElement;
    if (
      Date.now() - request.at > FOCUS_REQUEST_TTL_MS ||
      (request.onlyIfLost && active && active !== document.body && active.isConnected)
    ) {
      focusRequestRef.current = null;
      return;
    }
    const element = resolveFocusTarget(request.target);
    if (!element) {
      return;
    }
    focusRequestRef.current = null;
    element.focus({ preventScroll: true });
    if (request.target.kind !== "answer") {
      scrollIntoColumn(element, request.target.kind === "composer" ? researchScrollBehavior() : "auto");
    }
    const row = columnsLayoutRef.current?.row ?? null;
    const column = element.closest<HTMLElement>("[data-research-column]");
    if (request.strip === "settle") {
      settleResearchStrip(row, column);
    } else if (request.strip === "reveal" && column) {
      const level = column.dataset.researchLevel;
      revealResearchColumns(
        row,
        level === undefined ? column : pairColumn("turns", Number(level)) ?? column,
        level === undefined ? column : pairColumn("answer", Number(level)) ?? column,
      );
    }
  }, [pairColumn, resolveFocusTarget]);

  const requestFocus = useCallback(
    (target: FocusRequest["target"], strip: FocusRequest["strip"] = "reveal", onlyIfLost = false) => {
      focusRequestRef.current = { target, strip, onlyIfLost, at: Date.now() };
      window.requestAnimationFrame(processFocusRequest);
    },
    [processFocusRequest],
  );

  useLayoutEffect(() => {
    const row = columnsLayoutRef.current?.row;
    const left = stripLeftRef.current;
    if (row && left !== null && Math.abs(row.scrollLeft - left) > 1) {
      row.scrollLeft = left;
    }
    processFocusRequest();
  });

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
    levelPath.forEach((id, level) => {
      levelMemoryRef.current.set(id, deepest);
      const head = levelChains[level]?.[0];
      if (head) {
        chainMemoryRef.current.set(head, id);
      }
    });
  }, [levelChains, levelPath]);

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

  /** Moves the deepest selection to `nodeId` without touching history. */
  const applyVisit = useCallback(
    (nodeId: string) => {
      if (!nodesRef.current.some((node) => node.id === nodeId) && !createdNodeIdsRef.current.has(nodeId)) {
        return;
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
          navigationPersistence.clearAsk(currentTreeId, dropped.parentNodeId);
        }
        setComposerText((text) => withoutKeys(text, [`draft:${dropped.parentNodeId}`]));
      }
      setMenu(null);
      markOpened(nodeId);
    },
    [markOpened, navigationPersistence, persistSelection],
  );

  /** User navigation: applies the visit and extends history. */
  const navigate = useCallback(
    (nodeId: string) => {
      applyVisit(nodeId);
      setHistory((current) =>
        current.entries[current.index] === nodeId ? current : pushResearchHistory(current, nodeId),
      );
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
      const remembered = chainMemoryRef.current.get(headId);
      const message =
        end === "first"
          ? chain[0]
          : end === "last" || !remembered || !chain.includes(remembered)
            ? chain[chain.length - 1]
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

  // Node-open requests from the app shell (feed rows, child rows, the
  // Highlights view) while this tree's document is already mounted. Focus
  // stays where the request came from; the strip shows the opened level.
  useEffect(
    () =>
      listenToResearchNodeOpen((request) => {
        if (request.treeId !== treeIdRef.current) {
          return;
        }
        navigate(request.nodeId);
        window.requestAnimationFrame(() => {
          const path = levelPathRef.current;
          const level = path.length - 1;
          const row = selectedRow(level);
          if (row) {
            scrollIntoColumn(row);
          }
          settleResearchStrip(columnsLayoutRef.current?.row ?? null, pairColumn("turns", level));
        });
      }),
    [navigate, pairColumn, selectedRow],
  );

  // Tree switch (the document is keyed per tree, so this is its mount):
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
    setQueues({ ...(navigation?.queuedFollowups ?? {}) });
    setSelectedNodeId(selected);
    setHistory(initResearchHistory(selected));
    setExpandedNodes({ ...navigation?.expandedByNode });
    setFullTraceNodes({});
    // Restoring reopens the levels without animation: the strip shows the
    // deepest level (and, when the feed and the first pair don't fit, the
    // answer rather than the feed).
    // Keyboard focus already in the pairs (→ from the feed) stays in view.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const row = columnsLayoutRef.current?.row ?? null;
        const focused =
          document.activeElement?.closest<HTMLElement>("[data-research-pair]") ?? null;
        settleResearchStrip(row, focused && row?.contains(focused) ? focused : null, "auto");
      }),
    );
    // Runs once per tree: the document remounts on tree switches, and the
    // first detail to arrive carries the root and the nodes to restore.
  }, [treeId, rootNodeId, Boolean(detail)]);

  const mainComposerKey = rootNodeId ?? "main";
  const draftKey = activePending ? `draft:${activePending.parentNodeId}` : null;
  useResearchComposerDrafts({
    persistence: navigationPersistence,
    treeId,
    mainText: composerText[mainComposerKey] ?? "",
    draft: activePending?.anchor ? { nodeId: activePending.parentNodeId, anchor: activePending.anchor } : null,
    draftText: draftKey ? composerText[draftKey] ?? "" : "",
    draftOpen: activePending !== null,
    // Only the deepest selection's saved new branch reopens: one saved under
    // a shallower message would close the levels the path restored.
    chainNodeIds: deepestSelection,
    contentByNode,
    setMainText: (text) =>
      setComposerText((current) =>
        (current[mainComposerKey] ?? "") === text ? current : { ...current, [mainComposerKey]: text },
      ),
    restoreDraft: (nodeId, anchor, text) => {
      // A saved new branch reopens after its parent, without taking focus.
      setSelectedNodeId(nodeId);
      setPending({ parentNodeId: nodeId, anchor });
      if (text) {
        setComposerText((current) => ({ ...current, [`draft:${nodeId}`]: text }));
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
      setHistory((history) => researchHistoryAfterRemoval(history, validNodeIds, fallback));
      const level = researchLevelPath(detail.nodes, fallback).length - 1;
      requestFocus({ kind: "row", level: Math.max(0, level) }, "settle", true);
    } else {
      setHistory((history) => pruneResearchHistory(history, validNodeIds, detail.tree.rootNodeId));
    }
  }, [createdNodes, detail, persistSelection, requestFocus, selectedNodeId, treeId]);

  const updateQueue = useCallback(
    (headId: string, transform: (queue: QueuedResearchFollowup[]) => QueuedResearchFollowup[]) => {
      const current = queuesRef.current;
      const next = transform(current[headId] ?? EMPTY_QUEUE);
      const updated = next.length === 0 ? withoutKeys(current, [headId]) : { ...current, [headId]: next };
      queuesRef.current = updated;
      setQueues(updated);
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.recordQueue(currentTreeId, headId, next);
      }
    },
    [navigationPersistence],
  );

  /** Opens a new branch on `anchor` (a passage) or on the whole answer of
   * `parentNodeId`, as the pair after the parent's level. Its ask box takes
   * focus. */
  const openDraft = useCallback(
    (parentNodeId: string, anchor: ResearchHighlightAnchor | null) => {
      if (archived) {
        return;
      }
      const previous = pendingRef.current;
      if (previous && previous.parentNodeId !== parentNodeId) {
        setComposerText((text) => withoutKeys(text, [`draft:${previous.parentNodeId}`]));
        const currentTreeId = treeIdRef.current;
        if (currentTreeId) {
          navigationPersistence.clearAsk(currentTreeId, previous.parentNodeId);
        }
      }
      setMenu(null);
      if (levelPathRef.current[levelPathRef.current.length - 1] !== parentNodeId) {
        setSelectedNodeId(parentNodeId);
        persistSelection(parentNodeId);
      }
      setPending({ parentNodeId, anchor });
      requestFocus({ kind: "composer", key: `draft:${parentNodeId}` }, "settle");
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
      navigationPersistence.clearAsk(currentTreeId, current.parentNodeId);
    }
    setComposerText((text) => withoutKeys(text, [`draft:${current.parentNodeId}`]));
    const level = levelPathRef.current.indexOf(current.parentNodeId);
    if (level >= 0) {
      requestFocus({ kind: "answer", level }, "settle");
    }
  }, [navigationPersistence, requestFocus]);

  // ---- history -------------------------------------------------------------

  const canGoBack = historyCanGoBack(history) || workspaceCanGoBack;
  const canGoForward = historyCanGoForward(history) || workspaceCanGoForward;

  const goBack = useCallback(() => {
    const step = researchHistoryBack(history);
    if (step) {
      applyVisit(step.nodeId);
      setHistory(step.history);
      return;
    }
    onWorkspaceBack?.();
  }, [applyVisit, history, onWorkspaceBack]);

  const goForward = useCallback(() => {
    const step = researchHistoryForward(history);
    if (step) {
      applyVisit(step.nodeId);
      setHistory(step.history);
      return;
    }
    onWorkspaceForward?.();
  }, [applyVisit, history, onWorkspaceForward]);

  // Keyboard: ⌘[ / ⌘] and Alt+←/→ (and mouse buttons 3/4) walk history; Esc
  // returns to the root conversation when no menu, popover, or dialog is
  // open. Keys are ignored while typing.
  const anyOverlayOpen =
    Boolean(menu) ||
    Boolean(highlightAction) ||
    Boolean(renameTarget) ||
    Boolean(deletingBranchId) ||
    Boolean(documentEditSession) ||
    Boolean(recapDialogNodeId);
  const anyOverlayOpenRef = useRef(anyOverlayOpen);
  anyOverlayOpenRef.current = anyOverlayOpen;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        // An IME composition uses Escape to cancel itself.
        if (event.isComposing || event.keyCode === 229 || anyOverlayOpenRef.current) {
          return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (
          isEditableTarget(event.target) ||
          target?.closest("[role='menu'], [role='dialog'], [role='alertdialog'], .popover-surface")
        ) {
          return;
        }
        if (levelPathRef.current.length > 0 && document.querySelector(".research-columns")?.contains(target ?? document.body)) {
          event.preventDefault();
          requestFocus({ kind: "row", level: 0 }, "reveal");
        }
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      const primary = event.metaKey || event.ctrlKey;
      let handler: (() => void) | null = null;
      if (primary && !event.altKey && !event.shiftKey && event.code === "BracketLeft") {
        handler = goBack;
      } else if (primary && !event.altKey && !event.shiftKey && event.code === "BracketRight") {
        handler = goForward;
      } else if (event.altKey && !primary && !event.shiftKey && event.key === "ArrowLeft") {
        handler = goBack;
      } else if (event.altKey && !primary && !event.shiftKey && event.key === "ArrowRight") {
        handler = goForward;
      }
      if (handler) {
        event.preventDefault();
        handler();
      }
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
    const mouseTarget = workspaceRef.current;
    window.addEventListener("keydown", onKeyDown);
    mouseTarget?.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      mouseTarget?.removeEventListener("mouseup", onMouseUp);
    };
  }, [goBack, goForward, requestFocus]);

  /** The branches of level `level`'s selected answer, in reading order. */
  const siblingsAt = useCallback((level: number) => {
    const parentId = levelPathRef.current[level];
    const branches = parentId ? branchesByParentRef.current.get(parentId) ?? EMPTY_BRANCHES : EMPTY_BRANCHES;
    return researchBranchesInReadingOrder(branches, (branchId) => {
      const entry = branchRangeOffsetsRef.current.find(
        (candidate) => candidate.id === branchId && candidate.segmentId === parentId,
      );
      return entry ? entry.start : null;
    });
  }, []);

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

  /** → from level `level`: into the open (or first) branch of its answer;
   * with no branches, into the answer. */
  const rightFrom = useCallback(
    (level: number) => {
      const siblings = siblingsAt(level);
      if (siblings.length === 0) {
        requestFocus({ kind: "answer", level }, "settle");
        return;
      }
      const open = levelPathRef.current[level + 1];
      const current = open
        ? siblings.find((branch) => inlineChainFor(nodesRef.current, branch.id).includes(open))
        : undefined;
      goBranch(level, (current ?? siblings[0]).id);
    },
    [goBranch, requestFocus, siblingsAt],
  );

  /** Keys in the pairs: ↑/↓ move between messages (and, at a branch
   * column's first or last message, to the previous or next branch of the
   * same answer), Enter opens a message's answer, → selects a row in the
   * branch column, ← goes to the parent message (or the feed). */
  const onPairsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) {
      return;
    }
    const key = event.key;
    if (target.matches("[data-research-row]")) {
      const level = Number(target.dataset.researchLevel);
      const nodeId = target.dataset.nodeId ?? "";
      const column = target.closest<HTMLElement>("[data-research-pair]");
      const rows = [...(column?.querySelectorAll<HTMLElement>("[data-research-row]") ?? [])];
      const index = rows.indexOf(target);
      if ((key === "ArrowDown" || key === "ArrowUp") && level > 0 && (key === "ArrowUp" ? index === 0 : index === rows.length - 1)) {
        const siblings = siblingsAt(level - 1);
        const head = levelChains[level]?.[0];
        const at = siblings.findIndex((branch) => branch.id === head);
        const next = siblings[key === "ArrowUp" ? at - 1 : at + 1];
        event.preventDefault();
        if (at >= 0 && next) {
          goBranch(level - 1, next.id, key === "ArrowUp" ? "last" : "first");
        }
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
        event.preventDefault();
        const nextIndex =
          key === "Home" ? 0 : key === "End" ? rows.length - 1 : index + (key === "ArrowDown" ? 1 : -1);
        const next = rows[Math.max(0, Math.min(rows.length - 1, nextIndex))];
        if (next) {
          for (const row of rows) row.tabIndex = row === next ? 0 : -1;
          next.focus({ preventScroll: true });
          scrollIntoColumn(next);
        }
        return;
      }
      if (key === "ArrowRight") {
        event.preventDefault();
        if (levelPathRef.current[level] === nodeId) {
          rightFrom(level);
          return;
        }
        // An unselected message: selecting it and opening its branch (the
        // one remembered under it, else the first) is one visit, in one
        // render; with no branches, only the selection.
        const branches = researchBranchesInReadingOrder(
          branchesByParentRef.current.get(nodeId) ?? EMPTY_BRANCHES,
          () => null,
        );
        if (branches.length > 0) {
          const remembered = levelMemoryRef.current.get(nodeId);
          const rememberedPath = remembered ? researchLevelPath(nodesRef.current, remembered) : [];
          const head = branches.find((branch) => rememberedPath.includes(branch.id)) ?? branches[0];
          openBranch(level, head.id);
          requestFocus({ kind: "row", level: level + 1 }, "settle");
        } else {
          selectMessage(level, nodeId);
          requestFocus({ kind: "answer", level }, "settle");
        }
        return;
      }
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        selectMessage(level, nodeId);
        requestFocus({ kind: "answer", level }, "reveal");
        return;
      }
      if (key === "ArrowLeft") {
        event.preventDefault();
        if (level > 0) {
          requestFocus({ kind: "row", level: level - 1 }, "reveal");
        } else {
          columnsLayoutRef.current?.focusFeed();
        }
      }
      return;
    }
    if (target.matches("[data-research-pair='answer'] > .research-column-scroll")) {
      const level = Number(target.closest<HTMLElement>("[data-research-pair]")?.dataset.researchLevel);
      if (key === "ArrowRight") {
        event.preventDefault();
        rightFrom(level);
      } else if (key === "ArrowLeft") {
        event.preventDefault();
        requestFocus({ kind: "row", level }, "reveal");
      }
    }
  };

  // ⌘J routed from the app-level shortcut dispatcher: the ask box of the
  // current pair (the deepest level before anything is focused; the feed's
  // composer while the feed is current).
  const currentLevelRef = useRef<number>(0);
  useEffect(
    () =>
      listenToResearchFollowupsFocus(() => {
        if (columnsLayoutRef.current?.feedCurrent) {
          document.querySelector<HTMLElement>(".research-feed-composer textarea")?.focus();
          return;
        }
        const level = currentLevelRef.current;
        const pendingNow = pendingRef.current;
        const key =
          pendingNow && level >= levelPathRef.current.length
            ? `draft:${pendingNow.parentNodeId}`
            : inlineChainFor(nodesRef.current, levelPathRef.current[level] ?? "")[0];
        if (key) {
          requestFocus({ kind: "composer", key }, "reveal");
        }
      }),
    [requestFocus],
  );

  // The current pair follows keyboard focus.
  useEffect(() => {
    const row = columnsLayout?.row;
    if (!row) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("[data-research-column='feed']")) {
        setFocusedLevel(-1);
        return;
      }
      const level = target.closest<HTMLElement>("[data-research-pair]")?.dataset.researchLevel;
      if (level !== undefined) {
        setFocusedLevel(Number(level));
      }
    };
    row.addEventListener("focusin", onFocusIn);
    return () => row.removeEventListener("focusin", onFocusIn);
  }, [columnsLayout?.row]);

  const hasColumn = researchDocumentHasColumn(detail, rootNodeId, selectedNodeId);
  useResearchSwipeNavigation(workspaceRef, goBack, goForward, hasColumn);

  // Dialogs return focus to the control that opened them (the … menu's
  // button). A deleted message takes its button along: focus then goes to the
  // row of the message it was asked from, else to the root's ask box.
  const deletedParentIdRef = useRef<string | null>(null);
  useResearchDialogReturnFocus(renameTarget !== null);
  useResearchDialogReturnFocus(deletingBranchId !== null, () => {
    const parentId = deletedParentIdRef.current;
    const previous = parentId
      ? document.querySelector<HTMLElement>(`[data-research-row][data-node-id="${CSS.escape(parentId)}"]`)
      : null;
    const composer = composerRefs.current.get(mainComposerKey)?.element()?.querySelector("textarea");
    // Deleting the research closes the document: the feed's composer.
    return (
      previous ??
      (composer?.isConnected ? composer : document.querySelector<HTMLElement>(".new-research-input"))
    );
  });

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

  // ---- content loading -----------------------------------------------------

  // Bound the cache to the open levels' messages.
  useEffect(() => {
    const keep = new Set([...levelChains.flat(), ...chainNodeIds]);
    const prune = <T,>(current: Record<string, T>) =>
      withoutKeys(current, Object.keys(current).filter((key) => !keep.has(key)));
    setContentByNode(prune);
    setContentErrorByNode(prune);
    for (const key of [...fetchStampByNodeRef.current.keys()]) {
      if (!keep.has(key)) {
        fetchStampByNodeRef.current.delete(key);
      }
    }
  }, [chainKey, levelChainsKey]);

  useEffect(() => {
    if (chainNodeIds.length === 0) {
      return;
    }
    let cancelled = false;
    const timers = new Map<string, number>();
    const errorCounts = new Map<string, number>();
    const stampFor = (nodeId: string) => {
      const node = detailRef.current?.nodes.find((candidate) => candidate.id === nodeId);
      return node ? `${node.status}:${node.responseSnapshotAt ?? 0}:${node.recap?.id ?? node.recap?.responseRevision ?? ""}` : "";
    };
    const clearError = (nodeId: string) =>
      setContentErrorByNode((current) => withoutKeys(current, [nodeId]));
    const load = async (nodeId: string) => {
      // Capture the stamp before fetching. A state transition during the fetch
      // restarts this effect and refetches with the new stamp.
      const stamp = stampFor(nodeId);
      try {
        const next = await getResearchNodeContent(nodeId);
        if (cancelled) {
          return;
        }
        errorCounts.delete(nodeId);
        fetchStampByNodeRef.current.set(nodeId, stamp);
        clearError(nodeId);
        setContentByNode((current) => ({ ...current, [nodeId]: next }));
        if (isActiveResearchStatus(next.node.status)) {
          timers.set(nodeId, window.setTimeout(() => void load(nodeId), 1000));
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        setContentErrorByNode((current) => ({
          ...current,
          [nodeId]: err instanceof Error ? err.message : String(err),
        }));
        const knownNode = detailRef.current?.nodes.find(
          (candidate) => candidate.id === nodeId,
        );
        const attempts = (errorCounts.get(nodeId) ?? 0) + 1;
        errorCounts.set(nodeId, attempts);
        const isActive = knownNode && isActiveResearchStatus(knownNode.status);
        if (isActive || attempts <= 5) {
          timers.set(
            nodeId,
            window.setTimeout(() => void load(nodeId), Math.min(5000, 1000 * attempts)),
          );
        }
      }
    };
    for (const nodeId of chainNodeIds) {
      const node = detailRef.current?.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        // A just-created branch the next detail refresh has not delivered.
        continue;
      }
      const hasContent = Boolean(contentByNodeRef.current[nodeId]);
      const hasError = Boolean(contentErrorByNodeRef.current[nodeId]);
      if (
        !hasContent ||
        hasError ||
        fetchStampByNodeRef.current.get(nodeId) !== stampFor(nodeId)
      ) {
        // A restart is a fresh load for this turn (status transition,
        // snapshot landing, retry): a failure reported by the previous run
        // must not sit on screen while this one is in flight.
        clearError(nodeId);
        void load(nodeId);
      } else if (isActiveResearchStatus(node.status)) {
        // The cleanup above cancelled this still-streaming turn's pending
        // poll timer. Re-arm it, or its live transcript freezes until its
        // own status finally changes.
        void load(nodeId);
      }
    }
    return () => {
      cancelled = true;
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
    };
    // Keyed on the chains' statuses and snapshot stamps rather than the
    // detail object: streaming runs replace `detail` on every event, and
    // restarting this effect for each replacement refetched and reparsed
    // unchanged content.
  }, [chainKey, chainStatusKey, contentLoadNonce]);

  // Each answer's scroll offset: restored once its content has loaded (a
  // short loading placeholder would clamp the offset), then recorded on
  // scroll, in memory and in the persisted store.
  useLayoutEffect(() => {
    if (!treeId) {
      return;
    }
    for (const nodeId of [...restoredAnswerScrollRef.current]) {
      if (!levelPath.includes(nodeId)) {
        restoredAnswerScrollRef.current.delete(nodeId);
      }
    }
    for (const nodeId of levelPath) {
      if (restoredAnswerScrollRef.current.has(nodeId) || !(contentByNode[nodeId] || contentErrorByNode[nodeId])) {
        continue;
      }
      const level = levelPath.indexOf(nodeId);
      const scroller = pairColumn("answer", level)?.querySelector<HTMLElement>(":scope > .research-column-scroll");
      if (!scroller) {
        continue;
      }
      restoredAnswerScrollRef.current.add(nodeId);
      scroller.scrollTop =
        answerScrollRef.current.get(nodeId) ??
        restoreResearchScrollPosition(navigationPersistence.store[treeId], nodeId);
    }
  }, [contentByNode, contentErrorByNode, levelPath, navigationPersistence, pairColumn, treeId]);

  // Each messages column, as it mounts: its scroll offset comes back (from
  // this visit, else the persisted store), then its selected message is
  // brought fully into view (top-aligned when taller than the column),
  // without animation. Showing the selected message can change the restored offset.
  useLayoutEffect(() => {
    if (!treeId) {
      return;
    }
    const heads = levelChains.map((chain) => chain[0]).filter((id): id is string => Boolean(id));
    for (const headId of [...restoredTurnsScrollRef.current]) {
      if (!heads.includes(headId)) {
        restoredTurnsScrollRef.current.delete(headId);
      }
    }
    heads.forEach((headId, level) => {
      if (restoredTurnsScrollRef.current.has(headId)) {
        return;
      }
      const scroller = pairColumn("turns", level)?.querySelector<HTMLElement>(":scope > .research-column-scroll");
      const row = selectedRow(level);
      if (!scroller || !row) {
        return;
      }
      restoredTurnsScrollRef.current.add(headId);
      scroller.scrollTop =
        turnsScrollRef.current.get(headId) ??
        restoreResearchScrollPosition(navigationPersistence.store[treeId], headId, Date.now(), "turns");
      scrollIntoColumn(row, "auto");
    });
  });

  const recordTurnsScroll = useCallback(
    (headId: string, scroller: HTMLElement) => {
      if (!restoredTurnsScrollRef.current.has(headId)) {
        return;
      }
      turnsScrollRef.current.set(headId, scroller.scrollTop);
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.recordScroll(currentTreeId, headId, scroller.scrollTop, "turns");
      }
    },
    [navigationPersistence],
  );

  const recordAnswerScroll = useCallback(
    (nodeId: string, scroller: HTMLElement) => {
      // The column never scrolls sideways legitimately (wide tables and code
      // blocks scroll inside their own containers), but programmatic scrolls
      // can still shift a hidden axis. Pin it back to the left edge.
      if (scroller.scrollLeft !== 0) {
        scroller.scrollLeft = 0;
      }
      if (!restoredAnswerScrollRef.current.has(nodeId)) {
        return;
      }
      answerScrollRef.current.set(nodeId, scroller.scrollTop);
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.recordScroll(currentTreeId, nodeId, scroller.scrollTop);
      }
    },
    [navigationPersistence],
  );

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

  // ---- annotation painting -------------------------------------------------

  // Diagram rendering and other child-owned Markdown controls can replace text
  // nodes without changing the transcript items. Observe those commits so saved
  // ranges are rebuilt against the current rendered projection. Only annotated
  // turns' response roots are observed.
  const annotatedSegmentsKey = chainNodeIds
    .filter((id) => {
      if (!contentByNode[id]?.responseRevision) {
        return false;
      }
      return (
        Boolean(contentByNode[id]?.node.highlights?.length) ||
        branchEntries.some((entry) => entry.segmentId === id)
      );
    })
    .join("\n");
  useEffect(() => {
    if (
      !annotatedSegmentsKey ||
      !researchHighlightApi() ||
      typeof MutationObserver === "undefined"
    ) {
      return;
    }
    const roots = annotatedSegmentsKey
      .split("\n")
      .map((id) => segmentRoot(id))
      .filter((root): root is HTMLDivElement => Boolean(root));
    if (roots.length === 0) {
      return;
    }
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setHighlightDomNonce((value) => value + 1);
      });
    });
    for (const root of roots) {
      observer.observe(root, { childList: true, characterData: true, subtree: true });
    }
    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [annotatedSegmentsKey, revisionsKey, expandedKey, fullTraceKey, segmentRoot]);

  // Keep the two saved-highlight paint objects registered for this document's
  // lifetime. Mutating their range sets avoids WebKit leaving deleted registry
  // paint on screen until an unrelated selection or pointer event invalidates
  // the text layer.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_HIGHLIGHT_NAME);
    api?.registry.delete(RESEARCH_SELECTED_NAME);
    if (!api) {
      return;
    }
    const saved = new api.Highlight();
    const selected = new api.Highlight();
    selected.priority = RESEARCH_SELECTED_PRIORITY;
    savedHighlightPaintRef.current = saved;
    selectedHighlightPaintRef.current = selected;
    api.registry.set(RESEARCH_HIGHLIGHT_NAME, saved);
    api.registry.set(RESEARCH_SELECTED_NAME, selected);
    return () => {
      savedHighlightPaintRef.current = null;
      selectedHighlightPaintRef.current = null;
      api.registry.delete(RESEARCH_HIGHLIGHT_NAME);
      api.registry.delete(RESEARCH_SELECTED_NAME);
    };
  }, []);

  // Paint saved ranges without rewriting the markdown DOM, across every
  // rendered turn. The CSS Custom Highlight registry is name-global, so all
  // turns' ranges aggregate into one Highlight object per layer. Anchors
  // retain an exact quote and nearby context so they can be relocated when
  // transcript visibility changes shift the flat rendered-text offsets.
  useLayoutEffect(() => {
    const painted = savedHighlightPaintRef.current;
    painted?.clear();
    resolvedHighlightsRef.current = new Map();
    const hidden: Record<string, number> = {};
    if (painted) {
      for (const nodeId of chainNodeIds) {
        const root = segmentRoot(nodeId);
        const segmentContent = contentByNode[nodeId];
        if (!root || !segmentContent?.responseRevision) {
          continue;
        }
        const projection = root.textContent ?? "";
        const resolved: ResolvedHighlight[] = [];
        for (const highlight of segmentContent.node.highlights ?? []) {
          const offsets = resolveResearchHighlightOffset(
            projection,
            segmentContent.responseRevision,
            highlight,
          );
          if (!offsets) {
            continue;
          }
          const range = rangeForTextOffsets(root, offsets.start, offsets.end);
          if (!range) {
            continue;
          }
          painted.add(range);
          resolved.push({ highlight, ...offsets });
        }
        resolvedHighlightsRef.current.set(nodeId, resolved);
        const missing = (segmentContent.node.highlights?.length ?? 0) - resolved.length;
        if (missing > 0) {
          hidden[nodeId] = missing;
        }
      }
    }
    setHiddenHighlightsByNode((current) => (sameNumberRecord(current, hidden) ? current : hidden));
    if (treeId && navigationPersistence.store[treeId]?.focusHighlight) {
      setHighlightPaintVersion((version) => version + 1);
    }
    // Keyed on the revisions and highlight-id lists rather than contentByNode
    // identity: a streaming turn's 1s poll replaces the map every second, and
    // repainting would re-walk every settled turn's text nodes each time for
    // content that cannot have moved.
  }, [
    chainKey,
    chainNodeIds,
    highlightsKey,
    revisionsKey,
    expandedKey,
    fullTraceKey,
    highlightDomNonce,
    segmentRoot,
  ]);


  // Reveal the highlight opened from the Highlights feed. After restoring
  // the answer's scroll offset and painting the passage, scroll the passage
  // a third of the way down its column, flash it, and clear the request.
  // Waiting for restoration prevents it from overriding this scroll.
  useLayoutEffect(() => {
    if (!treeId) {
      return;
    }
    const navigation = navigationPersistence.store[treeId];
    const focus = navigation?.focusHighlight;
    if (!navigation || !focus || !restoredAnswerScrollRef.current.has(focus.nodeId)) {
      return;
    }
    const segmentContent = contentByNode[focus.nodeId];
    if (!segmentContent?.responseRevision) {
      return;
    }
    const clear = () => {
      delete navigation.focusHighlight;
      navigationPersistence.flush();
    };
    const resolved = resolvedHighlightsRef.current
      .get(focus.nodeId)
      ?.find(({ highlight }) => highlight.id === focus.highlightId);
    const root = segmentRoot(focus.nodeId);
    if (!resolved || !root) {
      const stillExists = segmentContent.node.highlights?.some(
        (highlight) => highlight.id === focus.highlightId,
      );
      if (!stillExists || resolvedHighlightsRef.current.has(focus.nodeId)) {
        clear();
      }
      return;
    }
    const range = rangeForTextOffsets(root, resolved.start, resolved.end);
    const scroller = root.closest<HTMLElement>(".research-column-scroll");
    clear();
    if (!range || !scroller) {
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    scroller.scrollTop += rect.top - scrollerRect.top - Math.max(72, scrollerRect.height / 3);
    setFlashRange({ nodeId: focus.nodeId, start: resolved.start, end: resolved.end });
  }, [contentByNode, highlightPaintVersion, navigationPersistence, segmentRoot, treeId]);

  // Paint branch passages (blue) and resolve their offsets for clicks, hover,
  // and reveal. The passages of open branches are also underlined; a new
  // branch's passage has only a dashed underline. Anchors that no longer
  // locate a passage simply drop out.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_BRANCH_NAME);
    api?.registry.delete(RESEARCH_OPEN_BRANCH_NAME);
    api?.registry.delete(RESEARCH_PENDING_BRANCH_NAME);
    branchRangeOffsetsRef.current = [];
    if (!api) {
      return;
    }
    const painted = new api.Highlight();
    const open = new api.Highlight();
    open.priority = RESEARCH_OPEN_PRIORITY;
    const pending = new api.Highlight();
    pending.priority = RESEARCH_OPEN_PRIORITY;
    let paintedAny = false;
    let openAny = false;
    let pendingAny = false;
    const openIds = new Set(openBranchKey ? openBranchKey.split(",") : []);
    for (const nodeId of chainNodeIds) {
      const root = segmentRoot(nodeId);
      const revision = contentByNode[nodeId]?.responseRevision;
      if (!root || !revision) {
        continue;
      }
      const projection = root.textContent ?? "";
      for (const { id, anchor } of branchEntries.filter((entry) => entry.segmentId === nodeId)) {
        const offsets = resolveResearchHighlightOffset(projection, revision, {
          id,
          anchor,
          createdAt: 0,
        });
        const range = offsets ? rangeForTextOffsets(root, offsets.start, offsets.end) : null;
        if (!range || !offsets) {
          continue;
        }
        branchRangeOffsetsRef.current.push({ segmentId: nodeId, id, ...offsets });
        if (id === PENDING_BRANCH_ID) {
          pending.add(range);
          pendingAny = true;
          continue;
        }
        painted.add(range);
        paintedAny = true;
        if (openIds.has(id)) {
          const underline = rangeForTextOffsets(root, offsets.start, offsets.end);
          if (underline) {
            open.add(underline);
            openAny = true;
          }
        }
      }
    }
    if (paintedAny) {
      api.registry.set(RESEARCH_BRANCH_NAME, painted);
    }
    if (openAny) {
      api.registry.set(RESEARCH_OPEN_BRANCH_NAME, open);
    }
    if (pendingAny) {
      api.registry.set(RESEARCH_PENDING_BRANCH_NAME, pending);
    }
    return () => {
      api.registry.delete(RESEARCH_BRANCH_NAME);
      api.registry.delete(RESEARCH_OPEN_BRANCH_NAME);
      api.registry.delete(RESEARCH_PENDING_BRANCH_NAME);
    };
    // revisionsKey instead of contentByNode identity for the same reason as
    // the saved-highlight paint above.
  }, [
    branchEntries,
    chainKey,
    chainNodeIds,
    openBranchKey,
    revisionsKey,
    expandedKey,
    fullTraceKey,
    highlightDomNonce,
    segmentRoot,
  ]);

  // Margin markers: for each open answer, one marker level with each
  // paragraph that has branched passages, and one at the end for branches
  // from the whole answer (and passages that no longer resolve, after a
  // rerun). Positions are measured from the painted ranges, after the branch
  // paint above, and again whenever an answer's layout changes.
  useLayoutEffect(() => {
    const next: Record<string, BranchMarker[]> = {};
    for (const nodeId of levelPath) {
      const branches = branchesByParent.get(nodeId) ?? EMPTY_BRANCHES;
      if (branches.length === 0) {
        continue;
      }
      const root = segmentRoot(nodeId);
      if (!root) {
        continue;
      }
      const answer = root.closest<HTMLElement>(".research-answer");
      const byBlock = new Map<HTMLElement, string[]>();
      const whole: string[] = [];
      for (const branch of branches) {
        const entry = branchRangeOffsetsRef.current.find(
          (candidate) => candidate.id === branch.id && candidate.segmentId === nodeId,
        );
        const range = entry ? rangeForTextOffsets(root, entry.start, entry.end) : null;
        const block = range ? passageBlockAt(root, range.startContainer) : null;
        if (block) {
          byBlock.set(block, [...(byBlock.get(block) ?? []), branch.id]);
        } else {
          whole.push(branch.id);
        }
      }
      const answerTop = answer?.getBoundingClientRect().top ?? 0;
      const markers: BranchMarker[] = [...byBlock.entries()]
        .map(([block, ids]) => ({ block, ids, top: block.getBoundingClientRect().top - answerTop }))
        .sort((a, b) => a.top - b.top)
        .map(({ ids, top }, index) => ({
          key: `p${index}`,
          top: Math.round(top),
          branchIds: researchBranchesInReadingOrder(
            ids.map((id) => nodeById.get(id)).filter((node): node is ResearchNode => Boolean(node)),
            (branchId) => branchRangeOffsetsRef.current.find((entry) => entry.id === branchId)?.start ?? null,
          ).map((node) => node.id),
        }));
      if (whole.length > 0) {
        markers.push({ key: "end", top: null, branchIds: whole });
      }
      next[nodeId] = markers;
    }
    setMarkersByNode((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [
    branchEntries,
    branchesByParent,
    levelPath,
    markerLayoutNonce,
    nodeById,
    revisionsKey,
    expandedKey,
    fullTraceKey,
    highlightDomNonce,
    segmentRoot,
  ]);

  // Paragraphs move when an answer reflows (the window resizes, an image or
  // diagram loads): measure the markers again.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setMarkerLayoutNonce((value) => value + 1);
        });
      }
    });
    for (const nodeId of levelPath) {
      const root = segmentRoot(nodeId);
      if (root) {
        observer.observe(root);
      }
    }
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [highlightDomNonce, levelPath, segmentRoot]);

  // Repaint regions where annotations stack — highlights over each other, or
  // a branch passage over a highlight — in the near-text overlap tone, so
  // stacked coverage stays visible.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_OVERLAP_NAME);
    if (!api) {
      return;
    }
    const painted = new api.Highlight();
    painted.priority = RESEARCH_OVERLAP_PRIORITY;
    let paintedAny = false;
    for (const nodeId of chainNodeIds) {
      const root = segmentRoot(nodeId);
      if (!root) {
        continue;
      }
      const ranges = [
        ...(resolvedHighlightsRef.current.get(nodeId) ?? []),
        ...branchRangeOffsetsRef.current.filter(
          (entry) => entry.segmentId === nodeId && entry.id !== PENDING_BRANCH_ID,
        ),
      ].map(({ start, end }) => ({ start, end }));
      for (const region of overlappingResearchHighlightRegions(ranges)) {
        const range = rangeForTextOffsets(root, region.start, region.end);
        if (!range) {
          continue;
        }
        painted.add(range);
        paintedAny = true;
      }
    }
    if (paintedAny) {
      api.registry.set(RESEARCH_OVERLAP_NAME, painted);
    }
    return () => {
      api.registry.delete(RESEARCH_OVERLAP_NAME);
    };
  }, [
    branchEntries,
    chainKey,
    chainNodeIds,
    highlightsKey,
    openBranchKey,
    revisionsKey,
    expandedKey,
    fullTraceKey,
    highlightDomNonce,
    segmentRoot,
  ]);

  // The passage under the pointer returns to full strength (tints are dimmed
  // outside the focused column) and darkens one step.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_HOVER_BRANCH_NAME);
    api?.registry.delete(RESEARCH_HOVER_HIGHLIGHT_NAME);
    const root = hoveredAnnotation ? segmentRoot(hoveredAnnotation.nodeId) : null;
    if (!api || !hoveredAnnotation || !root) {
      return;
    }
    const range = rangeForTextOffsets(root, hoveredAnnotation.start, hoveredAnnotation.end);
    if (!range) {
      return;
    }
    const painted = new api.Highlight();
    painted.priority = RESEARCH_HOVER_PRIORITY;
    painted.add(range);
    const name =
      hoveredAnnotation.kind === "branch" ? RESEARCH_HOVER_BRANCH_NAME : RESEARCH_HOVER_HIGHLIGHT_NAME;
    api.registry.set(name, painted);
    return () => {
      api.registry.delete(name);
    };
  }, [highlightDomNonce, hoveredAnnotation, segmentRoot]);

  // A passage flash (jumping to a branch's source, landing on a highlight).
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_FLASH_NAME);
    const root = flashRange ? segmentRoot(flashRange.nodeId) : null;
    if (!api || !flashRange || !root) {
      return;
    }
    const range = rangeForTextOffsets(root, flashRange.start, flashRange.end);
    if (!range) {
      return;
    }
    const painted = new api.Highlight();
    painted.priority = RESEARCH_FLASH_PRIORITY;
    painted.add(range);
    api.registry.set(RESEARCH_FLASH_NAME, painted);
    const timer = window.setTimeout(() => setFlashRange(null), FLASH_MS);
    return () => {
      window.clearTimeout(timer);
      api.registry.delete(RESEARCH_FLASH_NAME);
    };
  }, [flashRange, segmentRoot]);

  // A selection overlapping saved highlights repaints those annotations in
  // the standard selection tone, above the amber layer.
  const selectedHighlightKey = (highlightAction?.highlightIds ?? []).join("\n");
  const highlightActionNodeId = highlightAction?.nodeId ?? null;
  useLayoutEffect(() => {
    const painted = selectedHighlightPaintRef.current;
    painted?.clear();
    const root = highlightActionNodeId ? segmentRoot(highlightActionNodeId) : null;
    if (!painted || !root || !selectedHighlightKey || !highlightActionNodeId) {
      return;
    }
    const selectedIds = selectedHighlightKey.split("\n");
    for (const { highlight, start, end } of resolvedHighlightsRef.current.get(
      highlightActionNodeId,
    ) ?? []) {
      if (!selectedIds.includes(highlight.id)) {
        continue;
      }
      const range = rangeForTextOffsets(root, start, end);
      if (!range) {
        continue;
      }
      painted.add(range);
    }
  }, [highlightActionNodeId, highlightDomNonce, segmentRoot, selectedHighlightKey]);

  // ---- selection, highlights, and passage clicks ----------------------------

  const captureHighlightSelection = useCallback(() => {
    const selection = window.getSelection();
    if (
      !researchHighlightApi() ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      setHighlightAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    // Resolve which turn the selection landed in; a selection that spans
    // turns anchors nowhere.
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const root = container?.closest<HTMLElement>(".research-response-content-root") ?? null;
    const nodeId = root?.dataset.nodeId ?? null;
    const segmentContent = nodeId ? contentByNodeRef.current[nodeId] : null;
    const revision = segmentContent?.responseRevision ?? "";
    const node = nodeId ? detailRef.current?.nodes.find((candidate) => candidate.id === nodeId) : null;
    // A streaming answer has no revision to anchor to yet; its selection can
    // still be copied.
    const live = isLiveResearchSelection(revision, node?.status);
    if (!root || !nodeId || !segmentContent || (!revision && !live) || root.closest(".is-leaving")) {
      setHighlightAction(null);
      return;
    }
    if (selectionTouchesNonTextRow(root, range)) {
      setHighlightAction(null);
      return;
    }
    const offsets = selectionOffsets(root, range);
    if (!offsets) {
      setHighlightAction(null);
      return;
    }
    const projection = root.textContent ?? "";
    const copyText = projection.slice(offsets.start, offsets.end);
    // A highlight or branch passage stays within one paragraph: a selection
    // that runs into the next one is cut at the end of the first.
    const startBlock = passageBlockAt(root, range.startContainer);
    const { crossed, ...clipped } = clipResearchSelectionToParagraph(
      projection,
      offsets,
      startBlock && !startBlock.contains(range.endContainer)
        ? flatTextOffsetAt(root, startBlock, startBlock.childNodes.length)
        : null,
    );
    offsets.start = clipped.start;
    offsets.end = clipped.end;
    const exact = projection.slice(offsets.start, offsets.end);
    const resolvedRanges = (resolvedHighlightsRef.current.get(nodeId) ?? []).map(
      ({ highlight, start, end }) => ({
        id: highlight.id,
        start,
        end,
      }),
    );
    const highlightIds = intersectingResearchHighlightIds(offsets, resolvedRanges);
    // Whitespace cannot form a useful new highlight, but it can still be a
    // selected subset of an existing annotation that the user wants removed.
    if (!exact.trim() && highlightIds.length === 0) {
      setHighlightAction(null);
      return;
    }
    // Keep the quote's surrounding context inside the message it belongs to
    // so the anchor resolves the same in either transcript view.
    const contextBounds = researchAnchorContextBounds({
      isConversation: segmentContent?.node.kind === "conversation",
      messageBounds: enclosingMessageFlatBounds(root, range),
      projectionLength: projection.length,
    });
    if (!contextBounds) {
      setHighlightAction(null);
      return;
    }
    const contextFloor = contextBounds.start;
    const contextCeil = contextBounds.end;
    const anchorForOffsets = (span: {
      start: number;
      end: number;
    }): ResearchHighlightAnchor => ({
      version: 1,
      projection: "answer-v1",
      responseRevision: revision,
      start: span.start,
      end: span.end,
      exact: projection.slice(span.start, span.end),
      prefix: textContextSlice(
        projection,
        Math.max(contextFloor, span.start - RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
        span.start,
      ),
      suffix: textContextSlice(
        projection,
        span.end,
        Math.min(contextCeil, span.end + RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
      ),
    });
    const expandOffsets = live ? null : expandedResearchHighlightOffsets(offsets, resolvedRanges);
    setHighlightAction({
      nodeId,
      live,
      crossed,
      copyText,
      anchor: anchorForOffsets(offsets),
      highlightIds: live ? [] : highlightIds,
      expandAnchor: expandOffsets ? anchorForOffsets(expandOffsets) : null,
      ...highlightActionPlacement(range, selectionActionsSizeRef.current),
    });
  }, []);

  /** Replaces the native character-precise drag range with whole-word
   * endpoints. The raw range is checked first so snapping never makes an
   * otherwise ineligible selection (one crossing tool/thinking machinery)
   * eligible for Highlight/Branch. */
  const applySnappedResearchSelection = useCallback(
    (drag: ResearchSelectionDrag, clientX: number, clientY: number) => {
      if (!drag.snapEligible || drag.anchorOffset === null) {
        return;
      }
      const focusOffset = flatOffsetAtPoint(drag.root, clientX, clientY);
      if (focusOffset === null) {
        return;
      }
      if (focusOffset !== drag.anchorOffset) {
        const rawRange = rangeForTextOffsets(
          drag.root,
          Math.min(drag.anchorOffset, focusOffset),
          Math.max(drag.anchorOffset, focusOffset),
        );
        if (!rawRange || selectionTouchesNonTextRow(drag.root, rawRange)) {
          if (rawRange) {
            applyDirectionalSelectionRange(
              rawRange,
              focusOffset < drag.anchorOffset ? "backward" : "forward",
            );
          }
          return;
        }
      }

      if (drag.snapper === undefined) {
        drag.snapper = createResearchSelectionSnapper(
          drag.root.textContent ?? "",
          document.documentElement.lang || navigator.language,
          messageFlatBoundaries(drag.root),
        );
      }
      const snapped = drag.snapper?.(drag.anchorOffset, focusOffset) ?? null;
      if (!snapped) {
        return;
      }
      const range = rangeForTextOffsets(drag.root, snapped.start, snapped.end);
      if (!range) {
        return;
      }
      // Keep the live focus on the pointer side, so a subsequent keyboard
      // extension continues from the end the reader last moved.
      applyDirectionalSelectionRange(range, snapped.direction);
    },
    [],
  );

  // A mouse selection can begin in the answer and end over other column
  // chrome, where the response root's mouseup never fires. Remember
  // answer-originated drags and finish them from a document-level fallback.
  const beginHighlightSelectionDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const root = event.currentTarget;
      const nodeId = root.dataset.nodeId ?? null;
      const content = nodeId ? contentByNodeRef.current[nodeId] : null;
      const target = event.target instanceof Element ? event.target : null;
      const anchorOffset = flatOffsetAtPoint(root, event.clientX, event.clientY);
      selectionDragRef.current = {
        root,
        anchorOffset,
        originX: event.clientX,
        originY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        active: false,
        // The snapper splits its word units at every message seam, so it
        // moves each endpoint by at most a partial word within one turn.
        snapEligible: Boolean(
          researchHighlightApi() &&
            nodeId &&
            content?.responseRevision &&
            anchorOffset !== null &&
            !target?.closest(NON_TEXT_ROW_SELECTOR)
        ),
        snapper: undefined,
        frame: null,
      };
    },
    [],
  );
  const finishHighlightSelectionDrag = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const drag = selectionDragRef.current;
      if (!drag) {
        return;
      }
      selectionDragRef.current = null;
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      if (drag.active) {
        applySnappedResearchSelection(drag, event.clientX, event.clientY);
      }
      captureHighlightSelection();
    },
    [applySnappedResearchSelection, captureHighlightSelection],
  );
  useEffect(() => {
    const cancelDrag = () => {
      const drag = selectionDragRef.current;
      selectionDragRef.current = null;
      if (drag?.frame !== null && drag?.frame !== undefined) {
        window.cancelAnimationFrame(drag.frame);
      }
    };
    const updateDrag = (event: MouseEvent) => {
      const drag = selectionDragRef.current;
      if (!drag) {
        return;
      }
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      if (
        !drag.active &&
        Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) >=
          RESEARCH_SELECTION_DRAG_THRESHOLD
      ) {
        drag.active = true;
      }
      if (!drag.active || !drag.snapEligible || drag.frame !== null) {
        return;
      }
      drag.frame = window.requestAnimationFrame(() => {
        drag.frame = null;
        if (selectionDragRef.current === drag) {
          applySnappedResearchSelection(drag, drag.lastX, drag.lastY);
        }
      });
    };
    const resnapNativeSelection = () => {
      const drag = selectionDragRef.current;
      if (!drag?.active || !drag.snapEligible) {
        return;
      }
      // WebKit updates its native character-level range after mousemove. Fix
      // that range in the ensuing selectionchange task, before the next
      // paint, so a slow drag never exposes partial endpoint words.
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      applySnappedResearchSelection(drag, drag.lastX, drag.lastY);
    };
    document.addEventListener("mousemove", updateDrag);
    document.addEventListener("mouseup", finishHighlightSelectionDrag);
    document.addEventListener("selectionchange", resnapNativeSelection);
    window.addEventListener("blur", cancelDrag);
    return () => {
      document.removeEventListener("mousemove", updateDrag);
      document.removeEventListener("mouseup", finishHighlightSelectionDrag);
      document.removeEventListener("selectionchange", resnapNativeSelection);
      window.removeEventListener("blur", cancelDrag);
      cancelDrag();
    };
  }, [applySnappedResearchSelection, finishHighlightSelectionDrag]);

  // A plain click on a tinted passage opens its branch; with several
  // branches there, or a highlight, it opens a menu instead. CSS highlights
  // have no DOM nodes, so the click is hit-tested against the turn's
  // resolved flat-offset ranges.
  const openAnnotationAtPoint = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const root = event.currentTarget;
      const nodeId = root.dataset.nodeId;
      const selection = window.getSelection();
      if (!root || !nodeId || !selection || !selection.isCollapsed) {
        return;
      }
      // Links keep their own click behavior.
      if (event.target instanceof Element && event.target.closest("a")) {
        return;
      }
      const offset = flatOffsetAtPoint(root, event.clientX, event.clientY);
      if (offset === null) {
        return;
      }
      const branchIds = branchRangeOffsetsRef.current
        .filter(
          (entry) =>
            entry.segmentId === nodeId &&
            entry.id !== PENDING_BRANCH_ID &&
            offset >= entry.start &&
            offset < entry.end,
        )
        .map((entry) => entry.id);
      const highlight = (resolvedHighlightsRef.current.get(nodeId) ?? []).find(
        ({ start, end }) => offset >= start && offset < end,
      );
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
      setHighlightAction(null);
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
    [goBranch],
  );

  // Passage-side hover: hit-test the pointer against the turn's resolved
  // highlight and branch ranges (rAF-throttled), for the pointer cursor and
  // the hover tone.
  const trackAnnotationUnderPointer = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    annotationHoverPointerRef.current = {
      root: event.currentTarget,
      nodeId: event.currentTarget.dataset.nodeId ?? null,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (annotationHoverFrameRef.current !== null) {
      return;
    }
    annotationHoverFrameRef.current = window.requestAnimationFrame(() => {
      annotationHoverFrameRef.current = null;
      const sample = annotationHoverPointerRef.current;
      annotationHoverPointerRef.current = null;
      if (!sample) {
        return;
      }
      const { root, nodeId, clientX, clientY } = sample;
      if (!nodeId || !root.isConnected) {
        return;
      }
      const segmentBranches = branchRangeOffsetsRef.current.filter(
        (entry) => entry.segmentId === nodeId && entry.id !== PENDING_BRANCH_ID,
      );
      const segmentHighlights = resolvedHighlightsRef.current.get(nodeId) ?? [];
      const offset =
        segmentBranches.length > 0 || segmentHighlights.length > 0
          ? flatOffsetAtPoint(root, clientX, clientY)
          : null;
      const branch =
        offset === null
          ? undefined
          : segmentBranches.find(({ start, end }) => offset >= start && offset < end);
      const highlight =
        offset === null
          ? undefined
          : segmentHighlights.find(({ start, end }) => offset >= start && offset < end);
      const next = branch
        ? { nodeId, start: branch.start, end: branch.end, kind: "branch" as const }
        : highlight
          ? { nodeId, start: highlight.start, end: highlight.end, kind: "highlight" as const }
          : null;
      setPointerAnnotationNodeId((current) => {
        const value = next ? nodeId : null;
        return current === value ? current : value;
      });
      setHoveredAnnotation((current) =>
        current?.nodeId === next?.nodeId &&
        current?.start === next?.start &&
        current?.end === next?.end &&
        current?.kind === next?.kind
          ? current
          : next,
      );
    });
  }, []);

  const clearAnnotationPointer = useCallback(() => {
    if (annotationHoverFrameRef.current !== null) {
      window.cancelAnimationFrame(annotationHoverFrameRef.current);
      annotationHoverFrameRef.current = null;
    }
    annotationHoverPointerRef.current = null;
    setPointerAnnotationNodeId(null);
    setHoveredAnnotation(null);
  }, []);

  // One updater for every optimistic highlight mutation.
  const patchNodeHighlights = useCallback(
    (
      nodeId: string,
      transform: (highlights: ResearchHighlight[]) => ResearchHighlight[],
    ) => {
      setContentByNode((current) => {
        const entry = current[nodeId];
        if (!entry) {
          return current;
        }
        return {
          ...current,
          [nodeId]: {
            ...entry,
            node: {
              ...entry.node,
              highlights: transform(entry.node.highlights ?? []),
            },
          },
        };
      });
    },
    [],
  );

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

  // Highlight: saves the selection, merging it with every highlight it
  // overlaps (creation first — if removal then fails, the leftover is
  // overlapping highlights, not a lost annotation). A selection inside one
  // highlight, with nothing to merge, removes that highlight instead.
  const applyHighlightAction = useCallback(async () => {
    if (!highlightAction || highlightAction.live || savingHighlight) {
      return;
    }
    const targetNodeId = highlightAction.nodeId;
    if (!contentByNodeRef.current[targetNodeId]) {
      return;
    }
    setSavingHighlight(true);
    try {
      if (highlightAction.expandAnchor) {
        const created = await createResearchHighlight(targetNodeId, highlightAction.expandAnchor);
        const removed =
          highlightAction.highlightIds.length > 0
            ? await removeResearchHighlights(targetNodeId, highlightAction.highlightIds)
            : [];
        const removedIds = new Set(removed.map(({ id }) => id));
        patchNodeHighlights(targetNodeId, (highlights) => [
          ...highlights.filter(({ id }) => !removedIds.has(id)),
          created,
        ]);
      } else if (highlightAction.highlightIds.length > 0) {
        await removeHighlights(targetNodeId, highlightAction.highlightIds);
      } else {
        const created = await createResearchHighlight(targetNodeId, highlightAction.anchor);
        patchNodeHighlights(targetNodeId, (highlights) => [...highlights, created]);
        if (highlightAction.crossed) {
          onToast("Highlighted to the end of the paragraph. A highlight stays within one paragraph.");
        }
      }
      selectedHighlightPaintRef.current?.clear();
      window.getSelection()?.removeAllRanges();
      setHighlightAction(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingHighlight(false);
    }
  }, [highlightAction, onError, onToast, patchNodeHighlights, removeHighlights, savingHighlight]);

  // The selection can start a branch only while its turn can take one: that
  // node finished, and the tree accepts branches.
  const highlightActionNode = highlightAction
    ? nodeById.get(highlightAction.nodeId) ?? null
    : null;
  const selectionBranchBlocker = !highlightAction?.anchor.exact.trim()
    ? "Select some text first"
    : branchBlockerFor(highlightActionNode, archived);

  const branchFromSelection = useCallback(() => {
    if (!highlightAction || selectionBranchBlocker) {
      return;
    }
    const { nodeId, anchor } = highlightAction;
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
    openDraft(nodeId, anchor);
  }, [highlightAction, openDraft, selectionBranchBlocker]);

  const copySelection = useCallback(async () => {
    if (!highlightAction) {
      return;
    }
    const text = highlightAction.copyText;
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
    try {
      await writeClipboardText(text);
      onToast("Copied.");
    } catch {
      onToast("Couldn't copy.", "warning");
    }
  }, [highlightAction, onToast]);

  // Centring needs the bar's own size, which depends on its note line: after
  // it renders, measure it and place it again if the size was off.
  const selectionActionsRef = useRef<HTMLDivElement | null>(null);
  const highlightActionLayoutKey = highlightAction
    ? `${highlightAction.nodeId}:${highlightAction.live}:${selectionBranchBlocker ?? ""}`
    : "";
  useLayoutEffect(() => {
    const bar = selectionActionsRef.current;
    const selection = window.getSelection();
    if (!bar || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }
    const size = { width: bar.offsetWidth, height: bar.offsetHeight };
    const previous = selectionActionsSizeRef.current;
    if (size.width === previous.width && size.height === previous.height) {
      return;
    }
    selectionActionsSizeRef.current = size;
    const placement = highlightActionPlacement(selection.getRangeAt(0), size);
    setHighlightAction((current) => (current ? { ...current, ...placement } : current));
  }, [highlightActionLayoutKey]);

  // Keyed on the bar's existence, not the action object: repositioning below
  // replaces the object on every scroll frame.
  const hasHighlightAction = Boolean(highlightAction);
  useEffect(() => {
    if (!hasHighlightAction) {
      return;
    }
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".research-selection-actions")) {
        setHighlightAction(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setHighlightAction(null);
        return;
      }
      if (savingHighlight || isEditableTarget(event.target)) {
        return;
      }
      // H highlights (merging with what it overlaps), E is kept as the old
      // expand/merge key, and A — formerly Ask — starts a branch.
      if (isResearchAskActionShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        branchFromSelection();
        return;
      }
      if (isResearchHighlightActionShortcut(event) || isResearchExpandActionShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void applyHighlightAction();
      }
    };
    // The selection stays valid across scrolls and resizes, so follow it
    // instead of dismissing (rAF-throttled), and drop the bar only if the
    // selection itself has gone away.
    let repositionFrame: number | null = null;
    const reposition = () => {
      if (repositionFrame !== null) {
        return;
      }
      repositionFrame = window.requestAnimationFrame(() => {
        repositionFrame = null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setHighlightAction(null);
          return;
        }
        const range = selection.getRangeAt(0);
        setHighlightAction((current) => {
          if (!current) {
            return current;
          }
          const placement = highlightActionPlacement(range, selectionActionsSizeRef.current);
          return current.left !== placement.left ||
            current.top !== placement.top ||
            current.offscreen !== placement.offscreen
            ? { ...current, ...placement }
            : current;
        });
      });
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      if (repositionFrame !== null) {
        window.cancelAnimationFrame(repositionFrame);
      }
    };
  }, [applyHighlightAction, branchFromSelection, hasHighlightAction, savingHighlight]);

  // ---- run controls and composers -------------------------------------------

  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onRetryNodeRef = useRef(onRetryNode);
  onRetryNodeRef.current = onRetryNode;
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;
  const handleCancelNode = useCallback((nodeId: string) => {
    if (cancelRequestInFlightRef.current) {
      return;
    }
    cancelRequestInFlightRef.current = true;
    setCancelling(true);
    onCancelRef.current(nodeId)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // Completion can beat the click to the backend. The desired stopped
        // state is already reached; genuine cleanup failures still surface.
        if (message !== "research run is not active") {
          onErrorRef.current(message);
        }
      })
      .finally(() => {
        cancelRequestInFlightRef.current = false;
        setCancelling(false);
      });
  }, []);
  // Relaunches a settled node in place. Ref-guarded against double entry from
  // two controls for the same node. While another answer in its conversation
  // runs, the retry waits behind it (see the queued-retry effect).
  const retryRequestInFlightRef = useRef(false);
  const handleRetryNode = useCallback((nodeId: string) => {
    if (retryRequestInFlightRef.current) {
      return;
    }
    const nodesNow = nodesRef.current;
    const busy = inlineChainFor(nodesNow, nodeId).some(
      (id) => id !== nodeId && isActiveResearchStatus(nodesNow.find((node) => node.id === id)?.status ?? "complete"),
    );
    if (busy) {
      setQueuedRetries((current) => new Set(current).add(nodeId));
      onToastRef.current("Queued. It runs after the running answer finishes.");
      return;
    }
    retryRequestInFlightRef.current = true;
    setRetryingNodeId(nodeId);
    onRetryNodeRef.current(nodeId)
      .catch((err) => onErrorRef.current(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        retryRequestInFlightRef.current = false;
        setRetryingNodeId((current) => (current === nodeId ? null : current));
      });
  }, []);
  // Removing a queued retry brings the failed attempt back.
  const removeQueuedRetry = useCallback((nodeId: string) => {
    setQueuedRetries((current) => {
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
  }, []);
  /** A click on a message row: selects it and brings its pair into view. */
  const selectRow = useCallback(
    (nodeId: string, level: number) => {
      selectMessage(level, nodeId);
      requestFocus({ kind: "row", level }, "reveal");
    },
    [requestFocus, selectMessage],
  );
  const retryContentLoad = useCallback(() => setContentLoadNonce((value) => value + 1), []);
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
  const togglePromoted = useCallback((nodeId: string) => {
    const node = detailRef.current?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return;
    }
    const promoted = !node.promotedAt;
    setResearchNodePromoted(nodeId, promoted)
      .then(() =>
        onToastRef.current(
          promoted
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
    // Opens to the right of the button in the question's meta row, so it
    // stays over the conversation column.
    setMenu({ kind: "answer", nodeId, anchor: trigger, align: "start", trigger });
  }, []);
  const openContextMenu = useCallback((nodeId: string, clientX: number, clientY: number) => {
    setMenu({ kind: "answer", nodeId, anchor: researchMenuPoint(clientX, clientY), align: "point" });
  }, []);

  const handleEditQuestion = useCallback((nodeId: string) => {
    const currentDetail = detailRef.current;
    const node = currentDetail?.nodes.find((candidate) => candidate.id === nodeId);
    if (!currentDetail || !node) {
      return;
    }
    const headId = inlineChainFor(currentDetail.nodes, nodeId)[0] ?? nodeId;
    setEditingByHead((current) => ({ ...current, [headId]: nodeId }));
    setComposerText((current) => ({ ...current, [headId]: node.prompt }));
    requestFocus({ kind: "composer", key: headId }, "reveal");
  }, [requestFocus]);

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

  // Per chain head, the follow-up last sent from it: `true` while the fork
  // request runs, then the new child's id until the detail includes it. The
  // chain's tail is stale until then, so nothing else is sent from it.
  const queueInFlightRef = useRef(new Map<string, string | true>());
  const [queueReleases, setQueueReleases] = useState(0);
  const awaitChainChild = useCallback((headId: string, childId: string) => {
    const inFlight = queueInFlightRef.current;
    inFlight.set(headId, childId);
    window.setTimeout(() => {
      if (inFlight.get(headId) === childId) {
        inFlight.delete(headId);
        setQueueReleases((count) => count + 1);
      }
    }, QUEUE_CHILD_WAIT_MS);
  }, []);

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
            request.queryAnchor,
            request.inline,
            request.replyAnchor,
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
      if (step === "wait" || queued.length > 0 || queueInFlightRef.current.has(headId)) {
        updateQueue(headId, (queue) => [
          ...queue,
          { id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, prompt, createdAt: Date.now() },
        ]);
        clearComposer();
        return;
      }
      if (step === "stalled" || !canContinueThread(currentDetail.nodes, tail)) {
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
    [addCreatedNode, archived, awaitChainChild, mainComposerKey, navigate, navigationPersistence, requestFocus, updateQueue],
  );

  /** Sends the new branch's first question: the branch is created with it
   * and becomes the next level, with its ask box focused. */
  const submitDraft = useCallback(async () => {
    const current = pendingRef.current;
    if (!current) {
      return;
    }
    const key = `draft:${current.parentNodeId}`;
    const prompt = (composerTextRef.current[key] ?? "").trim();
    if (!prompt || submittingKeyRef.current || archived) {
      return;
    }
    setSubmittingKey(key);
    try {
      const child = await onForkRef.current(current.parentNodeId, prompt, current.anchor, false);
      const currentTreeId = treeIdRef.current;
      if (currentTreeId) {
        navigationPersistence.clearAsk(currentTreeId, current.parentNodeId);
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

  // Send each chain's first queued follow-up once its tail completes. A
  // chain stays blocked from the send until the child it created is in the
  // detail (see researchQueueAction); a child that never arrives releases
  // the chain after QUEUE_CHILD_WAIT_MS.
  useEffect(() => {
    if (!detail || archived) {
      return;
    }
    const inFlight = queueInFlightRef.current;
    for (const [headId, pending] of [...inFlight]) {
      if (typeof pending === "string" && nodeById.has(pending)) {
        inFlight.delete(headId);
      }
    }
    for (const [headId, queue] of Object.entries(queues)) {
      const action = researchQueueAction(detail.nodes, headId, queue, inFlight.get(headId));
      if (action.kind === "clear") {
        updateQueue(headId, () => []);
        continue;
      }
      if (action.kind !== "send") {
        continue;
      }
      const { item, tailId } = action;
      inFlight.set(headId, true);
      onFork(tailId, item.prompt, null, true)
        .then((child) => {
          awaitChainChild(headId, child.id);
          updateQueue(headId, (current) => current.filter((entry) => entry.id !== item.id));
        })
        .catch((err) => {
          inFlight.delete(headId);
          const message = err instanceof Error ? err.message : String(err);
          updateQueue(headId, (current) =>
            current.map((entry) => (entry.id === item.id ? { ...entry, failed: message } : entry)),
          );
        });
    }
  }, [archived, awaitChainChild, detail, nodeById, onFork, queueReleases, queues, updateQueue]);

  // After Retry on a queued question, focus that drops to the page (the
  // question was sent and its item, with the focused button, went away)
  // moves to the chain's composer.
  const queueRefocusRef = useRef<{ headId: string; itemId: string } | null>(null);
  useLayoutEffect(() => {
    const pending = queueRefocusRef.current;
    if (!pending || (queuesRef.current[pending.headId] ?? EMPTY_QUEUE).some((item) => item.id === pending.itemId)) {
      return;
    }
    queueRefocusRef.current = null;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      composerRefs.current.get(pending.headId)?.focus();
    }
  });

  // A retry waits while another answer in its conversation runs, and starts
  // once none does.
  useEffect(() => {
    if (queuedRetries.size === 0) {
      return;
    }
    for (const nodeId of queuedRetries) {
      const node = nodeById.get(nodeId);
      if (!node || !canRetryResearchNode(node)) {
        setQueuedRetries((current) => {
          const next = new Set(current);
          next.delete(nodeId);
          return next;
        });
        continue;
      }
      const busy = inlineChainFor(nodes, nodeId).some(
        (id) => id !== nodeId && isActiveResearchStatus(nodeById.get(id)?.status ?? "complete"),
      );
      if (!busy) {
        setQueuedRetries((current) => {
          const next = new Set(current);
          next.delete(nodeId);
          return next;
        });
        handleRetryNode(nodeId);
      }
    }
  }, [handleRetryNode, nodeById, nodes, queuedRetries]);

  const onOpenNodesChangeRef = useRef(onOpenNodesChange);
  onOpenNodesChangeRef.current = onOpenNodesChange;
  const openNodesKey = [
    levelPath[0] ?? "",
    ...levelChains.slice(1).map((chain) => chain[0] ?? ""),
  ].join("\n");
  useEffect(() => {
    onOpenNodesChangeRef.current?.(openNodesKey.split("\n").filter(Boolean));
  }, [openNodesKey]);
  useEffect(() => () => onOpenNodesChangeRef.current?.([]), []);

  // Running turns tick their elapsed clock once a second; relative times in
  // the meta rows refresh once a minute.
  const anyChainRunActive = chainNodes.some((node) => isActiveResearchStatus(node.status));
  useEffect(() => {
    setMetadataNow(Date.now());
    if (!anyChainRunActive) {
      return;
    }
    const timer = window.setInterval(() => setMetadataNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyChainRunActive, chainKey]);
  useEffect(() => {
    const timer = window.setInterval(() => setMinuteNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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
        const prompt = view.isDocument || view.isConversation ? null : chainNode.prompt.trim() || null;
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

  async function saveDocumentEdit(input: { markdown: string; title: string | null }) {
    if (!documentEditSession) {
      throw new Error("The document is not available for editing.");
    }
    const result = await onUpdateDocument({
      nodeId: documentEditSession.nodeId,
      markdown: input.markdown,
      title: input.title,
      expectedResponseRevision: documentEditSession.responseRevision,
      expectedTitle: documentEditSession.title,
      expectedHighlightIds: documentEditSession.highlightIds,
    });
    if (treeIdRef.current === result.tree.id && result.markdownChanged) {
      // Do not leave the old revision visible after the modal closes. The
      // existing loader refetches the atomically replaced snapshot.
      const editedNodeId = documentEditSession.nodeId;
      setContentByNode((current) => withoutKeys(current, [editedNodeId]));
      fetchStampByNodeRef.current.delete(editedNodeId);
      setContentLoadNonce((value) => value + 1);
    }
    if (result.removedHighlightCount > 0) {
      onToast(
        `Document updated · ${result.removedHighlightCount.toLocaleString()} highlight${
          result.removedHighlightCount === 1 ? "" : "s"
        } removed`,
      );
    } else {
      onToast("Document updated");
    }
  }

  async function confirmRename() {
    if (!renameTarget || !detail || renaming) {
      return;
    }
    const title = renameTarget.value.trim();
    if (!title) {
      return;
    }
    setRenaming(true);
    try {
      if (renameTarget.nodeId === detail.tree.rootNodeId) {
        await onRenameTree(detail.tree.id, title);
      } else {
        await renameResearchNode(renameTarget.nodeId, title);
      }
      setRenameTarget(null);
    } catch (err) {
      // The dialog stays open with the typed title.
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenaming(false);
    }
  }

  async function confirmBranchRemoval() {
    if (!deletingBranch?.node || !deletingBranch.info || deletingBranch.info.hasActiveRuns) {
      return;
    }
    setBranchRemovalError(null);
    setRemovingBranch(true);
    try {
      if (deletingBranch.node.id === detail?.tree.rootNodeId) {
        await onRemoveTree(detail.tree.id);
        setDeletingBranchId(null);
        return;
      }
      deletedParentIdRef.current = deletingBranch.node.parentNodeId ?? null;
      // Whether the open path runs through what is removed, checked before the
      // call: the caller prunes the detail before the call resolves.
      const subtree = new Set([deletingBranch.node.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const node of nodesRef.current) {
          if (node.parentNodeId && subtree.has(node.parentNodeId) && !subtree.has(node.id)) {
            subtree.add(node.id);
            grew = true;
          }
        }
      }
      const wasOnPath = levelPathRef.current.some((id) => subtree.has(id));
      const removal = await onRemoveBranch(deletingBranch.node.id);
      // The backend call and detail refresh can outlive this document's tree.
      if (treeIdRef.current !== removal.treeId) {
        setDeletingBranchId(null);
        return;
      }
      const removedNodeIds = new Set(removal.removedNodeIds);
      setCreatedNodes((current) => current.filter((entry) => !removedNodeIds.has(entry.node.id)));
      for (const id of removedNodeIds) {
        createdNodeIdsRef.current.delete(id);
      }
      const validNodeIds = new Set(
        nodesRef.current.filter((node) => !removedNodeIds.has(node.id)).map((node) => node.id),
      );
      // A removed message on the open path: the message it was asked from
      // becomes the deepest selection, which closes the levels after it.
      if (wasOnPath && removal.parentNodeId) {
        const parentId = removal.parentNodeId;
        setSelectedNodeId(parentId);
        persistSelection(parentId);
        setHistory((current) => researchHistoryAfterRemoval(current, validNodeIds, parentId));
      } else {
        setHistory((current) => pruneResearchHistory(current, validNodeIds, removal.parentNodeId));
      }
      setDeletingBranchId(null);
    } catch (err) {
      setBranchRemovalError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingBranch(false);
    }
  }

  if (!detail || !rootNodeId || !selectedNodeId || levelPath.length === 0) {
    // A failed *tree* fetch retries through the app shell — without detail
    // there is no node to load, so no in-document retry can recover.
    const placeholderError = detailError ?? null;
    const headerTitle = detail?.tree.title ?? treeTitle ?? "Loading research…";
    return (
      <ResearchDocumentFrame title={headerTitle}>
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
      </ResearchDocumentFrame>
    );
  }

  const rootNode = nodeById.get(rootNodeId) ?? null;
  const treeTitleText = detail.tree.title;
  const lastLevel = pendingLevel ?? levelPath.length - 1;
  const currentLevel =
    focusedLevel !== null && focusedLevel <= lastLevel ? focusedLevel : lastLevel;
  currentLevelRef.current = currentLevel < 0 ? lastLevel : currentLevel;

  // ---- rendering -------------------------------------------------------------

  /** Whether any node in the branch headed by `headId`, or in a branch below
   * it, is running or queued. */
  const branchBusy = (headId: string) => {
    const stack = [headId];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = nodeById.get(id);
      if (node && isActiveResearchStatus(node.status)) {
        return true;
      }
      for (const candidate of nodes) {
        if (candidate.parentNodeId === id) {
          stack.push(candidate.id);
        }
      }
    }
    return false;
  };

  const isUnread = (branch: ResearchNode) =>
    branch.status === "complete" &&
    firstSeenCompleteRef.current.get(branch.id) === false &&
    !openedNodeIds.has(branch.id);

  const renderRows = (chainIds: readonly string[], level: number) =>
    chainIds.map((id, index) => {
      const node = nodeById.get(id);
      if (!node) {
        return null;
      }
      const branches = branchesByParent.get(id) ?? EMPTY_BRANCHES;
      const whole = node.kind === "document" || node.kind === "conversation";
      const replyQuote = node.replyAnchor
        ? nodeById.get(node.parentNodeId ?? "")?.delivery?.replies?.find(
            (reply) => reply.id === node.replyAnchor,
          )?.body ?? null
        : null;
      const selected = levelPath[level] === id;
      return (
        <ResearchMessageRow
          key={id}
          node={node}
          level={level}
          label={nodeLabel(node, treeTitleText)}
          showPrompt={!whole}
          replyQuote={replyQuote}
          selected={selected}
          now={minuteNow}
          starrable={level === 0 ? index > 0 && Boolean(node.inline) : index === 0}
          retryQueued={queuedRetries.has(id)}
          branchCount={branches.length}
          branchOpen={selected && (levelPath.length > level + 1 || activePending?.parentNodeId === id)}
          branchUnread={branches.some(isUnread)}
          answerMenuOpen={menu?.kind === "answer" && menu.nodeId === id && Boolean(menu.trigger)}
          registerSegmentElement={registerSegmentElement}
          onSelect={selectRow}
          onTogglePromoted={togglePromoted}
          onShowBranches={showBranches}
          onOpenAnswerMenu={openAnswerMenu}
          onOpenContextMenu={openContextMenu}
        />
      );
    });

  const renderQueue = (headId: string) =>
    (queues[headId] ?? EMPTY_QUEUE).map((item, index) => {
      const chain = inlineChainFor(nodes, headId);
      const tail = nodeById.get(chain[chain.length - 1] ?? "") ?? null;
      const stalled = index === 0 && !item.failed && researchQueueStep(tail) === "stalled";
      const remove = () => {
        updateQueue(headId, (queue) => queue.filter((entry) => entry.id !== item.id));
        window.requestAnimationFrame(() => composerRefs.current.get(headId)?.focus());
      };
      // Retry removes the Retry button: focus moves to the item's Remove
      // button, and to the ask box once the question has been sent (see
      // queueRefocusRef).
      const retry = (event: React.MouseEvent<HTMLButtonElement>) => {
        const row = event.currentTarget.closest("li");
        queueRefocusRef.current = { headId, itemId: item.id };
        updateQueue(headId, (queue) =>
          queue.map((entry) => (entry.id === item.id ? { ...entry, failed: undefined } : entry)),
        );
        window.requestAnimationFrame(() => {
          if (row?.isConnected) {
            row.querySelector<HTMLButtonElement>(".research-queue-remove")?.focus();
          }
        });
      };
      // Editing moves the question into the ask box. Text already there is
      // never replaced or merged into it: the reader clears it first.
      const edit = () => {
        if ((composerTextRef.current[headId] ?? "").trim()) {
          onToast("Clear the ask box to edit this question.");
          return;
        }
        updateQueue(headId, (queue) => queue.filter((entry) => entry.id !== item.id));
        setComposerText((current) => ({ ...current, [headId]: item.prompt }));
        window.requestAnimationFrame(() => composerRefs.current.get(headId)?.focus());
      };
      return (
        <li key={item.id} className="research-msg-row is-status-queued is-client-queued">
          <div className="research-msg-content">
            <div className="research-msg-plain is-typed">{item.prompt}</div>
          </div>
          <div className="research-msg-meta">
            <time dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>
              {shortWhen(item.createdAt, minuteNow)}
            </time>
            <span className={`research-msg-pill${item.failed || stalled ? " is-error" : " is-plain"}`}>
              {item.failed || stalled ? "Not sent" : "Queued"}
            </span>
          </div>
          {item.failed || stalled ? (
            <p className="research-msg-note" role={item.failed ? "alert" : undefined}>
              {item.failed ?? "The answer above stopped; retry it, or edit this question."}
            </p>
          ) : null}
          <div className="research-turn-actions research-msg-actions">
            {item.failed ? (
              <button type="button" className="control-button research-turn-button" onClick={retry}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>Retry</span>
              </button>
            ) : null}
            {stalled || item.failed ? (
              <button type="button" className="control-button research-turn-button is-ghost" onClick={edit}>
                Edit question
              </button>
            ) : null}
            <button
              type="button"
              className="control-button research-turn-button is-ghost research-queue-remove"
              onClick={remove}
            >
              Remove
            </button>
          </div>
        </li>
      );
    });

  const registerComposer = (key: string) => (handle: ResearchComposerHandle | null) => {
    if (handle) {
      composerRefs.current.set(key, handle);
    } else {
      composerRefs.current.delete(key);
    }
  };

  /** A messages column's ask box: continue the chain (queueing while it
   * runs), or replace a failed question being edited. */
  const renderChainComposer = (headId: string, chainIds: readonly string[], level: number) => {
    const chain = chainIds
      .map((id) => nodeById.get(id))
      .filter((node): node is ResearchNode => Boolean(node));
    const tail = chain[chain.length - 1] ?? null;
    const head = chain[0] ?? null;
    if (!tail || !head || head.kind === "note") {
      return null;
    }
    const text = composerText[headId] ?? "";
    const editingId = editingByHead[headId];
    const step = researchQueueStep(tail);
    const queued = (queues[headId] ?? EMPTY_QUEUE).length > 0;
    const awaitingCheckpoint = tail.status === "complete" && !canFollowUpFrom(tail);
    const canSend =
      !archived &&
      (Boolean(editingId) || step === "wait" || queued || canContinueThread(nodes, tail));
    const note = editingId
      ? null
      : archived
        ? "Archived questions are read-only. Move the question out of Archive to continue."
        : awaitingCheckpoint
          ? "Waiting for the native session checkpoint before continuing."
          : step === "stalled" && !queued
            ? tail.status === "failed"
              ? "The last answer stopped with an error. Retry it or edit its question to continue."
              : "The last answer was stopped. Run it again to continue."
            : null;
    const busy = chain.some((node) => isActiveResearchStatus(node.status));
    const placeholder = editingId
      ? "Edit the question"
      : head.kind === "document" && chain.length === 1
        ? "Ask about this document"
        : head.kind === "conversation" && chain.length === 1
          ? "Ask about this conversation"
          : busy || queued
            ? "Ask a follow-up (queued)"
            : "Ask a follow-up";
    const cancelEditing = () => {
      setEditingByHead((current) => withoutKeys(current, [headId]));
      setComposerText((current) => ({ ...current, [headId]: "" }));
      requestFocus({ kind: "composer", key: headId }, "none");
    };
    return (
      <ResearchConversationComposer
        ref={registerComposer(headId)}
        value={text}
        placeholder={placeholder}
        ariaLabel={
          editingId ? "Edit the failed question" : level === 0 ? "Follow-up in this conversation" : "Follow-up in this branch"
        }
        mode={
          editingId
            ? {
                label: (
                  <>
                    <b>Editing</b> the failed question. Sending replaces the failed attempt.
                  </>
                ),
                cancelLabel: "Cancel editing",
                onCancel: cancelEditing,
              }
            : null
        }
        disabled={archived || (step === "stalled" && !editingId && !queued)}
        canSubmit={canSend}
        submitting={submittingKey === headId}
        note={note}
        shortcutHint={shortcutHintsShown && currentLevel === level ? "⌘J" : null}
        requireCmdEnter={requireCmdEnterToSend}
        onChange={(value) => setComposerText((current) => ({ ...current, [headId]: value }))}
        onSubmit={() => void submitComposer(headId)}
        onSubmitBranch={() => void submitComposer(headId, { branch: true })}
      />
    );
  };

  /** The passage a branch was asked about, a muted block at the top of its
   * messages column. */
  const sourceBlock = (anchor: ResearchHighlightAnchor | null, parentId: string, branchId: string | null) => {
    const resolves = branchId
      ? branchRangeOffsetsRef.current.some((entry) => entry.id === branchId)
      : Boolean(anchor);
    const parentLoaded = Boolean(contentByNode[parentId]);
    const quote = anchor ? quoteDisplayText(anchor.exact) : null;
    return (
      <div className="research-branch-source">
        <CornerDownRight size={13} aria-hidden="true" />
        <span className="research-branch-source-quote">
          {quote && (resolves || !parentLoaded) ? (
            <i>“{quote}”</i>
          ) : quote ? (
            `The whole answer (was “${quote}”, before the answer was rerun)`
          ) : (
            "The whole answer"
          )}
        </span>
      </div>
    );
  };

  const renderMarker = (level: number, marker: BranchMarker) => {
    const openHead = levelChains[level + 1]?.[0] ?? null;
    const openIndex = openHead ? marker.branchIds.indexOf(openHead) : -1;
    const target = marker.branchIds[openIndex < 0 ? 0 : openIndex];
    const count = marker.branchIds.length;
    const running = marker.branchIds.some(branchBusy);
    const whole = marker.top === null;
    const what =
      count === 1
        ? whole
          ? "1 branch from the whole answer"
          : "1 branch from this paragraph"
        : `${count} branches from ${whole ? "the whole answer" : "this paragraph"}`;
    const targetPrompt = nodeById.get(target)?.prompt ?? "";
    const label =
      openIndex >= 0
        ? `${what}, one is open${running ? ", running" : ""}. Closes it.`
        : `${what}${running ? ", running" : ""}. Opens: ${targetPrompt.split(/\s+/).join(" ").trim().slice(0, 80)}`;
    const showTip = (element: HTMLElement) =>
      setMarkerTip(openIndex >= 0 ? null : { element, branchIds: marker.branchIds, level });
    return (
      <button
        key={marker.key}
        type="button"
        className={`research-marker${openIndex >= 0 ? " is-open" : ""}${running ? " is-running" : ""}${
          whole ? " is-end" : ""
        }`}
        style={whole ? undefined : { top: marker.top ?? 0 }}
        data-research-marker={marker.key}
        aria-label={label}
        aria-current={openIndex >= 0 ? "true" : undefined}
        onMouseEnter={(event) => showTip(event.currentTarget)}
        onMouseLeave={() => setMarkerTip(null)}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) {
            showTip(event.currentTarget);
          }
        }}
        onBlur={() => setMarkerTip(null)}
        onClick={() => {
          setMarkerTip(null);
          if (openIndex >= 0) {
            closeAfter(level);
            requestFocus({ kind: "marker", level, key: marker.key }, "settle");
          } else if (target) {
            goBranch(level, target);
          }
        }}
      >
        <ResearchBranchIcon size={13} />
        {count > 1 ? <span className="research-tnum">{count}</span> : null}
      </button>
    );
  };

  const renderAnswerColumn = (level: number, nodeId: string) => {
    const node = nodeById.get(nodeId);
    const view = segmentViews.get(nodeId);
    if (!node || !view) {
      return null;
    }
    const active = isActiveResearchStatus(node.status);
    const markers = markersByNode[nodeId] ?? [];
    const endMarker = markers.find((marker) => marker.top === null) ?? null;
    const footTime = node.status === "complete" ? (node.completedAt ?? node.createdAt) : null;
    return (
      <section
        key={pairColumnKey("answer", level, nodeId)}
        className={`research-pair-answer${currentLevel === level ? " is-current" : ""}`}
        data-research-column={`A${level}`}
        data-research-pair="answer"
        data-research-level={level}
        aria-label={`Answer to: ${researchPairLabel(nodeLabel(node, treeTitleText))}`}
      >
        <header className="research-column-header is-spanned">
          <div className="research-column-bar" data-tauri-drag-region />
        </header>
        <div
          className="research-column-scroll"
          tabIndex={-1}
          onScroll={(event) => recordAnswerScroll(nodeId, event.currentTarget)}
        >
          <article className="research-answer research-reading-surface">
            <ResearchAnswerPane
              view={view}
              node={node}
              contentError={contentErrorByNode[nodeId] ?? null}
              cancelling={cancelling}
              elapsedText={active && node.startedAt ? formatElapsedClock(metadataNow - node.startedAt) : null}
              waitsForParent={
                node.status === "queued" &&
                isActiveResearchStatus(nodeById.get(node.parentNodeId ?? "")?.status ?? "complete")
              }
              recapPending={recapPendingNodeIds.has(nodeId)}
              pointerOverAnnotation={pointerAnnotationNodeId === nodeId}
              canRetry={!archived && canRetryResearchNode(node)}
              retrying={retryingNodeId === nodeId}
              retryQueued={queuedRetries.has(nodeId)}
              canEditQuestion={!archived && node.status === "failed" && Boolean(node.parentNodeId)}
              registerSegmentElement={registerSegmentElement}
              onExpandTurns={expandAllTurns}
              onRetryContentLoad={retryContentLoad}
              onToggleFullTrace={toggleFullTrace}
              onCancelNode={handleCancelNode}
              onRetryNode={handleRetryNode}
              onRemoveQueuedRetry={removeQueuedRetry}
              onEditQuestion={handleEditQuestion}
              onRootMouseDown={beginHighlightSelectionDrag}
              onRootMouseUp={finishHighlightSelectionDrag}
              onRootKeyUp={captureHighlightSelection}
              onRootClick={openAnnotationAtPoint}
              onRootMouseMove={trackAnnotationUnderPointer}
              onRootMouseLeave={clearAnnotationPointer}
            />
            {markers.filter((marker) => marker.top !== null).map((marker) => renderMarker(level, marker))}
            {footTime !== null || endMarker ? (
              <div className={`research-answer-foot${footTime === null ? " is-bare" : ""}`}>
                {footTime !== null ? (
                  <div className="research-answer-foot-meta">
                    <time dateTime={new Date(footTime).toISOString()} title={new Date(footTime).toLocaleString()}>
                      {shortWhen(footTime, minuteNow)}
                    </time>
                  </div>
                ) : null}
                {endMarker ? renderMarker(level, endMarker) : null}
              </div>
            ) : null}
          </article>
        </div>
      </section>
    );
  };

  const historyNav = {
    canGoBack,
    canGoForward,
    backTitle: `Back (${IS_MAC ? "⌘[" : "Ctrl+["})`,
    forwardTitle: `Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`,
    onBack: goBack,
    onForward: goForward,
  };

  const levelColumns = levelPath.map((selectedId, level) => {
    const chainIds = levelChains[level] ?? [selectedId];
    const headId = chainIds[0] ?? selectedId;
    const head = nodeById.get(headId);
    const current = currentLevel === level ? " is-current" : "";
    if (level === 0 && rootNode?.kind === "note") {
      return (
        <section
          key={pairColumnKey("turns", 0, headId)}
          className={`research-pair-note${current}`}
          data-research-column="T0"
          data-research-pair="turns"
          data-research-level={0}
          aria-label={`Thread: ${treeTitleText}`}
        >
          {/* The note itself starts the column, so the header names the
              column ("Thread") rather than repeating the note's text. */}
          <ResearchPairHeader title="Thread" history={historyNav} archived={archived} />
          <div className="research-column-scroll">
            <div className="research-column-content research-reading-surface">
              <ResearchNoteDocument
                detail={detail}
                note={rootNode}
                archived={archived}
                actions={noteActions}
                requireCmdEnterToSend={requireCmdEnterToSend}
                onSelectNode={(nodeId) => navigate(nodeId)}
              />
            </div>
          </div>
        </section>
      );
    }
    const turns = (
      <section
        key={pairColumnKey("turns", level, headId)}
        className={`research-pair-turns${current}`}
        data-research-column={`T${level}`}
        data-research-pair="turns"
        data-research-level={level}
        aria-label={`${level === 0 ? "Messages" : "Branch messages"}: ${
          level === 0 ? treeTitleText : nodeLabel(head, "Branch")
        }`}
      >
        <ResearchPairHeader
          title={level === 0 ? treeTitleText : nodeLabel(head, "Branch")}
          branch={level === 0 ? null : chainIds.length}
          history={level === 0 ? historyNav : null}
          imported={level === 0 && rootNode?.origin === "terminalExport"}
          archived={level === 0 && archived}
          onAsk={
            head && head.kind !== "note"
              ? () => requestFocus({ kind: "composer", key: headId }, "reveal")
              : undefined
          }
        />
        <div className="research-column-scroll" onScroll={(event) => recordTurnsScroll(headId, event.currentTarget)}>
          <div className="research-column-content research-reading-surface">
            {level > 0 && head?.parentNodeId ? sourceBlock(head.queryAnchor ?? null, head.parentNodeId, headId) : null}
            <ul className="research-msg-list">
              {renderRows(chainIds, level)}
              {renderQueue(headId)}
            </ul>
            {renderChainComposer(headId, chainIds, level)}
          </div>
        </div>
      </section>
    );
    return [turns, renderAnswerColumn(level, selectedId)];
  });

  const pendingColumn =
    activePending && pendingLevel !== null ? (
      <section
        key={`P${pendingLevel}:${activePending.parentNodeId}`}
        className={`research-pair-turns is-pending${currentLevel === pendingLevel ? " is-current" : ""}`}
        data-research-column={`P${pendingLevel}`}
        data-research-pair="turns"
        data-research-level={pendingLevel}
        aria-label="New branch"
      >
        <ResearchPairHeader title="New branch" branch="new" />
        <div className="research-column-scroll">
          <div className="research-column-content research-reading-surface">
            {sourceBlock(activePending.anchor, activePending.parentNodeId, null)}
            <ResearchConversationComposer
              ref={registerComposer(`draft:${activePending.parentNodeId}`)}
              value={composerText[`draft:${activePending.parentNodeId}`] ?? ""}
              placeholder={activePending.anchor ? "Ask about this passage" : "Ask about this answer"}
              ariaLabel="First question of the new branch"
              mode={{ label: <b>New branch</b>, cancelLabel: "Cancel branch", onCancel: cancelPending }}
              requireCmdEnter={requireCmdEnterToSend}
              disabled={archived}
              canSubmit={!archived}
              submitting={submittingKey === `draft:${activePending.parentNodeId}`}
              shortcutHint={shortcutHintsShown && currentLevel === pendingLevel ? "⌘J" : null}
              onChange={(value) =>
                setComposerText((current) => ({ ...current, [`draft:${activePending.parentNodeId}`]: value }))
              }
              onSubmit={() => void submitDraft()}
            />
          </div>
        </div>
      </section>
    ) : null;

  const menuNode = menu ? nodeById.get(menu.nodeId) ?? null : null;
  const renderMenu = () => {
    if (!menu || !menuNode) {
      return null;
    }
    if (menu.kind === "mark") {
      const highlight = menu.highlightId
        ? (contentByNode[menu.nodeId]?.node.highlights ?? []).find((item) => item.id === menu.highlightId) ?? null
        : null;
      const blocker = branchBlockerFor(menuNode, archived);
      return (
        <ResearchMenu
          anchor={menu.anchor}
          align={menu.align}
          trigger={menu.trigger}
          label="Passage"
          compact
          onClose={() => setMenu(null)}
        >
          {menu.branchIds.map((branchId) => (
            <ResearchMenuItem
              key={branchId}
              icon={<ResearchBranchIcon size={15} />}
              label={nodeLabel(nodeById.get(branchId), "Branch")}
              current={openBranchIds.has(branchId)}
              onSelect={() => {
                setMenu(null);
                const level = levelPathRef.current.indexOf(menu.nodeId);
                if (level >= 0) {
                  goBranch(level, branchId);
                }
              }}
            />
          ))}
          {highlight ? (
            <>
              <ResearchMenuItem
                icon={<ResearchBranchIcon size={15} />}
                label="Branch from highlight"
                disabled={blocker !== null}
                title={blocker ?? undefined}
                onSelect={() => openDraft(menu.nodeId, highlight.anchor)}
              />
              <ResearchMenuItem
                icon={<X size={15} aria-hidden="true" />}
                label="Remove highlight"
                onSelect={() => {
                  setMenu(null);
                  removeHighlights(menu.nodeId, [highlight.id]).catch((err) =>
                    onError(err instanceof Error ? err.message : String(err)),
                  );
                }}
              />
            </>
          ) : null}
        </ResearchMenu>
      );
    }
    const node = menuNode;
    const info = researchBranchInfo(detail.nodes, node.id);
    if (!info) {
      return null;
    }
    const isRoot = node.id === rootNodeId;
    const view = segmentViews.get(node.id) ?? null;
    const content = contentByNode[node.id] ?? null;
    const chainIds = inlineChainFor(nodes, node.id);
    const deleteLabel = isRoot
      ? "Delete research"
      : node.inline
        ? info.descendantCount > 0
          ? "Delete from here"
          : "Delete follow-up"
        : info.descendantCount > 0
          ? "Delete branch"
          : "Delete follow-up";
    const canRegenerateRecap = Boolean(
      !archived && content?.responseRevision && content.node.recap?.text.trim(),
    );
    const active = isActiveResearchStatus(node.status);
    // A cancelled turn already says how long it ran ("Stopped after").
    const durationText =
      view?.isConversation || active || node.status === "cancelled" || !node.startedAt
        ? null
        : `${node.status === "complete" ? "" : "Ran for "}${formatRunDuration(
            (node.completedAt ?? metadataNow) - node.startedAt,
          )}`;
    const stats = [
      node.status === "complete" && view
        ? `${view.answerWordCount.toLocaleString()} ${view.answerWordCount === 1 ? "word" : "words"}`
        : null,
      durationText,
      node.origin === "imported" ? null : formatResearchModelSummary(node.adapter, node.model, node.origin) || null,
    ]
      .filter(Boolean)
      .join(" · ");
    const hiddenHighlights = hiddenHighlightsByNode[node.id] ?? 0;
    // What can hide a run's passage sits behind the answer fold; a
    // conversation has no fold and hides only windowed-off turns.
    const revealsHighlights = hiddenHighlights > 0 && Boolean(view?.hasTranscriptActivity) && !fullTraceNodes[node.id];
    const copyText = node.status === "complete" ? view?.conversationCopyText ?? view?.rawAnswer : null;
    const branchBlocker = branchBlockerFor(node, archived);
    return (
      <ResearchMenu
        anchor={menu.anchor}
        align={menu.align}
        trigger={menu.trigger}
        label="Answer actions"
        describedBy={stats || hiddenHighlights > 0 ? "research-answer-menu-meta" : undefined}
        // Retry hides the … button (a queued run has no answer yet).
        fallbackFocus={() =>
          document.querySelector<HTMLElement>(
            `[data-research-row][data-node-id="${CSS.escape(node.id)}"]`,
          )
        }
        onClose={() => setMenu(null)}
      >
        {stats || hiddenHighlights > 0 ? (
          <div id="research-answer-menu-meta">
            {stats ? <ResearchMenuMeta>{stats}</ResearchMenuMeta> : null}
            {hiddenHighlights > 0 ? (
              <ResearchMenuMeta title="These saved highlights couldn't be located in the current view. Their passages may sit in content that isn't rendered right now.">
                {hiddenHighlights} {hiddenHighlights === 1 ? "highlight" : "highlights"} not visible in this view
              </ResearchMenuMeta>
            ) : null}
          </div>
        ) : null}
        {revealsHighlights ? (
          <ResearchMenuItem
            icon={<ScrollText size={15} aria-hidden="true" />}
            label="Show full transcript"
            onSelect={() => {
              setMenu(null);
              showFullTraceFor(node.id);
            }}
          />
        ) : null}
        {stats || hiddenHighlights > 0 ? <ResearchMenuSeparator /> : null}
        <ResearchMenuItem
          icon={<ResearchBranchIcon size={15} />}
          label="Branch from the whole answer"
          disabled={branchBlocker !== null}
          title={branchBlocker ?? undefined}
          onSelect={() => openDraft(node.id, null)}
        />
        {copyText && view ? (
          <ResearchMenuItem
            icon={<Copy size={15} aria-hidden="true" />}
            label={view.isConversation ? "Copy conversation as Markdown" : "Copy answer as Markdown"}
            onSelect={() => {
              setMenu(null);
              handleCopyAnswer(view);
            }}
          />
        ) : null}
        {chainIds.length > 1 ? (
          <ResearchMenuItem
            icon={<Files size={15} aria-hidden="true" />}
            label="Copy thread as Markdown"
            onSelect={() => {
              setMenu(null);
              void copyThread(chainIds);
            }}
          />
        ) : null}
        {view?.hasTranscriptActivity && !revealsHighlights ? (
          <ResearchMenuItem
            icon={<ScrollText size={15} aria-hidden="true" />}
            label={fullTraceNodes[node.id] ? "Hide full transcript" : "Show full transcript"}
            onSelect={() => {
              setMenu(null);
              setFullTraceNodes((current) => ({ ...current, [node.id]: !current[node.id] }));
            }}
          />
        ) : null}
        {!archived && canRetryResearchNode(node) ? (
          <ResearchMenuItem
            icon={<RefreshCw size={15} aria-hidden="true" />}
            label="Retry run"
            disabled={retryingNodeId !== null}
            onSelect={() => {
              setMenu(null);
              handleRetryNode(node.id);
            }}
          />
        ) : null}
        {canRegenerateRecap ? (
          <ResearchMenuItem
            icon={<RefreshCw size={15} aria-hidden="true" />}
            label="Generate summary"
            onSelect={() => {
              setMenu(null);
              setRecapDialogNodeId(node.id);
            }}
          />
        ) : null}
        {isRoot || !node.inline ? (
          <ResearchMenuItem
            icon={<Pencil size={15} aria-hidden="true" />}
            label="Rename…"
            onSelect={() => {
              setMenu(null);
              setRenameError(null);
              setRenameTarget({
                nodeId: node.id,
                value: isRoot ? treeTitleText : (node.title ?? node.prompt).trim(),
              });
            }}
          />
        ) : null}
        {isRoot && node.kind === "document" ? (
          <ResearchMenuItem
            icon={<Pencil size={15} aria-hidden="true" />}
            label="Edit document"
            disabled={
              archived || !content?.responseRevision || view?.editableDocumentMarkdown == null
            }
            title={
              archived
                ? "Move this question out of Archive to edit its document"
                : !content?.responseRevision || view?.editableDocumentMarkdown == null
                  ? "The document content is unavailable"
                  : undefined
            }
            onSelect={() => {
              setMenu(null);
              if (content?.responseRevision && view?.editableDocumentMarkdown != null) {
                setDocumentEditSession({
                  nodeId: node.id,
                  markdown: view.editableDocumentMarkdown,
                  title: treeTitleText,
                  responseRevision: content.responseRevision,
                  highlightIds: content.node.highlights?.map((highlight) => highlight.id) ?? [],
                  highlightCount: content.node.highlights?.length ?? 0,
                });
              }
            }}
          />
        ) : null}
        <ResearchMenuSeparator />
        <ResearchMenuItem
          icon={<Trash2 size={15} aria-hidden="true" />}
          label={deleteLabel}
          danger
          disabled={info.hasActiveRuns}
          title={
            info.hasActiveRuns
              ? "This branch must finish or be cancelled before deletion"
              : undefined
          }
          onSelect={() => {
            setMenu(null);
            setBranchRemovalError(null);
            setDeletingBranchId(node.id);
          }}
        />
        {treeMenu && chainIds[0] === rootNodeId ? (
          <>
            <ResearchMenuSeparator />
            <ResearchTreeMenuItems
              currentPlace={treeMenu.currentPlace}
              folders={treeMenu.folders}
              bookmarked={treeMenu.bookmarked}
              onToggleBookmark={() => {
                setMenu(null);
                treeMenu.onSetBookmarked(!treeMenu.bookmarked);
              }}
              followed={treeMenu.followed}
              followDisabledReason={treeMenu.followDisabledReason}
              onToggleFollow={() => {
                setMenu(null);
                treeMenu.onSetFollowed(!treeMenu.followed);
              }}
              onMove={(place) => {
                setMenu(null);
                treeMenu.onMove(place);
              }}
              onNewFolder={() => {
                setMenu(null);
                treeMenu.onNewFolder(
                  menu.trigger ??
                    document.querySelector<HTMLElement>(
                      `[data-research-row][data-node-id="${CSS.escape(node.id)}"]`,
                    ) ??
                    undefined,
                );
              }}
            />
          </>
        ) : null}
      </ResearchMenu>
    );
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
    const column = element?.closest<HTMLElement>("[data-research-column]") ?? null;
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

  const lastColumnIsAnswer = !activePending && !(levelPath.length === 1 && rootNode?.kind === "note");
  return (
    <TranscriptLinkActionsProvider actions={linkActions}>
      <div
        ref={workspaceRef}
        className="research-workspace research-pairs"
        onKeyDown={onPairsKeyDown}
      >
        {levelColumns}
        {pendingColumn}
        <div className="research-columns-filler" aria-hidden={!lastColumnIsAnswer || undefined}>
          {lastColumnIsAnswer ? (
            <p>Select a passage or a branch marker beside the answer to open it as the next pair.</p>
          ) : null}
        </div>
      </div>
      {columnsLayout?.overlay ? createPortal(searchBar, columnsLayout.overlay) : searchBar}
      {renderMenu()}
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
                question: branch.prompt,
                source: branch.queryAnchor ? `“${quoteDisplayText(branch.queryAnchor.exact)}”` : "Whole answer",
                messages: chain.length,
                state: levelChains[markerTip.level + 1]?.[0] === branchId ? ("open" as const) : branchBusy(branchId) ? ("running" as const) : null,
              },
            ];
          })}
          opensNext={markerTip.branchIds.includes(levelChains[markerTip.level + 1]?.[0] ?? "")}
          onDismiss={dismissMarkerTip}
        />
      ) : null}
      {highlightAction
        ? createPortal(
            <div
              ref={selectionActionsRef}
              className="popover-surface research-selection-actions"
              role="toolbar"
              aria-label="Selection"
              style={{
                left: highlightAction.left,
                top: highlightAction.top,
                visibility: highlightAction.offscreen ? "hidden" : undefined,
              }}
            >
              <div className="research-selection-row">
                <button
                  type="button"
                  className="control-button research-menu-item is-inline"
                  disabled={savingHighlight || selectionBranchBlocker !== null}
                  aria-keyshortcuts="A"
                  title={selectionBranchBlocker ?? "Branch (A)"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={branchFromSelection}
                >
                  <ResearchBranchIcon size={14} />
                  <span>Branch</span>
                </button>
                <button
                  type="button"
                  className="control-button research-menu-item is-inline"
                  disabled={savingHighlight || highlightAction.live}
                  aria-keyshortcuts="H"
                  title={highlightAction.live ? "Wait for the answer to finish" : "Highlight (H)"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void applyHighlightAction()}
                >
                  <Highlighter size={14} aria-hidden="true" />
                  <span>
                    {savingHighlight
                      ? "Saving…"
                      : highlightAction.expandAnchor || highlightAction.highlightIds.length === 0
                        ? "Highlight"
                        : highlightAction.highlightIds.length > 1
                          ? "Remove highlights"
                          : "Remove highlight"}
                  </span>
                </button>
                <button
                  type="button"
                  className="control-button research-menu-item is-inline"
                  title="Copy"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void copySelection()}
                >
                  <Copy size={14} aria-hidden="true" />
                  <span>Copy</span>
                </button>
              </div>
              {highlightAction.live ? (
                <div className="research-menu-note">
                  Highlighting and branching are available when the answer finishes.
                </div>
              ) : selectionBranchBlocker === "Wait for the answer to finish" ? (
                <div className="research-menu-note">Branching is available when the answer finishes.</div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
      {renameTarget
        ? createPortal(
            <div
              className="confirm-dialog-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !renaming) {
                  setRenameTarget(null);
                }
              }}
            >
              <form
                className="confirm-dialog research-rename-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="rename-research-dialog-title"
                onSubmit={(event) => {
                  event.preventDefault();
                  void confirmRename();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !renaming) {
                    event.preventDefault();
                    setRenameTarget(null);
                    return;
                  }
                  trapResearchDialogTab(event);
                }}
              >
                <h2 id="rename-research-dialog-title">
                  {renameTarget.nodeId === rootNodeId ? "Rename research" : "Rename branch"}
                </h2>
                <input
                  className="research-rename-input"
                  autoFocus
                  aria-label="Title"
                  value={renameTarget.value}
                  onChange={(event) =>
                    setRenameTarget({ nodeId: renameTarget.nodeId, value: event.currentTarget.value })
                  }
                />
                {renameError ? (
                  <p className="confirm-dialog-error" role="alert">
                    {renameError}
                  </p>
                ) : null}
                <div className="confirm-dialog-actions">
                  <button
                    className="control-button"
                    type="button"
                    disabled={renaming}
                    onClick={() => setRenameTarget(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="control-button primary"
                    type="submit"
                    disabled={renaming || !renameTarget.value.trim()}
                  >
                    {renaming ? "Renaming…" : "Rename"}
                  </button>
                </div>
              </form>
            </div>,
            document.body,
          )
        : null}
      {documentEditSession
        ? createPortal(
            <DocumentComposer
              initialMarkdown={documentEditSession.markdown}
              initialTitle={documentEditSession.title}
              highlightCount={documentEditSession.highlightCount}
              resetKey={`${documentEditSession.nodeId}:${documentEditSession.responseRevision}`}
              onClose={() => setDocumentEditSession(null)}
              onSubmit={saveDocumentEdit}
            />,
            document.body,
          )
        : null}
      {recapDialogNodeId && contentByNode[recapDialogNodeId]?.node.recap
        ? createPortal(
            <ResearchRecapDialog
              content={contentByNode[recapDialogNodeId]}
              onClose={() => setRecapDialogNodeId(null)}
              onApplied={(updatedNode) => {
                setContentByNode((current) => {
                  const content = current[updatedNode.id];
                  return content
                    ? { ...current, [updatedNode.id]: { ...content, node: updatedNode } }
                    : current;
                });
                onToast("Summary updated");
              }}
            />,
            document.body,
          )
        : null}
      {deletingBranch?.node && deletingBranch.info
        ? createPortal(
            <div
              className="confirm-dialog-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !removingBranch) {
                  setDeletingBranchId(null);
                }
              }}
            >
              <div
                className="confirm-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-research-branch-dialog-title"
                aria-busy={removingBranch}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !removingBranch) {
                    event.preventDefault();
                    setDeletingBranchId(null);
                    return;
                  }
                  trapResearchDialogTab(event);
                }}
              >
                <h2 id="delete-research-branch-dialog-title">
                  {deletingBranch.node.id === rootNodeId
                    ? "Delete research"
                    : deletingBranch.node.inline && deletingBranch.info.descendantCount > 0
                    ? "Delete the rest of this thread?"
                    : deletingBranch.info.descendantCount > 0
                    ? "Delete this research branch?"
                    : "Delete this follow-up?"}
                </h2>
                <p>
                  Delete "
                  {(deletingBranch.node.title ?? deletingBranch.node.prompt) || treeTitleText}
                  "?
                </p>
                <p>
                  {deletingBranch.node.id === rootNodeId
                    ? deletingBranch.info.descendantCount > 0
                      ? `This permanently deletes the root answer and all ${deletingBranch.info.descendantCount} follow-up${deletingBranch.info.descendantCount === 1 ? "" : "s"}.`
                      : "This permanently deletes the root answer and its research history."
                    : deletingBranch.node.inline && deletingBranch.info.descendantCount > 0
                    ? `This permanently deletes this follow-up and everything after it in the thread — ${deletingBranch.info.descendantCount} descendant node${deletingBranch.info.descendantCount === 1 ? "" : "s"} in total, including any branches. Its parent answer keeps the freed inline slot.`
                    : deletingBranch.info.descendantCount > 0
                    ? `This also permanently deletes ${deletingBranch.info.descendantCount} descendant follow-up${deletingBranch.info.descendantCount === 1 ? "" : "s"}.`
                    : "This permanently deletes the follow-up and its response."} {" "}
                  This can’t be undone.
                </p>
                {branchRemovalError ? (
                  <p className="confirm-dialog-error" role="alert">
                    {branchRemovalError}
                  </p>
                ) : null}
                <div className="confirm-dialog-actions">
                  <button className="control-button"
                    type="button"
                    disabled={removingBranch}
                    onClick={() => setDeletingBranchId(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="control-button danger"
                    autoFocus
                    disabled={removingBranch || deletingBranch.info.hasActiveRuns}
                    onClick={() => void confirmBranchRemoval()}
                  >
                    {removingBranch
                      ? "Deleting…"
                      : deletingBranch.node.id === rootNodeId
                        ? "Delete research"
                        : deletingBranch.node.inline && deletingBranch.info.descendantCount > 0
                        ? "Delete from here"
                        : deletingBranch.info.descendantCount > 0
                        ? "Delete branch"
                        : "Delete follow-up"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </TranscriptLinkActionsProvider>
  );
}

export default memo(ResearchDocument);
