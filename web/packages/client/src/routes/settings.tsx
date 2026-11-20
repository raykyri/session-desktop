import {
  clampResearchLaunchInstruction,
  DEFAULT_RESEARCH_LAUNCH_INSTRUCTION,
} from "@session/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useRuntimeConfig, useSettings, useSignedIn, useUpdateSettings } from "../api/queries.js";
import { useResolvedAppearance } from "../lib/appearance.js";
import { BODY_FONT_OPTIONS } from "../lib/bodyFonts.js";
import { isApplePlatform } from "../lib/platform.js";
import { errorMessage } from "../lib/toast.js";
import { useSettingsStore } from "../stores/settings.js";
import { Textarea } from "../ui/Field.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { Checkbox } from "../ui/Toggle.js";

/** The desktop's two appearances. A stored "system" (from an earlier web
 * build) shows as the appearance it resolves to until one is picked. */
const APPEARANCE_OPTIONS: SelectOption[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** The desktop's theme names are internal; the labels are the desktop's. */
const COLOR_THEME_OPTIONS: SelectOption[] = [
  { value: "green-blob", label: "Cool" },
  { value: "orange-blob", label: "Warm" },
];

const BODY_FONT_SELECT_OPTIONS: SelectOption[] = BODY_FONT_OPTIONS.map((option) => ({
  value: option.id,
  label: option.label,
  ...(option.localNames ? { detail: "if installed" } : {}),
}));

/** Research instructions save this long after the last keystroke, and at
 * once when the field loses focus or the page closes. */
export const RESEARCH_INSTRUCTIONS_SAVE_MS = 500;

/** Compact, content-sized pickers, as the desktop's selects. */
const PICKER_CLASS = "w-fit min-w-44";

/** A row with its label on the left and its picker on the right, as the
 * desktop's `settings-row`. The picker carries the label as its accessible
 * name. */
function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-fg-primary text-base" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Research instructions (the desktop's row): prepended to every launch,
 * stored on the account, saved as the text changes. The 4 KiB cap is the
 * shared clamp both halves apply, so the field cannot hold text the server
 * would refuse.
 */
function ResearchInstructionsRow() {
  const settings = useSettings();
  const update = useUpdateSettings();
  // The text being typed, or null while the field shows the stored value.
  const [edit, setEdit] = useState<string | null>(null);
  const stored = settings.data?.researchLaunchInstruction ?? "";
  const value = edit ?? stored;
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutate = update.mutate;
  const id = useId();

  const save = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const text = pendingRef.current;
    if (text === null) return;
    pendingRef.current = null;
    mutate(
      { researchLaunchInstruction: text.trim() === "" ? null : text },
      // Typing that continued meanwhile stays in the field.
      { onSuccess: () => setEdit((current) => (current === text ? null : current)) },
    );
  }, [mutate]);
  // Leaving the page saves what is still waiting.
  useEffect(() => save, [save]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-fg-primary text-base">
          Research instructions
        </label>
        <p id={`${id}-hint`} className="text-fg-muted m-0 text-base">
          Sent with every research launch
        </p>
      </div>
      <Textarea
        id={id}
        aria-describedby={`${id}-hint`}
        rows={2}
        className="w-full"
        placeholder={DEFAULT_RESEARCH_LAUNCH_INSTRUCTION}
        value={value}
        onChange={(event) => {
          const next = clampResearchLaunchInstruction(event.currentTarget.value);
          setEdit(next);
          pendingRef.current = next;
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(save, RESEARCH_INSTRUCTIONS_SAVE_MS);
        }}
        onBlur={save}
      />
      {update.error ? (
        <p className="text-status-failed m-0 text-base" role="alert">
          Could not save the research-instructions setting: {errorMessage(update.error)}
        </p>
      ) : null}
    </div>
  );
}

/** Web only: the model a question runs on unless the ask box picks another
 * (it replaces the desktop's agent choice). */
