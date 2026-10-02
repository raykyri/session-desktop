import test from "ava";

import {
  EMPTY_RESEARCH_HISTORY,
  canGoBack,
  canGoForward,
  initResearchHistory,
  pruneResearchHistory,
  pushResearchHistory,
  researchHistoryBack,
  researchHistoryForward,
} from "../src/research/history.js";

test("disallows backward and forward navigation when history is empty", (t) => {
  t.is(canGoBack(EMPTY_RESEARCH_HISTORY), false);
  t.is(canGoForward(EMPTY_RESEARCH_HISTORY), false);
  t.is(researchHistoryBack(EMPTY_RESEARCH_HISTORY), null);
  t.is(researchHistoryForward(EMPTY_RESEARCH_HISTORY), null);
});

test("init roots the history at the entry node", (t) => {
  t.deepEqual(initResearchHistory("root"), { entries: ["root"], index: 0 });
  t.is(initResearchHistory(null), EMPTY_RESEARCH_HISTORY);
});

test("a single-entry history cannot navigate", (t) => {
  const history = initResearchHistory("root");
  t.is(canGoBack(history), false);
  t.is(canGoForward(history), false);
});

test("push appends and advances the cursor to the end", (t) => {
  let history = initResearchHistory("a");
  history = pushResearchHistory(history, "b");
  history = pushResearchHistory(history, "c");
  t.deepEqual(history, { entries: ["a", "b", "c"], index: 2 });
  t.is(canGoBack(history), true);
  t.is(canGoForward(history), false);
});

test("back then forward returns to the same node", (t) => {
  const history = pushResearchHistory(initResearchHistory("a"), "b");
  const back = researchHistoryBack(history);
  t.true(Boolean(back));
  t.is(back?.nodeId, "a");
  t.deepEqual(back?.history, { entries: ["a", "b"], index: 0 });

  const forward = back ? researchHistoryForward(back.history) : null;
  t.true(Boolean(forward));
  t.is(forward?.nodeId, "b");
  t.deepEqual(forward?.history, { entries: ["a", "b"], index: 1 });
});

test("pushing after going back truncates the forward entries", (t) => {
  // a -> b -> c, step back to b, then branch to d: c must be discarded.
  const history = pushResearchHistory(pushResearchHistory(initResearchHistory("a"), "b"), "c");
  const back = researchHistoryBack(history);
  t.is(back?.nodeId, "b");
  const branched = pushResearchHistory(back?.history ?? history, "d");
  t.deepEqual(branched, { entries: ["a", "b", "d"], index: 2 });
  t.is(canGoForward(branched), false);
});

test("push does not mutate the prior history value", (t) => {
  const before = initResearchHistory("a");
  const after = pushResearchHistory(before, "b");
  t.deepEqual(before, { entries: ["a"], index: 0 });
  t.not(before.entries, after.entries);
});

test("pruning deleted visits preserves the surviving cursor position", (t) => {
  const history = { entries: ["root", "branch", "leaf", "root"], index: 2 };
  t.deepEqual(pruneResearchHistory(history, new Set(["root"]), "root"), {
    entries: ["root"],
    index: 0,
  });
});

test("pruning keeps the cursor on a later surviving visit", (t) => {
  const history = { entries: ["root", "branch", "leaf"], index: 1 };
  t.deepEqual(pruneResearchHistory(history, new Set(["root", "leaf"]), "root"), {
    entries: ["root", "leaf"],
    index: 0,
  });
});

test("pruning collapses visits that become adjacent duplicates", (t) => {
  // root -> branch -> back to root, then branch is deleted: without the
  // collapse the history reads [root, root] and Back re-applies the already
  // selected node — readers treat that as real navigation (clearing content
  // for a load that never restarts).
  const history = { entries: ["root", "branch", "root"], index: 2 };
  const pruned = pruneResearchHistory(history, new Set(["root", "other"]), "root");
  t.deepEqual(pruned, { entries: ["root"], index: 0 });
  t.is(canGoBack(pruned), false);
  t.is(canGoForward(pruned), false);
});

test("pruning falls back when every visited node was deleted", (t) => {
  t.deepEqual(
    pruneResearchHistory({ entries: ["branch", "leaf"], index: 1 }, new Set(["root"]), "root"),
    { entries: ["root"], index: 0 },
  );
});
