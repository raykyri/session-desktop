import test from "ava";

import { launcherTabAction } from "../src/app/launcherKeyboard.js";

const key = (overrides: Partial<Parameters<typeof launcherTabAction>[0]> = {}) => ({
  key: "Tab",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("Tab cycles the model when the launcher offers a selection", (t) => {
  t.is(launcherTabAction(key(), true), "cycle-model");
  t.is(launcherTabAction(key(), false), "capture");
});

test("Shift-Tab is left to the browser so focus can leave the composer", (t) => {
  // Taking both directions and calling `preventDefault` on each is a keyboard
  // trap: focus enters the prompt textarea and nothing gets it out (WCAG
  // 2.1.2). Tab forwards is the model cycle; Shift-Tab is the way out.
  t.is(launcherTabAction(key({ shiftKey: true }), true), null);
  t.is(launcherTabAction(key({ shiftKey: true }), false), null);
  t.is(launcherTabAction(key(), true), "cycle-model", "the forward direction still cycles");
});

test("modified Tab chords remain available to app shortcuts", (t) => {
  t.is(launcherTabAction(key({ ctrlKey: true }), true), null);
  t.is(launcherTabAction(key({ metaKey: true }), true), null);
  t.is(launcherTabAction(key({ altKey: true }), true), null);
  t.is(launcherTabAction(key({ key: "Enter" }), true), null);
});
