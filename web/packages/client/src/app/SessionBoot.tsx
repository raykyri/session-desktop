// Session initialization and background sync services (07 §2, §4.2, §8).
//
// Account- and session-scoped background services: the server events
// subscription, draft persistence, and settings sync. `AppShell` mounts this
// once; it no-ops until a session exists, so none of it runs for guests or on
// `/login`.

import { userSettingsSchema } from "@session/shared";
import type { UserSettings } from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ensureDefaultResearchWorkspace, setDraft, updateSettings } from "../api/api.js";
import { queryKeys } from "../api/cache.js";
import { connectEventBridge } from "../api/events.js";
import { useActiveNodes, useMe, useSettings, useWorkspaces } from "../api/queries.js";
import { setDraftSyncTarget, type ComposerDraft, type DraftKey } from "../stores/drafts.js";
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

/** Maintains the event stream subscription for the application lifetime. */
function useEventBridge(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const bridge = connectEventBridge({ queryClient });
    return () => bridge.close();
  }, [queryClient]);
}

/**
 * Registers remote synchronization target for the local draft store. Draft
 * records are serialized as JSON strings for storage via `interfaceDrafts.set`.
 */
function useDraftSync(): void {
  useEffect(() => {
    const write = (key: DraftKey, draft: ComposerDraft | null): void => {
      // An empty string signals draft deletion on the server.
      void setDraft(key, draft === null ? "" : JSON.stringify(draft)).catch(() => {
        // Draft sync errors do not trigger notifications; the local draft remains preserved in sessionStorage and retries on subsequent changes.
      });
    };
    setDraftSyncTarget(write);
    return () => setDraftSyncTarget(null);
  }, []);
}

/**
 * Ensures a default workspace exists for the account. When workspace listings
 * return empty, invokes `workspaces.ensureDefault` once per mount to establish
 * the initial workspace required for queries and submissions.
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
        // Allow retry on subsequent mounts if workspace initialization fails.
        requested.current = false;
      });
  }, [empty, queryClient]);
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

/**
 * Maintains the session-wide active nodes cache.
 *
 * Event reducers query this cache via `cachedNode` to determine whether a node's
 * predecessor is known. Without this cache, nodes outside the currently open thread
 * would cause `research.node.updated` events to trigger full tree invalidations
 * on every run progress update. When populated, updates patch summaries in place.
 *
 * The cache is updated directly via `setQueryData` and invalidated only upon
 * event parsing failures or bridge reconnections.
 */
function useActiveNodeCache(): void {
  useActiveNodes();
}

export function SessionBoot() {
  const me = useMe();
  if (!me.data) return null;
  return <SignedInSessionBoot />;
}

function SignedInSessionBoot() {
  useEventBridge();
  useActiveNodeCache();
  useDraftSync();
  useSettingsSync();
  useDefaultWorkspace();
  return null;
}
