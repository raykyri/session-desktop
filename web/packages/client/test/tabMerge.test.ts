// State several tabs keep in one localStorage key merges key by key
// (`lib/tabMerge`): the thread page's per-tree state and the feeds' anchors.

import test from "ava";

import {
  flushThreadNavigation,
  forgetThread,
  recordSelection,
  resetThreadNavigationForTests,
  savedSelection,
  THREAD_NAVIGATION_KEY,
} from "../src/features/thread/persistence.js";
import { mergeByUpdatedAt } from "../src/lib/tabMerge.js";
import { NAVIGATION_STORAGE_KEY, useNavigationStore } from "../src/stores/navigation.js";

test.beforeEach(() => {
  localStorage.clear();
  resetThreadNavigationForTests();
});

test("the entry written last wins, and a removal holds against older copies", (t) => {
  const ours = { a: { updatedAt: 5, v: "ours" }, b: { updatedAt: 1, v: "ours" } };
  const stored = { b: { updatedAt: 2, v: "theirs" }, c: { updatedAt: 3, v: "theirs" } };
  t.deepEqual(mergeByUpdatedAt(ours, stored), {
    a: { updatedAt: 5, v: "ours" },
    b: { updatedAt: 2, v: "theirs" },
    c: { updatedAt: 3, v: "theirs" },
  });
  t.deepEqual(mergeByUpdatedAt({}, stored, new Map([["c", 3]])), {
    b: { updatedAt: 2, v: "theirs" },
  });
  t.deepEqual(Object.keys(mergeByUpdatedAt({}, stored, new Map([["c", 2]]))), ["b", "c"]);
});

test.serial("a tab's write keeps another tab's threads", (t) => {
  recordSelection("t1", ["n1"]);
  // Another tab saved t2 meanwhile.
  const other = JSON.parse(localStorage.getItem(THREAD_NAVIGATION_KEY) ?? "{}") as Record<
    string,
    unknown
  >;
  other["t2"] = {
    selectionPath: ["m1"],
    scroll: { answer: {}, messages: {}, branches: {} },
    updatedAt: Date.now() + 1_000,
  };
  localStorage.setItem(THREAD_NAVIGATION_KEY, JSON.stringify(other));
  recordSelection("t1", ["n1", "n2"]);
  flushThreadNavigation();
  const stored = JSON.parse(localStorage.getItem(THREAD_NAVIGATION_KEY) ?? "{}") as Record<
    string,
    { selectionPath?: string[] }
  >;
  t.deepEqual(stored["t1"]?.selectionPath, ["n1", "n2"]);
  t.deepEqual(stored["t2"]?.selectionPath, ["m1"], "the other tab's thread stays");
  t.deepEqual(savedSelection("t2"), ["m1"], "and this tab reads it");
  forgetThread("t1");
  t.false(
    Object.hasOwn(JSON.parse(localStorage.getItem(THREAD_NAVIGATION_KEY) ?? "{}") as object, "t1"),
    "a forgotten thread is not merged back",
  );
});

test.serial("a feed anchor write keeps another tab's anchors", (t) => {
  localStorage.setItem(
    NAVIGATION_STORAGE_KEY,
    JSON.stringify({
      state: {
        feedAnchorByView: { other: { key: "r9", offset: 0, top: 40, updatedAt: Date.now() } },
        sidebarCollapsed: false,
        sidebarWidth: 268,
      },
      version: 3,
    }),
  );
  useNavigationStore.getState().recordFeedAnchor("home", { key: "r1", offset: 4, top: 120 });
  const stored = JSON.parse(localStorage.getItem(NAVIGATION_STORAGE_KEY) ?? "{}") as {
    state: { feedAnchorByView: Record<string, { key: string }> };
  };
  t.deepEqual(Object.keys(stored.state.feedAnchorByView).sort(), ["home", "other"]);
  t.is(stored.state.feedAnchorByView["home"]?.key, "r1");
});
