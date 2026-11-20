// Online-only procedures (02 §9.1, ADR-20): the signed-in account, its
// settings, the runtime config, usage and the site-admin calls. These are
// TanStack Query reads over tRPC and are not replicated. Everything the
// spaces screens read (channels, threads, saves, notifications) comes from
// the replica (`02` §9), which is not part of this module.

import type { User, UserSettings } from "@session/shared";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type DefaultOptions,
} from "@tanstack/react-query";

import { clearLocalAccountState } from "../stores/localAccount.js";
import { useSettingsStore } from "../stores/settings.js";

import { trpc } from "./trpc.js";

/** Query client defaults. Reads here are refetched on mount once stale; no
 * read is kept alive by an event stream. */
export const queryClientDefaults = {
  queries: {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  },
} as const satisfies DefaultOptions;

export const queryKeys = {
  me: () => ["me"] as const,
  settings: () => ["settings"] as const,
  runtimeConfig: () => ["runtimeConfig"] as const,
  usage: () => ["usage"] as const,
  adminUsers: () => ["adminUsers"] as const,
};

/* -------------------------------------------------------------------------
 * Calls
 * ---------------------------------------------------------------------- */

export function getMe(): Promise<User | null> {
  return trpc().auth.me.query();
}

export function logout() {
  return trpc().auth.logout.mutate();
}

export function getRuntimeConfig() {
  return trpc().system.runtimeConfig.query();
}

export function getSettings() {
  return trpc().settings.get.query();
}

export interface SettingsUpdate {
  settings?: Partial<UserSettings>;
}

export function updateSettings(input: SettingsUpdate) {
  return trpc().settings.update.mutate(input);
}

export function getUsageSummary() {
  return trpc().usage.summary.query();
}

export function listUsers() {
  return trpc().admin.listUsers.query();
}

export function setUserLimits(input: {
  userId: string;
  dailyTokens?: number | null;
  dailyRuns?: number | null;
}) {
  return trpc().admin.setLimits.mutate(input);
}

export function createInvites(count: number) {
  return trpc().admin.createInvites.mutate({ count });
}

/** The GitHub OAuth start URL. The server validates `return_to`; `signupCode`
 * is an account invite code, sent as `invite`. */
export function gitHubSignInUrl(returnTo?: string, signupCode?: string): string {
  const params = new URLSearchParams();
  if (returnTo) params.set("return_to", returnTo);
  if (signupCode) params.set("invite", signupCode);
  const query = params.toString();
  return `/auth/github${query === "" ? "" : `?${query}`}`;
}

/** Navigates the whole page to the GitHub OAuth start. */
export function startGitHubSignIn(returnTo?: string, signupCode?: string): void {
  window.location.assign(gitHubSignInUrl(returnTo, signupCode));
}

/* -------------------------------------------------------------------------
 * Options, shared with the router's `beforeLoad`
 * ---------------------------------------------------------------------- */

export const meQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.me(),
    queryFn: () => getMe(),
    retry: false,
  });

export const settingsQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.settings(), queryFn: () => getSettings() });

export const runtimeConfigQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.runtimeConfig(),
    queryFn: () => getRuntimeConfig(),
    staleTime: Number.POSITIVE_INFINITY,
  });

/* -------------------------------------------------------------------------
 * Hooks
 * ---------------------------------------------------------------------- */

export function useMe() {
  return useQuery(meQueryOptions());
}

export function useSignedIn(): boolean {
  return Boolean(useMe().data);
}

export function useSettings() {
  const signedIn = useSignedIn();
  return useQuery({ ...settingsQueryOptions(), enabled: signedIn });
}

export function useRuntimeConfig() {
  return useQuery(runtimeConfigQueryOptions());
}

/** Usage is not pushed; a mounted reader refreshes every 30 s. */
export const USAGE_REFRESH_MS = 30_000;

export function useUsageSummary() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.usage(),
    queryFn: () => getUsageSummary(),
    refetchInterval: USAGE_REFRESH_MS,
    enabled: signedIn,
  });
}

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => listUsers(),
    refetchInterval: USAGE_REFRESH_MS,
    enabled,
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SettingsUpdate) => updateSettings(input),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.settings(), settings);
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      // Nothing of the signed-out account stays in memory or in this tab.
      client.clear();
      useSettingsStore.getState().reset();
      clearLocalAccountState();
    },
  });
}

export function useSetUserLimits() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setUserLimits,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.adminUsers() }),
  });
}

export function useCreateInvites() {
  return useMutation({ mutationFn: createInvites });
}
