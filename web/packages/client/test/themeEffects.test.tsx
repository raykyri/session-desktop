import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { act, cleanup, render } from "@testing-library/react";
import test from "ava";

import { ThemeEffects } from "../src/app/ThemeEffects.js";
import { useSettingsStore } from "../src/stores/settings.js";

import { resetDocumentRoot } from "./helpers.js";

test.beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_USER_SETTINGS }, hydrated: true });
  resetDocumentRoot();
});

test.afterEach(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial("the settings store is applied to <html> as attributes", (t) => {
  render(<ThemeEffects />);
  const root = document.documentElement;

  t.is(root.dataset["colorTheme"], "orange-blob");
  // The default appearance is "system"; without `window.matchMedia` (jsdom)
  // it resolves to dark (`lib/appearance.ts`).
  t.is(root.dataset["appearance"], "dark");
  t.false(root.classList.contains("reduce-motion"));
});

test.serial("the body font setting is not applied: the face is Inter from tokens.css", (t) => {
  render(<ThemeEffects />);
  act(() => useSettingsStore.getState().set("bodyFontId", "valley-sans"));

  const root = document.documentElement;
  t.is(root.dataset["bodyFont"], undefined);
  t.is(root.style.getPropertyValue("--font-ui"), "");
});

test.serial("changing the theme rewrites the attributes without a remount", (t) => {
  render(<ThemeEffects />);

  act(() => {
    useSettingsStore.getState().patch({ colorTheme: "green-blob", appearance: "dark" });
  });

  t.is(document.documentElement.dataset["colorTheme"], "green-blob");
  t.is(document.documentElement.dataset["appearance"], "dark");
});

test.serial("appearance drives the color-scheme meta the tokens cannot reach", (t) => {
  render(<ThemeEffects />);
  const meta = () => document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');

  t.is(meta()?.content, "dark");
  act(() => useSettingsStore.getState().setAppearance("light"));
  t.is(meta()?.content, "light");
});

test.serial("text size becomes a bounded pixel zoom, not a root font size", (t) => {
  render(<ThemeEffects />);

  act(() => useSettingsStore.getState().setTextSize(14));
  t.is(document.documentElement.style.getPropertyValue("--app-text-zoom"), "0px");

  act(() => useSettingsStore.getState().setTextSize(18));
  t.is(document.documentElement.style.getPropertyValue("--app-text-zoom"), "4px");

  act(() => useSettingsStore.getState().setTextSize(12));
  t.is(document.documentElement.style.getPropertyValue("--app-text-zoom"), "-2px");
});
