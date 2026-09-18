// Selection capture and word snapping (`09-research-document-view.md` §5).
//
// The fixture is the shape a rendered answer actually has: message wrappers
// with a tool disclosure between them, which is what makes the two rules worth
// testing — context is clamped to one message, and a selection that touches
// transcript machinery is refused.

import { createResearchSelectionSnapper } from "@session/shared";
import type { ResolvedResearchHighlightRange } from "@session/shared";
import test from "ava";

import { captureResearchSelection } from "../src/features/research/selection/capture.js";
import {
  RESPONSE_ROOT_ATTRIBUTE,
  RESPONSE_ROOT_SELECTOR,
  enclosingMessageFlatBounds,
  flatTextOffsetAt,
  formatResearchReplySnippet,
  messageFlatBoundaries,
  quoteDisplayText,
  rangeForTextOffsets,
  selectionOffsets,
  selectionTouchesNonTextRow,
  textContextSlice,
} from "../src/features/research/selection/dom.js";

const REVISION = "a".repeat(64);

/** Two messages with a tool disclosure between them, as the answer pane
 * renders them. */
function fixture(): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute(RESPONSE_ROOT_ATTRIBUTE, "n1");
  root.innerHTML = [
    '<section><div class="research-response-message"><p>Alpha beta gamma.</p></div></section>',
    '<details class="tool-block"><summary>web_search</summary></details>',
    '<section><div class="research-response-message"><p>Delta epsilon zeta.</p></div></section>',
  ].join("");
  document.body.appendChild(root);
  return root;
}

test.afterEach(() => {
  document.body.innerHTML = "";
});

test("the projection is the root's text in DOM order with no separators", (t) => {
  const root = fixture();
  t.is(root.textContent, "Alpha beta gamma.web_searchDelta epsilon zeta.");
});

test("a flat range round-trips through offsets", (t) => {
  const root = fixture();
  const range = rangeForTextOffsets(root, 0, 5);
  t.truthy(range);
  t.is(range?.toString(), "Alpha");
  t.deepEqual(selectionOffsets(root, range as Range), { start: 0, end: 5 });
});

test("message seams are reported where the enclosing message changes", (t) => {
  const root = fixture();
  const boundaries = messageFlatBoundaries(root);
  // "Alpha beta gamma." ends at 17, "web_search" ends at 27.
  t.deepEqual(boundaries, [17, 27]);
});

test("word snapping never fuses a word across a seam", (t) => {
  const root = fixture();
  const projection = root.textContent ?? "";
  const snapper = createResearchSelectionSnapper(projection, "en", messageFlatBoundaries(root));
  t.truthy(snapper);
  // A caret inside "gamma" dragged one character past the seam: without the
  // boundaries, "gamma.web_search" segments as one unit.
  const snapped = snapper?.(13, 18);
  t.truthy(snapped);
  t.true((snapped?.end ?? 0) <= 27);
  t.is(projection.slice(snapped!.start, snapped!.end).includes("Delta"), false);
});

test("snapping expands a partial word to the whole word", (t) => {
  const root = fixture();
  const projection = root.textContent ?? "";
  const snapper = createResearchSelectionSnapper(projection, "en", messageFlatBoundaries(root));
  const snapped = snapper?.(7, 9);
  t.is(projection.slice(snapped!.start, snapped!.end), "beta");
});

test("a capture anchors the passage and clamps context to its message", (t) => {
  const root = fixture();
  const range = rangeForTextOffsets(root, 6, 10) as Range;
  const captured = captureResearchSelection({
    root,
    range,
    nodeId: "n1",
    responseRevision: REVISION,
    resolved: [],
  });
  t.truthy(captured);
  t.is(captured?.anchor.exact, "beta");
  t.is(captured?.anchor.projection, "answer-v1");
  t.is(captured?.anchor.responseRevision, REVISION);
  t.is(captured?.anchor.prefix, "Alpha ");
  // Clamped at the message's end (17) rather than running into "web_search".
  t.is(captured?.anchor.suffix, " gamma.");
  t.deepEqual(captured?.highlightIds, []);
  t.is(captured?.expandAnchor, null);
});