function DefaultModelRow() {
  const runtimeConfig = useRuntimeConfig();
  const setLocal = useSettingsStore((state) => state.set);
  const defaultModel = useSettingsStore((state) => state.settings.defaultModel);
  const models = (runtimeConfig.data?.models ?? []).filter((model) => model.available);
  const options: SelectOption[] = models.map((model) => ({
    value: model.id,
    label: model.label,
    ...(model.adminOnly ? { detail: "admin" } : {}),
  }));
  return (
    <SettingsRow label="Default model">
      <Select
        label="Default model"
        value={defaultModel}
        options={options.length > 0 ? options : [{ value: defaultModel, label: defaultModel }]}
        className={PICKER_CLASS}
        onChange={(value) => setLocal("defaultModel", value)}
      />
    </SettingsRow>
  );
}

/**
 * Settings (07 §3), the desktop's rows and wording. Every control but the
 * research instructions writes the local store, which `ThemeEffects` applies
 * to `<html>` synchronously and `SessionBoot` pushes to `settings.update` on
 * a 300 ms debounce. Web only: Default model (the desktop chooses an agent)
 * and Notifications (the server's notifications about other people's
 * activity). The desktop's show/hide shortcut and Keep awake have no web
 * equivalent.
 */
export function SettingsPage() {
  const signedIn = useSignedIn();
  const settings = useSettingsStore((state) => state.settings);
  const set = useSettingsStore((state) => state.set);
  const appearance = useResolvedAppearance(settings.appearance);
  // The desktop names the macOS chord; elsewhere the browser's is Ctrl+↵.
  const sendChord = isApplePlatform() ? "⌘↵" : "Ctrl+↵";

  return (
    <div className="h-full overflow-y-auto px-8 py-10">
      <div className="mx-auto flex w-[min(640px,100%)] flex-col gap-6">
        <h1 className="text-title text-fg-heading m-0 font-semibold">Settings</h1>

        <div className="flex flex-col gap-5">
          <Checkbox
            label={`Require ${sendChord} to send`}
            description={`A thread's question boxes always require ${sendChord}. This setting controls the Home ask box, drafts and note follow-ups.`}
            checked={settings.requireCmdEnterToSend}
            onCheckedChange={(checked) => set("requireCmdEnterToSend", checked)}
          />
          {signedIn ? <ResearchInstructionsRow /> : null}
          <Checkbox
            label="Widgets in answers"
            description="Agents may add sandboxed HTML; its scripts run only when you start them"
            checked={settings.researchInlineWidgets}
            onCheckedChange={(checked) => set("researchInlineWidgets", checked)}
          />
          {signedIn ? <DefaultModelRow /> : null}
          <Checkbox
            label="Notifications"
            description="Show popup notifications for background server events."
            checked={settings.showNotifications}
            onCheckedChange={(checked) => set("showNotifications", checked)}
          />
          {signedIn ? null : (
            <p className="text-fg-muted m-0 text-base">
              Sign in to set research instructions and the default model.
            </p>
          )}

          <div className="border-border-faint border-t" role="separator" />

          <SettingsRow label="Appearance">
            <Select
              label="Appearance"
              value={appearance}
              options={APPEARANCE_OPTIONS}
              className={PICKER_CLASS}
              onChange={(value) => set("appearance", value === "light" ? "light" : "dark")}
            />
          </SettingsRow>
          <SettingsRow label="Color theme">
            <Select
              label="Color theme"
              value={settings.colorTheme}
              options={COLOR_THEME_OPTIONS}
              className={PICKER_CLASS}
              onChange={(value) =>
                set("colorTheme", value === "orange-blob" ? "orange-blob" : "green-blob")
              }
            />
          </SettingsRow>
          <SettingsRow label="Body font">
            <Select
              label="Body font"
              value={settings.bodyFontId}
              options={BODY_FONT_SELECT_OPTIONS}
              className={PICKER_CLASS}
              onChange={(value) => set("bodyFontId", value)}
            />
          </SettingsRow>
          <Checkbox
            label="Show keyboard shortcut hints"
            checked={settings.showShortcutHints}
            onCheckedChange={(checked) => set("showShortcutHints", checked)}
          />
          <Checkbox
            label="Reduce motion"
            checked={settings.reduceMotion}
            onCheckedChange={(checked) => set("reduceMotion", checked)}
          />
        </div>
      </div>
    </div>
  );
}
