import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_RESEARCH_VISITS,
  canGoResearchBack,
  canGoResearchForward,
  currentResearchVisit,
  initResearchVisits,
  pruneResearchVisits,
  pushResearchVisit,
  replaceResearchVisit,
  researchSwipeDirection,
  researchSwipeTailCapturesWheel,
  researchVisitAction,
  researchVisitBack,
  researchVisitFor,
  researchVisitForward,
  researchVisitsAfterRemoval,
  seedResearchVisits,
  type ResearchVisit,
  type ResearchVisitHistory,
} from "../src/lib/researchHistory";

const home: ResearchVisit = { kind: "home" };
const at = (treeId: string, nodeId: string | null): ResearchVisit => ({ kind: "node", treeId, nodeId });

function pushAll(history: ResearchVisitHistory, visits: ResearchVisit[]): ResearchVisitHistory {
  return visits.reduce(pushResearchVisit, history);
}

/** Steps `count` times with `step`, returning the visits shown after each. */
function walk(
  history: ResearchVisitHistory,
  step: typeof researchVisitBack,
  count: number,
): { history: ResearchVisitHistory; shown: ResearchVisit[] } {
  const shown: ResearchVisit[] = [];
  let current = history;
  for (let index = 0; index < count; index += 1) {
    const next = step(current);
    assert.ok(next, `step ${index + 1} of ${count} has somewhere to go`);
    current = next.history;
    shown.push(next.visit);
  }
  return { history: current, shown };
}

test("an empty history can go neither way", () => {
  assert.equal(canGoResearchBack(EMPTY_RESEARCH_VISITS), false);
  assert.equal(canGoResearchForward(EMPTY_RESEARCH_VISITS), false);
  assert.equal(researchVisitBack(EMPTY_RESEARCH_VISITS), null);
  assert.equal(researchVisitForward(EMPTY_RESEARCH_VISITS), null);
  assert.equal(currentResearchVisit(EMPTY_RESEARCH_VISITS), null);
  assert.equal(initResearchVisits(null), EMPTY_RESEARCH_VISITS);
});

test("switching between questions within and across threads replays in order", () => {
  // Thread A: a0 -> a1, then B opened from Home: b0 -> b1.
  const history = pushAll(initResearchVisits(at("A", "a0")), [
    at("A", "a1"),
    at("B", "b0"),
    at("B", "b1"),
  ]);
  assert.equal(history.index, 3);
  const back = walk(history, researchVisitBack, 3);
  assert.deepEqual(back.shown, [at("B", "b0"), at("A", "a1"), at("A", "a0")]);
  assert.equal(canGoResearchBack(back.history), false);
  const forward = walk(back.history, researchVisitForward, 3);
  assert.deepEqual(forward.shown, [at("A", "a1"), at("B", "b0"), at("B", "b1")]);
  assert.equal(canGoResearchForward(forward.history), false);
});

test("a thread visited twice keeps both visits in their places", () => {
  const history = pushAll(initResearchVisits(at("A", "a0")), [at("B", "b0"), at("A", "a1")]);
  assert.deepEqual(walk(history, researchVisitBack, 2).shown, [at("B", "b0"), at("A", "a0")]);
});

test("navigating after going back drops the forward visits of every thread", () => {
  const history = pushAll(initResearchVisits(at("A", "a0")), [at("B", "b0"), at("B", "b1")]);
  const { history: back } = walk(history, researchVisitBack, 2);
  assert.deepEqual(currentResearchVisit(back), at("A", "a0"));
  // A message selected in A truncates B's visits.
  const inThread = pushResearchVisit(back, at("A", "a1"));
  assert.deepEqual(inThread, { entries: [at("A", "a0"), at("A", "a1")], index: 1 });
  assert.equal(canGoResearchForward(inThread), false);
  // So does opening another thread.
  const otherThread = pushResearchVisit(back, at("C", null));
  assert.deepEqual(otherThread, { entries: [at("A", "a0"), at("C", null)], index: 1 });
});

test("navigating to the visit on screen does not add a step", () => {
  const history = initResearchVisits(at("A", "a1"));
  assert.equal(pushResearchVisit(history, at("A", "a1")), history);
  // Opening the thread already on screen (no message named) keeps its visit.
  assert.equal(pushResearchVisit(history, at("A", null)), history);
  const atHome = initResearchVisits(home);
  assert.equal(pushResearchVisit(atHome, home), atHome);
  // A different message of the same thread is a step.
  assert.equal(pushResearchVisit(history, at("A", "a2")).entries.length, 2);
});

test("a thread visit without a message takes the message named next", () => {
  // Opening B records it before it loads; its page then names the message.
  const opened = pushResearchVisit(initResearchVisits(at("A", "a0")), at("B", null));
  const named = pushResearchVisit(opened, at("B", "b3"));
  assert.deepEqual(named, { entries: [at("A", "a0"), at("B", "b3")], index: 1 });
});

test("replace changes the visit on screen and keeps the forward visits", () => {
  const history = { entries: [at("A", "a0"), at("B", null), at("C", "c0")], index: 1 };
  const replaced = replaceResearchVisit(history, at("B", "b2"));
  assert.deepEqual(replaced, { entries: [at("A", "a0"), at("B", "b2"), at("C", "c0")], index: 1 });
  assert.equal(replaceResearchVisit(replaced, at("B", "b2")), replaced);
  assert.deepEqual(replaceResearchVisit(EMPTY_RESEARCH_VISITS, at("A", "a0")), initResearchVisits(at("A", "a0")));
});

test("replace merges a visit that now repeats its neighbour", () => {
  const history = { entries: [at("A", "a0"), at("A", "a1")], index: 1 };
  assert.deepEqual(replaceResearchVisit(history, at("A", "a0")), { entries: [at("A", "a0")], index: 0 });
});

