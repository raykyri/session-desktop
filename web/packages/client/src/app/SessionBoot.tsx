// What a signed-in tab keeps running (phase 2a): the appearance settings in
// sync with the server. Remote settings are authoritative on load; local
// changes are sent after a debounce, as a patch of the changed keys
// (`06-auth-and-users.md` §6).

import { userSettingsSchema } from "@session/shared";
import type { UserSettings } from "@session/shared";
import { useEffect, useRef } from "react";

import { preferencesResource, useMe, useSettings } from "../api/account.js";
import { postJson } from "../api/http.js";
import type { ServerSettings } from "../api/account.js";
import { normalizeSettings, useSettingsStore } from "../stores/settings.js";

/** Debounce interval for pushing local user settings modifications to the
 * server (07 §4.3). */
export const SESSION_SETTINGS_SYNC_DEBOUNCE_MS = 300;

const SETTINGS_KEYS = Object.keys(userSettingsSchema.shape) as (keyof UserSettings)[];

export function sameSettings(left: UserSettings, right: UserSettings): boolean {
  return SETTINGS_KEYS.every((key) => left[key] === right[key]);
}

/** The keys of `next` that differ from `base`, as a patch. */
export function changedSettings(next: UserSettings, base: UserSettings): Partial<UserSettings> {
  const patch: Partial<UserSettings> = {};
  for (const key of SETTINGS_KEYS) {
    if (next[key] !== base[key]) (patch as Record<string, unknown>)[key] = next[key];
  }
  return patch;
}

function useSettingsSync(): void {
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
      if (server.current === null) return;
      if (sameSettings(state.settings, server.current)) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const pending = useSettingsStore.getState().settings;
        const sent = server.current;
        if (sent === null) return;
        const patch = changedSettings(pending, sent);
        if (Object.keys(patch).length === 0) return;
        server.current = { ...sent, ...patch };
        void postJson<ServerSettings>("/api/me/preferences", { settings: patch })
          .then((saved) => {
            server.current = normalizeSettings(saved);
            preferencesResource.set(saved);
          })
          .catch(() => {
            server.current = sent;
          });
      }, SESSION_SETTINGS_SYNC_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);
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
