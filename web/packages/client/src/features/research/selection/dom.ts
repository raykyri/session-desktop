// The DOM half of the selection and highlight flow
// (`09-research-document-view.md` §5). The algorithms live in
// `@session/shared` (`researchSelection`, `researchHighlights`); this module is
// the measuring glue — flat offsets in, `Range`s out — and holds no state.
//
// The `answer-v1` projection is `root.textContent` of a segment's response
// content root: every rendered text node in DOM order, no separators. That is
// also why the seams between messages have to be supplied to the word snapper
// explicitly: there is no whitespace between one message's last word and the
// next one's first.

import { isEditableTarget, stripWikilinks } from "@session/shared";

/** Excludes non-content UI elements (tool inputs/outputs, thinking disclosures) from text selection anchors. */
export const NON_TEXT_ROW_SELECTOR = ".tool-block, .thinking-block, .activity-group-block";

/** The class the message wrapper carries, used both to clamp anchor context to
 * one message and to find the seams between them. */
export const RESPONSE_MESSAGE_CLASS = "research-response-message";

/**
 * Marks the one element whose `textContent` *is* the `answer-v1` projection.
 *
 * It is not `data-node-id`: that attribute is on the segment grid, on the rail
 * and on every branch card as well, so a `closest()` walk from a selection that
 * strayed outside the answer would find one of those and measure an anchor
 * against text no anchor can be resolved in. This attribute is on the response
 * content root and nowhere else, and its value is the node id.
 */
export const RESPONSE_ROOT_ATTRIBUTE = "data-research-response-root";
export const RESPONSE_ROOT_SELECTOR = `[${RESPONSE_ROOT_ATTRIBUTE}]`;

/** The node a response root belongs to, or null when the element is not one. */
export function responseRootNodeId(root: HTMLElement | null | undefined): string | null {
  return root?.getAttribute(RESPONSE_ROOT_ATTRIBUTE) || null;
}