test("a selection touching a tool row is refused", (t) => {
  const root = fixture();
  const range = rangeForTextOffsets(root, 12, 30) as Range;
  t.true(selectionTouchesNonTextRow(root, range));
  t.is(
    captureResearchSelection({
      root,
      range,
      nodeId: "n1",
      responseRevision: REVISION,
      resolved: [],
    }),
    null,
  );
});

test("a whitespace-only selection is refused unless it covers a highlight", (t) => {
  const root = fixture();
  const range = rangeForTextOffsets(root, 5, 6) as Range;
  t.is(
    captureResearchSelection({
      root,
      range,
      nodeId: "n1",
      responseRevision: REVISION,
      resolved: [],
    }),
    null,
  );
  const resolved: ResolvedResearchHighlightRange[] = [{ id: "h1", start: 0, end: 10 }];
  const captured = captureResearchSelection({
    root,
    range,
    nodeId: "n1",
    responseRevision: REVISION,
    resolved,
  });
  t.deepEqual(captured?.highlightIds, ["h1"]);
});

test("a selection overlapping saved highlights offers the merged annotation", (t) => {
  const root = fixture();
  const range = rangeForTextOffsets(root, 6, 17) as Range;
  const captured = captureResearchSelection({
    root,
    range,
    nodeId: "n1",
    responseRevision: REVISION,
    resolved: [{ id: "h1", start: 0, end: 10 }],
  });
  t.deepEqual(captured?.highlightIds, ["h1"]);
  t.is(captured?.expandAnchor?.exact, "Alpha beta gamma.");
});

test("a selection inside one message reports that message's bounds", (t) => {
  const root = fixture();
  const range = rangeForTextOffsets(root, 28, 33) as Range;
  t.deepEqual(enclosingMessageFlatBounds(root, range), { start: 27, end: 46 });
});

test("an element position resolves to a flat offset", (t) => {
  const root = fixture();
  const message = root.querySelectorAll(".research-response-message")[1] as HTMLElement;
  t.is(flatTextOffsetAt(root, message, 0), 27);
});

test("context slices never split a surrogate pair", (t) => {
  const text = `ab${String.fromCodePoint(0x1f600)}cd`;
  // Offset 3 is the middle of the emoji's surrogate pair.
  t.is(textContextSlice(text, 3, 5), `${String.fromCodePoint(0x1f600)}c`);
  t.is(textContextSlice(text, 0, 3), `ab${String.fromCodePoint(0x1f600)}`);
});

test("a quoted passage collapses to one line", (t) => {
  t.is(quoteDisplayText("  many\n  spaced   words \n"), "many spaced words");
});

test("the reply snippet keeps eight words and marks the cut", (t) => {
  t.is(
    formatResearchReplySnippet("## One two three four five six seven eight nine ten"),
    "One two three four five six seven eight…",
  );
  t.is(formatResearchReplySnippet("short answer"), "short answer");
  t.is(formatResearchReplySnippet(""), "");
});

test("only the response content root claims to be one", (t) => {
  // `data-node-id` is on the segment grid, on the rail and on every branch
  // card, so a `closest()` walk from a selection that strayed out of the answer
  // used to find one of those and measure an anchor against text no anchor can
  // be resolved in. The projection root is marked with an attribute nothing
  // else carries.
  const grid = document.createElement("div");
  grid.dataset["nodeId"] = "n1";
  grid.innerHTML = [
    `<div ${RESPONSE_ROOT_ATTRIBUTE}="n1" data-node-id="n1"><p id="answer">Alpha beta.</p></div>`,
    '<aside data-node-id="n1"><button data-node-id="n2"><span id="card">Gamma</span></button></aside>',
  ].join("");

  const fromAnswer = grid.querySelector("#answer")?.closest(RESPONSE_ROOT_SELECTOR);
  t.is(fromAnswer?.getAttribute(RESPONSE_ROOT_ATTRIBUTE), "n1");
  t.is(
    grid.querySelector("#card")?.closest(RESPONSE_ROOT_SELECTOR) ?? null,
    null,
    "a selection in the rail resolves to no projection root at all",
  );
  t.truthy(
    grid.querySelector("#card")?.closest("[data-node-id]"),
    "which is exactly what the old lookup would have found instead",
  );
});
