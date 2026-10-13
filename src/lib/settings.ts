import { APP_TEXT_SIZE, APP_TEXT_SIZE_MIN, APP_TEXT_SIZE_MAX } from "./appearance";

export interface BodyFontOption {
  id: string;
  label: string;
  /** Full CSS font-family stack applied to the app UI. */
  stack: string;
  /** Full/PostScript local face names used to verify an optional installed font. */
  localNames?: readonly string[];
}

const SYSTEM_BODY_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const BODY_FONT_OPTIONS: BodyFontOption[] = [
  {
    id: "inter",
    label: "Inter",
    // Latin and Latin Extended variable faces are bundled with Session under the SIL OFL 1.1.
    stack: `"Inter", ${SYSTEM_BODY_FONT_STACK}`,
  },
  {
    id: "dm-sans",
    label: "DM Sans",
    // Latin and Latin Extended variable faces are bundled with Session under the SIL OFL 1.1.
    stack: `"DM Sans", ${SYSTEM_BODY_FONT_STACK}`,
  },
  {
    id: "anthropic-sans-text",
    label: "Anthropic Sans Text",
    // Personal-use font referenced from the host system; do not bundle its files.
    stack: `"Anthropic Sans Text", ${SYSTEM_BODY_FONT_STACK}`,
    localNames: ["Anthropic Sans Text Regular", "AnthropicSansText-Regular"],
  },
  {
    id: "system",
    label: "System",
    stack: SYSTEM_BODY_FONT_STACK,
  },
];

export const DEFAULT_BODY_FONT_ID = BODY_FONT_OPTIONS[0].id;
export const SYSTEM_BODY_FONT_ID = "system";

function localFontSource(localName: string): string {
  const escapedName = localName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `local("${escapedName}")`;
}

async function localFontIsAvailable(localName: string): Promise<boolean> {
  try {
    const probe = new FontFace("__session_local_font_probe__", localFontSource(localName));
    await probe.load();
    return true;
  } catch {
    return false;
  }
}

/** Returns bundled/generic fonts plus locally installed optional faces, in menu order. */
export async function detectAvailableBodyFonts(): Promise<BodyFontOption[]> {
  if (typeof FontFace === "undefined") {
    return BODY_FONT_OPTIONS.filter((option) => option.localNames === undefined);
  }

  const availability = await Promise.all(
    BODY_FONT_OPTIONS.map(async (option) => {
      if (option.localNames === undefined) {
        return true;
      }
      const matches = await Promise.all(option.localNames.map(localFontIsAvailable));
      return matches.some(Boolean);
    }),
  );

  return BODY_FONT_OPTIONS.filter((_option, index) => availability[index]);
}

type ColorTheme = "green-blob" | "orange-blob";
type Appearance = "dark" | "light";

export const COLOR_THEME_OPTIONS: { id: ColorTheme; label: string }[] = [
  { id: "green-blob", label: "Cool" },
  { id: "orange-blob", label: "Warm" },
];

export const APPEARANCE_OPTIONS: { id: Appearance; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

/**
 * Byte cap on the research launch instruction, mirroring
 * MAX_RESEARCH_LAUNCH_INSTRUCTION_BYTES on the backend (which refuses larger
 * values), so the dialog can never hold a value the backend won't persist.
 */
export const RESEARCH_LAUNCH_INSTRUCTION_MAX_BYTES = 4 * 1024;

/**
 * Suggested research launch instruction. Used as the settings textarea
 * placeholder; the stored default remains empty (launches send prompts
 * unchanged until the user sets something).
 */
export const DEFAULT_RESEARCH_LAUNCH_INSTRUCTION =
  "Answer concisely, in a few short paragraphs.";

/**
 * Trims a research launch instruction to the backend's byte cap at a code-point
 * boundary. The cap counts UTF-8 bytes — the unit the backend validates — not
 * UTF-16 length, so a multi-byte instruction cannot pass here yet be refused
 * on save.
 */
export function clampResearchLaunchInstruction(value: string): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes + size > RESEARCH_LAUNCH_INSTRUCTION_MAX_BYTES) {
      break;
    }
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

