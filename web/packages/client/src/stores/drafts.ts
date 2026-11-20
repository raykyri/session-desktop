// Composer drafts (07 §4.3, §8). Draft state is stored locally first, mirrored to
// `sessionStorage` to persist across reloads within the same tab, and synchronized
// to the server `interface_drafts` with a 120 ms debounce and a `pagehide` flush.
//
// Composers restore remote draft copies when mounting. Local edits within the active tab
// take precedence over asynchronous remote restoration.
//
// Persisted drafts record the author account ID (`owner`). Once session identity
// resolves (`stores/localAccount.ts`), drafts belonging to other accounts or unauthenticated
// sessions are discarded, and sign-out clears all drafts along with pending writes.
// When an unauthenticated state is encountered due to session expiration, drafts are retained
// but hidden, disabling reads and writes until the account re-authenticates.

import type { ResearchImageAttachment } from "@session/shared";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { ownsLocalState } from "../lib/localOwner.js";

export const DRAFTS_STORAGE_KEY = "session.drafts.v2";
export const DRAFT_SYNC_DEBOUNCE_MS = 120;

export interface ComposerDraft {
  text: string;
  /** Model registry identifier configured for the composer. */
  model?: string | undefined;
  /** Configured reasoning effort level; undefined uses the model default. */
  effort?: string | undefined;
  /** Image attachments staged for the prompt. */
  images?: ResearchImageAttachment[] | undefined;
  updatedAt: number;
}

/** Draft scope keys indexing workspace root composers and per-node follow-up composers. */
export type DraftKey = `home:${string}` | `node:${string}`;

export function homeDraftKey(workspaceId: string): DraftKey {
  return `home:${workspaceId}`;
}

export function nodeDraftKey(nodeId: string): DraftKey {
  return `node:${nodeId}`;
}

export type DraftSyncTarget = (key: DraftKey, draft: ComposerDraft | null) => void;

export interface DraftsState {
  byKey: Record<string, ComposerDraft>;
  /** Account ID owning the stored drafts; null for unauthenticated, undefined prior to session resolution. */
  owner?: string | null | undefined;
  /** When true, draft reads return undefined and writes are ignored (e.g. during session expiration). Not persisted. */
  hidden?: boolean | undefined;
  get: (key: DraftKey) => ComposerDraft | undefined;
  setDraft: (key: DraftKey, draft: Omit<ComposerDraft, "updatedAt">) => void;
  clearDraft: (key: DraftKey) => void;
  /** Flushes debounced synchronization writes immediately, such as during `pagehide`. */
  flush: () => void;
}

let syncTarget: DraftSyncTarget | null = null;
const pending = new Map<DraftKey, ComposerDraft | null>();
const editedKeys = new Set<DraftKey>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Resets the set of edited draft keys for test isolation. */
export function resetEditedDraftKeysForTests(): void {
  editedKeys.clear();
}

/** Records that a draft key was edited in this tab, preventing subsequent server restores from overwriting it. */
export function markDraftEdited(key: DraftKey): void {
  editedKeys.add(key);
}

export function restoreServerDraft(key: DraftKey, raw: string | null): ComposerDraft | null {
  if (raw === null || editedKeys.has(key) || useDraftsStore.getState().hidden) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value["text"] !== "string" ||
    typeof value["updatedAt"] !== "number" ||
    !Number.isFinite(value["updatedAt"]) ||
    value["updatedAt"] < 0 ||
    (value["model"] !== undefined && typeof value["model"] !== "string") ||
    (value["effort"] !== undefined && typeof value["effort"] !== "string") ||
    (value["images"] !== undefined && !Array.isArray(value["images"]))
  )
    return null;
  const draft = value as unknown as ComposerDraft;
  const local = useDraftsStore.getState().get(key);
  if (local && local.updatedAt >= draft.updatedAt) return null;
  useDraftsStore.setState((state) => ({ byKey: { ...state.byKey, [key]: draft } }));
  return draft;
}

/** Configures the remote synchronization callback. Drafts remain local-only when null. */
export function setDraftSyncTarget(target: DraftSyncTarget | null): void {
  syncTarget = target;
}

function flushPending(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  // Discard pending writes if remote sync target is absent or tab ownership no longer matches local state.
  if (!syncTarget || !ownsLocalState()) {
    pending.clear();
    return;
  }
  for (const [key, draft] of pending) syncTarget(key, draft);
  pending.clear();
}

// Flush pending writes on `pagehide` so synchronization completes before navigation or bfcache entry.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushPending());
}

function schedule(key: DraftKey, draft: ComposerDraft | null): void {
  pending.set(key, draft);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushPending, DRAFT_SYNC_DEBOUNCE_MS);
}

export const useDraftsStore = create<DraftsState>()(
  persist(
    (set, get) => ({
      byKey: {},
      get: (key) => (get().hidden ? undefined : get().byKey[key]),
      setDraft: (key, draft) => {
        if (get().hidden) return;
        markDraftEdited(key);
        const stored: ComposerDraft = { ...draft, updatedAt: Date.now() };
        set((state) => ({ byKey: { ...state.byKey, [key]: stored } }));
        schedule(key, stored);
      },
      clearDraft: (key) => {
        if (get().hidden) return;
        markDraftEdited(key);
        set((state) => {
          if (!(key in state.byKey)) return state;
          const next = { ...state.byKey };
          delete next[key];
          return { byKey: next };
        });
        schedule(key, null);
      },
      flush: flushPending,
    }),
    {
      name: DRAFTS_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => sessionStorage),
      // Persist only draft entries and owner identity to storage.
      partialize: (state) => ({ byKey: state.byKey, owner: state.owner }),
    },
  ),
);

/** Clears all in-memory and pending drafts, setting `owner` as the active account. */
export function resetDrafts(owner: string | null | undefined): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending.clear();
  editedKeys.clear();
  useDraftsStore.setState({ byKey: {}, owner, hidden: false });
}

/** Associates stored drafts with `owner`, unhiding them if previously hidden or clearing mismatched drafts. */
export function claimDrafts(owner: string | null): void {
  if (useDraftsStore.getState().owner === owner) {
    if (useDraftsStore.getState().hidden) useDraftsStore.setState({ hidden: false });
    return;
  }
  resetDrafts(owner);
}

/** Hides stored drafts and aborts pending remote sync operations upon session expiration. */
export function hideDrafts(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending.clear();
  useDraftsStore.setState({ hidden: true });
}
