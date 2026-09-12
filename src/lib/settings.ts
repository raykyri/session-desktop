import { APP_TEXT_SIZE, APP_TEXT_SIZE_MIN, APP_TEXT_SIZE_MAX } from "./appearance";
import {
  DEFAULT_CONFIRM_PASTE_OVER_CHARS,
  type PasteProtectionSettings,
} from "./paste";
import {
  DEFAULT_COMPLETION_SOUND,
  isCompletionSoundId,
  type CompletionSoundId,
} from "./completionSounds";

export interface BodyFontOption {
  id: string;
  label: string;
  /** Full CSS font-family stack applied to non-terminal app UI. */
  stack: string;
  /** Full/PostScript local face names used to verify an optional installed font. */
  localNames?: readonly string[];
}

const SYSTEM_BODY_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const BODY_FONT_OPTIONS: BodyFontOption[] = [
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
    id: "valley-sans",
    label: "Valley Sans",
    // Roman and italic variable faces are bundled with Session under the SIL OFL 1.1.
    stack: `"Valley Sans", ${SYSTEM_BODY_FONT_STACK}`,
  },
  {
    id: "inter",
    label: "Inter",
    stack: `"Inter", ${SYSTEM_BODY_FONT_STACK}`,
    localNames: ["Inter Regular", "Inter-Regular"],
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

export type ColorTheme = "green-blob" | "orange-blob";
export type TabTitleProvider = "openRouter" | "disabled";
export type WorktreeLocation = "global" | "localQmux" | "localClaude";

export const COLOR_THEME_OPTIONS: { id: ColorTheme; label: string }[] = [
  { id: "green-blob", label: "Cool" },
  { id: "orange-blob", label: "Warm" },
];

export const TAB_TITLE_PROVIDER_OPTIONS: { id: TabTitleProvider; label: string }[] = [
  { id: "openRouter", label: "OpenRouter" },
  { id: "disabled", label: "Disable" },
];

export const WORKTREE_LOCATION_OPTIONS: { id: WorktreeLocation; label: string }[] = [
  { id: "global", label: "Global (default)" },
  { id: "localQmux", label: "Local .qmux/" },
  { id: "localClaude", label: "Local .claude/" },
];

export const CONFIRM_PASTE_OVER_CHARS_MIN = 1;
export const CONFIRM_PASTE_OVER_CHARS_MAX = 5_000_000;
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
  /** id into BODY_FONT_OPTIONS */
  bodyFontId: string;
  /** App text zoom; legacy fontSize values are read on first load. */
  textSize: number;
  /** confirm pasted text containing more than one line */
  confirmMultiLinePaste: boolean;
  /** confirm pasted text above this many characters */
  confirmPasteOverChars: number;
  /** show Cmd-held shortcut badges in the sidebar */
  showShortcutHints: boolean;
  /** show qmux's native menu bar icon */
  showMenuBarIcon: boolean;
  /** disable decorative/status pulse animations */
  reduceMotion: boolean;
  /** provider used to summarize first user messages into tab titles */
  tabTitleProvider: TabTitleProvider;
  /**
   * OpenRouter API key. Held in memory for the session but NOT persisted to
   * localStorage (saveSettings strips it) — the durable copy lives in the
   * backend's owner-only preferences file, loaded/saved via the openrouter_key_*
   * commands. A key found in a pre-existing localStorage blob is still read here
   * once so it can be migrated to the backend.
   */
  openRouterKey: string;
  /** OpenRouter model id */
  openRouterModel: string;
  /** keep the machine awake while any agent is running */
  preventSleep: boolean;
  /**
   * Run shells as login shells, sourcing the user's login profile files
   * (~/.zprofile + ~/.zlogin, or ~/.bash_profile/~/.profile) in addition to the
   * interactive rc. On by default so spawned shells match how terminal emulators
   * launch them. The backend persists its own copy (read on the spawn path,
   * including startup recovery); this mirror keeps the dialog in sync.
   */
  useLoginShell: boolean;
  /** root used for newly-created isolated worktrees */
  worktreeLocation: WorktreeLocation;
  /**
   * Custom instruction text sent with every research launch (fresh runs and
   * all follow-up kinds). Empty means launches send prompts unchanged. The
   * backend persists its own copy (read on every research launch path); this
   * mirror keeps the dialog in sync.
   */
  researchLaunchInstruction: string;
  /** Use the headless Claude research harness instead of a hidden TUI pane. */
  researchSdkHarness: boolean;
  /**
   * Show code-oriented context in tabs and the launcher: per-tab paths, git
   * worktree metadata, and the "New worktree" launcher option. When off, tabs
   * collapse to a single aligned row (status dot · title · status).
   */
  codeMode: boolean;
  /** show per-tab working directories when code mode is enabled */
  showTabDirectories: boolean;
  /** show tool calls and other activity detail in agent transcripts */
  showToolCalls: boolean;
  /** show the draggable per-agent input delivery diagnostics panel */
  showDebugPanel: boolean;
  /** sound played when a live chat agent finishes its queued work */
  completionSound: CompletionSoundId;
  /** pin the latest user message to the top of the transcript while its reply scrolls */
  stickyUserMessages: boolean;
  /**
   * Show a wall-clock timestamp after each consecutive run of assistant
   * messages (before the next user/system message, or at the transcript tail).
   */
  showAssistantTimestamps: boolean;
  /** Overlay toasts for `session send` notifications. The Journal still records them. */
  showNotifications: boolean;
  /** require Command+Enter instead of bare Enter for composer submit shortcuts */
  requireCmdEnterToSend: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  colorTheme: "green-blob",
  bodyFontId: DEFAULT_BODY_FONT_ID,
  textSize: APP_TEXT_SIZE,
  confirmMultiLinePaste: false,
  confirmPasteOverChars: DEFAULT_CONFIRM_PASTE_OVER_CHARS,
  showShortcutHints: true,
  showMenuBarIcon: false,
  reduceMotion: false,
  tabTitleProvider: "disabled",
  openRouterKey: "",
  openRouterModel: "",
  preventSleep: true,
  useLoginShell: true,
  worktreeLocation: "global",
  researchLaunchInstruction: "",
  researchSdkHarness: true,
  codeMode: true,
  showTabDirectories: true,
  showToolCalls: true,
  showDebugPanel: false,
  completionSound: DEFAULT_COMPLETION_SOUND,
  stickyUserMessages: true,
  showAssistantTimestamps: false,
  showNotifications: true,
  requireCmdEnterToSend: true,
};