test("startup seeds an empty history with the restored thread or Home", () => {
  const restored = seedResearchVisits(EMPTY_RESEARCH_VISITS, researchVisitFor("A", null));
  assert.deepEqual(restored, { entries: [at("A", null)], index: 0 });
  // The first switch to another question can go back to the restored one.
  const switched = pushResearchVisit(pushResearchVisit(restored, at("A", "a2")), at("B", "b0"));
  assert.equal(canGoResearchBack(switched), true);
  assert.deepEqual(researchVisitBack(switched)?.visit, at("A", "a2"));
  assert.deepEqual(seedResearchVisits(EMPTY_RESEARCH_VISITS, researchVisitFor(null, null)), {
    entries: [home],
    index: 0,
  });
  // Navigation made before the restore finished is kept.
  const navigated = initResearchVisits(at("B", "b0"));
  assert.equal(seedResearchVisits(navigated, researchVisitFor("A", null)), navigated);
});

test("pruning removed threads keeps the visit on screen when asked to", () => {
  // Home -> A -> Home -> B, then A is removed.
  const history = { entries: [home, at("A", "a0"), home, at("B", "b0")], index: 3 };
  const keepTree = (visit: ResearchVisit) => visit.kind === "home" || visit.treeId !== "A";
  assert.deepEqual(pruneResearchVisits(history, keepTree, { keepCurrent: true }), {
    entries: [home, at("B", "b0")],
    index: 1,
  });
  const onA = { entries: [home, at("A", "a0")], index: 1 };
  assert.equal(pruneResearchVisits(onA, keepTree, { keepCurrent: true }), onA);
  assert.equal(pruneResearchVisits(history, () => true), history);
});

test("pruning removed messages moves the cursor to the nearest earlier visit", () => {
  const history = {
    entries: [at("A", "a0"), at("A", "a1"), at("B", "b0"), at("A", "a2")],
    index: 3,
  };
  const keep = (visit: ResearchVisit) => visit.kind === "home" || visit.nodeId !== "a2";
  assert.deepEqual(pruneResearchVisits(history, keep), {
    entries: [at("A", "a0"), at("A", "a1"), at("B", "b0")],
    index: 2,
  });
  // With nothing before it, the cursor moves to the first visit after.
  const first = { entries: [at("A", "a2"), at("B", "b0")], index: 0 };
  assert.deepEqual(pruneResearchVisits(first, keep), { entries: [at("B", "b0")], index: 0 });
  assert.equal(pruneResearchVisits({ entries: [at("A", "a2")], index: 0 }, keep), EMPTY_RESEARCH_VISITS);
});

test("pruning merges visits that become adjacent duplicates", () => {
  // a0 -> a1 -> back to a0 by a new click, then a1 is removed: without the
  // merge Back would re-apply the message already selected.
  const history = { entries: [at("A", "a0"), at("A", "a1"), at("A", "a0")], index: 2 };
  const pruned = pruneResearchVisits(history, (visit) => visit.kind === "home" || visit.nodeId !== "a1");
  assert.deepEqual(pruned, { entries: [at("A", "a0")], index: 0 });
  assert.equal(canGoResearchBack(pruned), false);
});

test("removal prunes the removed messages and puts the fallback on screen", () => {
  const history = pushAll(initResearchVisits(at("A", "c1-0")), [at("A", "c1-1"), at("A", "b1"), at("A", "b2")]);
  const keep = (visit: ResearchVisit) => visit.kind === "home" || !["b1", "b2"].includes(visit.nodeId ?? "");
  const after = researchVisitsAfterRemoval(history, keep, at("A", "c1-1"));
  assert.deepEqual(after, { entries: [at("A", "c1-0"), at("A", "c1-1")], index: 1 });
  assert.deepEqual(researchVisitBack(after)?.visit, at("A", "c1-0"));
  // The fallback is pushed when another surviving visit is on screen.
  const moved = researchVisitsAfterRemoval(pushResearchVisit(history, at("A", "c1-0")), keep, at("A", "c1-1"));
  assert.deepEqual(currentResearchVisit(moved), at("A", "c1-1"));
  assert.equal(canGoResearchForward(moved), false);
});

test("a visit is shown in place only in the thread page already showing its thread", () => {
  assert.equal(researchVisitAction(home, "A", true), "home");
  assert.equal(researchVisitAction(at("A", "a1"), "A", true), "in-place");
  assert.equal(researchVisitAction(at("A", "a1"), "A", false), "open-tree");
  assert.equal(researchVisitAction(at("A", "a1"), "B", true), "open-tree");
  assert.equal(researchVisitAction(at("A", "a1"), null, false), "open-tree");
});

test("horizontal wheel gestures resolve only after clear dominant travel", () => {
  assert.equal(researchSwipeDirection(-79, 0), 0);
  assert.equal(researchSwipeDirection(79, 0), 0);
  assert.equal(researchSwipeDirection(-100, 90), 0);
  assert.equal(researchSwipeDirection(100, 90), 0);
  assert.equal(researchSwipeDirection(-100, 20), -1);
  assert.equal(researchSwipeDirection(100, 20), 1);
});

test("swipe tail captures horizontal momentum per wheel event", () => {
  assert.equal(researchSwipeTailCapturesWheel(-40, 0), true);
  assert.equal(researchSwipeTailCapturesWheel(-12, 4), true);
  // Vertical scroll is not captured.
  assert.equal(researchSwipeTailCapturesWheel(0, 30), false);
  assert.equal(researchSwipeTailCapturesWheel(4, 12), false);
  assert.equal(researchSwipeTailCapturesWheel(10, -10), false);
});
