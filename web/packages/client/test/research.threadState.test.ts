// The thread page's pure state (`09-research-document-view.md` §3, §4): the
// selection's search parameter, column widths, what is kept per tree across
// visits, and the composer's key bindings.

import test from "ava";

import { composerEnterAction } from "../src/features/thread/ConversationComposer.js";
import { postFollowUpCopy } from "../src/features/thread/PostFollowUpField.js";
import {
  COLUMN_WIDTH_KEYS,
  columnResize,
  columnWidthKind,
  columnWidths,
  loadColumnWidths,
  parseStoredColumnWidth,
  saveColumnWidth,
  shownColumnWidths,
} from "../src/features/thread/columnWidths.js";
import {
  THREAD_NAVIGATION_KEY,
  clearPendingBranch,
  flushThreadNavigation,
  forgetThread,
  pruneThreadNavigation,
  recordExpanded,
  recordPendingBranch,
  recordScroll,
  recordSelection,
  resetThreadNavigationForTests,
  savedPendingBranch,
  savedScroll,
  savedSelection,
  expandedNodes,
} from "../src/features/thread/persistence.js";
import { decodeSelection, encodeSelection } from "../src/features/thread/useThreadHistory.js";

const ANCHOR = {
  version: 1 as const,
  projection: "answer-v1" as const,
  responseRevision: "a".repeat(64),
  start: 0,
  end: 5,
  exact: "Alpha",
  prefix: "",
  suffix: " beta",
};

test.afterEach.always(() => {
  resetThreadNavigationForTests();
  localStorage.clear();
});

/* -------------------------------------------------------------- selection */

test("a selection round-trips through its search parameter", (t) => {
  t.is(encodeSelection(["n1", "b1", "b2"]), "n1,b1,b2");
  t.deepEqual(decodeSelection("n1,b1,b2"), ["n1", "b1", "b2"]);
  t.is(decodeSelection(undefined), null);
  t.is(decodeSelection(""), null);
  t.deepEqual(decodeSelection("n1,,b1,"), ["n1", "b1"]);
  t.is(decodeSelection(","), null);
});

/* ---------------------------------------------------------- column widths */

test("automatic widths are a share of the strip, within bounds", (t) => {
  t.deepEqual(columnWidths(1000), { messages: 220, answer: 440 });
  t.deepEqual(columnWidths(1500), { messages: 270, answer: 660 });
  t.deepEqual(columnWidths(400), { messages: 220, answer: 340 });
  t.deepEqual(columnWidths(Number.NaN), { messages: 220, answer: 340 });
});

test("a set width is clamped to its handle's range", (t) => {
  t.deepEqual(shownColumnWidths({ messages: 900, answer: null }, 1000), {
    messages: 560,
    answer: 440,
  });
  t.deepEqual(shownColumnWidths({ messages: null, answer: 100 }, 1000), {
    messages: 220,
    answer: 340,
  });
});

test("widths are stored per kind and a bad stored value is automatic", (t) => {
  saveColumnWidth("answer", 512.4);
  t.is(localStorage.getItem(COLUMN_WIDTH_KEYS.answer), "512");
  t.deepEqual(loadColumnWidths(), { messages: null, answer: 512 });
  saveColumnWidth("answer", null);
  t.deepEqual(loadColumnWidths(), { messages: null, answer: null });
  t.is(parseStoredColumnWidth("-3"), null);
  t.is(parseStoredColumnWidth("wide"), null);
  t.is(parseStoredColumnWidth(" "), null);
});

test("note and editor columns share the answer width", (t) => {
  t.is(columnWidthKind("messages"), "messages");
  t.is(columnWidthKind("answer"), "answer");
  t.is(columnWidthKind("post"), "answer");
  t.is(columnWidthKind("editor"), "answer");
  t.is(columnWidthKind(undefined), null);
});

test("a resize scrolls the strip to keep the resized column's edge in place", (t) => {
  // Two answer columns left of the resized one grow with it.
  t.deepEqual(
    columnResize({
      startWidth: 400,
      delta: 20,
      startScrollLeft: 100,
      sharedBefore: 2,
      min: 340,
      max: 960,
    }),
    { width: 420, scrollLeft: 140 },
  );
  // With nothing shared, the width follows the pointer.
  t.deepEqual(
    columnResize({
      startWidth: 400,
      delta: -100,
      startScrollLeft: 0,
      sharedBefore: 0,
      min: 340,
      max: 960,
    }),
    { width: 340, scrollLeft: 0 },
  );
});

/* ------------------------------------------------------------ persistence */

test("a tree's selection, scroll and expansions survive a reload", (t) => {
  recordSelection("t1", ["n1", "b1"]);
  recordScroll("t1", "answer", "n1", 320);
  recordExpanded("t1", "n1");
  flushThreadNavigation();
  t.truthy(localStorage.getItem(THREAD_NAVIGATION_KEY));
  resetThreadNavigationForTests();
  t.deepEqual(savedSelection("t1"), ["n1", "b1"]);
  t.is(savedScroll("t1", "answer", "n1"), 320);
  t.is(savedScroll("t1", "answer", "n2"), 0);
  t.deepEqual(expandedNodes("t1"), { n1: true });
  t.is(savedSelection("t2"), null);
});

test("the unsent branch is kept until it is sent or cancelled", (t) => {
  recordPendingBranch("t1", "n1", ANCHOR, "Why?");
  flushThreadNavigation();
  resetThreadNavigationForTests();
  t.like(savedPendingBranch("t1", "n1"), { anchor: ANCHOR, text: "Why?" });
  clearPendingBranch("t1", "n1");
  resetThreadNavigationForTests();
  t.is(savedPendingBranch("t1", "n1"), null);
});

test("pruning drops state for messages that left the tree", (t) => {
  recordSelection("t1", ["n1", "gone"]);
  recordScroll("t1", "branches", "gone", 50);
  recordScroll("t1", "messages", "n1", 60);
  pruneThreadNavigation("t1", new Set(["n1"]));
  t.is(savedSelection("t1"), null);
  t.is(savedScroll("t1", "branches", "gone"), 0);
  t.is(savedScroll("t1", "messages", "n1"), 60);
  forgetThread("t1");
  t.is(savedScroll("t1", "messages", "n1"), 0);
});

/* --------------------------------------------------------------- composer */

function enter(modifiers: {
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  composing?: boolean;
}) {
  return {
    key: "Enter",
    metaKey: modifiers.meta ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    nativeEvent: { isComposing: modifiers.composing ?? false },
  };
}

test("⌘↵ sends and ⇧⌘↵ branches; a plain Enter is a newline", (t) => {
  t.is(composerEnterAction(enter({ meta: true }), true), "send");
  t.is(composerEnterAction(enter({ meta: true, shift: true }), true), "branch");
  t.is(composerEnterAction(enter({}), true), null);
  t.is(composerEnterAction(enter({ shift: true }), true), null);
  // Ctrl on other platforms.
  t.is(composerEnterAction(enter({ ctrl: true }), false), "send");
  t.is(composerEnterAction(enter({ ctrl: true }), true), null);
  // An IME composition owns its Enter.
  t.is(composerEnterAction(enter({ meta: true, composing: true }), true), null);
});

test("a note follow-up says the agent does not see it", (t) => {
  t.deepEqual(postFollowUpCopy(true), {
    placeholder: "Add a note (not visible to agent)",
    sendName: "Add note",
  });
  t.deepEqual(postFollowUpCopy(false), { placeholder: "Ask a follow-up", sendName: "Ask" });
});
