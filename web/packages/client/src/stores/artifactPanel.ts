// The document preview panel's geometry and contents
// (`11-artifacts-and-browser.md` §3).
//
// What survives from the desktop's `browserOverlay.ts` is the part that was
// pure DOM state and therefore testable: one panel at a time, a remembered
// size, a full-width toggle, and "is this link already showing". What is gone
// is everything that existed to drive a native view — `mode`, screencast
// frames, input injection, geometry publishing, occlusion, and the lifecycle
// queue (`01-architecture-decisions.md`, survey conclusion).
//
// One store, not a list: the desktop's `closeAllBrowserOverlays` existed
// because overlays could stack, and the web keeps a single slot so the
// invariant is structural rather than enforced by a sweep.

import { create } from "zustand";

export const ARTIFACT_PANEL_MIN_WIDTH = 320;
export const ARTIFACT_PANEL_MIN_HEIGHT = 200;
export const ARTIFACT_PANEL_DEFAULT_WIDTH = 560;
export const ARTIFACT_PANEL_DEFAULT_HEIGHT = 560;

/** A minted token is good for an hour; anything inside this margin is treated
 * as spent, so the panel re-mints rather than framing a URL that will 410
 * while the reader is looking at it. */
export const ARTIFACT_TOKEN_REUSE_SKEW_MS = 60_000;

export interface ArtifactPanelDocument {
  documentId: string;
  /** Shown in the address row; the file name the user uploaded. */
  name: string;
  /** The minted URL on the artifact origin. */
  url: string;
  /** Epoch milliseconds, from `artifacts.mintToken`. */
  expiresAt: number;
}

export interface ArtifactPanelScroll {
  x: number;
  y: number;
}

export interface ArtifactPanelState {
  /** The document on screen, or null when the panel is closed. */
  current: ArtifactPanelDocument | null;
  /** The last document shown, so Shift-Cmd-E can reopen what it closed. */
  last: ArtifactPanelDocument | null;
  width: number;
  height: number;
  fullWidth: boolean;
  /** Bumped to remount the iframe; a `src` that has not changed would not
   * reload on its own. */
  reloadNonce: number;
  /** The offset the artifact page last reported, restored after a reload. */
  scroll: ArtifactPanelScroll;

  open: (document: ArtifactPanelDocument) => void;
  close: () => void;
  /** Closes an open panel, or reopens the last document. Returns whether a
   * panel is open afterwards. */
  toggle: () => boolean;
  reload: () => void;
  /** Swaps in a freshly minted URL for the same document, keeping the scroll
   * offset so a re-mint is invisible. */
  remint: (url: string, expiresAt: number) => void;
  recordScroll: (scroll: ArtifactPanelScroll) => void;
  resize: (size: { width?: number; height?: number }) => void;
  toggleFullWidth: () => void;
  reset: () => void;
}

/** The token for `documentId` that can still be reused, if there is one. A
 * closed panel keeps its last document, so reopening the same chip twice in a
 * minute does not mint twice (`11-artifacts-and-browser.md` §3). */
export function reusableToken(
  state: Pick<ArtifactPanelState, "current" | "last">,
  documentId: string,
  now = Date.now(),
): ArtifactPanelDocument | null {
  for (const candidate of [state.current, state.last]) {
    if (candidate?.documentId !== documentId) continue;
    if (candidate.expiresAt - ARTIFACT_TOKEN_REUSE_SKEW_MS <= now) continue;
    return candidate;
  }
  return null;
}

const INITIAL = {
  current: null,
  last: null,
  width: ARTIFACT_PANEL_DEFAULT_WIDTH,
  height: ARTIFACT_PANEL_DEFAULT_HEIGHT,
  fullWidth: false,
  reloadNonce: 0,
  scroll: { x: 0, y: 0 },
} satisfies Pick<
  ArtifactPanelState,
  "current" | "last" | "width" | "height" | "fullWidth" | "reloadNonce" | "scroll"
>;

export const useArtifactPanelStore = create<ArtifactPanelState>()((set, get) => ({
  ...INITIAL,

  open: (document) =>
    set((state) => ({
      current: document,
      last: document,
      // A different document starts at the top; the same one reopened — from
      // the chip or from Shift-Cmd-E — keeps where it was left, which is why
      // the closed panel's `last` counts here too.
      scroll:
        (state.current ?? state.last)?.documentId === document.documentId
          ? state.scroll
          : { x: 0, y: 0 },
      reloadNonce: state.reloadNonce + 1,
    })),

  close: () => set((state) => (state.current === null ? state : { current: null })),

  toggle: () => {
    const state = get();
    if (state.current) {
      set({ current: null });
      return false;
    }
    if (!state.last) return false;
    set({ current: state.last, reloadNonce: state.reloadNonce + 1 });
    return true;
  },

  reload: () => set((state) => ({ reloadNonce: state.reloadNonce + 1 })),

  remint: (url, expiresAt) =>
    set((state) => {
      if (!state.current) return state;
      const current = { ...state.current, url, expiresAt };
      return { current, last: current, reloadNonce: state.reloadNonce + 1 };
    }),

  recordScroll: (scroll) =>
    set((state) =>
      state.scroll.x === scroll.x && state.scroll.y === scroll.y ? state : { scroll },
    ),

  resize: ({ width, height }) =>
    set((state) => ({
      width:
        width === undefined ? state.width : Math.max(ARTIFACT_PANEL_MIN_WIDTH, Math.round(width)),
      height:
        height === undefined
          ? state.height
          : Math.max(ARTIFACT_PANEL_MIN_HEIGHT, Math.round(height)),
    })),

  toggleFullWidth: () => set((state) => ({ fullWidth: !state.fullWidth })),

  reset: () => set({ ...INITIAL, scroll: { x: 0, y: 0 } }),
}));
