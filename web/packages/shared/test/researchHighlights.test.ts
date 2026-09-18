import test from "ava";

import {
  expandedResearchHighlightOffsets,
  intersectingResearchHighlightIds,
  overlappingResearchHighlightRegions,
  researchAnchorContextBounds,
  resolveResearchHighlightOffset,
} from "../src/research/highlights.js";
import type { ResearchHighlight } from "../src/types/research.js";

function highlight(
  exact: string,
  start: number,
  options: { prefix?: string; suffix?: string; revision?: string } = {},
): ResearchHighlight {
  return {
    id: "h1",
    createdAt: 0,
    anchor: {
      version: 1,
      projection: "answer-v1",
      responseRevision: options.revision ?? "rev",
      start,
      end: start + exact.length,
      exact,
      prefix: options.prefix ?? "",
      suffix: options.suffix ?? "",
    },
  };
}

test("intersecting ids: overlap counts, edge contact does not", (t) => {
  const highlights = [
    { id: "a", start: 10, end: 20 },
    { id: "b", start: 30, end: 40 },
  ];
  t.deepEqual(intersectingResearchHighlightIds({ start: 15, end: 35 }, highlights), ["a", "b"]);
  t.deepEqual(intersectingResearchHighlightIds({ start: 20, end: 30 }, highlights), []);
});

test("expand: no overlap yields nothing to expand", (t) => {
  t.is(
    expandedResearchHighlightOffsets({ start: 0, end: 5 }, [{ id: "a", start: 10, end: 20 }]),
    null,
  );
});

test("expand: a selection inside one highlight would only recreate it", (t) => {
  t.is(
    expandedResearchHighlightOffsets({ start: 12, end: 18 }, [{ id: "a", start: 10, end: 20 }]),
    null,
  );
  // Selecting the entire highlight is equally a no-op.
  t.is(
    expandedResearchHighlightOffsets({ start: 10, end: 20 }, [{ id: "a", start: 10, end: 20 }]),
    null,
  );
});

test("expand: a selection extending past a highlight grows it", (t) => {
  t.deepEqual(
    expandedResearchHighlightOffsets({ start: 15, end: 25 }, [{ id: "a", start: 10, end: 20 }]),
    { start: 10, end: 25 },
  );
  t.deepEqual(
    expandedResearchHighlightOffsets({ start: 5, end: 12 }, [{ id: "a", start: 10, end: 20 }]),
    { start: 5, end: 20 },
  );
});

test("expand: a selection bridging several highlights merges them", (t) => {
  t.deepEqual(
    expandedResearchHighlightOffsets({ start: 15, end: 35 }, [
      { id: "a", start: 10, end: 20 },
      { id: "b", start: 30, end: 40 },
    ]),
    { start: 10, end: 40 },
  );
});

test("expand: only intersected highlights join the union", (t) => {
  t.deepEqual(
    expandedResearchHighlightOffsets({ start: 15, end: 25 }, [
      { id: "a", start: 10, end: 20 },
      { id: "far", start: 100, end: 110 },
    ]),
    { start: 10, end: 25 },
  );
});

test("overlap regions: partial overlap yields the shared span only", (t) => {
  t.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 10, end: 30 },
      { start: 20, end: 40 },
    ]),
    [{ start: 20, end: 30 }],
  );
});

test("overlap regions: edge contact and disjoint ranges yield nothing", (t) => {
  t.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 10, end: 20 },
      { start: 20, end: 30 },
      { start: 40, end: 50 },
    ]),
    [],
  );
});

test("overlap regions: containment and triple stacks merge into one span", (t) => {
  t.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 0, end: 50 },
      { start: 10, end: 20 },
      { start: 15, end: 35 },
    ]),
    [{ start: 10, end: 35 }],
  );
});

test("overlap regions: chained pairwise overlaps stay contiguous", (t) => {
  // a∩b ends exactly where b∩c begins; the paint should not split there.
  t.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 10, end: 20 },
    ]),
    [{ start: 5, end: 15 }],
  );
});

test("overlap regions: empty ranges never count toward depth", (t) => {
  t.deepEqual(
    overlappingResearchHighlightRegions([
      { start: 10, end: 10 },
      { start: 5, end: 15 },
    ]),
    [],
  );
});

test("context bounds: the enclosing message clamps the anchor's context", (t) => {
  const messageBounds = { start: 14, end: 32 };
  t.deepEqual(researchAnchorContextBounds({ messageBounds, projectionLength: 50 }), messageBounds);
});

test("context bounds: a selection spanning messages takes the whole projection", (t) => {
  // No enclosing message means the selection crossed one. A run's messages are
  // all one speaker, so the whole projection is fair context. The desktop
  // refused this case for terminal conversations, which the web does not have.
  t.deepEqual(researchAnchorContextBounds({ messageBounds: null, projectionLength: 50 }), {
    start: 0,
    end: 50,
  });
});

test("resolve: a whole-message quote keeps its place without either context", (t) => {
  // Context is clamped to the enclosing message, so selecting a whole message
  // saves no prefix and no suffix. The message is neither at the start nor at
  // the end of the projection, and the anchor must still resolve — treating an
  // empty side as "must sit at the projection edge" orphaned it the moment it
  // was created.
  const messages = ["Make it faster", "I rewrote the loop", "Why is that faster"];
  const projection = messages.join("");
  const first = messages[0] ?? "";
  const second = messages[1] ?? "";
  const start = first.length;
  t.deepEqual(resolveResearchHighlightOffset(projection, "rev", highlight(second, start)), {
    start,
    end: start + second.length,
  });
  // Still located after the view shifted the offsets, since the quote itself
  // carries the anchor.
  t.deepEqual(
    resolveResearchHighlightOffset(`Earlier turn${projection}`, "other", highlight(second, start)),
    { start: start + 12, end: start + 12 + second.length },
  );
});

test("resolve: one clamped side still discriminates between repeats", (t) => {
  // A message-leading quote saves a suffix but no prefix; the suffix alone has
  // to pick the right occurrence of a phrase that repeats.
  const projection = "Yes, for the reasons above.Yes, but only on macOS.";
  t.deepEqual(
    resolveResearchHighlightOffset(
      projection,
      "rev",
      highlight("Yes", 27, { suffix: ", but only" }),
    ),
    { start: 27, end: 30 },
  );
  // No occurrence keeps the context: the highlight is orphaned rather than
  // painted on a guess.
  t.is(
    resolveResearchHighlightOffset(
      projection,
      "rev",
      highlight("Yes", 27, { suffix: ", and also" }),
    ),
    null,
  );
});
