// Account-scoped wire types introduced by the web app: the signed-in user,
// workspaces (the desktop's research-scoped `GroupInfo`), user settings, the
// per-day usage summary, and the model registry
// entries as returned to the client (`04-agent-runtime.md` §1).

import { z } from "zod";

import { DEFAULT_MODEL_ID } from "../models/registry.js";

/** The two sign-in providers (plan `04` I1, Z2). An account is bound to the
 * one it was created with. */
export const signInProviderSchema = z.enum(["github", "x"]);

export type SignInProvider = z.infer<typeof signInProviderSchema>;

/** `waiting`: signed in without an invite; reads like a signed-out reader and
 * cannot write. `active`: redeemed an invite and chose a handle (`01` C8). */
export const accountStatusSchema = z.enum(["waiting", "active"]);

export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const userSchema = z.object({
  id: z.string(),
  /** The provider's username. Shown nowhere and unique nowhere (04 I1). */
  login: z.string(),
  /** The name the provider reports. */
  name: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  /** Set by `npm run db:admin -- <handle>`; site admins seed the invite tree. */
  isAdmin: z.boolean(),
  createdAt: z.number(),
  /** The Session handle, unique and never reused; null while waiting. */
  handle: z.string().nullable(),
  /** The name chosen at the profile step; null while waiting. */
  displayName: z.string().nullable(),
  status: accountStatusSchema,
  /** Null only for a deleted account, which no session can belong to. */
  provider: signInProviderSchema.nullable(),
});

export type User = z.infer<typeof userSchema>;

/** Who made an account invite, as the "Join with invite?" step shows it. A
 * root invite (`db:admin -- --invite`) has no creator: `handle` is null. */
export const inviterSchema = z.object({
  name: z.string(),
  handle: z.string().nullable(),
});

export type Inviter = z.infer<typeof inviterSchema>;

/** `auth.me`: the account, and the invite it will redeem at the profile step
 * while that invite is still open. */
export const meSchema = userSchema.extend({
  pendingInvite: inviterSchema.nullable(),
});

export type Me = z.infer<typeof meSchema>;

/** `auth.checkInvite` and `accountInvites.redeem`: an open invite with its
 * creator, or one answer for a used, revoked, unknown or malformed code
 * (04 I4, §13). */
export type InviteCheck = { status: "open"; inviter: Inviter } | { status: "unusable" };

/** The one message for a code that does not work (04 I4, 02 W7.2). */
export const UNUSABLE_INVITE_MESSAGE =
  "This invite code doesn't work. Ask the person who invited you for a new one.";

/** How a member is named: the profile name, else the provider's, else the
 * handle. */
export function memberName(user: Pick<User, "displayName" | "handle" | "name" | "login">): string {
  return user.displayName ?? user.name ?? user.handle ?? user.login;
}

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
  /** The Warm theme, whose light and dark values are the members mockup's
   * palette (`docs/mockups/session-web-members.html`, 02 §11). */
  colorTheme: "orange-blob",
  /** Follows the system's light or dark preference, as the mockup does. */
  appearance: "system",
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

/** `openai` serves only key-only models, called with the member's own
 * OpenAI key (`03` K11); the deployment has no OpenAI credential. */
export const modelProviderSchema = z.enum(["vertex", "openrouter", "anthropic", "openai"]);

export type ModelProvider = z.infer<typeof modelProviderSchema>;

/** Replaces the desktop's `AgentAdapterMetadata`. `available` is false when
 * the deployment has no credential for the model's provider. */
export const modelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: modelProviderSchema,
  available: z.boolean(),
  supportsFiles: z.boolean(),
  supportsImages: z.boolean(),
});

export type ModelInfo = z.infer<typeof modelInfoSchema>;
