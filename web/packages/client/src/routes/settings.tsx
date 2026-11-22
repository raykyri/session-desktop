import type { Appearance } from "@session/shared";
import type { ReactNode } from "react";

import { PageFrame } from "../features/shell/Frames.js";
import { isApplePlatform } from "../lib/platform.js";
import { useSettingsStore } from "../stores/settings.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { Checkbox } from "../ui/Toggle.js";

/** "System" follows the device's light or dark setting
 * (`prefers-color-scheme`), and is the default. */
const APPEARANCE_OPTIONS: SelectOption[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const asAppearance = (value: string): Appearance =>
  value === "light" || value === "dark" ? value : "system";

/** The desktop's theme names are internal; the labels are the desktop's. */
const COLOR_THEME_OPTIONS: SelectOption[] = [
  { value: "green-blob", label: "Cool" },
  { value: "orange-blob", label: "Warm" },
];

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
 * Settings (02 §1): kept from the earlier client and not linked from the
 * account menu at launch (decision P23). Every control writes the local
 * store, which `ThemeEffects` applies to `<html>` synchronously and
 * `SessionBoot` pushes to `settings.update` on a 300 ms debounce. The
 * research client's rows (research instructions, widgets in answers, the
 * default model, the body font) are gone: answers are plain Markdown (P21),
 * the default model is a site setting (W8.2), and the face is Inter (§11).
 */
export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings);
  const set = useSettingsStore((state) => state.set);
  // The desktop names the macOS chord; elsewhere the browser's is Ctrl+↵.
  const sendChord = isApplePlatform() ? "⌘↵" : "Ctrl+↵";

  return (
    <PageFrame title="Settings" narrow>
      <div className="mt-4 flex flex-col gap-5">
        <Checkbox
          label={`Require ${sendChord} to send`}
          checked={settings.requireCmdEnterToSend}
          onCheckedChange={(checked) => set("requireCmdEnterToSend", checked)}
        />
        <Checkbox
          label="Notifications"
          description="Show popup notifications for background server events."
          checked={settings.showNotifications}
          onCheckedChange={(checked) => set("showNotifications", checked)}
        />

        <div className="border-border-faint border-t" role="separator" />

        <SettingsRow label="Appearance">
          <Select
            label="Appearance"
            value={settings.appearance}
            options={APPEARANCE_OPTIONS}
            className={PICKER_CLASS}
            onChange={(value) => set("appearance", asAppearance(value))}
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
    </PageFrame>
  );
}
