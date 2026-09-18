// The document's two-column geometry (`09-research-document-view.md` §3).
//
// These are the parts of the layout that have no DOM in them: where a crowded
// rail puts its cards, and which connectors have to take an elbow because their
// vertical runs collide. Measuring is the view's job; deciding is tested here.

import test from "ava";

import {
  ANCHORED_CARD_GAP,
  assignConnectorLanes,
  buildSegmentConnectors,
  connectorElbowPath,
  resolveAnchoredCardTops,
  sameCardTops,
} from "../src/features/research/layout.js";

test("cards on an unconstrained rail align directly with their target passage offsets", (t) => {
  const tops = resolveAnchoredCardTops([
    { id: "a", desiredTop: 0, height: 40 },
    { id: "b", desiredTop: 200, height: 40 },
  ]);
  t.deepEqual(tops, { a: 0, b: 200 });
});

test("crowded cards cascade downward with a fixed gap", (t) => {
  const tops = resolveAnchoredCardTops([
    { id: "a", desiredTop: 100, height: 50 },
    { id: "b", desiredTop: 110, height: 30 },
    { id: "c", desiredTop: 120, height: 20 },
  ]);
  // The first keeps its place; each later card starts below its predecessor's
  // bottom plus the gap, never above its own desired top.
  t.is(tops["a"], 100);
  t.is(tops["b"], 100 + 50 + ANCHORED_CARD_GAP);
  t.is(tops["c"], tops["b"]! + 30 + ANCHORED_CARD_GAP);
});

test("the cascade orders by desired top and breaks ties on id", (t) => {
  const tops = resolveAnchoredCardTops([
    { id: "z", desiredTop: 10, height: 20 },
    { id: "a", desiredTop: 10, height: 20 },
  ]);
  t.is(tops["a"], 10);
  t.is(tops["z"], 10 + 20 + ANCHORED_CARD_GAP);
});

test("cards with sufficient vertical clearance avoid unnecessary downward layout shifts", (t) => {
  const tops = resolveAnchoredCardTops([
    { id: "a", desiredTop: 0, height: 20 },
    { id: "b", desiredTop: 10, height: 20 },
    { id: "c", desiredTop: 400, height: 20 },
  ]);
  t.is(tops["c"], 400);
});

test("assigns non-overlapping connectors to lane zero", (t) => {
  const lanes = assignConnectorLanes([
    { id: "a", sx: 0, sy: 0, ex: 100, ey: 10 },
    { id: "b", sx: 0, sy: 200, ex: 100, ey: 210 },
  ]);
  t.deepEqual(lanes, [0, 0]);
});

test("overlapping vertical runs get the lowest free lane, top-first", (t) => {
  const lanes = assignConnectorLanes([
    { id: "a", sx: 0, sy: 0, ex: 100, ey: 100 },
    { id: "b", sx: 0, sy: 10, ex: 100, ey: 110 },
    { id: "c", sx: 0, sy: 20, ex: 100, ey: 120 },
  ]);
  t.deepEqual(lanes, [0, 1, 2]);
});

test("connector routing lanes are reused once non-overlapping vertical spans clear", (t) => {
  const lanes = assignConnectorLanes([
    { id: "a", sx: 0, sy: 0, ex: 100, ey: 50 },
    { id: "b", sx: 0, sy: 10, ex: 100, ey: 60 },
    // Starts well past both, so lane 0 is free again.
    { id: "c", sx: 0, sy: 300, ex: 100, ey: 320 },
  ]);
  t.deepEqual(lanes, [0, 1, 0]);
});

test("primary lane routes as a direct straight line while outer lanes render elbow bends", (t) => {
  const connectors = buildSegmentConnectors("n1", [
    { id: "a", sx: 0, sy: 0, ex: 100, ey: 100 },
    { id: "b", sx: 0, sy: 10, ex: 100, ey: 110 },
  ]);
  t.is(connectors[0]?.d, "M 0 0 L 100 100");
  t.true(connectors[1]?.d.startsWith("M 0 10 L "));
  t.true(connectors[1]?.d.includes("Q "));
  // The endpoint dot sits on the passage side of every connector.
  t.deepEqual(
    connectors.map((connector) => [connector.x, connector.y]),
    [
      [0, 0],
      [0, 10],
    ],
  );
  t.is(connectors[0]?.segmentId, "n1");
});

test("a stagger is capped at a quarter of the connector's own span", (t) => {
  // Six lanes at 14 px each would be 84 px, far past a quarter of a 40 px span.
  const geometry = Array.from({ length: 6 }, (_, index) => ({
    id: `c${index}`,
    sx: 0,
    sy: index,
    ex: 40,
    ey: 100 + index,
  }));
  const connectors = buildSegmentConnectors("n1", geometry);
  const last = connectors[connectors.length - 1];
  // midX = (0 + 40) / 2 - min(5 * 14, 0.25 * 40) = 20 - 10 = 10
  t.true(last?.d.includes(" 10 "));
});

test("horizontally aligned endpoints render as a simple horizontal line segment", (t) => {
  t.is(connectorElbowPath(0, 50, 100, 51), "M 0 50 L 100 51");
});

test("an elbow turns at the supplied midline", (t) => {
  const path = connectorElbowPath(0, 0, 100, 100, 50);
  t.true(path.startsWith("M 0 0 L "));
  t.true(path.endsWith("L 100 100"));
  t.is((path.match(/Q /g) ?? []).length, 2);
});

test("compares card-top coordinates by value", (t) => {
  t.true(sameCardTops({ a: 1, b: 2 }, { a: 1, b: 2 }));
  t.false(sameCardTops({ a: 1 }, { a: 1, b: 2 }));
  t.false(sameCardTops({ a: 1 }, { a: 2 }));
});
