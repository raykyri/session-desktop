// Composer drafts (07 §4.3, §8). A draft is local-first so typing never waits
// on the network, mirrored to `sessionStorage` so a reload in the same tab
// keeps it, and pushed to the server's `interface_drafts` on a 120 ms debounce
// with a flush on `pagehide` so it survives a new device.
//
// Composers restore the server copy on entering their scope. Local edits made
// in this tab always win over asynchronous restoration.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const DRAFTS_STORAGE_KEY = "session.drafts.v2";
export const DRAFT_SYNC_DEBOUNCE_MS = 120;

export interface ComposerDraft {
  text: string;
  /** Registry model id the composer will launch with. */
  model?: string | undefined;
  /** Ids of documents attached to this draft. */
  documentIds?: string[] | undefined;
  updatedAt: number;
}

/** Draft scopes, keyed so one flat record holds them all: the Home composer
 * per workspace, and a follow-up composer per node. */
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
  get: (key: DraftKey) => ComposerDraft | undefined;
  setDraft: (key: DraftKey, draft: Omit<ComposerDraft, "updatedAt">) => void;
  clearDraft: (key: DraftKey) => void;
  /** Sends every pending debounced write immediately. Called from `pagehide`,
   * where a timer would never fire. */
  flush: () => void;
}

let syncTarget: DraftSyncTarget | null = null;
const pending = new Map<DraftKey, ComposerDraft | null>();
const editedKeys = new Set<DraftKey>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Also marks edits such as an in-flight attachment that has no durable id yet. */
export function markDraftEdited(key: DraftKey): void {
  editedKeys.add(key);
}

export function restoreServerDraft(key: DraftKey, raw: string | null): ComposerDraft | null {
  if (raw === null || editedKeys.has(key)) return null;
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
    (value["documentIds"] !== undefined &&
      (!Array.isArray(value["documentIds"]) ||
        !value["documentIds"].every((id: unknown) => typeof id === "string")))
  )
    return null;
  const draft = value as unknown as ComposerDraft;
  const local = useDraftsStore.getState().get(key);
  if (local && local.updatedAt >= draft.updatedAt) return null;
  useDraftsStore.setState((state) => ({ byKey: { ...state.byKey, [key]: draft } }));
  return draft;
}

/** Installs the server writer. Until one is set, drafts are local only. */
export function setDraftSyncTarget(target: DraftSyncTarget | null): void {
  syncTarget = target;
}

function flushPending(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!syncTarget) {
    pending.clear();
    return;
  }
  for (const [key, draft] of pending) syncTarget(key, draft);
  pending.clear();
}

// `pagehide` is the last event a navigating or bfcached tab reliably gets;
// `beforeunload` does not fire on mobile Safari and `unload` cancels the
// in-flight request it would start. A 120 ms timer left pending at that point
// never fires, so the debounce is collapsed here instead.
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
      get: (key) => get().byKey[key],
      setDraft: (key, draft) => {
        markDraftEdited(key);
        const stored: ComposerDraft = { ...draft, updatedAt: Date.now() };
        set((state) => ({ byKey: { ...state.byKey, [key]: stored } }));
        schedule(key, stored);
      },
      clearDraft: (key) => {
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
      // Only the drafts are durable. Without this the whole state object is
      // handed to `JSON.stringify`, and it happens to come out right only
      // because functions serialize to nothing.
      partialize: (state) => ({ byKey: state.byKey }),
    },
  ),
);
