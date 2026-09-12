import { CompletionSoundSetting } from "../src/components/settings/CompletionSoundSetting";
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_SOUND_OPTIONS,
  DEFAULT_COMPLETION_SOUND,
} from "../src/lib/completionSounds";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/lib/settings";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
};

test("the shared completion sound catalog is curated and Default is the default", () => {
  assert.equal(DEFAULT_COMPLETION_SOUND, "default");
  assert.deepEqual(
    COMPLETION_SOUND_OPTIONS.map((option) => [
      option.id,
      option.label,
      option.bundledName ?? null,
      option.systemName,
      option.systemPath ?? null,
    ]),
    [
      ["none", "None", null, null, null],
      ["default", "Default", "success", null, null],
      ["confirmation", "Confirmation", "confirmation", null, null],
      ["chime", "Chime", "chime", null, null],
      [
        "messages",
        "Messages",
        null,
        null,
        "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/SentMessage.caf",
      ],
      [
        "apple-pay",
        "Apple Pay",
        null,
        null,
        "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/payment_success.aif",
      ],
      ["nokia", "Nokia", "nokia", null, null],
      ["metal-gear", "Metal Gear", "metal-gear", null, null],
      ["minecraft", "Minecraft", "minecraft", null, null],
      ["door", "Door", "door", null, null],
      ["light", "Light", "light", null, null],
      ["water", "Water", "water", null, null],
      ["warp", "Warp", "warp", null, null],
      ["switch", "Switch", "switch", null, null],
      ["digital", "Digital", "digital", null, null],
      ["power-up", "Power Up", "power-up", null, null],
      ["event", "Event", "event", null, null],
      ["drum", "Drum", "drum", null, null],
      ["quest", "Quest", "quest", null, null],
      ["impact", "Impact", "impact", null, null],
      ["pots", "Pots", "pots", null, null],
      ["bell", "Bell", "bell", null, null],
    ],
  );
});

test("completion sound settings round-trip and reject unknown ids", () => {
  store.clear();
  assert.equal(loadSettings().completionSound, "default");

  saveSettings({ ...DEFAULT_SETTINGS, completionSound: "digital" });
  assert.equal(loadSettings().completionSound, "digital");

  saveSettings({ ...DEFAULT_SETTINGS, completionSound: "none" });
  assert.equal(loadSettings().completionSound, "none");

  saveSettings({
    ...DEFAULT_SETTINGS,
    completionSound: "arbitrary-path" as unknown as typeof DEFAULT_SETTINGS.completionSound,
  });
  assert.equal(loadSettings().completionSound, "default");
});

test("changing the completion sound saves the selection before previewing it", () => {
  const actions: string[] = [];
  const setting = CompletionSoundSetting({
    value: "default",
    onChange: (sound) => actions.push(`save:${sound}`),
    onPreview: (sound) => actions.push(`preview:${sound}`),
  });
  const [select] = setting.props.children[1].props.children;
  assert.equal(select.props.value, "default");
  select.props.onChange({ currentTarget: { value: "digital" } });
  assert.deepEqual(actions, ["save:digital", "preview:digital"]);
});

test("the Test button previews the current sound without changing the setting", () => {
  const actions: string[] = [];
  const setting = CompletionSoundSetting({
    value: "bell",
    onChange: (sound) => actions.push(`save:${sound}`),
    onPreview: (sound) => actions.push(`preview:${sound}`),
  });
  const [, button] = setting.props.children[1].props.children;
  button.props.onClick();
  assert.deepEqual(actions, ["preview:bell"]);
});
