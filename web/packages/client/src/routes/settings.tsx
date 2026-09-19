import {
  RESEARCH_LAUNCH_INSTRUCTION_MAX_BYTES,
  appearanceSchema,
  clamp,
  clampResearchLaunchInstruction,
} from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";

import { setDefaultResearchWorkspace } from "../api/api.js";
import {
  queryKeys,
  useRuntimeConfig,
  useSettings,
  useSignedIn,
  useUpdateSettings,
  useUsage,
  useWorkspaces,
} from "../api/queries.js";
import { BODY_FONT_OPTIONS } from "../lib/bodyFonts.js";
import { errorMessage, pushErrorToast, pushToast } from "../lib/toast.js";
import { useSettingsStore } from "../stores/settings.js";
import { ControlButton } from "../ui/Button.js";
import { Field, Textarea } from "../ui/Field.js";
import { QueryState } from "../ui/QueryState.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { Checkbox } from "../ui/Toggle.js";

const APPEARANCE_OPTIONS: SelectOption[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** The desktop's theme names are internal; the labels describe what the user
 * sees, a cool or warm neutral palette. */
const COLOR_THEME_OPTIONS: SelectOption[] = [
  { value: "green-blob", label: "Cool" },
  { value: "orange-blob", label: "Warm" },
];

/** Five named sizes in pixels. The stored value keeps the wider schema range;
 * a size outside these steps (from an earlier build) shows the nearest one. */
const TEXT_SIZE_OPTIONS: SelectOption[] = [
  { value: "13", label: "Extra small", detail: "13 px" },
  { value: "14", label: "Small", detail: "14 px" },
  { value: "15", label: "Medium", detail: "15 px" },
  { value: "16", label: "Large", detail: "16 px" },
  { value: "17", label: "Extra large", detail: "17 px" },
];
const TEXT_SIZE_OPTION_MIN = 13;
const TEXT_SIZE_OPTION_MAX = 17;

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
/** Compact, content-sized pickers: a preference has a handful of values, and
 * a control stretched to the column reads as a form field awaiting input. */
const PICKER_CLASS = "w-fit min-w-44";

/** A titled group on the settings page. */
function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <h2 className="text-fg-heading border-border-faint m-0 border-b pb-2 text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

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
  const client = useQueryClient();
  const workspaces = useWorkspaces();
  const workspaceOptions: SelectOption[] = (workspaces.data ?? []).map((workspace) => ({
    value: workspace.id,
    label: workspace.name,
  }));

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Research instructions"
        error={update.error ? errorMessage(update.error) : undefined}
      >
        {({ id, describedBy }) => (
          <div className="flex flex-col items-start gap-2">
            <Textarea
              id={id}
              aria-describedby={describedBy ?? `${id}-hint`}
              rows={3}
              className="w-full"
              placeholder="For example: Prefer primary sources and cite them inline."
              value={instruction}
              onChange={(event) =>
                setEdit(clampResearchLaunchInstruction(event.currentTarget.value))
              }
            />
            <div className="flex items-center gap-3">
              <ControlButton
                disabled={!dirty || update.isPending}
                onClick={() =>
                  update.mutate(
                    { researchLaunchInstruction: instruction.trim() === "" ? null : instruction },
                    {
                      onSuccess: () => {
                        setEdit(null);
                        pushToast({ title: "Instructions saved", tone: "success" });
                      },
                    },
                  )
                }
              >
                {update.isPending ? "Saving…" : "Save instructions"}
              </ControlButton>
              <p id={`${id}-hint`} className="text-fg-muted m-0 text-base">
                Added to the beginning of every research question. Up to{" "}
                {RESEARCH_LAUNCH_INSTRUCTION_MAX_BYTES / 1024} KiB.
              </p>
            </div>
          </div>
        )}
      </Field>

      <Field label="Default workspace">
        {() => (
          <Select
            label="Default workspace"
            value={settings.data?.defaultWorkspaceId ?? ""}
            options={workspaceOptions}
            className={PICKER_CLASS}
            onChange={(value) => {
              void setDefaultResearchWorkspace(value)
                .then(() => client.invalidateQueries({ queryKey: queryKeys.settings() }))
                .catch((error: unknown) =>
                  pushErrorToast("Failed to set default workspace", error),
                );
            }}
          />
        )}
      </Field>

      <Field label="Default model">
        {() => (
          <Select
            label="Default model"
            value={defaultModel}
            options={
              modelOptions.length > 0
                ? modelOptions
                : [{ value: defaultModel, label: defaultModel }]
            }
            className={PICKER_CLASS}
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
      <QueryState
        className="py-0"
        loading={usage.isLoading}
        loadingLabel="Loading usage…"
        error={usage.isError ? "Couldn’t load usage." : undefined}
        onRetry={() => void usage.refetch()}
        empty="No usage recorded."
      />
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
      <caption className="text-fg-muted pb-2 text-left text-base">
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
  const signedIn = useSignedIn();
  const settings = useSettingsStore((state) => state.settings);
  const set = useSettingsStore((state) => state.set);
  const setTextSize = useSettingsStore((state) => state.setTextSize);

  return (
    <div className="h-full overflow-y-auto px-8 py-10">
      <div className="mx-auto flex w-[min(640px,100%)] flex-col gap-6">
        <h1 className="text-title text-fg-heading m-0 font-semibold">Settings</h1>

        <div className="flex flex-col gap-8">
          <SettingsGroup title="Appearance">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              <Field label="Appearance">
                {() => (
                  <Select
                    label="Appearance"
                    value={settings.appearance}
                    options={APPEARANCE_OPTIONS}
                    className="w-full"
                    onChange={(value) =>
                      set("appearance", appearanceSchema.catch("dark").parse(value))
                    }
                  />
                )}
              </Field>

              <Field label="Theme">
                {() => (
                  <Select
                    label="Theme"
                    value={settings.colorTheme}
                    options={COLOR_THEME_OPTIONS}
                    className="w-full"
                    onChange={(value) =>
                      set("colorTheme", value === "orange-blob" ? "orange-blob" : "green-blob")
                    }
                  />
                )}
              </Field>

              <Field label="Body font">
                {() => (
                  <Select
                    label="Body font"
                    value={settings.bodyFontId}
                    options={BODY_FONT_SELECT_OPTIONS}
                    className="w-full"
                    onChange={(value) => set("bodyFontId", value)}
                  />
                )}
              </Field>

              <Field label="Text size">
                {() => (
                  <Select
                    label="Text size"
                    value={String(
                      clamp(settings.textSize, TEXT_SIZE_OPTION_MIN, TEXT_SIZE_OPTION_MAX),
                    )}
                    options={TEXT_SIZE_OPTIONS}
                    className="w-full"
                    onChange={(value) => setTextSize(Number(value))}
                  />
                )}
              </Field>
            </div>
          </SettingsGroup>

          <SettingsGroup title="Reading">
            <Checkbox
              label="Show tool calls"
              description="Include searches, fetches and document reads in answers."
              checked={settings.showToolCalls}
              onCheckedChange={(checked) => set("showToolCalls", checked)}
            />
            <Checkbox
              label="Show timestamps"
              description="Display timestamps on assistant responses."
              checked={settings.showAssistantTimestamps}
              onCheckedChange={(checked) => set("showAssistantTimestamps", checked)}
            />
          </SettingsGroup>

          <SettingsGroup title="Notifications">
            <Checkbox
              label="Notifications"
              description="Show popup notifications for background server events."
              checked={settings.showNotifications}
              onCheckedChange={(checked) => set("showNotifications", checked)}
            />
          </SettingsGroup>

          {signedIn ? (
            <>
              <SettingsGroup title="Research defaults">
                <ResearchSection />
              </SettingsGroup>

              <SettingsGroup title="Usage">
                <UsageSection />
              </SettingsGroup>
            </>
          ) : (
            <p className="text-fg-muted m-0 text-base">
              Sign in to edit research defaults and see usage.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
