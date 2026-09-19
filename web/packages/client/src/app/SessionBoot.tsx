// What starts once a session exists (07 §2, §4.2, §8).
//
// Manages account- and session-scoped background services: server events subscription, draft persistence, and settings synchronization. `AppShell` mounts this
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

/** A local settings change waits this long for the next one before it is
 * pushed: dragging the text-size slider is one write, not thirty (07 §4.3). */
export const SESSION_SETTINGS_SYNC_DEBOUNCE_MS = 300;

/** Every field of `UserSettings`, taken from the schema rather than listed
 * here. A key missing from the comparison below is a preference that silently
 * stops syncing, and a second copy of the field list is a copy that drifts the
 * moment a field is added or removed. */
const SETTINGS_KEYS = Object.keys(userSettingsSchema.shape) as (keyof UserSettings)[];

export function sameSettings(left: UserSettings, right: UserSettings): boolean {
  return SETTINGS_KEYS.every((key) => left[key] === right[key]);
}

/**
 * The fields of `next` that differ from `base`.
 *
 * The push is a patch, not the whole record, because two tabs can be inside
 * the same debounce window: `settings.update` merges field by field, so a tab
 * that sends its entire mirror also sends its stale copy of whatever the other
 * tab just changed, and reverts it — then the `settings.updated` echo flips
 * the first tab's UI back. A patch of the keys this tab actually moved leaves
 * every other field at whatever the server has (`06-auth-and-users.md` §6).
 */
export function changedSettings(next: UserSettings, base: UserSettings): Partial<UserSettings> {
  const patch: Partial<UserSettings> = {};
  for (const key of SETTINGS_KEYS) {
    if (next[key] !== base[key]) (patch as Record<string, unknown>)[key] = next[key];
  }
  return patch;
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
        // Draft sync errors do not trigger notifications; the local draft remains preserved in localStorage and retries on subsequent changes.
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
        // Another write may have landed while the debounce ran, leaving
        // nothing of this tab's own to send.
        if (Object.keys(patch).length === 0) return;
        // Optimistic, so the echo of this write is not pushed back at the
        // server; and only the patched keys move, because the rest of `sent`
        // is still the last thing the server actually said. Restored on
        // failure rather than cleared, because `null` means "the account's
        // copy has not landed yet" and would stop every later change from
        // being pushed at all.
        server.current = { ...sent, ...patch };
        void updateSettings({ settings: patch })
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

/**
 * The account's running and queued nodes, held for the whole session.
 *
 * This is a cache the event reducers write rather than a list any view
 * renders, which is why it is mounted here: `cachedNode` is what tells a node
 * update whether its predecessor is known, and without this query the answer
 * is "no" for every node outside the thread the reader has open. A "no" sends
 * `research.node.updated` down the `invalidate(["trees"])` branch, and the run
 * loop publishes that event every 500 ms per running node — so a reader
 * sitting on Home with one run streaming would refetch the whole sidebar twice
 * a second. Populated, the same event patches the summary instead.
 *
 * It cannot feed back into itself: the reducers write it with `setQueryData`,
 * and the only things that invalidate it are a bridge reconnect and an event
 * that fails parsing (`api/cache.ts`, `api/events.ts`), neither of
 * which a refetch produces. `staleTime` is infinite and focus refetching is
 * off, so mounting it costs one request per session.
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
