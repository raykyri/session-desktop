// The web client's shell (phase 2a): the account procedures the server keeps
// on tRPC (sign-in state, appearance settings, the daily usage summary, the
// admin pages). Spaces are the sync protocol's; phase 2b builds them on
// `@session/sync`'s client in this shell.

import type { UserSettings } from "@session/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSettingsStore } from "../stores/settings.js";

import { trpc } from "./trpc.js";

export const queryKeys = {
  me: () => ["me"] as const,
  settings: () => ["settings"] as const,
  runtimeConfig: () => ["runtimeConfig"] as const,
  usage: () => ["usage"] as const,
  adminUsers: () => ["adminUsers"] as const,
};

/** Query defaults: account state changes only when this tab changes it. */
export const queryClientDefaults = {
  queries: {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  },
} as const;

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

export interface SettingsUpdate {
  settings?: Partial<UserSettings>;
  researchLaunchInstruction?: string | null;
}

export type ServerSettings = UserSettings & { researchLaunchInstruction: string | null };

export const meQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.me(),
    queryFn: () => trpc().auth.me.query(),
    retry: false,
  });

export const settingsQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.settings(), queryFn: () => trpc().settings.get.query() });

export const runtimeConfigQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.runtimeConfig(),
    queryFn: () => trpc().system.runtimeConfig.query(),
  });

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

export function useUsageSummary() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.usage(),
    queryFn: () => trpc().usage.summary.query(),
    enabled: signedIn,
  });
}

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => trpc().admin.listUsers.query(),
    enabled,
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SettingsUpdate) => trpc().settings.update.mutate(input),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.settings(), settings);
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => trpc().auth.logout.mutate(),
    onSuccess: () => {
      client.clear();
      useSettingsStore.getState().reset();
    },
  });
}

export function useSetUserLimits() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      userId: string;
      dailyTokens?: number | null;
      dailyRuns?: number | null;
    }) => trpc().admin.setLimits.mutate(input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.adminUsers() }),
  });
}

export function useCreateInvites() {
  return useMutation({
    mutationFn: (input: { count: number }) => trpc().admin.createInvites.mutate(input),
  });
}
