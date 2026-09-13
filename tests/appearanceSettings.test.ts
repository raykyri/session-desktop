import assert from "node:assert/strict";
import test from "node:test";
import { loadSettings, saveSettings } from "../src/lib/settings";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
};
const key = "session.settings.v1";

test("legacy terminal preferences preserve visible text size and supported settings", () => {
  store.set(key, JSON.stringify({ fontSize: 18, themeId: "Dracula", cursorStyle: "bar",
    colorTheme: "orange-blob", bodyFontId: "system",
    researchLaunchInstruction: "Check primary sources", preventSleep: false }));
  const settings = loadSettings();
  assert.equal(settings.textSize, 18);
  assert.equal(settings.colorTheme, "orange-blob");
  assert.equal(settings.bodyFontId, "system");
  assert.equal(settings.researchLaunchInstruction, "Check primary sources");
  assert.equal(settings.preventSleep, false);
  saveSettings(settings);
  assert.equal(loadSettings().textSize, 18);
  assert.equal(JSON.parse(store.get(key)!).themeId, undefined);
});

test("app text size takes precedence and invalid legacy values fall back safely", () => {
  store.set(key, JSON.stringify({ textSize: 16, fontSize: 20 }));
  assert.equal(loadSettings().textSize, 16);
  store.set(key, JSON.stringify({ fontSize: "huge" }));
  assert.equal(loadSettings().textSize, 14);
  store.set(key, JSON.stringify({ fontSize: 100 }));
  assert.equal(loadSettings().textSize, 32);
});
