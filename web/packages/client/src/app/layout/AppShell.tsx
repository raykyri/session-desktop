import { appShortcutAllowsRepeat, isEditableTarget, resolveAppShortcut } from "@session/shared";
import type { AppShortcutCommand } from "@session/shared";
import { Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useTreeSummaries } from "../../api/queries.js";
import { ArtifactPanel } from "../../features/artifacts/ArtifactPanel.js";
import { buildPaletteCommands } from "../../features/palette/commands.js";
import { useWorkspaceScope } from "../../features/sidebar/scope.js";
import { useNavigationStore } from "../../stores/navigation.js";
import { useOverlaysStore } from "../../stores/overlays.js";
import { CommandPalette, type PaletteCommand } from "../../ui/CommandPalette.js";
import { DiagramLightbox, ImageLightbox } from "../../ui/Lightboxes.js";
import { NotificationStack } from "../../ui/NotificationStack.js";
import { useUserNotifications } from "../../ui/useUserNotifications.js";
import { SessionBoot } from "../SessionBoot.js";

import { Sidebar } from "./Sidebar.js";
import { StageHeader } from "./StageHeader.js";

/** The routes Cmd-1..9 and Ctrl-Tab cycle through, in sidebar order. Trees
 * join this list once `research.listTrees` is wired. */
const TAB_ROUTES = ["/", "/bookmarks", "/highlights"] as const;

/** An open Base UI dialog, popover, menu or select popup, if there is one.
 * Every Base UI layer carries `data-open` while it is mounted and open; the
 * role narrows the match to the layers that own dismissal, so a hovering
 * tooltip (also `data-open`, but not dismissable) does not count. */
const BASE_UI_LAYER_SELECTOR =
  '[data-open][role="dialog"],[data-open][role="alertdialog"],' +
  '[data-open][role="menu"],[data-open][role="listbox"]';

/**
 * The application frame (07 §1, §4.4, §5): sidebar, stage header, the routed
 * view, the two lightboxes, the toast region, and the command palette.
 *
 * It installs exactly one capture-phase keydown listener, which does two
 * things in order:
 *
 * 1. Escape goes to the top of the overlay stack, if anything is on it. Base UI
 *    dismisses its own dialogs, menus and popovers with correct nesting, so
 *    only non-library layers register (07 §4.4).
 * 2. Every other key goes through `resolveAppShortcut`, the one chord table
 *    (07 §5). Keystrokes aimed at a text field are not chords, so an editable
 *    target ends the dispatch.
 *
 * This replaces `App.tsx:9094-9220`, where the dismissal order was a hand-
 * maintained sequence of `if` branches.
 */
export function AppShell() {
  const router = useRouter();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);
  const { notifications, dismiss } = useUserNotifications();
  const { workspaceId } = useWorkspaceScope();
  const trees = useTreeSummaries({ workspaceId });

  const runCommand = useCallback(
    (command: AppShortcutCommand) => {
      switch (command.type) {
        case "focusResearchTab": {
          const path = TAB_ROUTES[command.tabIndex];
          if (path) void navigate({ to: path });
          return;
        }
        case "focusResearchHome":
          void navigate({ to: "/" });
          return;
        case "cycleResearchTab": {
          const current = TAB_ROUTES.indexOf(
            router.state.location.pathname as (typeof TAB_ROUTES)[number],
          );
          const from = current === -1 ? 0 : current;
          const next =
            TAB_ROUTES[(from + command.direction + TAB_ROUTES.length) % TAB_ROUTES.length];
          if (next) void navigate({ to: next });
          return;
        }
        case "openSettings":
          void navigate({ to: "/settings" });
          return;
        case "openCommandPalette":
          setPaletteOpen(true);
          return;
        case "toggleLeftSidebar":
          toggleSidebar();
          return;
        case "focusFollowups":
        case "openFolderMenu":
        case "toggleArtifactPanel":
        case "moveResearchItem":
          // Owned by the mounted view rather than the shell: the shell
          // re-dispatches as a window event and the route consumes it (07 §5).
          window.dispatchEvent(new CustomEvent("session:shortcut", { detail: command }));
          return;
      }
    },
    [navigate, router, toggleSidebar],
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

      const target = event.target;
      const editableTarget =
        target instanceof HTMLElement
          ? isEditableTarget({
              tagName: target.tagName,
              isContentEditable: target.isContentEditable,
            })
          : false;

      // `editableTarget` is passed in, not acted on here: which chords a text
      // field swallows is a property of the chord, and the shared table owns
      // it (`shared/app/shortcuts.ts`). A blanket return would kill Cmd-K and
      // Cmd-J exactly where they are most used.
      const command = resolveAppShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        editableTarget,
      });
      if (!command) return;
      // Only the reorder command repeats while held; every other chord would
      // fire a burst of navigations on key repeat.
      if (event.repeat && !appShortcutAllowsRepeat(command)) return;

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
        openTree: (treeId) => void navigate({ to: "/r/$treeId", params: { treeId }, search: {} }),
        openHome: () => void navigate({ to: "/" }),
        toggleSidebar,
        openSettings: () => void navigate({ to: "/settings" }),
      })
    : [];

  return (
    <div className="bg-surface-workspace text-fg-primary flex h-full w-full overflow-hidden">
      <SessionBoot />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <StageHeader />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <ArtifactPanel />
      <ImageLightbox />
      <DiagramLightbox />
      <NotificationStack notifications={notifications} onDismiss={dismiss} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
