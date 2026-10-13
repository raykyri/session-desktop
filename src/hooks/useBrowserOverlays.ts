import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowserOverlayMode, BrowserOverlaySize, BrowserOverlayState } from "../appTypes";
import type { LinkActions } from "../components/TranscriptMarkdown";
import {
  browserOpenCodexInlineVisualization,
  browserOpenCodexVisualizationReference,
  browserOpenLocalPath,
  destroyHumanBrowser,
  hideAllHumanBrowsers,
  openExternalUrl,
  reloadHumanBrowser,
  setNativeBrowserOverlayOpen,
} from "../lib/api";
import { IS_MAC } from "../lib/appHelpers";
import {
  anyBrowserOverlayOpen,
  browserOverlayShowsLink,
  closeAllBrowserOverlaysState,
  closeBrowserOverlayState,
} from "../lib/browserOverlay";
import { nativeHumanBrowserOwnerIds } from "../lib/humanBrowserState";
import { canRenderInInternalBrowser, isFileServerUrl, pathFromSessionFileHref, resolveLocalLinkPath } from "../lib/links";
import type { ResearchTreeSummary } from "../types";

// Browser-overlay / link-action owner for a research tree's thread page. Keyed
// per tree so an overlay opened from one tree's links doesn't follow the user
// into another tree.
const RESEARCH_BROWSER_OWNER_PREFIX = "__research_thread__:";
export function researchBrowserOwnerId(treeId: string) {
  return `${RESEARCH_BROWSER_OWNER_PREFIX}${treeId}`;
}

/** The right-click chooser for a link: web URLs choose internal vs external;
 * local paths choose protected preview, reveal, or an explicit OS open. */
interface LinkMenuState {
  url: string;
  x: number;
  y: number;
  paneId: string | null;
}