/** Resolves a stored body font id to its CSS stack, falling back to the default. */
export function bodyFontStackFor(bodyFontId: string): string {
  return (
    BODY_FONT_OPTIONS.find((option) => option.id === bodyFontId) ?? BODY_FONT_OPTIONS[0]
  ).stack;
}

export function clampTextSize(size: number): number {
  if (!Number.isFinite(size)) {
    return APP_TEXT_SIZE;
  }
  return Math.min(APP_TEXT_SIZE_MAX, Math.max(APP_TEXT_SIZE_MIN, Math.round(size)));
}

export function clampConfirmPasteOverChars(chars: number): number {
  if (!Number.isFinite(chars)) {
    return DEFAULT_CONFIRM_PASTE_OVER_CHARS;
  }
  return Math.min(
    CONFIRM_PASTE_OVER_CHARS_MAX,
    Math.max(CONFIRM_PASTE_OVER_CHARS_MIN, Math.round(chars)),
  );
}


export function pasteProtectionFor(settings: AppSettings): PasteProtectionSettings {
  return {
    confirmMultiLinePaste: settings.confirmMultiLinePaste,
    confirmPasteOverChars: settings.confirmPasteOverChars,
  };
}

// Bumped if the stored shape ever changes incompatibly; an unknown blob simply
// falls back to defaults.
const STORAGE_KEY = "qmux.settings.v1";

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
    const parsed = JSON.parse(raw) as Omit<Partial<AppSettings>, "colorTheme"> & {
      colorTheme?: unknown;
      fontSize?: unknown;
      openRouterTitlesEnabled?: boolean;
    };
    const storedColorTheme = typeof parsed.colorTheme === "string" ? parsed.colorTheme : null;
    const colorTheme =
      COLOR_THEME_OPTIONS.find((option) => option.id === storedColorTheme)?.id ??
      DEFAULT_SETTINGS.colorTheme;
    const bodyFontId =
      typeof parsed.bodyFontId === "string" &&
      BODY_FONT_OPTIONS.some((option) => option.id === parsed.bodyFontId)
        ? parsed.bodyFontId
        : DEFAULT_BODY_FONT_ID;
    const storedTextSize = parsed.textSize ?? parsed.fontSize;
    const textSize = typeof storedTextSize === "number" ? clampTextSize(storedTextSize) : APP_TEXT_SIZE;
    const confirmMultiLinePaste =
      typeof parsed.confirmMultiLinePaste === "boolean"
        ? parsed.confirmMultiLinePaste
        : DEFAULT_SETTINGS.confirmMultiLinePaste;
    const confirmPasteOverChars =
      typeof parsed.confirmPasteOverChars === "number"
        ? clampConfirmPasteOverChars(parsed.confirmPasteOverChars)
        : DEFAULT_SETTINGS.confirmPasteOverChars;
    const preventSleep =
      typeof parsed.preventSleep === "boolean"
        ? parsed.preventSleep
        : DEFAULT_SETTINGS.preventSleep;
    const useLoginShell =
      typeof parsed.useLoginShell === "boolean"
        ? parsed.useLoginShell
        : DEFAULT_SETTINGS.useLoginShell;
    const worktreeLocation =
      typeof parsed.worktreeLocation === "string" &&
      WORKTREE_LOCATION_OPTIONS.some((option) => option.id === parsed.worktreeLocation)
        ? parsed.worktreeLocation
        : DEFAULT_SETTINGS.worktreeLocation;
    const researchLaunchInstruction =
      typeof parsed.researchLaunchInstruction === "string"
        ? clampResearchLaunchInstruction(parsed.researchLaunchInstruction)
        : DEFAULT_SETTINGS.researchLaunchInstruction;
    const researchSdkHarness =
      typeof parsed.researchSdkHarness === "boolean"
        ? parsed.researchSdkHarness
        : DEFAULT_SETTINGS.researchSdkHarness;
    const showShortcutHints =
      typeof parsed.showShortcutHints === "boolean"
        ? parsed.showShortcutHints
        : DEFAULT_SETTINGS.showShortcutHints;
    const showMenuBarIcon =
      typeof parsed.showMenuBarIcon === "boolean"
        ? parsed.showMenuBarIcon
        : DEFAULT_SETTINGS.showMenuBarIcon;
    const reduceMotion =
      typeof parsed.reduceMotion === "boolean"
        ? parsed.reduceMotion
        : DEFAULT_SETTINGS.reduceMotion;
    // A retired provider must not revive a stale OpenRouter opt-in. Only use the
    // legacy flag when no provider selection has ever been saved.
    const tabTitleProvider =
      typeof parsed.tabTitleProvider === "string" &&
      TAB_TITLE_PROVIDER_OPTIONS.some((option) => option.id === parsed.tabTitleProvider)
        ? parsed.tabTitleProvider
        : parsed.tabTitleProvider == null && parsed.openRouterTitlesEnabled === true
          ? "openRouter"
          : DEFAULT_SETTINGS.tabTitleProvider;
    const codeMode =
      typeof parsed.codeMode === "boolean" ? parsed.codeMode : DEFAULT_SETTINGS.codeMode;
    const showTabDirectories =
      typeof parsed.showTabDirectories === "boolean" ? parsed.showTabDirectories : codeMode;
    const showToolCalls =
      typeof parsed.showToolCalls === "boolean" ? parsed.showToolCalls : codeMode;
    const showDebugPanel =
      typeof parsed.showDebugPanel === "boolean"
        ? parsed.showDebugPanel
        : DEFAULT_SETTINGS.showDebugPanel;
    const completionSound = isCompletionSoundId(parsed.completionSound)
      ? parsed.completionSound
      : DEFAULT_SETTINGS.completionSound;
    const stickyUserMessages =
      typeof parsed.stickyUserMessages === "boolean"
        ? parsed.stickyUserMessages
        : codeMode;
    const showAssistantTimestamps =
      typeof parsed.showAssistantTimestamps === "boolean"
        ? parsed.showAssistantTimestamps
        : DEFAULT_SETTINGS.showAssistantTimestamps;
    const showNotifications =
      typeof parsed.showNotifications === "boolean"
        ? parsed.showNotifications
        : DEFAULT_SETTINGS.showNotifications;
    const requireCmdEnterToSend =
      typeof parsed.requireCmdEnterToSend === "boolean"
        ? parsed.requireCmdEnterToSend
        : codeMode;
    const openRouterKey =
      typeof parsed.openRouterKey === "string"
        ? parsed.openRouterKey
        : DEFAULT_SETTINGS.openRouterKey;
    const openRouterModel =
      typeof parsed.openRouterModel === "string"
        ? parsed.openRouterModel
        : DEFAULT_SETTINGS.openRouterModel;
    return {
      colorTheme,
      bodyFontId,
      textSize,
      confirmMultiLinePaste,
      confirmPasteOverChars,
      showShortcutHints,
      showMenuBarIcon,
      reduceMotion,
      tabTitleProvider,
      openRouterKey,
      openRouterModel,
      preventSleep,
      useLoginShell,
      worktreeLocation,
      researchLaunchInstruction,
      researchSdkHarness,
      codeMode,
      showTabDirectories,
      showToolCalls,
      showDebugPanel,
      completionSound,
      stickyUserMessages,
      showAssistantTimestamps,
      showNotifications,
      requireCmdEnterToSend,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persists the application settings. Failures (e.g. storage disabled or over
 * quota) are swallowed: the settings stay live for the session, just not saved.
 */
export function saveSettings(settings: AppSettings): void {
  try {
    // Never persist the OpenRouter key to localStorage: it lives in the backend's
    // owner-only preferences file instead, so an injected script can't read the secret
    // out of webview storage at rest.
    const { openRouterKey: _omitted, ...persistable } = settings;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
  } catch {
    // Storage unavailable; preferences remain in-memory for this session only.
  }
}
