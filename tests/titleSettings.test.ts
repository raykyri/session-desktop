import assert from "node:assert/strict";
import test from "node:test";
import { loadSettings, saveSettings } from "../src/lib/settings";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
};
const key = "session.settings.v1";

test("retired local title provider does not enable a remote provider", () => {
  store.set(key, JSON.stringify({
    tabTitleProvider: "appleFoundationModels",
    openRouterTitlesEnabled: true,
    openRouterKey: "saved-key",
    openRouterModel: "saved-model",
  }));
  const settings = loadSettings();
  assert.equal(settings.tabTitleProvider, "disabled");
  assert.equal(settings.openRouterKey, "saved-key");
  assert.equal(settings.openRouterModel, "saved-model");
  saveSettings(settings);
  assert.equal(loadSettings().tabTitleProvider, "disabled");
});

test("current provider selections take precedence over the old enable flag", () => {
  for (const provider of ["openRouter", "disabled"] as const) {
    store.set(key, JSON.stringify({
      tabTitleProvider: provider,
      openRouterTitlesEnabled: true,
      openRouterKey: "saved-key",
      openRouterModel: "saved-model",
    }));
    const settings = loadSettings();
    assert.equal(settings.tabTitleProvider, provider);
    assert.equal(settings.openRouterModel, "saved-model");
  }
});

test("fresh settings disable tab generation and legacy OpenRouter opt-in still loads", () => {
  store.clear();
  assert.equal(loadSettings().tabTitleProvider, "disabled");
  store.set(key, JSON.stringify({ openRouterTitlesEnabled: true }));
  assert.equal(loadSettings().tabTitleProvider, "openRouter");
});
