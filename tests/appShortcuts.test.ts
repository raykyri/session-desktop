import assert from "node:assert/strict";
import test from "node:test";
import {
  appShortcutAllowsRepeat,
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
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "4", metaKey: true })), {
    type: "focusResearchTab",
    tabIndex: 3,
  });
  assert.deepEqual(resolveAppShortcut(shortcut({ key: "Tab", ctrlKey: true })), {
    type: "cycleResearchTab",
    direction: 1,
  });
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "Tab", ctrlKey: true, shiftKey: true })),
    { type: "cycleResearchTab", direction: -1 },
  );
  assert.deepEqual(
    resolveAppShortcut(shortcut({ key: "ArrowUp", metaKey: true, altKey: true })),
    { type: "moveResearchItem", direction: -1 },
  );
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

test("native shortcut parsing accepts only research actions", () => {
  assert.deepEqual(parseAppShortcutCommand("focusResearchTab", 2), {
    type: "focusResearchTab",
    tabIndex: 2,
  });
  assert.deepEqual(parseAppShortcutCommand("cyclePaneTabNext", null), {
    type: "cycleResearchTab",
    direction: 1,
  });
  assert.deepEqual(parseAppShortcutCommand("moveSidebarItemUp", null), {
    type: "moveResearchItem",
    direction: -1,
  });
  assert.equal(parseAppShortcutCommand("splitPaneRight", null), null);
  assert.equal(parseAppShortcutCommand("focusTerminalMode", null), null);
});

test("shortcut repeat and show-hide conflicts use Session actions", () => {
  assert.equal(appShortcutAllowsRepeat({ type: "moveResearchItem", direction: 1 }), true);
  assert.equal(appShortcutAllowsRepeat({ type: "focusResearchHome" }), false);
  assert.equal(showHideShortcutConflict("Command+T"), "open Home");
  assert.equal(showHideShortcutConflict("Command+K"), "open the command palette");
  assert.equal(showHideShortcutConflict("Option+Space"), null);
});
