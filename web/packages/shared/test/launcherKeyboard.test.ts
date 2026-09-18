import test from "ava";

import { launcherTabAction } from "../src/app/launcherKeyboard.js";

const key = (overrides: Partial<Parameters<typeof launcherTabAction>[0]> = {}) => ({
  key: "Tab",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...overrides,
});

test("Tab cycles the model when the launcher offers a selection", (t) => {
  t.is(launcherTabAction(key(), true), "cycle-model");
  t.is(launcherTabAction(key(), false), "capture");
});

test("modified Tab chords remain available to app shortcuts", (t) => {
  t.is(launcherTabAction(key({ ctrlKey: true }), true), null);
  t.is(launcherTabAction(key({ metaKey: true }), true), null);
  t.is(launcherTabAction(key({ altKey: true }), true), null);
  t.is(launcherTabAction(key({ key: "Enter" }), true), null);
});
