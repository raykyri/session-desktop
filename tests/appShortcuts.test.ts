import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAppShortcutCommand,
  RESEARCH_HOME_SHORTCUT_LABEL,
  resolveAppShortcut,
  showHideShortcutConflict,
} from "../src/lib/appShortcuts";

const shortcut = (
  overrides: Partial<Parameters<typeof resolveAppShortcut>[0]> = {},
) => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("Session resolves research navigation shortcuts", () => {
  assert.equal(RESEARCH_HOME_SHORTCUT_LABEL, "⌘N");
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "t", metaKey: true })), {
    type: "focusResearchHome",
  });
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "n", metaKey: true })), {
    type: "focusResearchHome",
  });
  assert.equal(resolveAppShortcut(shortcut({ key: "d", metaKey: true })), null);
});

test("Session keeps research document and browser shortcuts", () => {
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "j", metaKey: true })), {
    type: "focusFollowups",
  });
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "o", metaKey: true })), {
    type: "openFolderMenu",
  });
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "e", metaKey: true, shiftKey: true })),
    { type: "toggleSourceBrowser" },
  );
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "k", metaKey: true })), {
    type: "openCommandPalette",
  });
});

test("terminal-only chords no longer resolve", () => {
  for (const input of [
    shortcut({ key: "+", metaKey: true }),
    shortcut({ key: "r", metaKey: true, shiftKey: true }),
    shortcut({ key: "h", metaKey: true, shiftKey: true }),
    shortcut({ key: "l", metaKey: true, shiftKey: true }),
    shortcut({ key: "w", metaKey: true }),
  ]) {
    assert.equal(resolveAppShortcut(input), null);
  }
});

test("research item jump, cycle, and move chords no longer resolve", () => {
  for (const input of [
    shortcut({ key: "4", metaKey: true }),
    shortcut({ key: "4", ctrlKey: true }),
    shortcut({ key: "Tab", ctrlKey: true }),
    shortcut({ key: "Tab", ctrlKey: true, shiftKey: true }),
    shortcut({ key: "{", metaKey: true, shiftKey: true }),
    shortcut({ key: "}", metaKey: true, shiftKey: true }),
    shortcut({ key: "ArrowUp", metaKey: true, altKey: true }),
    shortcut({ key: "ArrowDown", metaKey: true, altKey: true }),
  ]) {
    assert.equal(resolveAppShortcut(input), null);
  }
});

test("native shortcut parsing accepts only research actions", () => {
  assert.deepEqual(parseAppShortcutCommand("openSettings"), { type: "openSettings" });
  assert.equal(parseAppShortcutCommand("moveResearchItemUp"), null);
  assert.equal(parseAppShortcutCommand("focusResearchTab"), null);
  assert.equal(parseAppShortcutCommand("cycleResearchTabNext"), null);
  assert.equal(parseAppShortcutCommand("splitPaneRight"), null);
  assert.equal(parseAppShortcutCommand("focusTerminalMode"), null);
});

test("show-hide conflicts use Session actions", () => {
  assert.equal(showHideShortcutConflict("Command+T"), "open Home");
  assert.equal(showHideShortcutConflict("Command+K"), "open the command palette");
  assert.equal(showHideShortcutConflict("Option+Space"), null);
});
