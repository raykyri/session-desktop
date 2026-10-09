import assert from "node:assert/strict";
import test from "node:test";
import { launcherTabAction } from "../src/lib/launcherKeyboard";

const key = (overrides: Partial<Parameters<typeof launcherTabAction>[0]> = {}) => ({
  key: "Tab",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("plain Tab and Shift-Tab move focus out of the composer", () => {
  assert.equal(launcherTabAction(key(), true), null);
  assert.equal(launcherTabAction(key(), false), null);
  assert.equal(launcherTabAction(key({ shiftKey: true }), true), null);
});

test("Control-Tab cycles models, and is captured while no model applies", () => {
  assert.equal(launcherTabAction(key({ ctrlKey: true }), true), "cycle-model");
  assert.equal(launcherTabAction(key({ ctrlKey: true }), false), "capture");
});

test("Control-Shift-Tab cycles agents", () => {
  assert.equal(launcherTabAction(key({ ctrlKey: true, shiftKey: true }), true), "cycle-provider");
  assert.equal(launcherTabAction(key({ ctrlKey: true, shiftKey: true }), false), "cycle-provider");
});

test("other Tab chords remain available to app shortcuts", () => {
  assert.equal(launcherTabAction(key({ ctrlKey: true, metaKey: true }), true), null);
  assert.equal(launcherTabAction(key({ metaKey: true }), true), null);
  assert.equal(launcherTabAction(key({ ctrlKey: true, altKey: true }), true), null);
  assert.equal(launcherTabAction(key({ key: "Enter", ctrlKey: true }), true), null);
});
