// Online-only procedures (02 §9.1, ADR-20): the signed-in account, its
// settings, the runtime config, usage and the site-admin calls. These are
// TanStack Query reads over tRPC and are not replicated. Everything the
// spaces screens read (channels, threads, saves, notifications) comes from
// the replica (`02` §9), which is not part of this module.

import type { ApiKeyProvider, Me, UserSettings } from "@session/shared";
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
  /** `usage.get` (03 K5, K6): the ring and the Usage page. */
  weeklyUsage: () => ["usage", "week"] as const,
  usageRuns: () => ["usage", "runs"] as const,
  models: () => ["models"] as const,
};

/* -------------------------------------------------------------------------
 * Calls
 * ---------------------------------------------------------------------- */

export function getMe(): Promise<Me | null> {
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

export function getWeeklyUsage() {
  return trpc().usage.get.query();
}

export function listUsageRuns(input: { limit?: number; cursor?: string | null } = {}) {
  return trpc().usage.listRuns.query(input);
}

export function setBilling(mode: "pause" | "key") {
  return trpc().usage.setBilling.mutate({ mode });
}

export function setApiKey(input: { provider: ApiKeyProvider; raw: string }) {
  return trpc().apiKeys.set.mutate(input);
}

export function removeApiKey(provider: ApiKeyProvider) {
  return trpc().apiKeys.remove.mutate({ provider });
}

export function listModels() {
  return trpc().models.list.query();
}

export function setDefaultModel(model: string) {
  return trpc().admin.models.setDefault.mutate({ model });
}

export function setDefaultEffort(effort: string) {
  return trpc().admin.models.setDefaultEffort.mutate({ effort });
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

/** Usage is not pushed: a reading is stale after 30 s, and a reader that
 * mounts after that fetches it again. It is also refetched when one of the
 * member's runs ends and when its week resets (`UsageRefresh` in
 * `replica/ReplicaProvider.tsx`), and after a write refused for it. */
export const USAGE_REFRESH_MS = 30_000;

/** `usage.get` is online-only and not pushed: 30 s stale time (03 K6). */
export const weeklyUsageQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.weeklyUsage(),
    queryFn: () => getWeeklyUsage(),
    staleTime: USAGE_REFRESH_MS,
  });

/** `models.list`, cached 60 s (03 K15): a change an admin makes reaches an
 * open tab on its next fetch. */
export const modelsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.models(),
    queryFn: () => listModels(),
    staleTime: 60_000,
  });

type WeeklyUsageReading = Awaited<ReturnType<typeof getWeeklyUsage>>;

export function useWeeklyUsage(enabled = true) {
  return useQuery({ ...weeklyUsageQueryOptions(), enabled });
}

export function useModels(enabled = true) {
  return useQuery({ ...modelsQueryOptions(), enabled });
}

/** The Usage page's recent runs: the newest 6 (03 K5). */
export function useUsageRuns() {
  return useQuery({
    queryKey: queryKeys.usageRuns(),
    queryFn: () => listUsageRuns({ limit: 6 }),
    staleTime: USAGE_REFRESH_MS,
  });
}

export function useSetBilling() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setBilling,
    onSuccess: ({ billing }) =>
      client.setQueryData<WeeklyUsageReading>(queryKeys.weeklyUsage(), (old) =>
        old ? { ...old, billing } : old,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.weeklyUsage() }),
  });
}

/** The saved key goes into the cached reading at once, so its row does not
 * fall back to "Not set" until the refetch answers. The mutation's input is
 * the raw key: it is not kept in the mutation cache once the mutation has no
 * observer (`gcTime: 0`; the Usage page resets it when it settles). */
export function useSetApiKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setApiKey,
    gcTime: 0,
    onSuccess: (saved) =>
      client.setQueryData<WeeklyUsageReading>(queryKeys.weeklyUsage(), (old) =>
        old
          ? {
              ...old,
              keys: [...old.keys.filter((key) => key.provider !== saved.provider), saved].sort(
                (a, b) => a.provider.localeCompare(b.provider),
              ),
            }
          : old,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.weeklyUsage() }),
  });
}

/** Without an Anthropic key billing is `pause` (03 K7). */
export function useRemoveApiKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: removeApiKey,
    onSuccess: (_result, provider) =>
      client.setQueryData<WeeklyUsageReading>(queryKeys.weeklyUsage(), (old) =>
        old
          ? {
              ...old,
              keys: old.keys.filter((key) => key.provider !== provider),
              billing: provider === "anthropic" ? "pause" : old.billing,
            }
          : old,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.weeklyUsage() }),
  });
}

type ModelsListing = Awaited<ReturnType<typeof listModels>>;

/** The new setting goes into the cached listing at once, then the listing
 * is refetched (02 W8.2). */
export function useSetDefaultModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setDefaultModel,
    onSuccess: ({ defaultModel }) =>
      client.setQueryData<ModelsListing>(queryKeys.models(), (old) =>
        old ? { ...old, defaultModel } : old,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.models() }),
  });
}

export function useSetDefaultEffort() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setDefaultEffort,
    onSuccess: ({ defaultEffort }) =>
      client.setQueryData<ModelsListing>(queryKeys.models(), (old) =>
        old ? { ...old, defaultEffort } : old,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.models() }),
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
      // `auth.me` is set to null rather than dropped: the shell's mounted
      // `useMe` observer keeps the last data of a query that is removed
      // from the cache, and would go on showing the account until a reload.
      client.setQueryData(queryKeys.me(), null);
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me()[0] });
      client.getMutationCache().clear();
      useSettingsStore.getState().reset();
      clearLocalAccountState();
    },
  });
}
