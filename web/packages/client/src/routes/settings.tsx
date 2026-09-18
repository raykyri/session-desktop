import { APP_TEXT_SIZE_MAX, APP_TEXT_SIZE_MIN } from "@session/shared";
import { useState } from "react";

import { BODY_FONT_OPTIONS } from "../lib/bodyFonts.js";
import { useSettingsStore } from "../stores/settings.js";
import { Field } from "../ui/Field.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { TabPanel, Tabs } from "../ui/Tabs.js";
import { Switch } from "../ui/Toggle.js";

const APPEARANCE_OPTIONS: SelectOption[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** The desktop's theme names are internal; the labels describe what the user
 * sees, a cool or warm neutral palette. */
const COLOR_THEME_OPTIONS: SelectOption[] = [
  { value: "green-blob", label: "Cool" },
  { value: "orange-blob", label: "Warm" },
];

const BODY_FONT_SELECT_OPTIONS: SelectOption[] = BODY_FONT_OPTIONS.map((option) => ({
  value: option.id,
  label: option.label,
  ...(option.localNames ? { detail: "if installed" } : {}),
}));

/**
 * Settings (07 §3). Every control here writes the local store, which
 * `ThemeEffects` applies to `<html>` synchronously. The server round-trip
 * (`settings.update`, and the Research and Usage sections that need it) joins
 * in the second half of Phase 5; the store is already the shape the server
 * stores, so that is a mutation call, not a rewrite.
 */
export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings);
  const set = useSettingsStore((state) => state.set);
  const setTextSize = useSettingsStore((state) => state.setTextSize);
  const [section, setSection] = useState("appearance");

  return (
    <div className="h-full overflow-y-auto px-8 py-10">
      <div className="mx-auto flex w-[min(640px,100%)] flex-col gap-6">
        <h1 className="text-input text-fg-heading m-0 font-semibold">Settings</h1>

        <Tabs
          value={section}
          onValueChange={setSection}
          label="Settings sections"
          tabs={[
            { value: "appearance", label: "Appearance" },
            { value: "general", label: "General" },
          ]}
        >
          <TabPanel value="appearance">
            <div className="flex flex-col gap-5">
              <Field label="Appearance" hint="Independent of the system setting.">
                {() => (
                  <Select
                    label="Appearance"
                    value={settings.appearance}
                    options={APPEARANCE_OPTIONS}
                    onChange={(value) => set("appearance", value === "light" ? "light" : "dark")}
                  />
                )}
              </Field>

              <Field label="Theme" hint="Chooses the accent and the neutral temperature.">
                {() => (
                  <Select
                    label="Theme"
                    value={settings.colorTheme}
                    options={COLOR_THEME_OPTIONS}
                    onChange={(value) =>
                      set("colorTheme", value === "orange-blob" ? "orange-blob" : "green-blob")
                    }
                  />
                )}
              </Field>

              <Field
                label="Body font"
                hint="Anthropic Sans Text and Inter are offered only when installed on this machine."
              >
                {() => (
                  <Select
                    label="Body font"
                    value={settings.bodyFontId}
                    options={BODY_FONT_SELECT_OPTIONS}
                    onChange={(value) => set("bodyFontId", value)}
                  />
                )}
              </Field>

              <Field label={`Text size (${settings.textSize})`} hint="Scales answer text.">
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    type="range"
                    min={APP_TEXT_SIZE_MIN}
                    max={APP_TEXT_SIZE_MAX}
                    step={1}
                    value={settings.textSize}
                    className="accent-accent w-full"
                    onChange={(event) => setTextSize(Number(event.currentTarget.value))}
                  />
                )}
              </Field>

              <Switch
                label="Shortcut hints"
                description="Show chord badges beside sidebar rows."
                checked={settings.showShortcutHints}
                onCheckedChange={(checked) => set("showShortcutHints", checked)}
              />

              <Switch
                label="Reduce motion"
                description="Settle decorative transitions immediately. Progress indicators keep moving."
                checked={settings.reduceMotion}
                onCheckedChange={(checked) => set("reduceMotion", checked)}
              />
            </div>
          </TabPanel>

          <TabPanel value="general">
            <div className="flex flex-col gap-5">
              <Switch
                label="Show tool calls"
                description="Include searches, fetches and document reads in answers."
                checked={settings.showToolCalls}
                onCheckedChange={(checked) => set("showToolCalls", checked)}
              />
              <Switch
                label="Show timestamps"
                description="A wall-clock time after each run of assistant messages."
                checked={settings.showAssistantTimestamps}
                onCheckedChange={(checked) => set("showAssistantTimestamps", checked)}
              />
              <Switch
                label="Notifications"
                description="Overlay toasts for server-originated notices."
                checked={settings.showNotifications}
                onCheckedChange={(checked) => set("showNotifications", checked)}
              />
              <Switch
                label="Require ⌘↵ to send"
                description="Otherwise Enter sends and Shift-Enter inserts a newline."
                checked={settings.requireCmdEnterToSend}
                onCheckedChange={(checked) => set("requireCmdEnterToSend", checked)}
              />
            </div>
          </TabPanel>
        </Tabs>
      </div>
    </div>
  );
}
