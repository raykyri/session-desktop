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
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Copy,
  GitBranch,
  Highlighter,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
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
import type { NoteActions } from "./ResearchNote";
import {
  EMPTY_RESEARCH_HISTORY,
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
  initResearchHistory,
  pushResearchHistory,
  pruneResearchHistory,
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
  RESEARCH_PINNED_COLUMN_WIDTH,
  researchBranchesByParent,
  researchChainHead,
  researchDrawerWidth,
  researchMainChainAncestor,
  researchNodePlacement,
  researchParentBranchHead,
  researchQueueStep,
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
  createResearchSelectionSnapper,
  researchSelectionActionPlacement,
  type ResearchSelectionSnapper,
} from "../../lib/researchSelection";
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
import {
  ResearchConversationHeader,
  ResearchDocumentFrame,
} from "./ResearchDocumentChrome";
import { ResearchTurn, type SegmentDomKind, type SegmentView } from "./ResearchTurn";
import ResearchConversationComposer, {
  type ResearchComposerHandle,
} from "./ResearchConversationComposer";
import {
  prefersReducedMotion,
  ResearchBranchDrawer,
  ResearchBranchHeader,
  ResearchBranchSource,
} from "./ResearchBranchDrawer";
import { ResearchColumnsContext, showResearchColumn } from "./ResearchColumns";

const EMPTY_RECAP_PENDING_NODE_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_BRANCHES: ResearchNode[] = [];
const EMPTY_QUEUE: QueuedResearchFollowup[] = [];

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
  ) => Promise<ResearchNode>;
  /** Replies and follow-ups on a note page (see ResearchNoteDocument). */
  noteActions: NoteActions;
  onRemoveBranch: (nodeId: string) => Promise<ResearchBranchRemoval>;
  onRemoveTree: (treeId: string) => Promise<void>;
  onRenameTree: (treeId: string, title: string) => Promise<void>;
  /** Persist the thread's Follow / Bookmark flags; the tree update event
   * flows back through `detail`. */
  onSetFollowed: (treeId: string, followed: boolean) => Promise<void>;
  onSetBookmarked: (treeId: string, bookmarked: boolean) => Promise<void>;
  /** Opens the folder menu for this question (the header's Move button). */
  onMoveTree?: (treeId: string, trigger: HTMLElement) => void;
  /** Closes the conversation column. */
  onClose?: () => void;
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
  /** Runs whose background summary job is in flight; each renders a spinner in
   * its recap slot until the summary arrives. */
  recapPendingNodeIds?: ReadonlySet<string>;
  /** Workspace-level back/forward (Recent Activity ↔ documents). Used when
   * this tree's own visit stack has nowhere left to go. */
  workspaceCanGoBack?: boolean;
  workspaceCanGoForward?: boolean;
  onWorkspaceBack?: () => void;
  onWorkspaceForward?: () => void;
  /** Called with the node the branch drawer shows whenever that changes, and
   * with null when the drawer closes (or shows a branch not yet created). */
  onDrawerNodeChange?: (nodeId: string | null) => void;
}

const TIMELINE_ITEM_RENDER_WINDOW = 100;
const MENU_MARGIN = 8;
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

/** What the drawer shows: a branch (any node of its chain), or a new branch
 * that has no node until its first question is sent. */
type DrawerTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "draft"; parentNodeId: string; anchor: ResearchHighlightAnchor | null };

interface FloatingMenuAnchor {
  left: number;
  top: number;
  bottom: number;
  /** Where focus returns when Escape closes the menu. */
  trigger?: HTMLElement | null;
}

type FloatingMenuState =
  | ({ kind: "answer"; nodeId: string } & FloatingMenuAnchor)
  | ({ kind: "branches"; nodeId: string } & FloatingMenuAnchor)
  | ({
      kind: "mark";
      nodeId: string;
      branchIds: string[];
      highlightId: string | null;
    } & FloatingMenuAnchor);

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
const RESEARCH_HIGHLIGHT_CONTEXT_LENGTH = 128;
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
    return "Restore this question from Archive to branch from it";
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

function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/** Scrolls `element`'s column (its nearest `.research-column-scroll`) so the
 * element's top sits `offset` px below the column's top; a third of the way
 * down by default. */
function scrollColumnTo(element: Element, offset?: number, behavior = scrollBehavior()) {
  const scroller = element.closest<HTMLElement>(".research-column-scroll");
  if (!scroller) {
    return;
  }
  const top =
    element.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop -
    (offset ?? scroller.clientHeight / 3);
  scroller.scrollTo({ top: Math.max(0, top), behavior });
}

function inColumnView(rect: DOMRect, element: Element) {
  const scroller = element.closest<HTMLElement>(".research-column-scroll");
  if (!scroller) {
    return true;
  }
  const bounds = scroller.getBoundingClientRect();
  return rect.top >= bounds.top + 8 && rect.bottom <= bounds.bottom - 8;
}

/** A small anchored menu: placed below its anchor (above when there is no
 * room), dismissed by an outside press, Escape, scrolling, or resizing, and
 * navigable with the arrow keys. */
