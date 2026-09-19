import { DEFAULT_USER_SETTINGS } from "@session/shared";
import test from "ava";

import { BODY_FONT_OPTIONS, DEFAULT_BODY_FONT_ID } from "../src/lib/bodyFonts.js";
import {
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  useSettingsStore,
} from "../src/stores/settings.js";

test.beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ settings: { ...DEFAULT_USER_SETTINGS }, hydrated: false });
});

test.serial("uses default appearance settings when local storage is empty", (t) => {
  t.is(useSettingsStore.getState().settings.appearance, "dark");
  t.is(useSettingsStore.getState().settings.colorTheme, "green-blob");
  t.is(useSettingsStore.getState().settings.bodyFontId, "dm-sans");
});

test.serial("hydration reads the persisted record under session.settings.v2", async (t) => {
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      state: {
        settings: { ...DEFAULT_USER_SETTINGS, appearance: "light", colorTheme: "orange-blob" },
      },
    }),
  );

  await useSettingsStore.persist.rehydrate();

  t.is(useSettingsStore.getState().settings.appearance, "light");
  t.is(useSettingsStore.getState().settings.colorTheme, "orange-blob");
  t.true(useSettingsStore.getState().hydrated);
});

test.serial("hydration flips `hydrated` even when nothing was stored", async (t) => {
  await useSettingsStore.persist.rehydrate();
  t.true(useSettingsStore.getState().hydrated);
  t.deepEqual(useSettingsStore.getState().settings, DEFAULT_USER_SETTINGS);
});

test.serial("a stored record still carrying `showShortcutHints` loads intact", async (t) => {
  // The setting was removed with the sidebar's Cmd-held badges, but every
  // browser that ran an earlier build still has it in `session.settings.v2`.
  // Preserve valid settings while removing deprecated keys.
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      state: {
        settings: { ...DEFAULT_USER_SETTINGS, showShortcutHints: false, appearance: "light" },
      },
    }),
  );

  await useSettingsStore.persist.rehydrate();

  const settings = useSettingsStore.getState().settings;
  t.is(settings.appearance, "light", "the rest of the record is not discarded");
  t.false("showShortcutHints" in settings, "and the removed key is not carried forward");
  t.deepEqual(settings, { ...DEFAULT_USER_SETTINGS, appearance: "light" });
});

test.serial("a partially readable record keeps the fields it got right", (t) => {
  const settings = normalizeSettings({
    appearance: "light",
    colorTheme: "not-a-theme",
    textSize: 999,
    showNotifications: false,
    somethingRemoved: true,
  });

  t.is(settings.appearance, "light");
  t.is(settings.colorTheme, DEFAULT_USER_SETTINGS.colorTheme, "invalid enum falls back");
  t.is(settings.textSize, DEFAULT_USER_SETTINGS.textSize, "out-of-range number falls back");
  t.false(settings.showNotifications);
  t.false("somethingRemoved" in settings);
});

test.serial("a v1-shaped blob does not leak desktop keys into the v2 shape", (t) => {
  const settings = normalizeSettings({
    colorTheme: "orange-blob",
    worktreeLocation: "localSession",
    tabTitleProvider: "openRouter",
  });
  t.is(settings.colorTheme, "orange-blob");
  t.deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULT_USER_SETTINGS).sort());
});

test.serial("text size is clamped to the documented bounds", (t) => {
  useSettingsStore.getState().setTextSize(999);
  t.is(useSettingsStore.getState().settings.textSize, 18);
  useSettingsStore.getState().setTextSize(-4);
  t.is(useSettingsStore.getState().settings.textSize, 12);
});

test.serial("toggleAppearance flips between the two appearances", (t) => {
  useSettingsStore.getState().toggleAppearance();
  t.is(useSettingsStore.getState().settings.appearance, "light");
  useSettingsStore.getState().toggleAppearance();
  t.is(useSettingsStore.getState().settings.appearance, "dark");
});

// The default record lives in `shared`, which cannot import the client's font
// list and so repeats the id as a literal. This is the seam where that would
// drift unnoticed.
test("the shared default font identifier exists in the client font options", (t) => {
  t.is(DEFAULT_USER_SETTINGS.bodyFontId, DEFAULT_BODY_FONT_ID);
  t.truthy(
    BODY_FONT_OPTIONS.find((option) => option.id === DEFAULT_USER_SETTINGS.bodyFontId),
    "the default must be a real option, not just a matching string",
  );
});
