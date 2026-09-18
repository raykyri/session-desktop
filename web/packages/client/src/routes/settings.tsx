import {
  APP_TEXT_SIZE_MAX,
  APP_TEXT_SIZE_MIN,
  RESEARCH_LAUNCH_INSTRUCTION_MAX_BYTES,
  clampResearchLaunchInstruction,
} from "@session/shared";
import { useState } from "react";

import { useRuntimeConfig, useSettings, useUpdateSettings, useUsage } from "../api/queries.js";
import { BODY_FONT_OPTIONS } from "../lib/bodyFonts.js";
import { useSettingsStore } from "../stores/settings.js";
import { ControlButton } from "../ui/Button.js";
import { Field, Textarea } from "../ui/Field.js";
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
 * Research (07 §3, `06-auth-and-users.md` §6). The instruction is prepended to
 * every launch, so it is stored on the account rather than in this tab: the
 * 4 KiB cap is the shared clamp both halves apply, and it is applied here so
 * the field cannot hold text the server would silently cut.
 */
function ResearchSection() {
  const settings = useSettings();
  const runtimeConfig = useRuntimeConfig();
  const update = useUpdateSettings();
  const setLocal = useSettingsStore((state) => state.set);
  const defaultModel = useSettingsStore((state) => state.settings.defaultModel);
  // The edit in progress, or `null` while the field shows the stored value.
  // Derive the displayed value directly so server updates take effect without
  // synchronization lag while preserving active edits.
  const [edit, setEdit] = useState<string | null>(null);
  const stored = settings.data?.researchLaunchInstruction ?? "";
  const instruction = edit ?? stored;

  const models = (runtimeConfig.data?.models ?? []).filter((model) => model.available);
  const modelOptions: SelectOption[] = models.map((model) => ({
    value: model.id,
    label: model.label,
    ...(model.adminOnly ? { detail: "admin" } : {}),
  }));
  const dirty = edit !== null && edit !== stored;

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Research instructions"
        hint={`Added to the beginning of every research question. Up to ${RESEARCH_LAUNCH_INSTRUCTION_MAX_BYTES / 1024} KiB.`}
      >
        {({ id, describedBy }) => (
          <div className="flex flex-col items-start gap-2">
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={5}
              className="w-full"
              value={instruction}
              onChange={(event) =>
                setEdit(clampResearchLaunchInstruction(event.currentTarget.value))
              }
            />
            <ControlButton
              size="sm"
              disabled={!dirty || update.isPending}
              onClick={() =>
                update.mutate(
                  { researchLaunchInstruction: instruction.trim() === "" ? null : instruction },
                  { onSuccess: () => setEdit(null) },
                )
              }
            >
              Save instructions
            </ControlButton>
          </div>
        )}
      </Field>

      <Field label="Default model" hint="Default model selected in the composer.">
        {() => (
          <Select
            label="Default model"
            value={defaultModel}
            options={
              modelOptions.length > 0
                ? modelOptions
                : [{ value: defaultModel, label: defaultModel }]
            }
            onChange={(value) => setLocal("defaultModel", value)}
          />
        )}
      </Field>
    </div>
  );
}

function tokenRow(label: string, value: number) {
  return { label, value: value.toLocaleString() };
}

/**
 * Usage (07 §3). `usage.summary` is one UTC day of totals against the
 * account's limits; it carries no per-model dimension, so this is a totals
 * table rather than the by-model breakdown `03-api-and-events.md` §2
 * describes.
 */
function UsageSection() {
  const usage = useUsage();
  const summary = usage.data;
  if (!summary) {
    return (
      <p className="text-fg-muted m-0 text-base">
        {usage.isLoading ? "Loading…" : "No usage recorded."}
      </p>
    );
  }
  const rows = [
    tokenRow("Input tokens", summary.inputTokens),
    tokenRow("Output tokens", summary.outputTokens),
    tokenRow("Reasoning tokens", summary.reasoningTokens),
    tokenRow("Cached tokens", summary.cachedTokens),
    tokenRow("Runs", summary.runs),
    { label: "Estimated cost", value: `$${(summary.costEstimateMicros / 1_000_000).toFixed(2)}` },
    {
      label: "Daily token limit",
      value: summary.dailyTokenLimit == null ? "none" : summary.dailyTokenLimit.toLocaleString(),
    },
    {
      label: "Daily run limit",
      value: summary.dailyRunLimit == null ? "none" : summary.dailyRunLimit.toLocaleString(),
    },
  ];
  return (
    <table className="w-full border-collapse text-base">
      <caption className="text-fg-muted pb-2 text-left text-sm">
        {new Date(summary.day).toISOString().slice(0, 10)}, UTC
      </caption>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="border-border-divider border-t">
            <th scope="row" className="text-fg-secondary py-1.5 text-left font-normal">
              {row.label}
            </th>
            <td className="py-1.5 text-right tabular-nums">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Settings (07 §3). Every appearance control writes the local store, which
 * `ThemeEffects` applies to `<html>` synchronously and `SessionBoot` pushes to
 * `settings.update` on a 300 ms debounce; the two fields that are not part of
 * `UserSettings` — the launch instruction and the default workspace — are
 * written directly, because they have no local mirror to debounce.
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
            { value: "research", label: "Research" },
            { value: "usage", label: "Usage" },
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

              <Field label="Theme" hint="Selects the accent color and background tone.">
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
                hint="Anthropic Sans Text and Inter are available only if installed locally."
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
                label="Reduce motion"
                description="Disable non-essential animations and transitions. Progress indicators remain active."
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
                description="Display timestamps on assistant responses."
                checked={settings.showAssistantTimestamps}
                onCheckedChange={(checked) => set("showAssistantTimestamps", checked)}
              />
              <Switch
                label="Notifications"
                description="Show popup notifications for background server events."
                checked={settings.showNotifications}
                onCheckedChange={(checked) => set("showNotifications", checked)}
              />
              <Switch
                label="Require ⌘↵ to send"
                description="When enabled, press ⌘↵ to send. When disabled, press Enter to send and Shift-Enter for a new line."
                checked={settings.requireCmdEnterToSend}
                onCheckedChange={(checked) => set("requireCmdEnterToSend", checked)}
              />
            </div>
          </TabPanel>

          <TabPanel value="research">
            <ResearchSection />
          </TabPanel>

          <TabPanel value="usage">
            <UsageSection />
          </TabPanel>
        </Tabs>
      </div>
    </div>
  );
}
