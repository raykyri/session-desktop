import BrowserOverlay from "./BrowserOverlay";
import LinkContextMenu from "./LinkContextMenu";
import type { BrowserOverlays } from "../hooks/useBrowserOverlays";
import {
  browserOpenLocalPathExternal,
  browserOpenPreviewExternal,
  browserRevealLocalPath,
  openExternalUrl,
} from "../lib/api";
import { IS_MAC } from "../lib/appHelpers";
import {
  canPreviewLocalFilePath,
  canRenderInInternalBrowser,
  isFileServerUrl,
  pathFromSessionFileHref,
} from "../lib/links";

const EXPAND_TOGGLE_SHORTCUT_LABEL = "⌘⇧E / Ctrl+Shift+E";

interface BrowserOverlayLayerProps {
  browser: BrowserOverlays;
  bodyFontId: string;
  /** An app-level dialog, menu, toast or notification covers the window. */
  occluded: boolean;
  fileServerPort: number | null;
  onError: (message: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The active owner's browser overlay and the link context menu. */
export default function BrowserOverlayLayer({
  browser,
  bodyFontId,
  occluded,
  fileServerPort,
  onError,
}: BrowserOverlayLayerProps) {
  const { activeOwnerId: ownerId, activeOverlay: overlay, linkMenu } = browser;
  const linkMenuLocalPath = linkMenu ? pathFromSessionFileHref(linkMenu.url) : undefined;
  const linkMenuOwnerId = linkMenu?.ownerId ?? null;
  return (
    <>
      {ownerId && overlay?.open ? (
        <BrowserOverlay
          key={ownerId}
          paneId={ownerId}
          url={overlay.url}
          reloadNonce={overlay.reloadNonce}
          sandbox={overlay.sandbox}
          mode={overlay.mode}
          bodyFontId={bodyFontId}
          size={overlay.size}
          fullWidth={overlay.fullWidth ?? false}
          toggleShortcutLabel={EXPAND_TOGGLE_SHORTCUT_LABEL}
          occluded={occluded}
          onNavigate={browser.navigateActive}
          onLocationChange={(url) => browser.setLocation(ownerId, url)}
          onRefresh={browser.refreshActive}
          onOpenExternal={(currentUrl) => {
            if (!currentUrl) {
              return;
            }
            if (isFileServerUrl(currentUrl, fileServerPort)) {
              void browserOpenPreviewExternal(currentUrl).catch((err) => {
                onError(errorMessage(err));
              });
              return;
            }
            void openExternalUrl(currentUrl);
          }}
          onClose={browser.closeActive}
          onModeChange={(mode, currentUrl) => browser.setMode(ownerId, mode, currentUrl)}
          onResize={(size) => browser.setSize(ownerId, size)}
          onFullWidthChange={(fullWidth) => browser.setFullWidth(ownerId, fullWidth)}
        />
      ) : null}
      {linkMenu ? (
        <LinkContextMenu
          x={linkMenu.x}
          y={linkMenu.y}
          canOpenInternal={
            linkMenuOwnerId !== null &&
            (canRenderInInternalBrowser(linkMenu.url) ||
              (linkMenuLocalPath !== undefined && canPreviewLocalFilePath(linkMenuLocalPath)))
          }
          onOpenInternal={() => {
            browser.openLink(linkMenu.ownerId, linkMenu.url);
            browser.closeLinkMenu();
          }}
          onOpenExternal={() => {
            if (linkMenuLocalPath !== undefined && linkMenuOwnerId !== null) {
              void browserRevealLocalPath(linkMenuOwnerId, linkMenuLocalPath).catch((err) => {
                onError(errorMessage(err));
              });
            } else {
              void openExternalUrl(linkMenu.url).catch((err) => {
                onError(errorMessage(err));
              });
            }
            browser.closeLinkMenu();
          }}
          externalLabel={
            linkMenuLocalPath !== undefined
              ? IS_MAC
                ? "Reveal in Finder"
                : "Reveal in file manager"
              : undefined
          }
          externalKind={linkMenuLocalPath !== undefined ? "reveal" : undefined}
          onOpenWithDefaultApp={
            linkMenuLocalPath !== undefined && linkMenuOwnerId !== null
              ? () => {
                  void browserOpenLocalPathExternal(linkMenuOwnerId, linkMenuLocalPath).catch(
                    (err) => {
                      onError(errorMessage(err));
                    },
                  );
                  browser.closeLinkMenu();
                }
              : null
          }
          onClose={browser.closeLinkMenu}
        />
      ) : null}
    </>
  );
}
