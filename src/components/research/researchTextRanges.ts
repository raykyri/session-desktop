// Rendered-text geometry of an answer: flat text offsets (the projection
// highlight and branch anchors are stored against), the ranges they map
// to, and access to the CSS Custom Highlight registry that paints them.

import type { ResearchHighlight } from "../../types";

/** A saved highlight resolved against an answer's rendered text. */
export interface ResearchResolvedHighlight {
  highlight: ResearchHighlight;
  start: number;
  end: number;
}

interface ResearchHighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

export interface ResearchNativeHighlight {
  add(range: Range): void;
  clear(): void;
  priority: number;
}

interface ResearchHighlightApi {
  registry: ResearchHighlightRegistry;
  Highlight: new () => ResearchNativeHighlight;
}

export function researchHighlightApi(): ResearchHighlightApi | null {
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

const WIDGET_SELECTOR = "[data-research-widget]";

function textNodesWithin(root: Node) {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(WIDGET_SELECTOR)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

/** The annotation projection excludes widget source in every presentation,
 * including disabled, incomplete, oversized and failed widgets. */
export function researchTextProjection(root: Node): string {
  return textNodesWithin(root).map((node) => node.data).join("");
}

export function rangeForTextOffsets(root: HTMLElement, start: number, end: number) {
  if (start < 0 || end <= start) {
    return null;
  }
  const nodes = textNodesWithin(root);
  let consumed = 0;
  let startPoint: { node: Text; offset: number } | null = null;
  let endPoint: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const next = consumed + node.data.length;
    if (!startPoint && start < next) {
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

export function applyDirectionalSelectionRange(
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
export const NON_TEXT_ROW_SELECTOR =
  `.tool-block, .thinking-block, .activity-group-block, .research-conversation-activity, ${WIDGET_SELECTOR}`;

/** True when the range starts, ends, or spans across any non-text row. Because
 * `.tool-block` disclosures can sit inside a `.research-response-message`, this
 * intersection test — not a positive "is inside a message" check — is what
 * keeps highlights confined to prose. */
export function selectionTouchesNonTextRow(root: HTMLElement, range: Range) {
  for (const row of root.querySelectorAll(NON_TEXT_ROW_SELECTOR)) {
    if (range.intersectsNode(row)) {
      return true;
    }
  }
  return false;
}

export function selectionOffsets(root: HTMLElement, range: Range) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  const start = flatTextOffsetAt(root, range.startContainer, range.startOffset);
  const end = flatTextOffsetAt(root, range.endContainer, range.endOffset);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

/** The flat rendered-text offset of a caret position, or null when the
 * position sits outside `root`. Text-node positions take the cheap walking
 * path; element positions (rare — clicks on gaps between blocks) fall back to
 * the same clone-and-measure approach as `selectionOffsets`. */
export function flatTextOffsetAt(root: HTMLElement, node: Node, offsetInNode: number) {
  if (!root.contains(node)) {
    return null;
  }
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  if (element?.closest(WIDGET_SELECTOR)) {
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
  return researchTextProjection(probe.cloneContents()).length;
}

/** Hit-tests a viewport point against the rendered text: the flat offset the
 * point falls on, or null off-text. caretRangeFromPoint is the WebKit spelling,
 * caretPositionFromPoint the standard one. */
export function flatOffsetAtPoint(root: HTMLElement, clientX: number, clientY: number) {
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
export function messageFlatBoundaries(root: HTMLElement) {
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
export function enclosingMessageFlatBounds(root: HTMLElement, range: Range) {
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

// The paragraph-level blocks a highlight or branch passage stays within.
const PASSAGE_BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption";

/** The block (paragraph, list item, heading, ...) a position sits in, inside
 * `root`, or null outside any. */
export function passageBlockAt(root: HTMLElement, node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>(PASSAGE_BLOCK_SELECTOR) ?? null;
  return block && root.contains(block) ? block : null;
}
