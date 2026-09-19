// The client's mirror of the server's `UserSettings` (07 §4.3). The server copy
// is authoritative; this store exists so the very first paint already has the
// user's theme instead of flashing the default, and so every appearance control
// is synchronous.
//
// Persistence key is `session.settings.v2`, replacing the desktop's
// `session.settings.v1` (07 §8). The version bump is deliberate: the desktop
// record carried terminal, worktree and agent keys that no longer exist, so a
// v1 blob must not be read back into this shape. Persist `version` 3 migrates
// a still-default Cool/Small local record to the guest Warm/Medium defaults.
//
// `DEFAULT_USER_SETTINGS` comes from `shared`: the server writes the same
// object into `user_preferences` on first access, and a second copy here would
// drift the moment a field is added. Guests paint from `GUEST_USER_SETTINGS`
// until a session lands.

import {
  APP_TEXT_SIZE_MAX,
  APP_TEXT_SIZE_MIN,
  DEFAULT_USER_SETTINGS,
  clamp,
  userSettingsSchema,
  type Appearance,
  type ColorTheme,
  type UserSettings,
} from "@session/shared";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { resolveAppearance } from "../lib/appearance.js";

export const SETTINGS_STORAGE_KEY = "session.settings.v2";

/** First paint for a guest: Warm theme and Medium type. Account defaults stay
 * `DEFAULT_USER_SETTINGS`; `SessionBoot` replaces this once a session exists. */
export const GUEST_USER_SETTINGS: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  colorTheme: "orange-blob",
  textSize: 15,
};

export interface SettingsState {
  settings: UserSettings;
  /** False until the persisted record has been read (or found missing). The
   * shell renders nothing theme-dependent before this flips, which is what
   * keeps a stored light theme from flashing dark. */
  hydrated: boolean;
  setHydrated: () => void;
  set: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;
  patch: (patch: Partial<UserSettings>) => void;
  /** Applies the server's copy wholesale, e.g. after `settings.get` resolves. */
  replace: (settings: UserSettings) => void;
  setColorTheme: (colorTheme: ColorTheme) => void;
  setAppearance: (appearance: Appearance) => void;
  toggleAppearance: () => void;
  setTextSize: (textSize: number) => void;
  reset: () => void;
}

/** Accepts anything and returns a complete `UserSettings`: unknown keys are
 * dropped, invalid ones fall back to their default. A partially readable record
 * keeps the fields it got right rather than resetting the whole preference
 * set. */
export function normalizeSettings(value: unknown): UserSettings {
  const whole = userSettingsSchema.safeParse(value);
  if (whole.success) return whole.data;
  if (typeof value !== "object" || value === null) return { ...DEFAULT_USER_SETTINGS };

  const source = value as Record<string, unknown>;
  const result = { ...DEFAULT_USER_SETTINGS };
  for (const key of Object.keys(DEFAULT_USER_SETTINGS) as (keyof UserSettings)[]) {
    if (!(key in source)) continue;
    const field = userSettingsSchema.shape[key].safeParse(source[key]);
    if (field.success) {
      // The per-key parse has already proven the value belongs to this key.
      (result as Record<string, unknown>)[key] = field.data;
    }
  }
  return result;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: { ...GUEST_USER_SETTINGS },
      hydrated: false,
      setHydrated: () => set({ hydrated: true }),
      set: (key, value) => set((state) => ({ settings: { ...state.settings, [key]: value } })),
      patch: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
      replace: (settings) => set({ settings: normalizeSettings(settings) }),
      setColorTheme: (colorTheme) =>
        set((state) => ({ settings: { ...state.settings, colorTheme } })),
      setAppearance: (appearance) =>
        set((state) => ({ settings: { ...state.settings, appearance } })),
      toggleAppearance: () =>
        set((state) => ({
          settings: {
            ...state.settings,
            appearance: resolveAppearance(state.settings.appearance) === "light" ? "dark" : "light",
          },
        })),
      setTextSize: (textSize) =>
        set((state) => ({
          settings: {
            ...state.settings,
            textSize: Math.round(clamp(textSize, APP_TEXT_SIZE_MIN, APP_TEXT_SIZE_MAX)),
          },
        })),
      reset: () => set({ settings: { ...GUEST_USER_SETTINGS } }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ settings: state.settings }),
      migrate: (persisted, version) => {
        const settings = normalizeSettings(
          (persisted as { settings?: unknown } | undefined)?.settings,
        );
        if (version >= 3) return { settings };
        return {
          settings: {
            ...settings,
            ...(settings.colorTheme === DEFAULT_USER_SETTINGS.colorTheme
              ? { colorTheme: GUEST_USER_SETTINGS.colorTheme }
              : {}),
            ...(settings.textSize === DEFAULT_USER_SETTINGS.textSize
              ? { textSize: GUEST_USER_SETTINGS.textSize }
              : {}),
          },
        };
      },
      merge: (persisted, current) => {
        const stored = (persisted as { settings?: unknown } | undefined)?.settings;
        return {
          ...current,
          settings: stored === undefined ? current.settings : normalizeSettings(stored),
        };
      },
      // Fires once the persisted record has been read, including when there is
      // none; either way the shell may paint.
      onRehydrateStorage: () => (state) => {
        (state ?? useSettingsStore.getState()).setHydrated();
      },
    },
  ),
);

/** Selector helpers, so components subscribe to a slice rather than the object. */
export const selectSettings = (state: SettingsState): UserSettings => state.settings;
export const selectAppearance = (state: SettingsState): Appearance => state.settings.appearance;
export const selectColorTheme = (state: SettingsState): ColorTheme => state.settings.colorTheme;
