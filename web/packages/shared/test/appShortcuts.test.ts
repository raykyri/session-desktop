import test from "ava";

import {
  appShortcutAllowsRepeat,
  RESEARCH_HOME_SHORTCUT_LABEL,
  resolveAppShortcut,
} from "../src/app/shortcuts.js";

const shortcut = (overrides: Partial<Parameters<typeof resolveAppShortcut>[0]> = {}) => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("resolves research navigation shortcuts", (t) => {
  t.deepEqual(resolveAppShortcut(shortcut({ key: "t", metaKey: true })), {
    type: "focusResearchHome",
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "n", metaKey: true })), {
    type: "focusResearchHome",
  });
  t.is(resolveAppShortcut(shortcut({ key: "d", metaKey: true })), null);
  t.deepEqual(resolveAppShortcut(shortcut({ key: "4", metaKey: true })), {
    type: "focusResearchTab",
    tabIndex: 3,
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "Tab", ctrlKey: true })), {
    type: "cycleResearchTab",
    direction: 1,
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "Tab", ctrlKey: true, shiftKey: true })), {
    type: "cycleResearchTab",
    direction: -1,
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "ArrowUp", metaKey: true, altKey: true })), {
    type: "moveResearchItem",
    direction: -1,
  });
});

// Browsers keep Cmd-N and Cmd-T for their own windows and tabs, so Home needs
// a chord that reaches the page. It is the label the hint renders.
test("Shift-Cmd-H opens Home where the browser swallows Cmd-N and Cmd-T", (t) => {
  t.is(RESEARCH_HOME_SHORTCUT_LABEL, "⇧⌘H");
  t.deepEqual(resolveAppShortcut(shortcut({ key: "h", metaKey: true, shiftKey: true })), {
    type: "focusResearchHome",
  });
  t.is(resolveAppShortcut(shortcut({ key: "h", metaKey: true })), null);
});

test("Ctrl stands in as the primary modifier for the digit and comma chords", (t) => {
  t.deepEqual(resolveAppShortcut(shortcut({ key: "1", ctrlKey: true })), {
    type: "focusResearchTab",
    tabIndex: 0,
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: ",", ctrlKey: true })), {
    type: "openSettings",
  });
  // Both primary modifiers at once is not a chord.
  t.is(resolveAppShortcut(shortcut({ key: "1", ctrlKey: true, metaKey: true })), null);
});

test("keeps the research document and panel shortcuts", (t) => {
  t.deepEqual(resolveAppShortcut(shortcut({ key: "j", metaKey: true })), {
    type: "focusFollowups",
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "o", metaKey: true })), {
    type: "openFolderMenu",
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "e", metaKey: true, shiftKey: true })), {
    type: "toggleArtifactPanel",
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "g", metaKey: true, shiftKey: true })), {
    type: "toggleLeftSidebar",
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "k", metaKey: true })), {
    type: "openCommandPalette",
  });
});

test("Shift-Cmd-[ and Shift-Cmd-] cycle, with curly variants normalized", (t) => {
  t.deepEqual(resolveAppShortcut(shortcut({ key: "]", metaKey: true, shiftKey: true })), {
    type: "cycleResearchTab",
    direction: 1,
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "{", metaKey: true, shiftKey: true })), {
    type: "cycleResearchTab",
    direction: -1,
  });
});

// The table, not the dispatcher, decides what an editable target blocks: the
// app is used from a composer most of the time, and a chord that dies there is
// a chord nobody can rely on.
test("an editable target blocks only the chords that compete with text editing", (t) => {
  const inField = (overrides: Partial<Parameters<typeof resolveAppShortcut>[0]>) =>
    resolveAppShortcut(shortcut({ ...overrides, editableTarget: true }));

  // Cmd-Alt-Arrow is word-wise selection, the digits and the cycle chords move
  // between documents while the caret is mid-sentence.
  t.is(inField({ key: "ArrowDown", metaKey: true, altKey: true }), null);
  t.is(inField({ key: "3", metaKey: true }), null);
  t.is(inField({ key: "3", ctrlKey: true }), null);
  t.is(inField({ key: "Tab", ctrlKey: true }), null);
  t.is(inField({ key: "]", metaKey: true, shiftKey: true }), null);

  // Everything else still reaches the app from inside a composer. Cmd-J is the
  // clearest case: jumping to the follow-ups is a thing you do while typing.
  t.deepEqual(inField({ key: "j", metaKey: true }), { type: "focusFollowups" });
  t.deepEqual(inField({ key: "k", metaKey: true }), { type: "openCommandPalette" });
  t.deepEqual(inField({ key: ",", metaKey: true }), { type: "openSettings" });
  t.deepEqual(inField({ key: "o", metaKey: true }), { type: "openFolderMenu" });
  t.deepEqual(inField({ key: "g", metaKey: true, shiftKey: true }), {
    type: "toggleLeftSidebar",
  });
  t.deepEqual(inField({ key: "h", metaKey: true, shiftKey: true }), {
    type: "focusResearchHome",
  });
  t.deepEqual(inField({ key: "e", metaKey: true, shiftKey: true }), {
    type: "toggleArtifactPanel",
  });
});

test("terminal, pane, split, and remote chords no longer resolve", (t) => {
  for (const input of [
    shortcut({ key: "+", metaKey: true }),
    shortcut({ key: "d", metaKey: true, shiftKey: true }),
    shortcut({ key: "r", metaKey: true, shiftKey: true }),
    shortcut({ key: "l", metaKey: true, shiftKey: true }),
    shortcut({ key: "w", metaKey: true }),
  ]) {
    t.is(resolveAppShortcut(input), null);
  }
});

test("only the reorder command repeats while its chord is held", (t) => {
  t.true(appShortcutAllowsRepeat({ type: "moveResearchItem", direction: 1 }));
  t.is(appShortcutAllowsRepeat({ type: "focusResearchHome" }), false);
});
