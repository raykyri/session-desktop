import assert from "node:assert/strict";
import test from "node:test";
import {
  shortcutFromKeyboardEvent,
  shortcutKeyLabel,
  showHideShortcutMessage,
  type ShortcutKeyEvent,
} from "../src/lib/showHideShortcut";

function press(code: string, modifiers: Partial<ShortcutKeyEvent> = {}, key = ""): ShortcutKeyEvent {
  return {
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  };
}

test("key labels follow the accelerator names", () => {
  assert.equal(shortcutKeyLabel(press("KeyK")), "K");
  assert.equal(shortcutKeyLabel(press("Digit7")), "7");
  assert.equal(shortcutKeyLabel(press("F12")), "F12");
  assert.equal(shortcutKeyLabel(press("Space")), "Space");
  assert.equal(shortcutKeyLabel(press("ArrowLeft")), "Left");
  assert.equal(shortcutKeyLabel(press("BracketRight")), "]");
  assert.equal(shortcutKeyLabel(press("AudioVolumeUp")), "VolumeUp");
  assert.equal(shortcutKeyLabel(press("IntlBackslash")), null);
});

test("a modifier pressed alone names no key", () => {
  assert.equal(shortcutKeyLabel(press("AltLeft", {}, "Alt")), null);
  assert.deepEqual(shortcutFromKeyboardEvent(press("MetaLeft", { metaKey: true }, "Meta")), {
    accelerator: null,
    error: null,
  });
});

test("accelerators list modifiers in a fixed order", () => {
  assert.deepEqual(
    shortcutFromKeyboardEvent(
      press("Space", { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }),
    ),
    { accelerator: "Control+Option+Shift+Command+Space", error: null },
  );
  assert.deepEqual(shortcutFromKeyboardEvent(press("Space", { altKey: true })), {
    accelerator: "Option+Space",
    error: null,
  });
});

test("a key without a modifier is rejected", () => {
  assert.deepEqual(shortcutFromKeyboardEvent(press("KeyK")), {
    accelerator: null,
    error: "Use at least one modifier, such as Option or Command.",
  });
});

test("the status line reports errors and unregistered shortcuts outside capture", () => {
  const setting = { accelerator: "Option+Space", registered: false, error: null, captureActive: false };
  assert.equal(showHideShortcutMessage(setting), "Shortcut is saved but not active.");
  assert.equal(showHideShortcutMessage({ ...setting, captureActive: true }), null);
  assert.equal(showHideShortcutMessage({ ...setting, registered: true }), null);
  assert.equal(showHideShortcutMessage({ ...setting, accelerator: null }), null);
  assert.equal(showHideShortcutMessage({ ...setting, error: "taken" }), "taken");
});
