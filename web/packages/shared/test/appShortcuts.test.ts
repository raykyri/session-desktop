import test from "ava";

import { RESEARCH_HOME_SHORTCUT_LABEL, resolveAppShortcut } from "../src/app/shortcuts.js";

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
});

// Browsers keep Cmd-N and Cmd-T for their own windows and tabs, so Home needs
// a chord that reaches the page. It is the label the hint renders.
test("maps Shift-Cmd-H to Home to avoid browser shortcut interception", (t) => {
  t.is(RESEARCH_HOME_SHORTCUT_LABEL, "⇧⌘H");
  t.deepEqual(resolveAppShortcut(shortcut({ key: "h", metaKey: true, shiftKey: true })), {
    type: "focusResearchHome",
  });
  t.is(resolveAppShortcut(shortcut({ key: "h", metaKey: true })), null);
});

test("uses Ctrl as primary modifier for the settings chord on non-macOS platforms", (t) => {
  t.deepEqual(resolveAppShortcut(shortcut({ key: ",", ctrlKey: true })), {
    type: "openSettings",
  });
  // Both primary modifiers at once is not a chord.
  t.is(resolveAppShortcut(shortcut({ key: ",", ctrlKey: true, metaKey: true })), null);
});

test("keeps the research document and sidebar shortcuts", (t) => {
  t.deepEqual(resolveAppShortcut(shortcut({ key: "j", metaKey: true })), {
    type: "focusFollowups",
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "o", metaKey: true })), {
    type: "openWorkspaceMenu",
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "g", metaKey: true, shiftKey: true })), {
    type: "toggleLeftSidebar",
  });
  t.deepEqual(resolveAppShortcut(shortcut({ key: "k", metaKey: true })), {
    type: "openCommandPalette",
  });
});

// The desktop has no tab digits, tab cycling or item-move chords; the keys
// reach the browser and the page.
test("web-only tab and move chords no longer resolve", (t) => {
  for (const input of [
    shortcut({ key: "1", metaKey: true }),
    shortcut({ key: "4", ctrlKey: true }),
    shortcut({ key: "Tab", ctrlKey: true }),
    shortcut({ key: "Tab", ctrlKey: true, shiftKey: true }),
    shortcut({ key: "]", metaKey: true, shiftKey: true }),
    shortcut({ key: "{", metaKey: true, shiftKey: true }),
    shortcut({ key: "ArrowUp", metaKey: true, altKey: true }),
    shortcut({ key: "ArrowDown", metaKey: true, altKey: true }),
  ]) {
    t.is(resolveAppShortcut(input), null);
  }
});

test("terminal, pane, split, and remote chords no longer resolve", (t) => {
  for (const input of [
    shortcut({ key: "+", metaKey: true }),
    shortcut({ key: "d", metaKey: true, shiftKey: true }),
    shortcut({ key: "r", metaKey: true, shiftKey: true }),
    shortcut({ key: "l", metaKey: true, shiftKey: true }),
    shortcut({ key: "w", metaKey: true }),
    shortcut({ key: "e", metaKey: true, shiftKey: true }),
  ]) {
    t.is(resolveAppShortcut(input), null);
  }
});