function FloatingMenu({
  anchor,
  label,
  role = "menu",
  className = "",
  onClose,
  children,
}: {
  anchor: FloatingMenuAnchor;
  label: string;
  role?: "menu" | "toolbar";
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Escape returns focus to the trigger, or to whatever had it when the menu
  // opened (a right-click or passage click has no trigger).
  const returnFocusRef = useRef<HTMLElement | null>(
    anchor.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) {
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    const below = anchor.bottom + 4;
    const top =
      below + height > window.innerHeight - MENU_MARGIN
        ? Math.max(MENU_MARGIN, anchor.top - height - 4)
        : below;
    const left = Math.max(
      MENU_MARGIN,
      Math.min(anchor.left, window.innerWidth - width - MENU_MARGIN),
    );
    setPosition({ left, top });
    if (role === "menu") {
      menu.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus({ preventScroll: true });
    }
  }, [anchor.bottom, anchor.left, anchor.top, role]);
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest("[data-research-menu-trigger]")) {
        return;
      }
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Only the menu closes: not the drawer behind it.
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        const target = returnFocusRef.current;
        if (target?.isConnected && target !== document.body) {
          target.focus({ preventScroll: true });
        }
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && ref.current?.contains(event.target as Node)) {
        const items = [
          ...(ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)") ?? []),
        ];
        if (items.length === 0) {
          return;
        }
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
        next.focus();
      }
    };
    const close = () => onCloseRef.current();
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, []);
  return createPortal(
    <div
      ref={ref}
      className={`popover-surface research-menu ${className}`}
      role={role}
      aria-label={label}
      style={position ?? { left: -9999, top: -9999 }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuItem({
  icon,
  label,
  description,
  onSelect,
  disabled = false,
  title,
  danger = false,
  current = false,
  trailing,
}: {
  icon?: ReactNode;
  label: string;
  /** Read after the label by screen readers (what a trailing mark shows). */
  description?: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  current?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`control-button research-menu-item${danger ? " is-danger" : ""}`}
      disabled={disabled}
      title={title}
      aria-current={current ? "true" : undefined}
      onClick={onSelect}
    >
      {icon}
      <span className="research-menu-label">
        {label}
        {description ? <span className="research-visually-hidden">, {description}</span> : null}
      </span>
      {trailing}
    </button>
  );
}

function nodeLabel(node: ResearchNode | null | undefined, fallback: string) {
  return (node?.title ?? node?.prompt ?? "").trim() || fallback;
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
  onSetFollowed,
  onSetBookmarked,
  onMoveTree,
  onClose,
  onUpdateDocument,
  onCancel,
  onRetryNode,
  linkActions,
  onError,
  onToast,
  shortcutHintsShown,
  recapPendingNodeIds = EMPTY_RECAP_PENDING_NODE_IDS,
  workspaceCanGoBack = false,
  workspaceCanGoForward = false,
  onWorkspaceBack,
  onWorkspaceForward,
  onDrawerNodeChange,
}: ResearchDocumentProps) {
  const columnsLayout = useContext(ResearchColumnsContext);
  const treeId = detail?.tree.id ?? null;
  const rootNodeId = detail?.tree.rootNodeId ?? null;
  // The current visit: the node the reader last navigated to. A conversation
  // node means the drawer is closed; a branch node is shown in the drawer (or
  // its pinned column). Back/forward walk these visits.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [history, setHistory] = useState(EMPTY_RESEARCH_HISTORY);
  // Loaded contents for every rendered turn, keyed by node id. Pruned to the
  // rendered chains (conversation, drawer, pinned columns) when they change.
  const [contentByNode, setContentByNode] = useState<Record<string, ResearchNodeContent>>({});
  const [contentErrorByNode, setContentErrorByNode] = useState<Record<string, string>>({});
  const [contentLoadNonce, setContentLoadNonce] = useState(0);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  // Each drawer opened from closed is a new instance (it slides in); a swap
  // keeps the instance (it fades). A closing drawer keeps its instance until
  // its slide-out ends.
  const [drawerInstance, setDrawerInstance] = useState(0);
  const [drawerAnimates, setDrawerAnimates] = useState(true);
  const [leavingDrawer, setLeavingDrawer] = useState<{
    target: DrawerTarget;
    mode: "close" | "pin";
    instance: number;
  } | null>(null);
  const [pinnedHeads, setPinnedHeads] = useState<string[]>([]);
  // "main" or a pinned column's head id. Focus only moves the accent rule.
  const [focusedColumn, setFocusedColumn] = useState<string>("main");
  const [composerText, setComposerText] = useState<Record<string, string>>({});
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [queues, setQueues] = useState<Record<string, QueuedResearchFollowup[]>>({});
  // Per chain head: the failed node whose question the composer is editing.
  const [editingByHead, setEditingByHead] = useState<Record<string, string>>({});
  const [retryingNodeId, setRetryingNodeId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequestInFlightRef = useRef(false);
  const [menu, setMenu] = useState<FloatingMenuState | null>(null);
  const [deletingBranchId, setDeletingBranchId] = useState<string | null>(null);
  const [removingBranch, setRemovingBranch] = useState(false);
  const [branchRemovalError, setBranchRemovalError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ nodeId: string; value: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [documentEditSession, setDocumentEditSession] = useState<DocumentEditSession | null>(null);
  const [recapDialogNodeId, setRecapDialogNodeId] = useState<string | null>(null);
  // Per-node reading state: which turns show their full item window
  // (persisted per tree), which show the full transcript (per visit), and
  // which finished answers are expanded past the nine-line clamp.
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [fullTraceNodes, setFullTraceNodes] = useState<Record<string, boolean>>({});
  const [expandedAnswers, setExpandedAnswers] = useState<Record<string, boolean>>({});
  const [highlightAction, setHighlightAction] = useState<HighlightAction | null>(null);
  const [savingHighlight, setSavingHighlight] = useState(false);
  // Saved highlights whose anchors no longer locate a passage in a turn's
  // current rendered projection. They still exist — surfaced in that turn's
  // footer instead of vanishing silently.
  const [hiddenHighlightsByNode, setHiddenHighlightsByNode] = useState<Record<string, number>>({});
  // Branches whose answer finished while this document was open and that
  // the reader has not opened carry an unread dot on their branch button.
  // `firstSeenComplete` records each branch's status the first time it is
  // seen, so a branch that was already complete when the tree loaded is read.
  const firstSeenCompleteRef = useRef<Map<string, boolean>>(new Map());
  const [openedNodeIds, setOpenedNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [highlightDomNonce, setHighlightDomNonce] = useState(0);
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
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const drawerScrollRef = useRef<HTMLDivElement | null>(null);
  const drawerElementRef = useRef<HTMLElement | null>(null);
  // Branches created a moment ago that the next detail refresh delivers:
  // until then the drawer and the selection may name a node detail lacks.
  const pendingNodeIdsRef = useRef(new Set<string>());
  // A new branch's composer takes focus once its node arrives.
  const pendingComposerFocusRef = useRef<string | null>(null);
  // The selection actions' measured size, for centring them.
  const selectionActionsSizeRef = useRef(SELECTION_ACTIONS_SIZE);
  const drawerTitleRef = useRef<HTMLHeadingElement | null>(null);
  const composerRefs = useRef(new Map<string, ResearchComposerHandle>());
  const columnTitleRefs = useRef(new Map<string, HTMLHeadingElement>());
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  // Resolved highlight ranges per turn, refreshed by the paint effect.
  const resolvedHighlightsRef = useRef(new Map<string, ResolvedHighlight[]>());
  // Bumped after each highlight paint so the focus-highlight effect below
  // observes freshly resolved ranges.
  const [highlightPaintVersion, setHighlightPaintVersion] = useState(0);
  // Flat-offset ranges of the branch passages that resolved, tagged with the
  // turn they sit in. Consulted by passage clicks, hover, and reveal.
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
  const drawerRef = useRef(drawer);
  const menuRef = useRef(menu);
  // The (status, snapshot) stamp each cached content was fetched under, so
  // the loader can tell a cache hit from a stale entry without refetching
  // unchanged turns every time the rendered chains recompute.
  const fetchStampByNodeRef = useRef(new Map<string, string>());
  // Guards scroll recording and restoration: offsets are only meaningful once
  // the whole conversation has settled (content or a terminal error per
  // turn). While a turn is still a short loading placeholder the page is not
  // at its real height, and the browser's clamp scroll event would otherwise
  // record — and permanently overwrite — the saved offset.
  const mainContentSettledRef = useRef(false);
  // Set once the conversation's scroll offset has been restored for this tree.
  const restoredScrollRef = useRef(false);
  // Scroll to a turn once it appears — the just-submitted follow-up, delivered
  // by the next detail refresh.
  const pendingScrollNodeIdRef = useRef<string | null>(null);
  // Live mirrors for stable callbacks that must read current state.
  const drawerInstanceRef = useRef(drawerInstance);
  const composerTextRef = useRef(composerText);
  const submittingKeyRef = useRef(submittingKey);
  const editingByHeadRef = useRef(editingByHead);
  const queuesRef = useRef(queues);
  treeIdRef.current = treeId;
  detailRef.current = detail;
  contentByNodeRef.current = contentByNode;
  contentErrorByNodeRef.current = contentErrorByNode;
  drawerRef.current = drawer;
  menuRef.current = menu;
  drawerInstanceRef.current = drawerInstance;
  composerTextRef.current = composerText;
  submittingKeyRef.current = submittingKey;
  editingByHeadRef.current = editingByHead;
  queuesRef.current = queues;

  const navigationPersistence = useResearchDocumentNavigation((persistence) => {
    const scroller = mainScrollRef.current;
    if (treeId && rootNodeId && scroller && mainContentSettledRef.current) {
      persistence.recordScroll(treeId, rootNodeId, scroller.scrollTop);
    }
  });

  const nodes = useMemo(() => detail?.nodes ?? [], [detail]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  // The root's inline chain: always the conversation column.
  const mainChainIds = useStableValue(
    useMemo(
      () => (detail && rootNodeId ? inlineChainFor(detail.nodes, rootNodeId) : []),
      [detail, rootNodeId],
    ),
    sameIds,
  );
  const mainChainIdsRef = useRef(mainChainIds);
  mainChainIdsRef.current = mainChainIds;
  const validPinnedHeads = useStableValue(
    useMemo(
      () => pinnedHeads.filter((id) => nodeById.has(id) && !mainChainIds.includes(id)),
      [mainChainIds, nodeById, pinnedHeads],
    ),
    sameIds,
  );
  const pinnedHeadsRef = useRef(validPinnedHeads);
  pinnedHeadsRef.current = validPinnedHeads;
  const pinnedChainsKey = useMemo(
    () =>
      validPinnedHeads
        .map((head) => (detail ? inlineChainFor(detail.nodes, head) : [head]).join(","))
        .join("\n"),
    [detail, validPinnedHeads],
  );
  const pinnedChains = useMemo(
    () => (pinnedChainsKey ? pinnedChainsKey.split("\n").map((chain) => chain.split(",")) : []),
    [pinnedChainsKey],
  );
  const drawerNodeId = drawer?.kind === "node" ? drawer.nodeId : null;
  const drawerChainIds = useStableValue(
    useMemo(
      () => (detail && drawerNodeId ? inlineChainFor(detail.nodes, drawerNodeId) : []),
      [detail, drawerNodeId],
    ),
    sameIds,
  );
  const drawerHeadId = drawerChainIds[0] ?? null;
  const leavingNodeId = leavingDrawer?.target.kind === "node" ? leavingDrawer.target.nodeId : null;
  const leavingChainIds = useStableValue(
    useMemo(
      () => (detail && leavingNodeId ? inlineChainFor(detail.nodes, leavingNodeId) : []),
      [detail, leavingNodeId],
    ),
    sameIds,
  );
  // Every rendered turn, across the conversation, pinned columns, and the
  // drawer. Chains partition the tree, so each node renders at most once
  // (the leaving drawer renders inert, without registering its DOM).
  const chainNodeIds = useStableValue(
    useMemo(() => {
      const ids = [...mainChainIds, ...pinnedChains.flat(), ...drawerChainIds];
      for (const id of leavingChainIds) {
        if (!ids.includes(id)) {
          ids.push(id);
        }
      }
      return ids;
    }, [drawerChainIds, leavingChainIds, mainChainIds, pinnedChains]),
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
  mainContentSettledRef.current =
    mainChainIds.length > 0 &&
    mainChainIds.every((id) => contentByNode[id] || contentErrorByNode[id]);
  // Refetch when a run finishes, its snapshot is saved, or its recap is available.
  // Other detail updates do not need to restart the content loaders.
  const chainStatusKey = chainNodes
    .map((node) => `${node.id}:${node.status}:${node.responseSnapshotAt ?? 0}:${node.recap?.id ?? node.recap?.responseRevision ?? ""}`)
    .join("\n");
  const branchesByParent = useMemo(() => researchBranchesByParent(nodes), [nodes]);
  const branchesByParentRef = useRef(branchesByParent);
  branchesByParentRef.current = branchesByParent;

  // Turn-scoped DOM lookups. Each turn registers its article (scroll anchor)
  // and response root as it mounts; measurement effects read the maps
  // instead of scanning the whole subtree with attribute selectors.
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
      // A turn's text moved to new DOM (pinning moves a branch from the
      // drawer to its column): ranges painted into the old DOM are gone.
      if (kind === "root") {
        setHighlightDomNonce((value) => value + 1);
      }
    },
    [],
  );
  // The leaving drawer renders inert copies of turns that may also be shown
  // in a pinned column; they never register, so lookups keep resolving to
  // the live copy.
  const registerNothing = useCallback(() => {}, []);
  const segmentRoot = useCallback(
    (nodeId: string) =>
      (segmentDomRef.current.root.get(nodeId) as HTMLDivElement | undefined) ?? null,
    [],
  );
  const segmentAnchor = useCallback(
    (nodeId: string) => segmentDomRef.current.anchor.get(nodeId) ?? null,
    [],
  );
  // A passage has no focusable element of its own (CSS highlights paint over
  // text), so focus returns to its turn's branch button when the drawer it
  // opened closes.
  const branchTriggerFor = useCallback(
    (nodeId: string) =>
      segmentDomRef.current.anchor
        .get(nodeId)
        ?.querySelector<HTMLElement>("[data-research-branch-trigger]") ?? null,
    [],
  );
  const scrollToSegment = useCallback(
    (nodeId: string, behavior: ScrollBehavior = scrollBehavior()) => {
      const anchor = segmentDomRef.current.anchor.get(nodeId);
      if (anchor) {
        scrollColumnTo(anchor, 0, behavior);
      }
    },
    [],
  );
  const flashTurn = useCallback((nodeId: string) => {
    const question = segmentDomRef.current.anchor
      .get(nodeId)
      ?.querySelector<HTMLElement>(".research-turn-question");
    if (!question) {
      return;
    }
    question.classList.remove("is-flashing");
    void question.offsetWidth;
    question.classList.add("is-flashing");
    window.setTimeout(() => question.classList.remove("is-flashing"), FLASH_MS);
  }, []);

  // Content-derived keys the annotation machinery re-runs on: a turn's
  // durable revision landing, or a turn's transcript view toggling, both
  // shift every flat-text offset in that turn. Answer expansion changes the
  // geometry (passages become visible) but not the offsets.
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

  // The floating action bar caches pixel geometry and a live selection from
  // one rendered projection, so a transcript-visibility change (or another
  // turn's content landing and reflowing the page) leaves it pointing at
  // content that has moved: drop it whenever the view changes.
  useEffect(() => {
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
  }, [treeId, chainKey, revisionsKey, expandedKey, fullTraceKey]);

  // Highlight mutations are announced as research events but do not replace
  // the response snapshot. Mirror their refreshed node metadata into each
  // loaded turn so another window's changes reach the document. Bail on
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
    for (const id of chainNodeIds) {
      for (const child of branchesByParent.get(id) ?? []) {
        if (!seen.has(child.id)) {
          seen.set(child.id, child.status === "complete");
        }
      }
    }
  }, [branchesByParent, chainNodeIds]);

  // Branch passages per rendered turn: the anchors of each turn's branches,
  // plus the pending new branch's passage. Immutable per id, so the stable
  // identity only changes when the (turn, id) list does.
  const pendingAnchor =
    drawer?.kind === "draft" && drawer.anchor
      ? { segmentId: drawer.parentNodeId, id: "__draft__", anchor: drawer.anchor }
      : null;
  const branchEntries = useStableValue(
    useMemo(() => {
      const next: { segmentId: string; id: string; anchor: ResearchHighlightAnchor }[] = [];
      for (const segmentId of chainNodeIds) {
        for (const child of branchesByParent.get(segmentId) ?? []) {
          if (child.queryAnchor) {
            next.push({ segmentId, id: child.id, anchor: child.queryAnchor });
          }
        }
      }
      if (pendingAnchor) {
        next.push(pendingAnchor);
      }
      return next;
      // pendingAnchor is derived from `drawer`.
    }, [branchesByParent, chainNodeIds, drawer]),
    (previous, candidate) =>
      previous.length === candidate.length &&
      previous.every(
        (entry, index) =>
          entry.id === candidate[index].id &&
          entry.segmentId === candidate[index].segmentId &&
          entry.anchor === candidate[index].anchor,
      ),
  );
  // Branch heads that are open somewhere: in the drawer (with the branches it
  // descends from), the pending draft, and the pinned columns. Their passages
  // are underlined and their turns' branch buttons turn accent.
  const openBranchIds = useMemo(() => {
    const open = new Set<string>(validPinnedHeads);
    if (drawer?.kind === "draft") {
      open.add("__draft__");
    }
    let head = drawerHeadId;
    const seen = new Set<string>();
    while (head && !seen.has(head)) {
      seen.add(head);
      open.add(head);
      const parentId = nodeById.get(head)?.parentNodeId;
      if (!parentId || mainChainIds.includes(parentId) || !detail) {
        break;
      }
      head = inlineChainFor(detail.nodes, parentId)[0] ?? null;
    }
    return open;
  }, [detail, drawer, drawerHeadId, mainChainIds, nodeById, validPinnedHeads]);
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

  // Tree switch (the document is keyed per tree, so this is its mount):
  // restore the visit, pinned columns, queued follow-ups, and reading state.
  useEffect(() => {
    if (!treeId || !rootNodeId || !detail) {
      return;
    }
    const navigation = navigationPersistence.store[treeId];
    const nodeIds = new Set(detail.nodes.map((node) => node.id));
    const saved = navigation?.selectedNodeId;
    const selected = saved && nodeIds.has(saved) ? saved : rootNodeId;
    const main = inlineChainFor(detail.nodes, rootNodeId);
    const pinned = (navigation?.pinnedBranches ?? []).filter(
      (id) => nodeIds.has(id) && !main.includes(id),
    );
    setPinnedHeads(pinned);
    setQueues({ ...(navigation?.queuedFollowups ?? {}) });
    setSelectedNodeId(selected);
    setHistory(initResearchHistory(selected));
    const placement = researchNodePlacement(detail.nodes, main, pinned, selected);
    if (placement.kind === "drawer") {
      setDrawerAnimates(false);
      setDrawer({ kind: "node", nodeId: selected });
    } else if (placement.kind === "pinned") {
      setFocusedColumn(placement.headId);
    }
    if (selected !== rootNodeId && placement.kind === "main") {
      pendingScrollNodeIdRef.current = selected;
    }
    setExpandedNodes({ ...navigation?.expandedByNode });
    setFullTraceNodes({});
    restoredScrollRef.current = false;
    // Runs once per tree: the document remounts on tree switches, and the
    // first detail to arrive carries the root and the nodes to restore.
  }, [treeId, rootNodeId, Boolean(detail)]);

  const mainComposerKey = rootNodeId ?? "main";
  const persistedDraft = useMemo(
    () =>
      drawer?.kind === "draft" && drawer.anchor
        ? { nodeId: drawer.parentNodeId, anchor: drawer.anchor }
        : null,
    [drawer],
  );
  const draftKey = drawer?.kind === "draft" ? `draft:${drawer.parentNodeId}` : null;
  useResearchComposerDrafts({
    persistence: navigationPersistence,
    treeId,
    mainText: composerText[mainComposerKey] ?? "",
    draft: persistedDraft,
    draftText: draftKey ? composerText[draftKey] ?? "" : "",
    drawerOpen: drawer !== null,
    chainNodeIds,
    contentByNode,
    setMainText: (text) =>
      setComposerText((current) =>
        (current[mainComposerKey] ?? "") === text ? current : { ...current, [mainComposerKey]: text },
      ),
    restoreDraft: (nodeId, anchor, text) => {
      setDrawerAnimates(false);
      setDrawer({ kind: "draft", parentNodeId: nodeId, anchor });
      if (text) {
        setComposerText((current) => ({ ...current, [`draft:${nodeId}`]: text }));
      }
    },
  });

  // Deleted nodes: prune persisted state, history, pinned columns, and a
  // drawer that showed a removed branch.
  useEffect(() => {
    if (!treeId || !detail) {
      return;
    }
    const validNodeIds = new Set(detail.nodes.map((node) => node.id));
    const pending = pendingNodeIdsRef.current;
    for (const id of [...pending]) {
      if (validNodeIds.has(id)) {
        pending.delete(id);
      } else {
        validNodeIds.add(id);
      }
    }
    pruneResearchNavigationNodes(treeId, [...validNodeIds]);
    setHistory((current) => pruneResearchHistory(current, validNodeIds, detail.tree.rootNodeId));
    setPinnedHeads((current) =>
      current.every((id) => validNodeIds.has(id)) ? current : current.filter((id) => validNodeIds.has(id)),
    );
    const current = drawerRef.current;
    if (
      (current?.kind === "node" && !validNodeIds.has(current.nodeId)) ||
      (current?.kind === "draft" && !validNodeIds.has(current.parentNodeId))
    ) {
      setDrawer(null);
    }
    if (selectedNodeId && !validNodeIds.has(selectedNodeId)) {
      setSelectedNodeId(detail.tree.rootNodeId);
      persistSelection(detail.tree.rootNodeId);
    }
  }, [detail, persistSelection, selectedNodeId, treeId]);

  // Pinned columns and queued follow-ups persist per tree.
  const pinnedPersistKey = validPinnedHeads.join(",");
  const pinnedRestoredRef = useRef(false);
  useEffect(() => {
    if (!treeId) {
      return;
    }
    // The first pass after mount carries the restored list; writing it back
    // would only rewrite the same value.
    if (!pinnedRestoredRef.current) {
      pinnedRestoredRef.current = true;
      return;
    }
    navigationPersistence.recordPinned(treeId, validPinnedHeads);
  }, [navigationPersistence, pinnedPersistKey, treeId]);

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

  // ---- columns, focus, and the drawer --------------------------------------

  // The column area (ResearchColumns) sets the drawer width and the
  // single-column mode: the drawer is 46% of the area, feed included, and
  // never wider than the conversation column.
  const areaWidth = columnsLayout?.areaWidth ?? 1200;
  const singleColumn = columnsLayout?.singleColumn ?? false;
  const drawerWidth = researchDrawerWidth(areaWidth, columnsLayout?.conversationWidth ?? areaWidth);
  const drawerWidthRef = useRef(drawerWidth);
  drawerWidthRef.current = drawerWidth;
  const singleColumnRef = useRef(singleColumn);
  singleColumnRef.current = singleColumn;
  const columnsLayoutRef = useRef(columnsLayout);
  columnsLayoutRef.current = columnsLayout;
  // The feed is column 0 for `[` and `]`.
  const focusedColumnKey = columnsLayout?.feedFocused
    ? "feed"
    : focusedColumn === "main" || validPinnedHeads.includes(focusedColumn)
      ? focusedColumn
      : "main";
  const columnKeys = useMemo(
    () => [...(columnsLayout ? ["feed"] : []), "main", ...validPinnedHeads],
    [Boolean(columnsLayout), validPinnedHeads],
  );

  const showColumn = useCallback((key: string) => {
    const row = columnsLayoutRef.current?.row ?? workspaceRef.current;
    showResearchColumn(
      row,
      row?.querySelector<HTMLElement>(`[data-research-column="${CSS.escape(key)}"]`) ?? null,
      scrollBehavior(),
    );
  }, []);

  /** Gives a conversation column (or the feed) the focus rule. */
  const takeColumnFocus = useCallback((key: string) => {
    setFocusedColumn(key);
    columnsLayoutRef.current?.releaseFeed();
  }, []);

  const focusColumn = useCallback(
    (key: string, { moveFocus = false }: { moveFocus?: boolean } = {}) => {
      if (key === "feed") {
        columnsLayoutRef.current?.focusFeed({ moveFocus });
        return;
      }
      takeColumnFocus(key);
      window.requestAnimationFrame(() => {
        showColumn(key);
        if (moveFocus) {
          columnTitleRefs.current.get(key)?.focus({ preventScroll: true });
        }
      });
    },
    [showColumn, takeColumnFocus],
  );

  const markOpened = useCallback((nodeId: string) => {
    setOpenedNodeIds((prev) => (prev.has(nodeId) ? prev : new Set(prev).add(nodeId)));
  }, []);

  /** The viewport x of the drawer's left edge (where it is, or where it
   * will be once it opens), from the column area's geometry. */
  const drawerLeftEdge = () => {
    const area = (columnsLayoutRef.current?.overlay ?? workspaceRef.current)?.getBoundingClientRect();
    if (!area) {
      return null;
    }
    return singleColumnRef.current ? area.left : area.right - drawerWidthRef.current;
  };

  // Keeps the passage a branch came from visible in its column. A passage
  // under the drawer can't be shown, so its turn's question is scrolled to
  // the top instead, unless it is already in view.
  const revealPassage = useCallback(
    (headId: string, flash: boolean) => {
      const head = detailRef.current?.nodes.find((node) => node.id === headId);
      const parentId = head?.parentNodeId;
      if (!head || !parentId) {
        return;
      }
      window.requestAnimationFrame(() => {
        const turn = segmentDomRef.current.anchor.get(parentId);
        if (!turn) {
          return;
        }
        const question = turn.querySelector<HTMLElement>(".research-turn-question") ?? turn;
        const entry = branchRangeOffsetsRef.current.find((candidate) => candidate.id === headId);
        const root = segmentDomRef.current.root.get(parentId);
        const range = entry && root ? rangeForTextOffsets(root, entry.start, entry.end) : null;
        const rect = range?.getBoundingClientRect() ?? null;
        const drawerLeft = drawerRef.current ? drawerLeftEdge() : null;
        const under =
          drawerLeft !== null &&
          !turn.closest(".research-branch-drawer") &&
          (rect ?? question.getBoundingClientRect()).right > drawerLeft + 4;
        if (under || !rect) {
          if (!inColumnView(question.getBoundingClientRect(), question)) {
            scrollColumnTo(turn, 0);
          }
        } else if (!inColumnView(rect, turn)) {
          const scroller = turn.closest<HTMLElement>(".research-column-scroll");
          if (scroller) {
            const bounds = scroller.getBoundingClientRect();
            scroller.scrollTo({
              top: Math.max(0, rect.top - bounds.top + scroller.scrollTop - scroller.clientHeight / 3),
              behavior: scrollBehavior(),
            });
          }
        }
        if (flash) {
          if (entry && !under) {
            setFlashRange({ nodeId: parentId, start: entry.start, end: entry.end });
          } else {
            flashTurn(parentId);
          }
        }
      });
    },
    [flashTurn],
  );

  // Expanding a clamped answer moves the text below it, so it happens only
  // when the passage a branch opens from is cut off by the clamp, and not
  // when the drawer will cover it anyway.
  const expandToRevealPassage = useCallback((headId: string) => {
    const head = detailRef.current?.nodes.find((node) => node.id === headId);
    const parentId = head?.parentNodeId;
    const entry = branchRangeOffsetsRef.current.find((candidate) => candidate.id === headId);
    const root = parentId ? segmentDomRef.current.root.get(parentId) : null;
    const clamp = root?.closest<HTMLElement>(".research-answer-clamp.is-clamped");
    if (!parentId || !entry || !root || !clamp || singleColumnRef.current) {
      return;
    }
    const range = rangeForTextOffsets(root, entry.start, entry.end);
    const rect = range?.getBoundingClientRect();
    const drawerLeft = root.closest(".research-branch-drawer") ? null : drawerLeftEdge();
    if (
      rect &&
      rect.bottom > clamp.getBoundingClientRect().bottom &&
      (drawerLeft === null || rect.right <= drawerLeft)
    ) {
      setExpandedAnswers((current) => (current[parentId] ? current : { ...current, [parentId]: true }));
    }
  }, []);

  /** Opens a branch node in the drawer: slides it in when the drawer was
   * closed, replaces its content otherwise. `returnFocus` is where focus
   * goes when the drawer closes; replacing the content keeps the first. */
  const openDrawerNode = useCallback(
    (nodeId: string, returnFocus: HTMLElement | null) => {
      if (!drawerRef.current) {
        drawerReturnFocusRef.current =
          returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        setDrawerInstance((value) => value + 1);
        setDrawerAnimates(true);
        setLeavingDrawer(null);
      }
      setDrawer({ kind: "node", nodeId });
      markOpened(nodeId);
      const nodesNow = detailRef.current?.nodes ?? [];
      const headId = inlineChainFor(nodesNow, nodeId)[0] ?? nodeId;
      markOpened(headId);
      expandToRevealPassage(headId);
      revealPassage(headId, false);
      window.requestAnimationFrame(() => {
        if (nodeId !== headId) {
          scrollToSegment(nodeId, "auto");
        } else if (drawerScrollRef.current) {
          drawerScrollRef.current.scrollTop = 0;
        }
      });
    },
    [expandToRevealPassage, markOpened, revealPassage, scrollToSegment],
  );

  const returnFocusAfterDrawer = useCallback((closed: DrawerTarget) => {
    window.requestAnimationFrame(() => {
      const saved = drawerReturnFocusRef.current;
      drawerReturnFocusRef.current = null;
      if (saved && saved.isConnected && !saved.closest(".research-branch-drawer")) {
        saved.focus({ preventScroll: true });
        return;
      }
      const nodesNow = detailRef.current?.nodes ?? [];
      let parentId =
        closed.kind === "draft"
          ? closed.parentNodeId
          : nodesNow.find((node) => node.id === (inlineChainFor(nodesNow, closed.nodeId)[0] ?? closed.nodeId))
              ?.parentNodeId ?? null;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const trigger = workspaceRef.current?.querySelector<HTMLElement>(
          `[data-research-branch-trigger="${CSS.escape(parentId)}"]`,
        );
        if (trigger && !trigger.closest(".research-branch-drawer")) {
          trigger.focus({ preventScroll: true });
          return;
        }
        parentId = nodesNow.find((node) => node.id === parentId)?.parentNodeId ?? null;
      }
      columnTitleRefs.current.get("main")?.focus({ preventScroll: true });
    });
  }, []);

  /** Closes the drawer: it slides out (or fades, when pinned) and focus
   * returns to whatever opened it. Closing a new branch before its first
   * question discards it. */
  const closeDrawer = useCallback(
    (mode: "close" | "pin" = "close") => {
      const current = drawerRef.current;
      if (!current) {
        return;
      }
      setDrawer(null);
      setLeavingDrawer(
        prefersReducedMotion() ? null : { target: current, mode, instance: drawerInstanceRef.current },
      );
      if (current.kind === "draft") {
        const currentTreeId = treeIdRef.current;
        if (currentTreeId) {
          navigationPersistence.clearAsk(currentTreeId, current.parentNodeId);
        }
        setComposerText((text) => withoutKeys(text, [`draft:${current.parentNodeId}`]));
      }
      if (mode === "close") {
        returnFocusAfterDrawer(current);
      }
    },
    [navigationPersistence, returnFocusAfterDrawer],
  );

  /** Moves the reader to a node without touching visit history: a node of
   * the conversation closes the drawer (and, with `reveal`, scrolls to and
   * flashes its turn); a pinned branch focuses its column; any other branch
   * opens in the drawer. */
  const applyVisit = useCallback(
    (
      nodeId: string,
      { reveal = false, returnFocus = null }: { reveal?: boolean; returnFocus?: HTMLElement | null } = {},
    ) => {
      const currentDetail = detailRef.current;
      if (!currentDetail || !currentDetail.nodes.some((node) => node.id === nodeId)) {
        return;
      }
      const placement = researchNodePlacement(
        currentDetail.nodes,
        mainChainIdsRef.current,
        pinnedHeadsRef.current,
        nodeId,
      );
      setSelectedNodeId(nodeId);
      persistSelection(nodeId);
      setMenu(null);
      if (placement.kind === "main") {
        if (drawerRef.current) {
          closeDrawer("close");
        }
        setFocusedColumn("main");
        if (reveal) {
          setExpandedAnswers((current) => (current[nodeId] ? current : { ...current, [nodeId]: true }));
          window.requestAnimationFrame(() => {
            scrollToSegment(nodeId);
            flashTurn(nodeId);
          });
        }
        return;
      }
      if (placement.kind === "pinned") {
        focusColumn(placement.headId, { moveFocus: true });
        if (reveal || nodeId !== placement.headId) {
          window.requestAnimationFrame(() => scrollToSegment(nodeId));
        }
        return;
      }
      openDrawerNode(nodeId, returnFocus);
      window.requestAnimationFrame(() => drawerTitleRef.current?.focus({ preventScroll: true }));
    },
    [closeDrawer, flashTurn, focusColumn, openDrawerNode, persistSelection, scrollToSegment],
  );

  /** User navigation: applies the visit and extends history. */
  const navigate = useCallback(
    (nodeId: string, options?: { reveal?: boolean; returnFocus?: HTMLElement | null }) => {
      applyVisit(nodeId, options);
      setHistory((current) =>
        current.entries[current.index] === nodeId ? current : pushResearchHistory(current, nodeId),
      );
    },
    [applyVisit],
  );
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  /** Closing the drawer is a visit too: back reopens the branch. */
  const closeDrawerToConversation = useCallback(() => {
    const current = drawerRef.current;
    if (!current) {
      return;
    }
    closeDrawer("close");
    const currentDetail = detailRef.current;
    const target =
      current.kind === "node" && currentDetail
        ? researchMainChainAncestor(currentDetail.nodes, mainChainIdsRef.current, current.nodeId)
        : null;
    if (current.kind === "node" && target) {
      setSelectedNodeId(target);
      persistSelection(target);
      setHistory((value) =>
        value.entries[value.index] === target ? value : pushResearchHistory(value, target),
      );
    }
  }, [closeDrawer, persistSelection]);

  const openDraft = useCallback(
    (parentNodeId: string, anchor: ResearchHighlightAnchor | null, returnFocus: HTMLElement | null) => {
      if (archived) {
        return;
      }
      if (!drawerRef.current) {
        drawerReturnFocusRef.current =
          returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        setDrawerInstance((value) => value + 1);
        setDrawerAnimates(true);
        setLeavingDrawer(null);
      } else if (drawerRef.current.kind === "draft") {
        const previous = drawerRef.current.parentNodeId;
        setComposerText((text) => withoutKeys(text, [`draft:${previous}`]));
        const currentTreeId = treeIdRef.current;
        if (currentTreeId) {
          navigationPersistence.clearAsk(currentTreeId, previous);
        }
      }
      setMenu(null);
      setDrawer({ kind: "draft", parentNodeId, anchor });
      window.requestAnimationFrame(() =>
        composerRefs.current.get(`draft:${parentNodeId}`)?.focus(),
      );
    },
    [archived, navigationPersistence],
  );

  /** Shows a branch created a moment ago in the drawer, with its composer
   * focused once it renders. The next detail refresh delivers its node, so
   * it cannot go through `navigate` yet. */
  const openNewBranch = useCallback(
    (nodeId: string) => {
      pendingNodeIdsRef.current.add(nodeId);
      pendingComposerFocusRef.current = nodeId;
      if (!drawerRef.current) {
        drawerReturnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setDrawerInstance((value) => value + 1);
        setDrawerAnimates(true);
        setLeavingDrawer(null);
      }
      setDrawer({ kind: "node", nodeId });
      markOpened(nodeId);
      setSelectedNodeId(nodeId);
      persistSelection(nodeId);
      setHistory((value) => pushResearchHistory(value, nodeId));
    },
    [markOpened, persistSelection],
  );

  const pinBranch = useCallback(
    (headId: string) => {
      setPinnedHeads((current) => [...current.filter((id) => id !== headId), headId]);
      closeDrawer("pin");
      focusColumn(headId, { moveFocus: true });
    },
    [closeDrawer, focusColumn],
  );

  const unpinBranch = useCallback(
    (headId: string) => {
      setPinnedHeads((current) => {
        const index = current.indexOf(headId);
        const next = current.filter((id) => id !== headId);
        setFocusedColumn((focused) =>
          focused === headId ? (index > 0 ? current[index - 1] : "main") : focused,
        );
        return next;
      });
      window.requestAnimationFrame(() => columnTitleRefs.current.get("main")?.focus({ preventScroll: true }));
    },
    [],
  );

  // Node-open requests from the app shell (feed rows, child rows, the
  // Highlights view) while this tree's document is already mounted.
  useEffect(
    () =>
      listenToResearchNodeOpen((request) => {
        if (request.treeId !== treeIdRef.current) {
          return;
        }
        navigateRef.current(request.nodeId, { reveal: true });
      }),
    [],
  );

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

  // Keyboard: ⌘[ / ⌘] and Alt+←/→ (and mouse buttons 3/4) walk history;
  // bare [ and ] move focus between columns; Esc closes the drawer when no
  // menu, popover, or dialog is open. Keys are ignored while typing, except
  // Esc, which also leaves a composer inside the drawer.
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
        if (event.isComposing || event.keyCode === 229) {
          return;
        }
        if (anyOverlayOpenRef.current || !drawerRef.current) {
          return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[role='menu'], [role='dialog'], [role='alertdialog'], .popover-surface")) {
          return;
        }
        // Escape in a field with text leaves the field and keeps the text
        // (closing a new branch discards its question); a second Escape
        // closes the drawer.
        if (
          (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
          target.value.trim()
        ) {
          event.preventDefault();
          const column = target.closest(".research-branch-drawer, .research-conv-column");
          const title = column?.querySelector<HTMLElement>(".research-column-title");
          if (title) {
            title.focus({ preventScroll: true });
          } else {
            target.blur();
          }
          return;
        }
        event.preventDefault();
        closeDrawerToConversation();
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      const primary = event.metaKey || event.ctrlKey;
      if (!primary && !event.altKey && !event.shiftKey && (event.key === "[" || event.key === "]")) {
        const index = columnKeys.indexOf(focusedColumnKey);
        const next = columnKeys[index + (event.key === "]" ? 1 : -1)];
        if (next) {
          event.preventDefault();
          focusColumn(next, { moveFocus: true });
        }
        return;
      }
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
  }, [closeDrawerToConversation, columnKeys, focusColumn, focusedColumnKey, goBack, goForward]);

  // ⌘J routed from the app-level shortcut dispatcher: bring the composer of
  // the column in front (the drawer when it is open) into view and focus it.
  const focusedComposerKeyRef = useRef<string>(mainComposerKey);
  useEffect(
    () =>
      listenToResearchFollowupsFocus(() => {
        const handle = composerRefs.current.get(focusedComposerKeyRef.current);
        handle?.focus();
        handle?.element()?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
      }),
    [],
  );

  useResearchSwipeNavigation(mainScrollRef, goBack, goForward, Boolean(detail));

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

  // Bound the cache to the rendered chains.
  useEffect(() => {
    const keep = new Set(chainNodeIds);
    const prune = <T,>(current: Record<string, T>) =>
      withoutKeys(current, Object.keys(current).filter((key) => !keep.has(key)));
    setContentByNode(prune);
    setContentErrorByNode(prune);
    for (const key of [...fetchStampByNodeRef.current.keys()]) {
      if (!keep.has(key)) {
        fetchStampByNodeRef.current.delete(key);
      }
    }
  }, [chainKey]);

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

  // Restore the conversation's scroll offset once it has fully settled (see
  // mainContentSettledRef — restoring against a partially loaded page clamps,
  // and the clamp destroys the saved offset). Once per tree visit. A pending
  // turn to land on (a feed child row) wins over the saved offset.
  useLayoutEffect(() => {
    if (
      !treeId ||
      !rootNodeId ||
      !mainContentSettledRef.current ||
      !mainScrollRef.current ||
      restoredScrollRef.current
    ) {
      return;
    }
    restoredScrollRef.current = true;
    if (pendingScrollNodeIdRef.current && mainChainIds.includes(pendingScrollNodeIdRef.current)) {
      const target = pendingScrollNodeIdRef.current;
      pendingScrollNodeIdRef.current = null;
      setExpandedAnswers((current) => (current[target] ? current : { ...current, [target]: true }));
      window.requestAnimationFrame(() => {
        scrollToSegment(target, "auto");
        flashTurn(target);
      });
      return;
    }
    mainScrollRef.current.scrollTop = restoreResearchScrollPosition(
      navigationPersistence.store[treeId],
      rootNodeId,
    );
  }, [contentByNode, contentErrorByNode, flashTurn, mainChainIds, navigationPersistence, rootNodeId, scrollToSegment, treeId]);

  const recordScroll = useCallback(() => {
    const scroller = mainScrollRef.current;
    if (!scroller) {
      return;
    }
    // The column never scrolls sideways legitimately (wide tables and code
    // blocks scroll inside their own containers), but programmatic scrolls
    // can still shift a hidden axis. Pin it back to the left edge.
    if (scroller.scrollLeft !== 0) {
      scroller.scrollLeft = 0;
    }
    if (!treeId || !rootNodeId || !mainContentSettledRef.current || !restoredScrollRef.current) {
      return;
    }
    navigationPersistence.recordScroll(treeId, rootNodeId, scroller.scrollTop);
  }, [navigationPersistence, rootNodeId, treeId]);

  // Per-turn content-derived view state. Recomputed only for turns whose
  // content or view toggles changed — node metadata stays live while the
  // parsed timeline keeps its identity, which is what keeps the memoized
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
      // A conversation node's whole timeline is the document: there is no
      // "answer" fold to collapse to and no fuller trace to reveal.
      const isConversation =
        node.kind === "conversation" || content?.node.kind === "conversation";
      const isDocument = node.kind === "document";
      const timelineItems = buildTimelineItems(content?.turns ?? []);
      const answerTimelineItems = timelineItemsAfterLastToolCall(timelineItems);
      const hasTranscriptActivity =
        !isConversation && timelineItemsContainTranscriptActivity(timelineItems);
      const displayedTimelineItems =
        isConversation || showFullTrace ? timelineItems : answerTimelineItems;
      // A run trace reads bottom-up (the answer is the tail), so its window
      // keeps the newest items; a conversation reads top-down from its
      // opening question, so its window keeps the head.
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
          for (const block of turn.blocks) {
            if (block.type === "text") {
              editableDocumentMarkdown = block.text;
              break;
            }
          }
          if (editableDocumentMarkdown !== null) {
            break;
          }
        }
      }
      const view: SegmentView = {
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

  // Land on the highlight a Highlights feed unit was opened from: once the
  // conversation has restored (so the saved offset cannot override us) and
  // the passage has been painted, expand its answer, scroll the passage a
  // third of the way down its column, and clear the request.
  useLayoutEffect(() => {
    if (!treeId || !restoredScrollRef.current) {
      return;
    }
    const navigation = navigationPersistence.store[treeId];
    const focus = navigation?.focusHighlight;
    if (!navigation || !focus) {
      return;
    }
    const segmentContent = contentByNode[focus.nodeId];
    if (!segmentContent?.responseRevision) {
      return;
    }
    if (!expandedAnswers[focus.nodeId]) {
      setExpandedAnswers((current) => ({ ...current, [focus.nodeId]: true }));
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
        scrollToSegment(focus.nodeId, "auto");
      }
      return;
    }
    const range = rangeForTextOffsets(root, resolved.start, resolved.end);
    const scroller = root.closest<HTMLElement>(".research-column-scroll");
    if (!range || !scroller) {
      clear();
      scrollToSegment(focus.nodeId, "auto");
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    scroller.scrollTop += rect.top - scrollerRect.top - Math.max(72, scrollerRect.height / 3);
    setFlashRange({ nodeId: focus.nodeId, start: resolved.start, end: resolved.end });
    clear();
  }, [contentByNode, expandedAnswers, highlightPaintVersion, navigationPersistence, scrollToSegment, segmentRoot, treeId]);

  // Paint branch passages (blue) and resolve their offsets for clicks, hover,
  // and reveal. The passages of open branches are also underlined. Anchors
  // that no longer locate a passage simply drop out.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_BRANCH_NAME);
    api?.registry.delete(RESEARCH_OPEN_BRANCH_NAME);
    branchRangeOffsetsRef.current = [];
    if (!api) {
      return;
    }
    const painted = new api.Highlight();
    const open = new api.Highlight();
    open.priority = RESEARCH_OPEN_PRIORITY;
    let paintedAny = false;
    let openAny = false;
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
        painted.add(range);
        paintedAny = true;
        branchRangeOffsetsRef.current.push({ segmentId: nodeId, id, ...offsets });
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
    return () => {
      api.registry.delete(RESEARCH_BRANCH_NAME);
      api.registry.delete(RESEARCH_OPEN_BRANCH_NAME);
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
        ...branchRangeOffsetsRef.current.filter((entry) => entry.segmentId === nodeId),
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
    const live = !revision && Boolean(node && isActiveResearchStatus(node.status));
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
    let crossed = false;
    const startBlock = passageBlockAt(root, range.startContainer);
    if (startBlock && !startBlock.contains(range.endContainer)) {
      let blockEnd = flatTextOffsetAt(root, startBlock, startBlock.childNodes.length) ?? offsets.end;
      while (blockEnd > offsets.start && /\s/.test(projection[blockEnd - 1] ?? "")) {
        blockEnd -= 1;
      }
      if (blockEnd < offsets.end && projection.slice(offsets.start, blockEnd).trim()) {
        offsets.end = blockEnd;
        crossed = true;
      }
    }
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
            entry.id !== "__draft__" &&
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
        navigate(branchIds[0], { returnFocus: branchTriggerFor(nodeId) });
        return;
      }
      setHighlightAction(null);
      setMenu({
        kind: "mark",
        nodeId,
        branchIds,
        highlightId: highlight?.highlight.id ?? null,
        left: event.clientX - 20,
        top: event.clientY - 10,
        bottom: event.clientY + 10,
      });
    },
    [branchTriggerFor, navigate],
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
        (entry) => entry.segmentId === nodeId,
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
    openDraft(nodeId, anchor, branchTriggerFor(nodeId));
  }, [branchTriggerFor, highlightAction, openDraft, selectionBranchBlocker]);

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
      onToast("Couldn’t copy the selection", "warning");
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
  const treeFollowed = Boolean(detail?.tree.followed);
  const treeBookmarked = Boolean(detail?.tree.bookmarked);
  const handleToggleFollow = useCallback(() => {
    if (treeId) void onSetFollowed(treeId, !treeFollowed);
  }, [onSetFollowed, treeFollowed, treeId]);
  const handleToggleBookmark = useCallback(() => {
    if (treeId) void onSetBookmarked(treeId, !treeBookmarked);
  }, [onSetBookmarked, treeBookmarked, treeId]);
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
  // two controls for the same node.
  const retryRequestInFlightRef = useRef(false);
  const handleRetryNode = useCallback((nodeId: string) => {
    if (retryRequestInFlightRef.current) {
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
  const toggleAnswer = useCallback((nodeId: string) => {
    setExpandedAnswers((current) => ({ ...current, [nodeId]: !current[nodeId] }));
  }, []);
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
        view.conversationCopyText ? "Copied conversation" : "Copied research answer",
      );
    } catch {
      onToastRef.current("Couldn’t copy the research answer", "warning");
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
    const rect = trigger.getBoundingClientRect();
    setMenu({ kind: "answer", nodeId, left: rect.right - 240, top: rect.top, bottom: rect.bottom, trigger });
  }, []);
  const openContextMenu = useCallback((nodeId: string, clientX: number, clientY: number) => {
    setMenu({ kind: "answer", nodeId, left: clientX, top: clientY, bottom: clientY });
  }, []);

  // The branch button: with branches it opens their menu; with none it
  // starts a new branch from the whole answer.
  const handleBranchButton = useCallback(
    (nodeId: string, trigger: HTMLButtonElement) => {
      const count = branchesByParentRef.current.get(nodeId)?.length ?? 0;
      if (count === 0) {
        openDraft(nodeId, null, trigger);
        return;
      }
      if (menuRef.current?.kind === "branches" && menuRef.current.nodeId === nodeId) {
        setMenu(null);
        return;
      }
      const rect = trigger.getBoundingClientRect();
      setMenu({ kind: "branches", nodeId, left: rect.left, top: rect.top, bottom: rect.bottom, trigger });
    },
    [openDraft],
  );

  const handleEditQuestion = useCallback((nodeId: string) => {
    const currentDetail = detailRef.current;
    const node = currentDetail?.nodes.find((candidate) => candidate.id === nodeId);
    if (!currentDetail || !node) {
      return;
    }
    const headId = inlineChainFor(currentDetail.nodes, nodeId)[0] ?? nodeId;
    setEditingByHead((current) => ({ ...current, [headId]: nodeId }));
    setComposerText((current) => ({ ...current, [headId]: node.prompt }));
    window.requestAnimationFrame(() => {
      const handle = composerRefs.current.get(headId);
      handle?.focus();
      handle?.element()?.scrollIntoView({ behavior: scrollBehavior(), block: "nearest" });
    });
  }, []);

  /** Sends a column's composer. Editing a failed question removes the failed
   * node and forks the new question from the same parent. While the tail is
   * running the question joins the chain's client-side queue. */
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
          openNewBranch(child.id);
        } catch (err) {
          onErrorRef.current(err instanceof Error ? err.message : String(err));
        } finally {
          setSubmittingKey(null);
        }
        return;
      }
      if (editingId) {
        const failed = currentDetail.nodes.find((node) => node.id === editingId);
        if (!failed?.parentNodeId) {
          setEditingByHead((current) => withoutKeys(current, [headId]));
          return;
        }
        setSubmittingKey(headId);
        try {
          await onRemoveBranch(failed.id);
          const child = await onForkRef.current(
            failed.parentNodeId,
            prompt,
            failed.queryAnchor ?? null,
            Boolean(failed.inline),
          );
          clearComposer();
          setEditingByHead((current) => withoutKeys(current, [headId]));
          if (failed.id === headId) {
            // The failed node headed a branch: show its replacement.
            pendingNodeIdsRef.current.add(child.id);
            if (pinnedHeadsRef.current.includes(headId)) {
              setPinnedHeads((current) => current.map((id) => (id === headId ? child.id : id)));
            } else {
              setDrawer({ kind: "node", nodeId: child.id });
            }
          } else {
            pendingScrollNodeIdRef.current = child.id;
          }
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
      if (step === "wait" || queued.length > 0) {
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
        clearComposer();
        pendingScrollNodeIdRef.current = child.id;
      } catch (err) {
        onErrorRef.current(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmittingKey(null);
      }
    },
    [archived, mainComposerKey, navigationPersistence, onRemoveBranch, openNewBranch, updateQueue],
  );

  /** Sends the drawer's new branch: the branch is created with its first
   * question, then the drawer shows it. */
  const submitDraft = useCallback(async () => {
    const current = drawerRef.current;
    if (current?.kind !== "draft") {
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
      if (drawerRef.current === current) {
        openNewBranch(child.id);
      }
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingKey(null);
    }
  }, [archived, navigationPersistence, openNewBranch]);

  // Send each chain's first queued follow-up once its tail completes.
  const queueSendingRef = useRef(new Set<string>());
  useEffect(() => {
    if (!detail || archived) {
      return;
    }
    for (const [headId, queue] of Object.entries(queues)) {
      // A question the backend refused waits for Retry or Remove.
      if (queue.length === 0 || queue[0].failed || queueSendingRef.current.has(headId)) {
        continue;
      }
      const chain = inlineChainFor(detail.nodes, headId);
      const tail = nodeById.get(chain[chain.length - 1] ?? "") ?? null;
      if (!nodeById.has(headId)) {
        updateQueue(headId, () => []);
        continue;
      }
      if (researchQueueStep(tail) !== "send" || !tail || !canContinueThread(detail.nodes, tail)) {
        continue;
      }
      const [next] = queue;
      queueSendingRef.current.add(headId);
      onFork(tail.id, next.prompt, null, true)
        .then((child) => {
          updateQueue(headId, (current) => current.filter((item) => item.id !== next.id));
          pendingScrollNodeIdRef.current = child.id;
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          updateQueue(headId, (current) =>
            current.map((item) => (item.id === next.id ? { ...item, failed: message } : item)),
          );
        })
        .finally(() => queueSendingRef.current.delete(headId));
    }
  }, [archived, detail, nodeById, onFork, queues, updateQueue]);

  // A new branch's composer takes focus once its node has rendered.
  useEffect(() => {
    const target = pendingComposerFocusRef.current;
    const handle = target ? composerRefs.current.get(target) : null;
    if (!target || !handle) {
      return;
    }
    pendingComposerFocusRef.current = null;
    if (drawerRef.current?.kind === "node" && drawerRef.current.nodeId === target) {
      handle.focus();
    }
  });

  const onDrawerNodeChangeRef = useRef(onDrawerNodeChange);
  onDrawerNodeChangeRef.current = onDrawerNodeChange;
  useEffect(() => {
    onDrawerNodeChangeRef.current?.(drawerNodeId);
  }, [drawerNodeId]);
  useEffect(() => () => onDrawerNodeChangeRef.current?.(null), []);

  // Scroll to a just-submitted follow-up once the refreshed detail delivers it.
  useEffect(() => {
    const target = pendingScrollNodeIdRef.current;
    if (!target || !chainNodeIds.includes(target) || !restoredScrollRef.current) {
      return;
    }
    pendingScrollNodeIdRef.current = null;
    window.requestAnimationFrame(() => {
      const anchor = segmentAnchor(target);
      anchor?.scrollIntoView({ behavior: scrollBehavior(), block: "nearest" });
    });
  }, [chainKey, chainNodeIds, segmentAnchor]);

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

  // The whole chain as one Markdown document: each turn's question and
  // answer in order, separated by rules.
  async function copyThread(chainIds: string[]) {
    const parts: string[] = [];
    for (const id of chainIds) {
      const view = segmentViews.get(id);
      const chainNode = nodeById.get(id);
      if (!view) {
        continue;
      }
      const body = (view.conversationCopyText ?? view.rawAnswer).trim();
      const prompt =
        view.isDocument || view.isConversation ? null : chainNode?.prompt.trim() || null;
      if (!prompt && !body) {
        continue;
      }
      parts.push(
        [prompt ? `**Question:** ${prompt}` : null, body || "_No response available._"]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    if (parts.length === 0) {
      return;
    }
    try {
      await writeClipboardText(parts.join("\n\n---\n\n"));
      onToast("Copied thread");
    } catch {
      onToast("Couldn’t copy the thread", "warning");
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
      const removal = await onRemoveBranch(deletingBranch.node.id);
      // The backend call and detail refresh can outlive this document's tree.
      if (treeIdRef.current !== removal.treeId) {
        setDeletingBranchId(null);
        return;
      }
      const removedNodeIds = new Set(removal.removedNodeIds);
      const validNodeIds = new Set(
        (detail?.nodes ?? [])
          .filter((node) => !removedNodeIds.has(node.id))
          .map((node) => node.id),
      );
      setHistory((current) => pruneResearchHistory(current, validNodeIds, removal.parentNodeId));
      setPinnedHeads((current) => current.filter((id) => !removedNodeIds.has(id)));
      const current = drawerRef.current;
      if (current?.kind === "node" && removedNodeIds.has(current.nodeId)) {
        // The drawer showed the removed branch (or a later turn of it): show
        // the surviving parent when it is itself a branch, else close.
        const parentId = removal.parentNodeId;
        if (parentId && !mainChainIdsRef.current.includes(parentId)) {
          setDrawer({ kind: "node", nodeId: parentId });
        } else {
          closeDrawer("close");
        }
      }
      if (selectedNodeId && removedNodeIds.has(selectedNodeId)) {
        setSelectedNodeId(removal.parentNodeId);
        persistSelection(removal.parentNodeId);
      }
      setDeletingBranchId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBranchRemovalError(message);
      onError(message);
    } finally {
      setRemovingBranch(false);
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
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenaming(false);
    }
  }

  // Which composer ⌘J focuses: the drawer's when it is open, else the
  // focused column's.
  focusedComposerKeyRef.current = drawer
    ? drawer.kind === "draft"
      ? `draft:${drawer.parentNodeId}`
      : drawerHeadId ?? mainComposerKey
    : focusedColumnKey === "main"
      ? mainComposerKey
      : focusedColumnKey;

  if (!detail || !rootNodeId || !selectedNodeId) {
    // A failed *tree* fetch retries through the app shell — without detail
    // there is no node to load, so no in-document retry can recover.
    const placeholderError = detailError ?? null;
    const headerTitle = detail?.tree.title ?? treeTitle ?? "Loading research…";
    return (
      <ResearchDocumentFrame
        title={headerTitle}
      >
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

  // ---- rendering -------------------------------------------------------------

  const renderTurns = (
    chainIds: readonly string[],
    {
      inConversation,
      register,
    }: {
      inConversation: boolean;
      register: (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => void;
    },
  ) =>
    chainIds.map((id, index) => {
      const node = nodeById.get(id);
      const view = segmentViews.get(id);
      if (!node || !view) {
        return null;
      }
      const branches = branchesByParent.get(id) ?? EMPTY_BRANCHES;
      const active = isActiveResearchStatus(node.status);
      // A cancelled turn already says how long it ran ("Stopped after").
      const durationText =
        view.isConversation || active || node.status === "cancelled" || !node.startedAt
          ? null
          : `${node.status === "complete" ? "" : "Ran for "}${formatRunDuration(
              (node.completedAt ?? metadataNow) - node.startedAt,
            )}`;
      const replyQuote = node.replyAnchor
        ? nodeById.get(node.parentNodeId ?? "")?.delivery?.replies?.find(
            (reply) => reply.id === node.replyAnchor,
          )?.body ?? null
        : null;
      return (
        <ResearchTurn
          key={id}
          view={view}
          node={node}
          replyQuote={replyQuote}
          now={minuteNow}
          promotable={inConversation && index > 0 && Boolean(node.inline)}
          branchCount={branches.length}
          branchOpen={branches.some((branch) => openBranchIds.has(branch.id)) ||
            (drawer?.kind === "draft" && drawer.parentNodeId === id)}
          branchUnread={branches.some(
            (branch) =>
              branch.status === "complete" &&
              firstSeenCompleteRef.current.get(branch.id) === false &&
              !openedNodeIds.has(branch.id),
          )}
          branchMenuOpen={menu?.kind === "branches" && menu.nodeId === id}
          branchBlocker={branchBlockerFor(node, archived)}
          contentError={contentErrorByNode[id] ?? null}
          cancelling={cancelling}
          elapsedText={active && node.startedAt ? formatElapsedClock(metadataNow - node.startedAt) : null}
          durationText={durationText}
          hiddenHighlightCount={hiddenHighlightsByNode[id] ?? 0}
          recapPending={recapPendingNodeIds.has(id)}
          pointerOverAnnotation={pointerAnnotationNodeId === id}
          menuOpen={menu?.kind === "answer" && menu.nodeId === id}
          expanded={Boolean(expandedAnswers[id])}
          canRetry={!archived && canRetryResearchNode(node)}
          retrying={retryingNodeId === id}
          canEditQuestion={!archived && node.status === "failed" && Boolean(node.parentNodeId)}
          registerSegmentElement={register}
          onExpandTurns={expandAllTurns}
          onRetryContentLoad={retryContentLoad}
          onShowFullTrace={showFullTraceFor}
          onToggleFullTrace={toggleFullTrace}
          onCopyAnswer={handleCopyAnswer}
          onOpenAnswerMenu={openAnswerMenu}
          onCancelNode={handleCancelNode}
          onRetryNode={handleRetryNode}
          onEditQuestion={handleEditQuestion}
          onToggleAnswer={toggleAnswer}
          onTogglePromoted={togglePromoted}
          onBranchButton={handleBranchButton}
          onOpenContextMenu={openContextMenu}
          onRootMouseDown={beginHighlightSelectionDrag}
          onRootMouseUp={finishHighlightSelectionDrag}
          onRootKeyUp={captureHighlightSelection}
          onRootClick={openAnnotationAtPoint}
          onRootMouseMove={trackAnnotationUnderPointer}
          onRootMouseLeave={clearAnnotationPointer}
        />
      );
    });

  const renderQueue = (headId: string) =>
    (queues[headId] ?? EMPTY_QUEUE).map((item, index) => {
      const chain = inlineChainFor(detail.nodes, headId);
      const tail = nodeById.get(chain[chain.length - 1] ?? "") ?? null;
      const stalled = index === 0 && !item.failed && researchQueueStep(tail) === "stalled";
      const remove = () => {
        updateQueue(headId, (queue) => queue.filter((entry) => entry.id !== item.id));
        window.requestAnimationFrame(() => composerRefs.current.get(headId)?.focus());
      };
      return (
        <article key={item.id} className="research-turn is-status-queued is-client-queued">
          <div className="research-turn-question">
            <div className="research-user-message research-prompt research-turn-prompt is-plain">
              {item.prompt}
            </div>
            <div className="research-turn-meta">
              <time
                dateTime={new Date(item.createdAt).toISOString()}
                title={new Date(item.createdAt).toLocaleString()}
              >
                {shortWhen(item.createdAt, minuteNow)}
              </time>
            </div>
          </div>
          <div className="research-turn-answer">
            {item.failed ? (
              <div className="research-turn-alert is-error" role="alert">
                <div>
                  <b>Not sent.</b> {item.failed}
                </div>
              </div>
            ) : (
              <div className="research-turn-note is-state">
                {stalled
                  ? "Not sent. The answer above stopped; retry it, or edit this question."
                  : "Queued. Starts when the running answer finishes."}
              </div>
            )}
            <div className="research-turn-actions">
              {item.failed ? (
                <button
                  type="button"
                  className="control-button research-turn-button"
                  onClick={() =>
                    updateQueue(headId, (queue) =>
                      queue.map((entry) => (entry.id === item.id ? { ...entry, failed: undefined } : entry)),
                    )
                  }
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  <span>Retry</span>
                </button>
              ) : null}
              {stalled || item.failed ? (
                <button
                  type="button"
                  className="control-button research-turn-button is-ghost"
                  onClick={() => {
                    updateQueue(headId, (queue) => queue.filter((entry) => entry.id !== item.id));
                    setComposerText((current) => ({ ...current, [headId]: item.prompt }));
                    window.requestAnimationFrame(() => composerRefs.current.get(headId)?.focus());
                  }}
                >
                  Edit question
                </button>
              ) : null}
              <button type="button" className="control-button research-turn-button is-ghost" onClick={remove}>
                Remove
              </button>
            </div>
          </div>
        </article>
      );
    });

  const registerComposer = (key: string) => (handle: ResearchComposerHandle | null) => {
    if (handle) {
      composerRefs.current.set(key, handle);
    } else {
      composerRefs.current.delete(key);
    }
  };

  /** A column's composer: continue the chain (queueing while it runs), or
   * replace a failed question being edited. */
  const renderChainComposer = (headId: string, chainIds: readonly string[], live = true) => {
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
      (Boolean(editingId) || step === "wait" || queued || canContinueThread(detail.nodes, tail));
    const note = editingId ? (
      <>
        Editing the failed question. Sending replaces the failed attempt.{" "}
        <button
          type="button"
          className="research-link-button"
          onClick={() => {
            setEditingByHead((current) => withoutKeys(current, [headId]));
            setComposerText((current) => ({ ...current, [headId]: "" }));
          }}
        >
          Cancel
        </button>
      </>
    ) : archived ? (
      "Archived questions are read-only. Restore it from Archive to ask follow-ups."
    ) : awaitingCheckpoint ? (
      "Waiting for the native session checkpoint before continuing."
    ) : step === "stalled" && !queued ? (
      tail.status === "failed"
        ? "The last answer stopped with an error. Retry it or edit its question to continue."
        : "The last answer was stopped. Run it again to continue."
    ) : null;
    const placeholder = editingId
      ? "Edit the question"
      : head.kind === "document" && chain.length === 1
        ? "Ask about this document"
        : head.kind === "conversation" && chain.length === 1
          ? "Ask about this conversation"
          : "Ask a follow-up";
    const composerFocused = focusedComposerKeyRef.current === headId;
    return (
      <ResearchConversationComposer
        ref={live ? registerComposer(headId) : undefined}
        value={text}
        placeholder={placeholder}
        ariaLabel={editingId ? "Edit the question" : "Ask a follow-up"}
        disabled={archived || (step === "stalled" && !editingId && !queued)}
        canSubmit={canSend}
        submitting={submittingKey === headId}
        note={note}
        shortcutHint={shortcutHintsShown && composerFocused ? "⌘J" : null}
        onChange={(value) => setComposerText((current) => ({ ...current, [headId]: value }))}
        onSubmit={() => void submitComposer(headId)}
        onSubmitBranch={() => void submitComposer(headId, { branch: true })}
      />
    );
  };

  const branchTitle = (head: ResearchNode | null | undefined, anchor?: ResearchHighlightAnchor | null) => {
    if (head) {
      return nodeLabel(head, "Branch");
    }
    return anchor ? `Branch: ${quoteDisplayText(anchor.exact)}` : "New branch";
  };

  const siblingSwitcher = (headId: string, onSwitch: (siblingId: string) => void) => {
    const head = nodeById.get(headId);
    const siblings = head?.parentNodeId ? branchesByParent.get(head.parentNodeId) ?? EMPTY_BRANCHES : EMPTY_BRANCHES;
    const index = siblings.findIndex((sibling) => sibling.id === headId);
    if (siblings.length < 2 || index < 0) {
      return null;
    }
    return {
      index,
      count: siblings.length,
      onStep: (delta: -1 | 1) => {
        const next = siblings[index + delta];
        if (next) {
          onSwitch(next.id);
        }
      },
    };
  };

  const jumpToSource = (headId: string) => {
    const head = nodeById.get(headId);
    const parentId = head?.parentNodeId;
    if (!head || !parentId) {
      return;
    }
    const placement = researchNodePlacement(detail.nodes, mainChainIds, validPinnedHeads, parentId);
    setExpandedAnswers((current) => (current[parentId] ? current : { ...current, [parentId]: true }));
    if (placement.kind === "drawer") {
      navigate(parentId);
      window.setTimeout(() => revealPassage(headId, true), 0);
      return;
    }
    if (singleColumn && drawer) {
      closeDrawer("close");
    }
    focusColumn(placement.kind === "main" ? "main" : placement.headId);
    window.requestAnimationFrame(() => revealPassage(headId, true));
  };

  /** The title of the conversation or branch a node is part of. */
  const chainTitleOf = (nodeId: string) =>
    mainChainIds.includes(nodeId)
      ? treeTitleText
      : nodeLabel(nodeById.get(researchChainHead(detail.nodes, nodeId)), "the parent branch");

  const sourceLine = (headId: string, hasTurns: boolean) => {
    const head = nodeById.get(headId);
    const parent = head?.parentNodeId ? nodeById.get(head.parentNodeId) : null;
    if (!head || !parent) {
      return null;
    }
    const resolves = branchRangeOffsetsRef.current.some((entry) => entry.id === headId);
    const quote = head.queryAnchor ? quoteDisplayText(head.queryAnchor.exact) : null;
    return (
      <ResearchBranchSource
        quote={quote && (resolves || !contentByNode[parent.id]) ? quote : null}
        previousQuote={quote && !resolves && contentByNode[parent.id] ? quote : null}
        parentTitle={chainTitleOf(parent.id)}
        full={!hasTurns}
        onJump={() => jumpToSource(headId)}
      />
    );
  };

  const columnBody = (headId: string, chainIds: readonly string[], register: typeof registerSegmentElement) => {
    const head = nodeById.get(headId);
    if (head?.kind === "note") {
      return (
        <ResearchNoteDocument
          detail={detail}
          note={head}
          archived={archived}
          actions={noteActions}
          onSelectNode={(nodeId) => navigate(nodeId)}
        />
      );
    }
    return (
      <>
        <div className="research-turns">{renderTurns(chainIds, { inConversation: false, register })}</div>
        {renderQueue(headId)}
        {renderChainComposer(headId, chainIds, register !== registerNothing)}
      </>
    );
  };

  const mainColumn = (
    <section
      key="main"
      className={`research-conv-column is-main${focusedColumnKey === "main" ? " is-focused" : ""}${
        singleColumn && focusedColumnKey !== "main" ? " is-hidden" : ""
      }`}
      data-research-column="main"
      aria-label={treeTitleText}
      onMouseDown={() => takeColumnFocus("main")}
    >
      <ResearchConversationHeader
        title={treeTitleText}
        titleRef={(element) => {
          if (element) columnTitleRefs.current.set("main", element);
          else columnTitleRefs.current.delete("main");
        }}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
        forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
        onBack={goBack}
        onForward={goForward}
        imported={rootNode?.origin === "terminalExport"}
        archived={archived}
        followed={treeFollowed}
        bookmarked={treeBookmarked}
        onToggleFollow={handleToggleFollow}
        onToggleBookmark={handleToggleBookmark}
        onMove={onMoveTree ? (trigger) => onMoveTree(detail.tree.id, trigger) : undefined}
        onClose={onClose}
        onColumnBack={
          singleColumn && columnsLayout ? () => columnsLayout.focusFeed({ moveFocus: true }) : undefined
        }
      />
      <div
        ref={mainScrollRef}
        className="research-column-scroll"
        onScroll={recordScroll}
      >
        <div ref={mainContentRef} className="research-column-content research-reading-surface">
          {rootNode?.kind === "note" ? (
            <ResearchNoteDocument
              detail={detail}
              note={rootNode}
              archived={archived}
              actions={noteActions}
              onSelectNode={(nodeId) => navigate(nodeId)}
            />
          ) : (
            <>
              <div className="research-turns">
                {renderTurns(mainChainIds, { inConversation: true, register: registerSegmentElement })}
              </div>
              {renderQueue(rootNodeId)}
              {renderChainComposer(rootNodeId, mainChainIds)}
            </>
          )}
        </div>
      </div>
    </section>
  );

  const pinnedColumns = validPinnedHeads.map((headId, index) => {
    const head = nodeById.get(headId);
    const chainIds = pinnedChains[index] ?? [headId];
    const parentBranch = researchParentBranchHead(detail.nodes, mainChainIds, headId);
    return (
      <section
        key={headId}
        className={`research-conv-column is-pinned${focusedColumnKey === headId ? " is-focused" : ""}${
          singleColumn && focusedColumnKey !== headId ? " is-hidden" : ""
        }`}
        style={singleColumn ? undefined : { width: RESEARCH_PINNED_COLUMN_WIDTH }}
        data-research-column={headId}
        aria-label={branchTitle(head)}
        onMouseDown={() => takeColumnFocus(headId)}
      >
        <ResearchBranchHeader
          title={branchTitle(head)}
          titleRef={(element) => {
            if (element) columnTitleRefs.current.set(headId, element);
            else columnTitleRefs.current.delete(headId);
          }}
          backLabel={
            singleColumn
              ? "Back"
              : parentBranch
                ? `Back to “${nodeLabel(nodeById.get(parentBranch), "the parent branch")}”`
                : undefined
          }
          onBack={
            singleColumn
              ? () => focusColumn(columnKeys[columnKeys.indexOf(headId) - 1] ?? "main", { moveFocus: true })
              : parentBranch
                ? () => navigate(parentBranch)
                : undefined
          }
          siblings={siblingSwitcher(headId, (siblingId) => {
            if (drawerHeadId === siblingId) {
              closeDrawer("pin");
            }
            setPinnedHeads((current) =>
              current
                .map((id) => (id === headId ? siblingId : id))
                .filter((id, position, all) => all.indexOf(id) === position),
            );
            takeColumnFocus(siblingId);
            markOpened(siblingId);
          })}
          promoted={Boolean(head?.promotedAt)}
          canPromote={Boolean(head)}
          onTogglePromoted={() => togglePromoted(headId)}
          onClose={() => unpinBranch(headId)}
          closeLabel="Close this pinned column"
        />
        <div className="research-column-scroll">
          <div className="research-column-content research-reading-surface is-branch">
            {sourceLine(headId, chainIds.some((id) => nodeById.has(id)))}
            {columnBody(headId, chainIds, registerSegmentElement)}
          </div>
        </div>
      </section>
    );
  });

  const renderDrawerContent = (target: DrawerTarget, live: boolean) => {
    const register = live ? registerSegmentElement : registerNothing;
    if (target.kind === "draft") {
      const parent = nodeById.get(target.parentNodeId);
      const key = `draft:${target.parentNodeId}`;
      const quote = target.anchor ? quoteDisplayText(target.anchor.exact) : null;
      return (
        <>
          <ResearchBranchHeader
            title={branchTitle(null, target.anchor)}
            titleRef={live ? drawerTitleRef : undefined}
            backLabel={singleColumn ? "Back" : undefined}
            onBack={singleColumn ? closeDrawerToConversation : undefined}
            promoted={false}
            canPromote={false}
            onClose={singleColumn ? undefined : closeDrawerToConversation}
            closeLabel="Close (Esc)"
          />
          <div className="research-column-scroll" ref={live ? drawerScrollRef : undefined}>
            <div className="research-column-content research-reading-surface is-branch">
              {parent ? (
                <ResearchBranchSource
                  quote={quote}
                  parentTitle={chainTitleOf(parent.id)}
                  full
                  onJump={() => {
                    const placement = researchNodePlacement(
                      detail.nodes,
                      mainChainIds,
                      validPinnedHeads,
                      parent.id,
                    );
                    if (placement.kind === "drawer") {
                      return;
                    }
                    focusColumn(placement.kind === "main" ? "main" : placement.headId);
                    window.requestAnimationFrame(() => {
                      const entry = branchRangeOffsetsRef.current.find((candidate) => candidate.id === "__draft__");
                      if (entry) {
                        setFlashRange({ nodeId: parent.id, start: entry.start, end: entry.end });
                      } else {
                        flashTurn(parent.id);
                      }
                    });
                  }}
                />
              ) : null}
              <div className="research-branch-empty">
                <p>
                  Ask about {quote ? "this passage" : "this answer"} to create a new branch.
                </p>
              </div>
              <ResearchConversationComposer
                ref={live ? registerComposer(key) : undefined}
                value={composerText[key] ?? ""}
                placeholder={quote ? "Ask about this passage" : "Ask about this answer"}
                ariaLabel="Ask about this passage to create a new branch"
                disabled={archived}
                canSubmit={!archived}
                submitting={submittingKey === key}
                onChange={(value) => setComposerText((current) => ({ ...current, [key]: value }))}
                onSubmit={() => void submitDraft()}
              />
            </div>
          </div>
        </>
      );
    }
    const chainIds = live ? drawerChainIds : leavingChainIds;
    const headId = chainIds[0] ?? target.nodeId;
    const head = nodeById.get(headId);
    const parentBranch = researchParentBranchHead(detail.nodes, mainChainIds, headId);
    return (
      <>
        <ResearchBranchHeader
          title={branchTitle(head)}
          titleRef={live ? drawerTitleRef : undefined}
          backLabel={
            singleColumn
              ? "Back"
              : parentBranch
                ? `Back to “${nodeLabel(nodeById.get(parentBranch), "the parent branch")}”`
                : undefined
          }
          onBack={
            singleColumn
              ? closeDrawerToConversation
              : parentBranch
                ? () => navigate(parentBranch)
                : undefined
          }
          siblings={siblingSwitcher(headId, (siblingId) => navigate(siblingId))}
          promoted={Boolean(head?.promotedAt)}
          canPromote={Boolean(head)}
          onTogglePromoted={() => togglePromoted(headId)}
          onPin={head ? () => pinBranch(headId) : undefined}
          onClose={singleColumn ? undefined : closeDrawerToConversation}
          closeLabel="Close (Esc)"
        />
        <div className="research-column-scroll" ref={live ? drawerScrollRef : undefined}>
          <div className="research-column-content research-reading-surface is-branch">
            {head ? (
              <>
                {sourceLine(headId, true)}
                {columnBody(headId, chainIds, register)}
              </>
            ) : (
              <div className="research-response-loading is-drawer">
                <LoaderCircle className="research-spinner" size={18} aria-hidden="true" />
              </div>
            )}
          </div>
        </div>
      </>
    );
  };

  const drawerTarget = drawer ?? leavingDrawer?.target ?? null;
  const drawerElement = drawerTarget ? (
    <ResearchBranchDrawer
      key={drawer ? drawerInstance : leavingDrawer?.instance}
      ref={drawer ? drawerElementRef : undefined}
      width={drawerWidth}
      full={singleColumn}
      label={`Branch: ${
        drawerTarget.kind === "draft"
          ? branchTitle(null, drawerTarget.anchor)
          : branchTitle(nodeById.get((drawer ? drawerChainIds : leavingChainIds)[0] ?? drawerTarget.nodeId))
      }`}
      contentKey={
        drawerTarget.kind === "draft"
          ? `draft:${drawerTarget.parentNodeId}`
          : (drawer ? drawerHeadId : leavingChainIds[0]) ?? drawerTarget.nodeId
      }
      animateOpen={drawerAnimates}
      leaving={drawer ? null : leavingDrawer?.mode ?? null}
      onLeft={() => setLeavingDrawer((current) => (current && !drawerRef.current ? null : current))}
    >
      {renderDrawerContent(drawerTarget, Boolean(drawer))}
    </ResearchBranchDrawer>
  ) : null;

  const menuNode = menu ? nodeById.get(menu.nodeId) ?? null : null;
  const renderMenu = () => {
    if (!menu || !menuNode) {
      return null;
    }
    if (menu.kind === "branches") {
      const branches = branchesByParent.get(menu.nodeId) ?? EMPTY_BRANCHES;
      const blocker = branchBlockerFor(menuNode, archived);
      return (
        <FloatingMenu anchor={menu} label="Branches from this answer" onClose={() => setMenu(null)}>
          <div className="research-menu-title">Branches from this answer</div>
          {branches.map((branch) => {
            const open = openBranchIds.has(branch.id);
            const unread =
              branch.status === "complete" &&
              firstSeenCompleteRef.current.get(branch.id) === false &&
              !openedNodeIds.has(branch.id);
            return (
              <MenuItem
                key={branch.id}
                icon={<GitBranch size={14} aria-hidden="true" />}
                label={nodeLabel(branch, "Branch")}
                description={unread && !open ? "New answer" : undefined}
                current={open}
                onSelect={() => navigate(branch.id, { returnFocus: menu.trigger ?? null })}
                trailing={
                  open ? (
                    <Check size={14} className="research-menu-check" aria-hidden="true" />
                  ) : unread ? (
                    <span className="research-turn-unread" aria-hidden="true" />
                  ) : null
                }
              />
            );
          })}
          <div className="research-menu-divider" role="separator" />
          <MenuItem
            icon={<Plus size={14} aria-hidden="true" />}
            label="New branch here"
            disabled={blocker !== null}
            title={blocker ?? undefined}
            onSelect={() => openDraft(menu.nodeId, null, menu.trigger ?? null)}
          />
        </FloatingMenu>
      );
    }
    if (menu.kind === "mark") {
      const highlight = menu.highlightId
        ? (contentByNode[menu.nodeId]?.node.highlights ?? []).find((item) => item.id === menu.highlightId) ?? null
        : null;
      const blocker = branchBlockerFor(menuNode, archived);
      return (
        <FloatingMenu anchor={menu} label="Passage" onClose={() => setMenu(null)}>
          {menu.branchIds.map((branchId) => (
            <MenuItem
              key={branchId}
              icon={<GitBranch size={14} aria-hidden="true" />}
              label={nodeLabel(nodeById.get(branchId), "Branch")}
              current={openBranchIds.has(branchId)}
              onSelect={() => navigate(branchId)}
            />
          ))}
          {highlight ? (
            <>
              <MenuItem
                icon={<GitBranch size={14} aria-hidden="true" />}
                label="Branch from highlight"
                disabled={blocker !== null}
                title={blocker ?? undefined}
                onSelect={() => openDraft(menu.nodeId, highlight.anchor, branchTriggerFor(menu.nodeId))}
              />
              <MenuItem
                icon={<X size={14} aria-hidden="true" />}
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
        </FloatingMenu>
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
    const chainIds = inlineChainFor(detail.nodes, node.id);
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
    const threadReady = chainIds.every((id) => segmentViews.get(id)?.content);
    return (
      <FloatingMenu
        anchor={menu}
        label={`Actions for ${nodeLabel(node, treeTitleText)}`}
        onClose={() => setMenu(null)}
      >
        {chainIds.length > 1 ? (
          <MenuItem
            icon={<Copy size={14} aria-hidden="true" />}
            label="Copy thread as Markdown"
            disabled={!threadReady}
            title={threadReady ? undefined : "The thread is still loading"}
            onSelect={() => {
              setMenu(null);
              void copyThread(chainIds);
            }}
          />
        ) : null}
        {view?.hasTranscriptActivity ? (
          <MenuItem
            icon={<ScrollText size={14} aria-hidden="true" />}
            label={fullTraceNodes[node.id] ? "Hide full transcript" : "Show full transcript"}
            onSelect={() => {
              setMenu(null);
              setFullTraceNodes((current) => ({ ...current, [node.id]: !current[node.id] }));
            }}
          />
        ) : null}
        {!archived && canRetryResearchNode(node) ? (
          <MenuItem
            icon={<RefreshCw size={14} aria-hidden="true" />}
            label="Retry run"
            disabled={retryingNodeId !== null}
            onSelect={() => {
              setMenu(null);
              handleRetryNode(node.id);
            }}
          />
        ) : null}
        {canRegenerateRecap ? (
          <MenuItem
            icon={<RefreshCw size={14} aria-hidden="true" />}
            label="Generate summary"
            onSelect={() => {
              setMenu(null);
              setRecapDialogNodeId(node.id);
            }}
          />
        ) : null}
        {isRoot || !node.inline ? (
          <MenuItem
            icon={<Pencil size={14} aria-hidden="true" />}
            label="Rename…"
            onSelect={() => {
              setMenu(null);
              setRenameTarget({
                nodeId: node.id,
                value: isRoot ? treeTitleText : (node.title ?? node.prompt).trim(),
              });
            }}
          />
        ) : null}
        {isRoot && node.kind === "document" ? (
          <MenuItem
            icon={<Pencil size={14} aria-hidden="true" />}
            label="Edit document"
            disabled={
              archived || !content?.responseRevision || view?.editableDocumentMarkdown == null
            }
            title={
              archived
                ? "Unarchive this research before editing its document"
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
        <div className="research-menu-divider" role="separator" />
        <MenuItem
          icon={<Trash2 size={14} aria-hidden="true" />}
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
      </FloatingMenu>
    );
  };

  // ⌘F searches the drawer, then the conversation, then pinned columns.
  const searchRoots = () => {
    const roots: HTMLElement[] = [];
    const drawerContent = drawerElementRef.current?.querySelector<HTMLElement>(".research-column-content");
    if (drawer && drawerContent) {
      roots.push(drawerContent);
    }
    roots.push(
      ...(workspaceRef.current?.querySelectorAll<HTMLElement>(
        ".research-conv-column:not(.is-hidden) .research-column-content",
      ) ?? []),
    );
    return roots;
  };
  // A match inside a clamped answer expands the answer; a match in a pinned
  // column scrolled out of view scrolls the row to it.
  const revealSearchMatch = (range: Range) => {
    const element =
      range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    showResearchColumn(
      columnsLayout?.row ?? null,
      element?.closest<HTMLElement>(".research-conv-column") ?? null,
      "auto",
    );
    const clamp = element?.closest<HTMLElement>(".research-answer-clamp.is-clamped");
    const nodeId = element?.closest<HTMLElement>(".research-response-content-root")?.dataset.nodeId;
    if (!clamp || !nodeId || range.getBoundingClientRect().bottom <= clamp.getBoundingClientRect().bottom - 2) {
      return false;
    }
    setExpandedAnswers((current) => ({ ...current, [nodeId]: true }));
    return true;
  };
  const overlayContent = (
    <>
      {drawerElement}
      <DomSearchBar
        active
        placeholder="Find in research"
        rootRef={mainContentRef}
        viewportRef={mainScrollRef}
        getRoots={searchRoots}
        rootsKey={`${drawerHeadId ?? drawer?.kind ?? ""}:${validPinnedHeads.join(",")}:${focusedColumnKey}`}
        scopeContains={(target) =>
          Boolean(workspaceRef.current?.contains(target) || drawerElementRef.current?.contains(target))
        }
        viewportFor={(range) =>
          (range.startContainer instanceof Element
            ? range.startContainer
            : range.startContainer.parentElement
          )?.closest<HTMLElement>(".research-column-scroll") ?? null
        }
        revealRange={revealSearchMatch}
      />
    </>
  );

  return (
    <TranscriptLinkActionsProvider actions={linkActions}>
      <div
        ref={workspaceRef}
        className={`research-workspace research-conversation-workspace${
          singleColumn ? " is-single-column" : ""
        }${drawer ? " has-drawer" : ""}`}
      >
        {mainColumn}
        {pinnedColumns}
      </div>
      {columnsLayout?.overlay ? createPortal(overlayContent, columnsLayout.overlay) : overlayContent}
      {renderMenu()}
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
                  disabled={savingHighlight || selectionBranchBlocker !== null}
                  aria-keyshortcuts="A"
                  title={selectionBranchBlocker ?? "Branch (A)"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={branchFromSelection}
                >
                  <GitBranch size={14} aria-hidden="true" />
                  <span>Branch</span>
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
                  }
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
                  }
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
