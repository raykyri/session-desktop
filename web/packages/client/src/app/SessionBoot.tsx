// Account-scoped background services (07 §2, §4.3). Today that is the user
// settings sync; the replica's provider and the sync client's registration
// join it with 02 §9. `AppShell` mounts this once; it renders nothing and
// does nothing until a session exists, so none of it runs for guests or on
// `/login`.

import { userSettingsSchema } from "@session/shared";
import type { UserSettings } from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { queryKeys, updateSettings, useMe, useSettings } from "../api/account.js";
import { normalizeSettings, useSettingsStore } from "../stores/settings.js";

/** Debounce interval for pushing local user settings modifications to the
 * server (07 §4.3). */
export const SESSION_SETTINGS_SYNC_DEBOUNCE_MS = 300;

/** Fields of `UserSettings`, derived directly from the schema so all
 * preferences synchronize without maintaining a duplicate key list. */
const SETTINGS_KEYS = Object.keys(userSettingsSchema.shape) as (keyof UserSettings)[];

export function sameSettings(left: UserSettings, right: UserSettings): boolean {
  return SETTINGS_KEYS.every((key) => left[key] === right[key]);
}

/**
 * Returns the subset of changed settings keys between `next` and `base`.
 *
 * Emitting partial patches prevents concurrent tabs in the same debounce window
 * from overwriting each other's updates (`06-auth-and-users.md` §6).
 */
export function changedSettings(next: UserSettings, base: UserSettings): Partial<UserSettings> {
  const patch: Partial<UserSettings> = {};
  for (const key of SETTINGS_KEYS) {
    if (next[key] !== base[key]) (patch as Record<string, unknown>)[key] = next[key];
  }
  return patch;
}

/**
 * Synchronizes user settings with the server. Remote settings are authoritative
 * on load; local changes debounce before sending; remote updates apply to both
 * cache and local store (`06-auth-and-users.md` §6).
 */
function useSettingsSync(): void {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const server = useRef<UserSettings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const data = settings.data;
  useEffect(() => {
    if (!data) return;
    const applied = normalizeSettings(data);
    server.current = applied;
    useSettingsStore.getState().replace(applied);
  }, [data]);

  useEffect(() => {
    const unsubscribe = useSettingsStore.subscribe((state, previous) => {
      if (state.settings === previous.settings) return;
      // Wait until remote settings are fetched before syncing changes to prevent overwriting server state with stale local data.
      if (server.current === null) return;
      if (sameSettings(state.settings, server.current)) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const pending = useSettingsStore.getState().settings;
        const sent = server.current;
        if (sent === null) return;
        const patch = changedSettings(pending, sent);
        // Skip request if concurrent updates eliminated diffs during the debounce interval.
        if (Object.keys(patch).length === 0) return;
        // Apply optimistic update for modified keys to avoid echoing values back on save.
        // Revert to previous baseline on request failure.
        server.current = { ...sent, ...patch };
        void updateSettings({ settings: patch })
          .then((saved) => {
            server.current = normalizeSettings(saved);
            queryClient.setQueryData(queryKeys.settings(), saved);
          })
          .catch(() => {
            // Revert optimistic state on failure so subsequent edits retry
            // against last known server state (`06` §6).
            server.current = sent;
          });
      }, SESSION_SETTINGS_SYNC_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [queryClient]);
}

export function SessionBoot() {
  const me = useMe();
  if (!me.data) return null;
  return <SignedInSessionBoot />;
}

function SignedInSessionBoot() {
  useSettingsSync();
  return null;
}
