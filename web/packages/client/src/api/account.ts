// The web shell's account state over plain routes (phase 2b; ADR-19 as
// amended): who is signed in (`/api/me`), the appearance settings
// (`/api/me/preferences`), the runtime configuration (`/api/config`), the
// admin pages (`/api/admin/*`) and sign-out (`/auth/logout`). Spaces are the
// sync protocol's (`../sync/`).

import type { ModelInfo, UserSettings } from "@session/shared";

import { isDesktop, platform } from "../platform.js";
import { useSettingsStore } from "../stores/settings.js";

import { HttpError, getJson, postJson } from "./http.js";
import { createResource, useAction, useResource } from "./resource.js";

/** `/api/me`: the mock's fields (`u`, `name`, `bio`) and the account's. */
export interface Me {
  u: string;
  name: string;
  bio: string;
  x: string;
  createdAt: string;
  id: string;
  login: string;
  handle: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export type ServerSettings = UserSettings & { researchLaunchInstruction: string | null };

export interface SettingsUpdate {
  settings?: Partial<UserSettings>;
  researchLaunchInstruction?: string | null;
}

export interface RuntimeConfig {
  version: string;
  models: ModelInfo[];
  limits: {
    runsPerUser: number;
    runTimeoutSeconds: number;
    /** The deployment's weekly allowance of included tokens. */
    includedTokens: number;
  };
  features: { webSearch: boolean; searchVendor?: "parallel" | "tavily" };
}

/** A person's weekly allowance of included tokens: their own (null: none,
 * the default applies), the deployment's default, and what they used this
 * week (Monday 00:00 UTC). */
export interface Allowance {
  weeklyTokens: number | null;
  defaultTokens: number;
  used: number;
}

export interface AdminUser {
  id: string;
  login: string;
  handle: string;
  name?: string | null;
  avatarUrl?: string | null;
  isAdmin: boolean;
  createdAt: number;
  /** This UTC week's usage, every payer. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    costEstimateMicros: number;
    runs: number;
  };
  allowance: Allowance;
}

export function gitHubSignInUrl(returnTo?: string, signupCode?: string): string {
  const params = new URLSearchParams();
  if (returnTo) params.set("return_to", returnTo);
  if (signupCode) params.set("invite", signupCode);
  const query = params.toString();
  return `/auth/github${query === "" ? "" : `?${query}`}`;
}

export function startGitHubSignIn(returnTo?: string, signupCode?: string): void {
  window.location.assign(gitHubSignInUrl(returnTo, signupCode));
}

/** Who is signed in: null when nobody is (401). The platform keeps the
 * answer: the Desktop app starts from it when the server cannot be reached
 * (it shows its replica offline), and a 401 there means the device's token
 * was revoked or expired (`Platform.unauthorized`). */
export const meResource = createResource<Me | null>(async () => {
  try {
    const me = await getJson<Me>("/api/me");
    platform().rememberMe(me);
    return me;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      platform().rememberMe(null);
      platform().unauthorized();
      return null;
    }
    const last = platform().lastMe();
    if (last) return last as Me;
    throw e;
  }
});

export const preferencesResource = createResource(() =>
  getJson<ServerSettings>("/api/me/preferences"),
);

export const configResource = createResource(() => getJson<RuntimeConfig>("/api/config"));

export const adminUsersResource = createResource(() => getJson<AdminUser[]>("/api/admin/users"));

/** The signed-in account, loading it when needed (route guards). */
export function ensureMe(): Promise<Me | null> {
  return meResource.load().catch(() => null);
}

export function useMe() {
  return useResource(meResource);
}

export function useSignedIn(): boolean {
  return Boolean(useMe().data);
}

/** The appearance settings the server keeps. A device's token reads none of
 * the browser's account routes (ADR-19 as amended), so the Desktop app keeps
 * its settings on the device only. */
export function useSettings() {
  return useResource(preferencesResource, useSignedIn() && !isDesktop());
}

export function useRuntimeConfig() {
  return useResource(configResource);
}

export function useAdminUsers(enabled = true) {
  return useResource(adminUsersResource, enabled);
}

export async function updatePreferences(input: SettingsUpdate): Promise<ServerSettings> {
  const saved = await postJson<ServerSettings>("/api/me/preferences", input);
  preferencesResource.set(saved);
  return saved;
}

/** Sign out this browser (or the Desktop app: its platform forgets the
 * device's token and its replica); the account state is forgotten. */
export async function logout(): Promise<void> {
  if (isDesktop()) await platform().signOut();
  else await postJson("/auth/logout");
  meResource.set(null);
  preferencesResource.reset();
  adminUsersResource.reset();
  useSettingsStore.getState().reset();
}

export async function setUserLimits(input: {
  userId: string;
  weeklyTokens: number | null;
}): Promise<Allowance> {
  const limits = await postJson<Allowance>("/api/admin/limits", input);
  void adminUsersResource.load(true).catch(() => undefined);
  return limits;
}

export function createInvites(input: { count: number }): Promise<{ codes: string[] }> {
  return postJson<{ codes: string[] }>("/api/admin/invites", input);
}

export const useUpdateSettings = () => useAction(updatePreferences);
export const useLogout = () => useAction<void, void>(() => logout());
export const useSetUserLimits = () => useAction(setUserLimits);
export const useCreateInvites = () => useAction(createInvites);
