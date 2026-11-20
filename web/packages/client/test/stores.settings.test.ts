import { DEFAULT_USER_SETTINGS } from "@session/shared";
import test from "ava";

import { BODY_FONT_OPTIONS, DEFAULT_BODY_FONT_ID } from "../src/lib/bodyFonts.js";
import {
  GUEST_USER_SETTINGS,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  useSettingsStore,
} from "../src/stores/settings.js";

test.beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ settings: { ...GUEST_USER_SETTINGS }, hydrated: false });
});

test.serial("uses default appearance settings when local storage is empty", (t) => {
  t.is(useSettingsStore.getState().settings.appearance, "dark");
  t.is(useSettingsStore.getState().settings.colorTheme, "orange-blob");
  t.is(useSettingsStore.getState().settings.textSize, 15);
  t.is(useSettingsStore.getState().settings.bodyFontId, "dm-sans");
});

test.serial("hydration reads the persisted record under session.settings.v2", async (t) => {
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      state: {
        settings: {
          ...DEFAULT_USER_SETTINGS,
          appearance: "light",
          colorTheme: "orange-blob",
          textSize: 16,
        },
      },
    }),
  );

  await useSettingsStore.persist.rehydrate();

  t.is(useSettingsStore.getState().settings.appearance, "light");
  t.is(useSettingsStore.getState().settings.colorTheme, "orange-blob");
  t.is(useSettingsStore.getState().settings.textSize, 16);
  t.true(useSettingsStore.getState().hydrated);
});

test.serial("hydration flips `hydrated` even when nothing was stored", async (t) => {
  await useSettingsStore.persist.rehydrate();
  t.true(useSettingsStore.getState().hydrated);
  t.deepEqual(useSettingsStore.getState().settings, GUEST_USER_SETTINGS);
});

test.serial("a stored record still carrying `showToolCalls` loads intact", async (t) => {
  // The web-only Reading settings (Show tool calls, Show timestamps) were
  // removed for the desktop's four, but browsers that ran an earlier build
  // still have them in `session.settings.v2`. Valid settings are kept, the
  // removed keys dropped, and the new ones start at their defaults.
  const {
    requireCmdEnterToSend,
    researchInlineWidgets,
    showShortcutHints,
    reduceMotion,
    ...older
  } = DEFAULT_USER_SETTINGS;
  t.true(requireCmdEnterToSend && researchInlineWidgets && showShortcutHints && !reduceMotion);
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      state: {
        settings: {
          ...older,
          showToolCalls: false,
          showAssistantTimestamps: true,
          appearance: "light",
        },
      },
    }),
  );

  await useSettingsStore.persist.rehydrate();

  const settings = useSettingsStore.getState().settings;
  t.is(settings.appearance, "light", "the rest of the record is not discarded");
  t.false("showToolCalls" in settings, "and the removed keys are not carried forward");
  t.deepEqual(settings, { ...GUEST_USER_SETTINGS, appearance: "light" });
});

test.serial("the desktop's four settings are kept as stored", async (t) => {
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      version: 3,
      state: {
        settings: {
          ...DEFAULT_USER_SETTINGS,
          requireCmdEnterToSend: false,
          researchInlineWidgets: false,
          showShortcutHints: false,
          reduceMotion: true,
        },
      },
    }),
  );
  await useSettingsStore.persist.rehydrate();
  const settings = useSettingsStore.getState().settings;
  t.false(settings.requireCmdEnterToSend);
  t.false(settings.researchInlineWidgets);
  t.false(settings.showShortcutHints);
  t.true(settings.reduceMotion);
});

test.serial(
  "a v2 Cool/Small local record migrates to the guest Warm/Medium defaults",
  async (t) => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        state: { settings: { ...DEFAULT_USER_SETTINGS } },
      }),
    );

    await useSettingsStore.persist.rehydrate();

    t.deepEqual(useSettingsStore.getState().settings, GUEST_USER_SETTINGS);
  },
);

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

// The default record is defined in `shared`, which cannot import the client's font
// list and so repeats the id as a literal. This test detects when that value would
// drift unnoticed.
test("the shared default font identifier exists in the client font options", (t) => {
  t.is(DEFAULT_USER_SETTINGS.bodyFontId, DEFAULT_BODY_FONT_ID);
  t.truthy(
    BODY_FONT_OPTIONS.find((option) => option.id === DEFAULT_USER_SETTINGS.bodyFontId),
    "the default must be a real option, not just a matching string",
  );
});

test("Inter is a bundled body font, not an optional local face", (t) => {
  const inter = BODY_FONT_OPTIONS.find((option) => option.id === "inter");
  t.truthy(inter);
  t.is(inter?.localNames, undefined);
  t.regex(inter?.stack ?? "", /Inter/);
});