export interface AppSettings {
  /** color theme for application chrome and active states */
  colorTheme: ColorTheme;
  /** dark or light surfaces; independent of the color theme's accent */
  appearance: Appearance;
  /** id into BODY_FONT_OPTIONS */
  bodyFontId: string;
  /** App text zoom; legacy fontSize values are read on first load. */
  textSize: number;
  /** show Cmd-held shortcut badges in the sidebar */
  showShortcutHints: boolean;
  /** disable decorative/status pulse animations */
  reduceMotion: boolean;
  /** keep the machine awake while any agent is running */
  preventSleep: boolean;
  /**
   * Custom instruction text sent with every research launch (fresh runs and
   * all follow-up kinds). Empty means launches send prompts unchanged. The
   * backend persists its own copy (read on every research launch path); this
   * mirror keeps the dialog in sync.
   */
  researchLaunchInstruction: string;
  /**
   * Render `session-html` blocks in research answers as sandboxed widgets and
   * tell research agents about them. On by default. The backend persists its
   * own copy (read on every research launch path); this mirror keeps the
   * dialog in sync.
   */
  researchInlineWidgets: boolean;
  /** Overlay toasts for `session send` notifications. */
  showNotifications: boolean;
  /** require Command+Enter instead of bare Enter for composer submit shortcuts */
  requireCmdEnterToSend: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  colorTheme: "orange-blob",
  appearance: "dark",
  bodyFontId: DEFAULT_BODY_FONT_ID,
  textSize: APP_TEXT_SIZE,
  showShortcutHints: true,
  reduceMotion: false,
  preventSleep: true,
  researchLaunchInstruction: "",
  researchInlineWidgets: true,
  showNotifications: true,
  requireCmdEnterToSend: true,
};

/** Resolves a stored body font id to its CSS stack, falling back to the default. */
export function bodyFontStackFor(bodyFontId: string): string {
  return (
    BODY_FONT_OPTIONS.find((option) => option.id === bodyFontId) ?? BODY_FONT_OPTIONS[0]
  ).stack;
}

function clampTextSize(size: number): number {
  if (!Number.isFinite(size)) {
    return APP_TEXT_SIZE;
  }
  return Math.min(APP_TEXT_SIZE_MAX, Math.max(APP_TEXT_SIZE_MIN, Math.round(size)));
}

// Bumped if the stored shape ever changes incompatibly; an unknown blob simply
// falls back to defaults.
const STORAGE_KEY = "session.settings.v1";

/**
 * Reads the persisted application settings from localStorage. Any missing,
 * corrupt, or out-of-range field is replaced with its default, so a bad blob
 * never breaks startup — it just yields the defaults for the offending field.
 */
export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Omit<Partial<AppSettings>, "colorTheme" | "appearance"> & {
      colorTheme?: unknown;
      appearance?: unknown;
      fontSize?: unknown;
      /** Removed setting; a stored value still seeds requireCmdEnterToSend. */
      codeMode?: unknown;
    };
    const storedColorTheme = typeof parsed.colorTheme === "string" ? parsed.colorTheme : null;
    const colorTheme =
      COLOR_THEME_OPTIONS.find((option) => option.id === storedColorTheme)?.id ??
      DEFAULT_SETTINGS.colorTheme;
    const appearance =
      APPEARANCE_OPTIONS.find((option) => option.id === parsed.appearance)?.id ??
      DEFAULT_SETTINGS.appearance;
    const bodyFontId =
      typeof parsed.bodyFontId === "string" &&
      BODY_FONT_OPTIONS.some((option) => option.id === parsed.bodyFontId)
        ? parsed.bodyFontId
        : DEFAULT_BODY_FONT_ID;
    const storedTextSize = parsed.textSize ?? parsed.fontSize;
    const textSize = typeof storedTextSize === "number" ? clampTextSize(storedTextSize) : APP_TEXT_SIZE;
    const preventSleep =
      typeof parsed.preventSleep === "boolean"
        ? parsed.preventSleep
        : DEFAULT_SETTINGS.preventSleep;
    const researchLaunchInstruction =
      typeof parsed.researchLaunchInstruction === "string"
        ? clampResearchLaunchInstruction(parsed.researchLaunchInstruction)
        : DEFAULT_SETTINGS.researchLaunchInstruction;
    const researchInlineWidgets =
      typeof parsed.researchInlineWidgets === "boolean"
        ? parsed.researchInlineWidgets
        : DEFAULT_SETTINGS.researchInlineWidgets;
    const showShortcutHints =
      typeof parsed.showShortcutHints === "boolean"
        ? parsed.showShortcutHints
        : DEFAULT_SETTINGS.showShortcutHints;
    const reduceMotion =
      typeof parsed.reduceMotion === "boolean"
        ? parsed.reduceMotion
        : DEFAULT_SETTINGS.reduceMotion;
    const showNotifications =
      typeof parsed.showNotifications === "boolean"
        ? parsed.showNotifications
        : DEFAULT_SETTINGS.showNotifications;
    // Blobs saved before this setting existed take it from the removed
    // codeMode flag, which it replaced.
    const requireCmdEnterToSend =
      typeof parsed.requireCmdEnterToSend === "boolean"
        ? parsed.requireCmdEnterToSend
        : typeof parsed.codeMode === "boolean"
          ? parsed.codeMode
          : DEFAULT_SETTINGS.requireCmdEnterToSend;
    return {
      colorTheme,
      appearance,
      bodyFontId,
      textSize,
      showShortcutHints,
      reduceMotion,
      preventSleep,
      researchLaunchInstruction,
      researchInlineWidgets,
      showNotifications,
      requireCmdEnterToSend,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persists the application settings. If storage is disabled or full, the
 * settings remain active for the current session but are not saved.
 */
export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable; preferences remain in-memory for this session only.
  }
}
