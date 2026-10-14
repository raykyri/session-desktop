// Account-scoped wire types introduced by the web app: the signed-in user,
// workspaces (the desktop's research-scoped `GroupInfo`), user settings, the
// per-day usage summary, and the model registry
// entries as the client sees them (`04-agent-runtime.md` §1).

import { z } from "zod";

import { DEFAULT_MODEL_ID } from "../models/registry.js";

export const userSchema = z.object({
  id: z.string(),
  login: z.string(),
  name: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  /** Set manually in the database; gates admin-only models and the user list. */
  isAdmin: z.boolean(),
  createdAt: z.number(),
});

export type User = z.infer<typeof userSchema>;

/** Replaces the desktop's `GroupInfo` with `scope: "research"`. */
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Sidebar order within the user's workspaces. */
  position: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const colorThemeSchema = z.enum(["green-blob", "orange-blob"]);

export type ColorTheme = z.infer<typeof colorThemeSchema>;

export const appearanceSchema = z.enum(["dark", "light", "system"]);

export type Appearance = z.infer<typeof appearanceSchema>;

/** Text size. Each step is one pixel on every `--fs-*` size, from two below
 * the default to four above. */
export const APP_TEXT_SIZE = 14;
export const APP_TEXT_SIZE_MIN = 12;
export const APP_TEXT_SIZE_MAX = 18;

export const userSettingsSchema = z.object({
  /** Color theme for application chrome and active states. */
  colorTheme: colorThemeSchema,
  /** Dark or light surfaces; independent of the color theme's accent. */
  appearance: appearanceSchema,
  /** Id into the client's body font options. */
  bodyFontId: z.string(),
  textSize: z.number().int().min(APP_TEXT_SIZE_MIN).max(APP_TEXT_SIZE_MAX),
  // The desktop's four reading and input settings. Each falls back to its
  // default (`.catch`) so a row stored before the field existed still
  // parses; `.catch` rather than `.default` because a partial update must
  // leave an absent field alone instead of resetting it.
  /** Ask boxes other than a thread's send with ⌘↵ (Ctrl+↵ outside macOS)
   * rather than ↵; a thread's ask boxes always do. */
  requireCmdEnterToSend: z.boolean().catch(true),
  /** Answers render `session-html` blocks as widgets; off, as code. */
  researchInlineWidgets: z.boolean().catch(true),
  /** The shortcut hints shown while ⌘ (Ctrl outside macOS) is held. */
  showShortcutHints: z.boolean().catch(true),
  /** Transitions and animations settle at once, as with the system's reduced
   * motion preference. */
  reduceMotion: z.boolean().catch(false),
  /** Overlay toasts for server-originated notifications. */
  showNotifications: z.boolean(),
  /** Registry id the composer preselects. */
  defaultModel: z.string(),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

/**
 * The settings a brand-new account starts with.
 *
 * One definition rather than two: the server writes it into `user_preferences`
 * on first access, and the client's `persist` store renders it for the first
 * paint before the server's copy arrives (`06-auth-and-users.md` §6). Two
 * copies of this object would drift the moment a field is added.
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  colorTheme: "green-blob",
  appearance: "dark",
  /** An id in the client's `BODY_FONT_OPTIONS`; the client cannot be imported
   * from here, so the value is repeated rather than referenced. */
  bodyFontId: "dm-sans",
  textSize: APP_TEXT_SIZE,
  requireCmdEnterToSend: true,
  researchInlineWidgets: true,
  showShortcutHints: true,
  reduceMotion: false,
  showNotifications: true,
  defaultModel: DEFAULT_MODEL_ID,
};

/** One UTC day of recorded usage for the signed-in account, against the
 * limits in `06-auth-and-users.md` §8. */
export const usageSummarySchema = z.object({
  /** Start of the UTC day the counts cover, in milliseconds. */
  day: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cachedTokens: z.number(),
  costEstimateMicros: z.number(),
  runs: z.number(),
  /** Null when the deployment has no limit configured. */
  dailyTokenLimit: z.number().nullish(),
  dailyRunLimit: z.number().nullish(),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

export const modelProviderSchema = z.enum(["vertex", "openrouter", "anthropic"]);

export type ModelProvider = z.infer<typeof modelProviderSchema>;

/** Replaces the desktop's `AgentAdapterMetadata`. `available` is false when
 * the deployment has no credential for the model's provider. */
export const modelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: modelProviderSchema,
  adminOnly: z.boolean(),
  available: z.boolean(),
  supportsFiles: z.boolean(),
  supportsImages: z.boolean(),
});

export type ModelInfo = z.infer<typeof modelInfoSchema>;
