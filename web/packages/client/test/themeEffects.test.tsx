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

test.serial("the settings store lands on <html> as attributes", (t) => {
  render(<ThemeEffects />);
  const root = document.documentElement;

  t.is(root.dataset["colorTheme"], "green-blob");
  t.is(root.dataset["appearance"], "dark");
  t.is(root.dataset["bodyFont"], "dm-sans");
  t.regex(root.style.getPropertyValue("--font-ui"), /DM Sans/);
  t.false(root.classList.contains("reduce-motion"));
});

test.serial("changing the theme rewrites the attributes without a remount", (t) => {
  render(<ThemeEffects />);

  act(() => {
    useSettingsStore.getState().patch({ colorTheme: "orange-blob", appearance: "light" });
  });

  t.is(document.documentElement.dataset["colorTheme"], "orange-blob");
  t.is(document.documentElement.dataset["appearance"], "light");
});

test.serial("appearance drives the color-scheme meta the tokens cannot reach", (t) => {
  render(<ThemeEffects />);
  const meta = () => document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');

  t.is(meta()?.content, "dark");
  act(() => useSettingsStore.getState().setAppearance("light"));
  t.is(meta()?.content, "light");
});

test.serial("the body font choice sets both the stack and the optical marker", (t) => {
  render(<ThemeEffects />);

  act(() => useSettingsStore.getState().set("bodyFontId", "valley-sans"));

  t.is(document.documentElement.dataset["bodyFont"], "valley-sans");
  t.regex(document.documentElement.style.getPropertyValue("--font-ui"), /Valley Sans/);
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
