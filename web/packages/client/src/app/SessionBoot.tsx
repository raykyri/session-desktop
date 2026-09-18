// What starts once a session exists (07 §2, §4.2, §8).
//
// Three things live here because all three are per-account and per-tab, and
// none of them belongs to a view: the event subscription, the draft writer,
// and the settings mirror's agreement with the server. `AppShell` mounts this
// once, behind the auth guard, so none of it runs on `/login`.

import type { UserSettings } from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ensureDefaultResearchWorkspace, setDraft, updateSettings } from "../api/api.js";
import { queryKeys } from "../api/cache.js";
import { connectEventBridge } from "../api/events.js";
import { useSettings, useWorkspaces } from "../api/queries.js";
import { setDraftSyncTarget, type ComposerDraft, type DraftKey } from "../stores/drafts.js";
import { normalizeSettings, useSettingsStore } from "../stores/settings.js";

/** A local settings change waits this long for the next one before it is
 * pushed: dragging the text-size slider is one write, not thirty (07 §4.3). */
export const SESSION_SETTINGS_SYNC_DEBOUNCE_MS = 300;

/** Every field of `UserSettings`, as a record rather than a list: a key
 * missing from the comparison below is a preference that silently stops
 * syncing, and a `Record<keyof UserSettings, true>` cannot be missing one. */
const SETTINGS_FIELDS: Record<keyof UserSettings, true> = {
  colorTheme: true,
  appearance: true,
  bodyFontId: true,
  textSize: true,
  showShortcutHints: true,
  reduceMotion: true,
  showToolCalls: true,
  showAssistantTimestamps: true,
  showNotifications: true,
  requireCmdEnterToSend: true,
  defaultModel: true,
};

const SETTINGS_KEYS = Object.keys(SETTINGS_FIELDS) as (keyof UserSettings)[];

export function sameSettings(left: UserSettings, right: UserSettings): boolean {
  return SETTINGS_KEYS.every((key) => left[key] === right[key]);
}

/** The subscription, opened once for the app's lifetime. */
function useEventBridge(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const bridge = connectEventBridge({ queryClient });
    return () => bridge.close();
  }, [queryClient]);
}

/**
 * The drafts store is local-first and already debounces; this only gives it
 * somewhere to write. A draft is a string field per key, so the whole record
 * is serialized: the server stores an opaque value (`drafts.set`).
 */
function useDraftSync(): void {
  useEffect(() => {
    const write = (key: DraftKey, draft: ComposerDraft | null): void => {
      // An empty value is the server's delete.
      void setDraft(key, draft === null ? "" : JSON.stringify(draft)).catch(() => {
        // A failed draft write is not worth a toast: the local copy is still
        // there and the next keystroke retries.
      });
    };
    setDraftSyncTarget(write);
    return () => setDraftSyncTarget(null);
  }, []);
}

/**
 * An account with no workspace has nowhere to put a research run, and every
 * scoped query is disabled on the empty scope (`features/sidebar/scope.ts`),
 * so a first sign-in would land on a Home whose composer can never be
 * submitted. `workspaces.ensureDefault` is idempotent and returns the existing
 * default when there is one; it is called once per mount, and only after the
 * list has actually answered with nothing.
 */
function useDefaultWorkspace(): void {
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces();
  const requested = useRef(false);

  const empty = workspaces.isSuccess && (workspaces.data?.length ?? 0) === 0;
  useEffect(() => {
    if (!empty || requested.current) return;
    requested.current = true;
    void ensureDefaultResearchWorkspace()
      .then((workspace) => {
        queryClient.setQueryData(queryKeys.workspaces(), [workspace]);
      })
      .catch(() => {
        // The next mount retries; there is nothing useful to say here, and the
        // sidebar already renders as an account with no workspace.
        requested.current = false;
      });
  }, [empty, queryClient]);
}

/**
 * The server's copy is authoritative on load; local changes are pushed on a
 * debounce; `settings.updated` events from another tab arrive through the
 * bridge, which writes both the cache and the mirror (`06-auth-and-users.md`
 * §6).
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
      // Before the server's copy lands there is nothing to disagree with, and
      // pushing the persisted local record would overwrite the account's.
      if (server.current === null) return;
      if (sameSettings(state.settings, server.current)) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const pending = useSettingsStore.getState().settings;
        const sent = server.current;
        // Optimistic, so the echo of this write is not pushed back at the
        // server; restored on failure rather than cleared, because `null`
        // means "the account's copy has not landed yet" and would stop every
        // later change from being pushed at all.
        server.current = pending;
        void updateSettings({ settings: pending })
          .then((saved) => {
            server.current = normalizeSettings(saved);
            queryClient.setQueryData(queryKeys.settings(), saved);
          })
          .catch(() => {
            // The next change retries; a reload takes the server's copy,
            // which is the documented resolution (`06` §6).
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
  useEventBridge();
  useDraftSync();
  useSettingsSync();
  useDefaultWorkspace();
  return null;
}
