// The web shell's account state over plain routes (phase 2b; ADR-19 as
// amended): who is signed in (`/api/me`), the appearance settings
// (`/api/me/preferences`), the runtime configuration (`/api/config`), the
// admin pages (`/api/admin/*`) and sign-out (`/auth/logout`). Spaces are the
// sync protocol's (`../sync/`).

import type { ModelInfo, UserSettings } from "@session/shared";

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
    dailyTokens: number;
    dailyRuns: number;
    enforced: boolean;
  };
  features: { webSearch: boolean; searchVendor?: "parallel" | "tavily" };
}

export interface DailyLimits {
  dailyTokens: number | null;
  dailyRuns: number | null;
}

export interface AdminUser {
  id: string;
  login: string;
  handle: string;
  name?: string | null;
  avatarUrl?: string | null;
  isAdmin: boolean;
  createdAt: number;
  usage: {
    day: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    costEstimateMicros: number;
    runs: number;
  };
  limits: DailyLimits;
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

/** Who is signed in: null when nobody is (401). */
export const meResource = createResource<Me | null>(async () => {
  try {
    return await getJson<Me>("/api/me");
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return null;
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

export function useSettings() {
  return useResource(preferencesResource, useSignedIn());
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

/** Sign out this browser; the account state is forgotten. */
export async function logout(): Promise<void> {
  await postJson("/auth/logout");
  meResource.set(null);
  preferencesResource.reset();
  adminUsersResource.reset();
  useSettingsStore.getState().reset();
}

export async function setUserLimits(input: {
  userId: string;
  dailyTokens?: number | null;
  dailyRuns?: number | null;
}): Promise<DailyLimits> {
  const limits = await postJson<DailyLimits>("/api/admin/limits", input);
  void adminUsersResource.load(true).catch(() => undefined);
  return limits;
}

export function createInvites(input: { count: number }): Promise<{ codes: string[] }> {
  return postJson<{ codes: string[] }>("/api/admin/invites", input);
}

export const useUpdateSettings = () => useAction(updatePreferences);
export const useLogout = () => useAction((_: void) => logout());
export const useSetUserLimits = () => useAction(setUserLimits);
export const useCreateInvites = () => useAction(createInvites);
