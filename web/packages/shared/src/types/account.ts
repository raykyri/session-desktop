// Account-scoped wire types introduced by the web app: the signed-in user,
// workspaces (the desktop's research-scoped `GroupInfo`), user settings,
// attached documents, the per-day usage summary, and the model registry
// entries as the client sees them (`04-agent-runtime.md` §1).

import { z } from "zod";

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

export const appearanceSchema = z.enum(["dark", "light"]);

export type Appearance = z.infer<typeof appearanceSchema>;

/** Session text zoom; the desktop's `APP_TEXT_SIZE` bounds are kept. */
export const APP_TEXT_SIZE = 14;
export const APP_TEXT_SIZE_MIN = 8;
export const APP_TEXT_SIZE_MAX = 32;

export const userSettingsSchema = z.object({
  /** Color theme for application chrome and active states. */
  colorTheme: colorThemeSchema,
  /** Dark or light surfaces; independent of the color theme's accent. */
  appearance: appearanceSchema,
  /** Id into the client's body font options. */
  bodyFontId: z.string(),
  textSize: z.number().int().min(APP_TEXT_SIZE_MIN).max(APP_TEXT_SIZE_MAX),
  /** Show Cmd-held shortcut badges in the sidebar. */
  showShortcutHints: z.boolean(),
  /** Disable decorative and status pulse animations. */
  reduceMotion: z.boolean(),
  /** Show tool calls and other activity detail in research answers. */
  showToolCalls: z.boolean(),
  /** Show a wall-clock timestamp after each run of assistant messages. */
  showAssistantTimestamps: z.boolean(),
  /** Overlay toasts for server-originated notifications. */
  showNotifications: z.boolean(),
  /** Require Command-Enter instead of bare Enter for composer submit. */
  requireCmdEnterToSend: z.boolean(),
  /** Registry id the composer preselects. */
  defaultModel: z.string(),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const documentExtractionStatusSchema = z.enum(["pending", "ok", "failed"]);

export type DocumentExtractionStatus = z.infer<typeof documentExtractionStatusSchema>;

export const documentInfoSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  mime: z.string(),
  byteSize: z.number(),
  sha256: z.string(),
  pageCount: z.number().nullish(),
  extractionStatus: documentExtractionStatusSchema,
  createdAt: z.number(),
});

export type DocumentInfo = z.infer<typeof documentInfoSchema>;

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