interface BrowserOverlayOptions {
  researchTrees: ResearchTreeSummary[];
  archivedResearchTrees: ResearchTreeSummary[];
  /** The owner whose overlay is shown: the open research tree, if any. */
  activeOwnerId: string | null;
  fileServerPort: number | null;
  onError: (message: string | null) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * The browser overlays, one per research thread, and the link actions and
 * link menu that open them. The native WKWebView children of closed or removed overlays are
 * destroyed here.
 */
export function useBrowserOverlays({
  researchTrees,
  archivedResearchTrees,
  activeOwnerId,
  fileServerPort,
  onError,
}: BrowserOverlayOptions) {
  const [overlays, setOverlays] = useState<Record<string, BrowserOverlayState>>({});
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
  const activeOwnerIdRef = useRef(activeOwnerId);
  activeOwnerIdRef.current = activeOwnerId;
  const fileServerPortRef = useRef(fileServerPort);
  fileServerPortRef.current = fileServerPort;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const nativeOwnerIdsRef = useRef<Set<string>>(new Set());
  const activeOverlay = activeOwnerId ? overlays[activeOwnerId] : undefined;

  // Collapse every native child. A dropped AppKit hide can leave a white
  // WKWebView square over the page after React state already marks the
  // overlay as closed; this is the recovery path for that leftover.
  const hideEveryHumanBrowser = useCallback(
    () =>
      hideAllHumanBrowsers().catch((err) => {
        onErrorRef.current(errorMessage(err));
        return 0;
      }),
    [],
  );

  // Drop overlay state only when its research tree disappears.
  useEffect(() => {
    const ownerIds = new Set<string>();
    for (const tree of [...researchTrees, ...archivedResearchTrees]) {
      ownerIds.add(researchBrowserOwnerId(tree.id));
    }
    setOverlays((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([ownerId]) => ownerIds.has(ownerId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [archivedResearchTrees, researchTrees]);

  // Keep a child mounted while its overlay is open, including inactive tabs.
  // Remove it after its overlay closes and the child effect publishes the
  // final hidden revision.
  useEffect(() => {
    const nextOwnerIds = nativeHumanBrowserOwnerIds(overlays);
    const retired = [...nativeOwnerIdsRef.current].filter((ownerId) => !nextOwnerIds.has(ownerId));
    nativeOwnerIdsRef.current = nextOwnerIds;
    if (retired.length === 0) {
      return;
    }
    // No remaining React-owned child should be on screen. Sweep first so a
    // dropped per-owner destroy cannot leave the last WKWebView painted.
    if (nextOwnerIds.size === 0) {
      void hideEveryHumanBrowser();
    }
    for (const ownerId of retired) {
      void destroyHumanBrowser(ownerId).catch((err) => {
        onErrorRef.current(errorMessage(err));
      });
    }
  }, [hideEveryHumanBrowser, overlays]);

  useLayoutEffect(() => {
    if (!IS_MAC) {
      return;
    }
    void setNativeBrowserOverlayOpen(activeOverlay?.open === true).catch(() => undefined);
  }, [activeOverlay?.open]);

  // Opens (or replaces) an owner's overlay with a URL, bumping the reload nonce
  // so even re-opening the same URL reloads. Driven by the browser.open event.
  // `sandbox` is set for token-bearing file-server URLs so the iframe loads them in an
  // opaque origin (see BrowserOverlay); plain http(s) URLs are not sandboxed.
  const openBrowserOverlay = useCallback(
    (ownerId: string, url: string, sandbox = false, artifactId: string | null = null) => {
      // Force the sandbox on for any token-bearing file-server URL regardless of the
      // caller's flag: only the backend browser.open event passes sandbox=true, so typed
      // navigation and link opens would otherwise load a file-server URL as a trusted
      // same-origin document and defeat the token protection. Dev-server URLs are excluded
      // by isFileServerUrl and keep their real same-origin context.
      const effectiveSandbox = sandbox || isFileServerUrl(url, fileServerPortRef.current);
      setOverlays((current) => ({
        ...current,
        [ownerId]: {
          url,
          open: true,
          artifactId,
          reloadNonce: (current[ownerId]?.reloadNonce ?? 0) + 1,
          sandbox: effectiveSandbox,
          mode: effectiveSandbox ? "webkit" : (current[ownerId]?.mode ?? "webkit"),
          size: current[ownerId]?.size ?? null,
          fullWidth: current[ownerId]?.fullWidth ?? false,
        },
      }));
    },
    [],
  );

  const openLink = useCallback(
    (ownerId: string | null | undefined, url: string) => {
      const localPath = pathFromSessionFileHref(url);
      const port = fileServerPortRef.current;
      if (localPath) {
        if (!ownerId) {
          onErrorRef.current(`Cannot open local file without an open thread: ${localPath}`);
          return;
        }
        const resolvedPath = resolveLocalLinkPath(localPath);
        if (browserOverlayShowsLink(overlaysRef.current[ownerId], { path: resolvedPath }, port)) {
          setOverlays((current) => closeBrowserOverlayState(current, ownerId));
          return;
        }
        // For absolute filesystem paths in transcript Markdown, create a
        // token-scoped file-server URL and load it in a sandbox. HTTPS host
        // conversion and browser navigation do not handle these paths correctly.
        void browserOpenLocalPath(ownerId, localPath).catch((err) => {
          onErrorRef.current(errorMessage(err));
        });
        return;
      }
      if (ownerId && canRenderInInternalBrowser(url)) {
        if (browserOverlayShowsLink(overlaysRef.current[ownerId], { url }, port)) {
          setOverlays((current) => closeBrowserOverlayState(current, ownerId));
          return;
        }
        openBrowserOverlay(ownerId, url);
      } else {
        void openExternalUrl(url);
      }
    },
    [openBrowserOverlay],
  );

  // One stable LinkActions object per owner, so markdown links rendered by
  // a memoized thread page keep their props across unrelated renders.
  const linkActionsByOwnerRef = useRef(new Map<string, LinkActions>());
  // Entries are kept for removed trees too: the cached closures are small
  // and a session contains few trees.
  const linkActionsFor = useCallback(
    (ownerId: string): LinkActions => {
      const cache = linkActionsByOwnerRef.current;
      let actions = cache.get(ownerId);
      if (!actions) {
        actions = {
          openLink: (url) => openLink(ownerId, url),
          openLinkMenu: (url, x, y) => setLinkMenu({ url, x, y, paneId: ownerId }),
          openCodexInlineVisualization: (file) => {
            void browserOpenCodexInlineVisualization(ownerId, file).catch((err) => {
              onErrorRef.current(errorMessage(err));
            });
          },
          openCodexVisualizationReference: async (reference) => {
            onErrorRef.current(null);
            try {
              await browserOpenCodexVisualizationReference(ownerId, reference.path);
            } catch (err) {
              onErrorRef.current(errorMessage(err));
              throw err;
            }
          },
        };
        cache.set(ownerId, actions);
      }
      return actions;
    },
    [openLink],
  );

  const closeAll = useCallback(() => {
    setOverlays((current) => closeAllBrowserOverlaysState(current));
    void hideEveryHumanBrowser();
  }, [hideEveryHumanBrowser]);

  const closeActive = useCallback(() => {
    if (anyBrowserOverlayOpen(overlaysRef.current)) {
      closeAll();
      return;
    }
    void hideEveryHumanBrowser();
  }, [closeAll, hideEveryHumanBrowser]);

  /** Escape: closes the open overlays when the active owner's is open, and
   * returns whether it did. */
  const closeOnEscape = useCallback(() => {
    const ownerId = activeOwnerIdRef.current;
    if (!ownerId || !overlaysRef.current[ownerId]?.open) {
      return false;
    }
    closeActive();
    return true;
  }, [closeActive]);

  /** The source-browser shortcut: closes every open overlay, or else hides a
   * leftover native child, or else toggles the active owner's overlay. */
  const toggleSourceBrowser = useCallback(() => {
    if (anyBrowserOverlayOpen(overlaysRef.current)) {
      closeAll();
      return;
    }
    void hideEveryHumanBrowser().then((hidden) => {
      const ownerId = activeOwnerIdRef.current;
      if (hidden > 0 || !ownerId) {
        return;
      }
      setOverlays((current) => {
        const prev = current[ownerId];
        return {
          ...current,
          [ownerId]: {
            url: prev?.url ?? null,
            open: !(prev?.open ?? false),
            artifactId: prev?.artifactId ?? null,
            reloadNonce: prev?.reloadNonce ?? 0,
            sandbox: prev?.sandbox ?? false,
            mode: prev?.mode ?? "webkit",
            size: prev?.size ?? null,
            fullWidth: prev?.fullWidth ?? false,
          },
        };
      });
    });
  }, [closeAll, hideEveryHumanBrowser]);

  const patchOverlay = useCallback(
    (ownerId: string, patch: (prev: BrowserOverlayState) => BrowserOverlayState) => {
      setOverlays((current) => {
        const prev = current[ownerId];
        if (!prev) {
          return current;
        }
        const next = patch(prev);
        return next === prev ? current : { ...current, [ownerId]: next };
      });
    },
    [],
  );

  const setSize = useCallback(
    (ownerId: string, size: BrowserOverlaySize) => patchOverlay(ownerId, (prev) => ({ ...prev, size })),
    [patchOverlay],
  );

  const setFullWidth = useCallback(
    (ownerId: string, fullWidth: boolean) =>
      patchOverlay(ownerId, (prev) => ({ ...prev, fullWidth })),
    [patchOverlay],
  );

  const setMode = useCallback(
    (ownerId: string, mode: BrowserOverlayMode, currentUrl?: string | null) =>
      patchOverlay(ownerId, (prev) => {
        if (prev.sandbox && mode === "agent") {
          return prev;
        }
        const transferableUrl = httpUrl(currentUrl);
        const nextUrl = mode === "webkit" && transferableUrl ? transferableUrl : prev.url;
        return {
          ...prev,
          mode,
          url: nextUrl,
          artifactId: nextUrl === prev.url ? prev.artifactId : null,
          reloadNonce:
            mode === "webkit" && nextUrl !== prev.url ? prev.reloadNonce + 1 : prev.reloadNonce,
        };
      }),
    [patchOverlay],
  );

  // The human browser reports its page's location as the user navigates.
  const setLocation = useCallback(
    (ownerId: string, nextUrl: string) => {
      const normalized = httpUrl(nextUrl);
      if (!normalized) {
        return;
      }
      patchOverlay(ownerId, (prev) =>
        !prev.open || prev.mode !== "webkit" || prev.sandbox || prev.url === normalized
          ? prev
          : { ...prev, url: normalized, artifactId: null },
      );
    },
    [patchOverlay],
  );

  const refreshActive = useCallback(() => {
    const ownerId = activeOwnerIdRef.current;
    if (!ownerId) {
      return;
    }
    const overlay = overlaysRef.current[ownerId];
    if (overlay?.open && overlay.mode === "webkit" && !overlay.sandbox) {
      void reloadHumanBrowser(ownerId).catch((err) => {
        onErrorRef.current(errorMessage(err));
      });
      return;
    }
    patchOverlay(ownerId, (prev) => ({ ...prev, reloadNonce: prev.reloadNonce + 1 }));
  }, [patchOverlay]);

  // Navigate the active overlay. A bare host (no scheme) gets http:// so
  // `localhost:5173` works; file paths still go through `session open`.
  const navigateActive = useCallback(
    (rawInput: string) => {
      const ownerId = activeOwnerIdRef.current;
      const trimmed = rawInput.trim();
      if (!ownerId || !trimmed) {
        return;
      }
      const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        return;
      }
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        openBrowserOverlay(ownerId, parsed.href);
      } else if (parsed.protocol === "mailto:") {
        void openExternalUrl(parsed.href);
      }
    },
    [openBrowserOverlay],
  );

  return {
    activeOwnerId,
    activeOverlay,
    linkMenu,
    closeLinkMenu: useCallback(() => setLinkMenu(null), []),
    openBrowserOverlay,
    openLink,
    linkActionsFor,
    closeActive,
    closeOnEscape,
    toggleSourceBrowser,
    setSize,
    setFullWidth,
    setMode,
    setLocation,
    refreshActive,
    navigateActive,
  };
}

export type BrowserOverlays = ReturnType<typeof useBrowserOverlays>;
