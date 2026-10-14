import { resolveAppShortcut } from "@session/shared";
import type { AppShortcutCommand } from "@session/shared";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useSignedIn, useTreeSummaries } from "../../api/queries.js";
import { FolderDialogsHost } from "../../features/home/FolderDialogsHost.js";
import { buildPaletteCommands } from "../../features/palette/commands.js";
import { useWorkspaceScope, workspaceSearch } from "../../features/sidebar/scope.js";
import { DeleteOfferHost } from "../../features/thread/DeleteOfferHost.js";
import { requestHomeComposerFocus } from "../../stores/homeFocus.js";
import { useNavigationStore } from "../../stores/navigation.js";
import { useOverlaysStore } from "../../stores/overlays.js";
import { CommandPalette, type PaletteCommand } from "../../ui/CommandPalette.js";
import { DiagramLightbox, ImageLightbox } from "../../ui/Lightboxes.js";
import { NotificationStack } from "../../ui/NotificationStack.js";
import { useUserNotifications } from "../../ui/useUserNotifications.js";
import { SessionBoot } from "../SessionBoot.js";

import { Sidebar } from "./Sidebar.js";

/** An open Base UI dialog, popover, menu or select popup, if there is one.
 * Every Base UI layer has `data-open` while it is mounted and open; the
 * role narrows the match to the layers that own dismissal, so a hovering
 * tooltip (also `data-open`, but not dismissable) does not count. */
const BASE_UI_LAYER_SELECTOR =
  '[data-open][role="dialog"],[data-open][role="alertdialog"],' +
  '[data-open][role="menu"],[data-open][role="listbox"]';

/**
 * The application frame (07 §1, §4.4, §5): sidebar, the routed view, the two
 * lightboxes, the toast region, and the command palette. There is no bar above
 * the routed view: page-level back/forward is the browser's (ADR-7), and the
 * only shell control beside the stage is the sidebar restore button, shown in
 * a slim column while the sidebar is collapsed.
 *
 * It installs exactly one capture-phase keydown listener, which does two
 * things in order:
 *
 * 1. Escape goes to the top of the overlay stack, if anything is on it. Base UI
 *    dismisses its own dialogs, menus and popovers with correct nesting, so
 *    only non-library layers register (07 §4.4).
 * 2. Every other key goes through `resolveAppShortcut`, the one chord table
 *    (07 §5). Every chord in it also works from a text field.
 *
 * This replaces `App.tsx:9094-9220`, where the dismissal order was a hand-
 * maintained sequence of `if` branches.
 */
export function AppShell() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);
  const signedIn = useSignedIn();
  const { notifications, dismiss } = useUserNotifications();
  const { workspaceId } = useWorkspaceScope();
  const trees = useTreeSummaries({ workspaceId });

  const runCommand = useCallback(
    (command: AppShortcutCommand) => {
      switch (command.type) {
        case "focusResearchHome":
          // Home, with the caret in its ask box.
          requestHomeComposerFocus();
          void navigate({ to: "/", search: workspaceSearch });
          return;
        case "openSettings":
          void navigate({ to: "/settings", search: workspaceSearch });
          return;
        case "openCommandPalette":
          setPaletteOpen(true);
          return;
        case "toggleLeftSidebar":
          toggleSidebar();
          return;
        case "focusFollowups":
        case "openWorkspaceMenu":
          // Owned by the mounted view rather than the shell: the shell
          // re-dispatches as a window event and the route consumes it (07 §5).
          window.dispatchEvent(new CustomEvent("session:shortcut", { detail: command }));
          return;
      }
    },
    [navigate, toggleSidebar],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      // The shell stands down while a library layer is open (07 §4.4, §5).
      // Base UI dismisses its own dialogs, menus and popovers with correct
      // nesting, so taking Escape here would close a lightbox underneath the
      // dialog the user is actually looking at; and an app chord fired from
      // inside a dialog would act on the page behind it.
      if (document.querySelector(BASE_UI_LAYER_SELECTOR)) return;

      if (event.key === "Escape") {
        if (useOverlaysStore.getState().dismissTop()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      const command = resolveAppShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
      if (!command) return;
      // A held chord would fire a burst of navigations on key repeat.
      if (event.repeat) return;

      event.preventDefault();
      event.stopPropagation();
      runCommand(command);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [runCommand]);

  // Built only while the palette is open (`App.tsx:8098`): a list rebuilt on
  // every render of a closed dialog is work nobody sees.
  const commands: PaletteCommand[] = paletteOpen
    ? buildPaletteCommands(trees.data ?? [], {
        openTree: (treeId) =>
          void navigate({
            to: "/r/$treeId",
            params: { treeId },
            search: workspaceSearch,
          }),
        openHome: () => void navigate({ to: "/", search: workspaceSearch }),
        toggleSidebar,
        openSettings: () => void navigate({ to: "/settings", search: workspaceSearch }),
      })
    : [];

  return (
    <div className="bg-surface-workspace text-fg-primary flex h-full w-full overflow-hidden">
      <SessionBoot />
      <Sidebar />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      <ImageLightbox />
      <DiagramLightbox />
      <NotificationStack
        notifications={notifications}
        onDismiss={dismiss}
        // A server notification names the in-app path it is about
        // (`notification.requested` `href`).
        onOpen={(href) => {
          if (href.startsWith("/") && !href.startsWith("//")) void navigate({ href });
        }}
      />
      {signedIn ? <FolderDialogsHost /> : null}
      {signedIn ? <DeleteOfferHost /> : null}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