export function textNodesWithin(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

/** A `Range` over the flat projection's `[start, end)`, or null when the
 * offsets do not address rendered text. */
export function rangeForTextOffsets(root: HTMLElement, start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null;
  const nodes = textNodesWithin(root);
  let consumed = 0;
  let startPoint: { node: Text; offset: number } | null = null;
  let endPoint: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const next = consumed + node.data.length;
    if (!startPoint && start <= next) startPoint = { node, offset: start - consumed };
    if (end <= next) {
      endPoint = { node, offset: end - consumed };
      break;
    }
    consumed = next;
  }
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

/**
 * Applies a range while preserving selection direction so keyboard adjustments
 * continue from the active focus boundary. Reapplying an identical selection is
 * a no-op, allowing repeated `selectionchange` normalization.
 */
export function applyDirectionalSelectionRange(
  range: Range,
  direction: "forward" | "backward",
): void {
  const selection = window.getSelection();
  if (!selection) return;
  if (selection.rangeCount > 0 && !selection.isCollapsed) {
    const current = selection.getRangeAt(0);
    const sameRange =
      current.startContainer === range.startContainer &&
      current.startOffset === range.startOffset &&
      current.endContainer === range.endContainer &&
      current.endOffset === range.endOffset;
    const anchorNode = direction === "forward" ? range.startContainer : range.endContainer;
    const anchorOffset = direction === "forward" ? range.startOffset : range.endOffset;
    const focusNode = direction === "forward" ? range.endContainer : range.startContainer;
    const focusOffset = direction === "forward" ? range.endOffset : range.startOffset;
    if (
      sameRange &&
      (typeof selection.setBaseAndExtent !== "function" ||
        (selection.anchorNode === anchorNode &&
          selection.anchorOffset === anchorOffset &&
          selection.focusNode === focusNode &&
          selection.focusOffset === focusOffset))
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

/** True when the range starts, ends, or spans across any non-text row. The
 * test is an intersection rather than a positive "inside a message" check
 * because a `.tool-block` disclosure can sit *inside* a message. */
export function selectionTouchesNonTextRow(root: HTMLElement, range: Range): boolean {
  for (const row of root.querySelectorAll(NON_TEXT_ROW_SELECTOR)) {
    if (range.intersectsNode(row)) return true;
  }
  return false;
}

/** The selection's flat offsets, or null when it is collapsed or leaves the
 * root. */
export function selectionOffsets(
  root: HTMLElement,
  range: Range,
): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(root);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const throughEnd = document.createRange();
  throughEnd.selectNodeContents(root);
  throughEnd.setEnd(range.endContainer, range.endOffset);
  const start = beforeStart.cloneContents().textContent?.length ?? 0;
  const end = throughEnd.cloneContents().textContent?.length ?? 0;
  return end > start ? { start, end } : null;
}

/** The flat offset of a caret position, or null when it sits outside `root`.
 * Text positions take the cheap walk; element positions (clicks on the gaps
 * between blocks) fall back to clone-and-measure. */
export function flatTextOffsetAt(
  root: HTMLElement,
  node: Node,
  offsetInNode: number,
): number | null {
  if (!root.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    let consumed = 0;
    for (const textNode of textNodesWithin(root)) {
      if (textNode === node) return consumed + Math.min(offsetInNode, textNode.data.length);
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

interface CaretDocument {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/** Hit-tests a viewport point against the rendered text.
 * `caretPositionFromPoint` is the standard spelling, `caretRangeFromPoint` the
 * WebKit one. */
export function flatOffsetAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  const doc = document as unknown as CaretDocument;
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(clientX, clientY);
    return position ? flatTextOffsetAt(root, position.offsetNode, position.offset) : null;
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    return range ? flatTextOffsetAt(root, range.startContainer, range.startOffset) : null;
  }
  return null;
}

/** Flat offsets where the enclosing message changes: every seam between one
 * message and the next, or between a message and the rows around it. The
 * projection concatenates these with no separating whitespace, so the word
 * snapper needs them to avoid fusing a message's last word onto its
 * neighbour's first. */
export function messageFlatBoundaries(root: HTMLElement): number[] {
  const boundaries: number[] = [];
  let consumed = 0;
  let previous: HTMLElement | null = null;
  let first = true;
  for (const node of textNodesWithin(root)) {
    const message = node.parentElement?.closest<HTMLElement>(`.${RESPONSE_MESSAGE_CLASS}`) ?? null;
    if (!first && message !== previous) boundaries.push(consumed);
    first = false;
    previous = message;
    consumed += node.data.length;
  }
  return boundaries;
}

/** Flat span of the message enclosing the whole selection, or null when the
 * selection is not confined to one. Anchor context is clamped to this span: a
 * prefix reaching into an adjacent tool row would only ever resolve in the view
 * it was captured in, so the highlight would vanish on a transcript toggle. */
export function enclosingMessageFlatBounds(
  root: HTMLElement,
  range: Range,
): { start: number; end: number } | null {
  const messageOf = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      `.${RESPONSE_MESSAGE_CLASS}`,
    ) ?? null;
  const message = messageOf(range.startContainer);
  if (!message || message !== messageOf(range.endContainer)) return null;
  const start = flatTextOffsetAt(root, message, 0);
  const end = flatTextOffsetAt(root, message, message.childNodes.length);
  return start !== null && end !== null ? { start, end } : null;
}

/** Context slice that never splits a surrogate pair, so an anchor's stored
 * prefix or suffix is always well-formed text. */
export function textContextSlice(text: string, start: number, end: number): string {
  let safeStart = Math.max(0, start);
  let safeEnd = Math.min(text.length, end);
  if (
    safeStart > 0 &&
    safeStart < text.length &&
    /[\uDC00-\uDFFF]/.test(text[safeStart] ?? "") &&
    /[\uD800-\uDBFF]/.test(text[safeStart - 1] ?? "")
  ) {
    safeStart -= 1;
  }
  if (
    safeEnd > 0 &&
    safeEnd < text.length &&
    /[\uD800-\uDBFF]/.test(text[safeEnd - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[safeEnd] ?? "")
  ) {
    safeEnd += 1;
  }
  return text.slice(safeStart, safeEnd);
}

/** A quoted passage as one line. Block structure and inline markup are already
 * absent from the flat projection, so collapsing whitespace is all quoting
 * needs. */
export function quoteDisplayText(exact: string): string {
  return exact.split(/\s+/).join(" ").trim();
}

const REPLY_SNIPPET_WORDS = 8;

/** First ~8 words of the previous answer, for the follow-up's "Reply to" line.
 * Punctuation tokens do not count toward the budget and a trailing ellipsis
 * marks a cut. */
export function formatResearchReplySnippet(answer: string, maxWords = REPLY_SNIPPET_WORDS): string {
  const tokens = quoteDisplayText(stripWikilinks(answer).replace(/^#{1,6}\s+/gm, ""))
    .split(" ")
    .filter(Boolean);
  if (tokens.length === 0) return "";
  const kept: string[] = [];
  let words = 0;
  for (const token of tokens) {
    if (/[\p{L}\p{N}]/u.test(token)) {
      if (words >= maxWords) return `${kept.join(" ")}…`;
      words += 1;
    }
    kept.push(token);
  }
  return kept.join(" ");
}

/** `isEditableTarget` over a DOM event target. The shared predicate takes the
 * two fields it reads rather than an element, so it stays testable without a
 * DOM; this is the adapter every listener in the document view uses. */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? isEditableTarget({ tagName: target.tagName, isContentEditable: target.isContentEditable })
    : false;
}
