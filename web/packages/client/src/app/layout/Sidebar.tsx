import { Link, useNavigate } from "@tanstack/react-router";
import { PanelLeftClose } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { useLogout, useMe } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useNavigationStore,
} from "../../stores/navigation.js";
import { useSettingsStore } from "../../stores/settings.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import { ShortcutHint } from "../../ui/Field.js";
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.js";

const NAV_ITEMS = [
  { to: "/", label: "Home", shortcut: "⌃1" },
  { to: "/bookmarks", label: "Bookmarks", shortcut: "⌃2" },
  { to: "/highlights", label: "Highlights", shortcut: "⌃3" },
] as const;

/**
 * The sidebar frame: workspace/thread/folder/encyclopedia sections land here in
 * Phase 6 (09, 10). What exists now is the part the shell owns — the resize
 * handle, the collapsed state, and the top-level navigation — so the routes and
 * the shortcut dispatcher have something real to drive.
 */
/** The account row in the sidebar footer: who is signed in, and the way out
 * (07 §3). `auth.logout` deletes the session rows; the Hono layer clears the
 * cookie on the same response, so the navigation that follows lands on
 * `/login` with no session to find. */
function AccountMenu() {
  const navigate = useNavigate();
  const me = useMe();
  const logout = useLogout();
  const user = me.data;
  if (!user) return null;

  return (
    <div className="border-border-divider flex items-center gap-2 border-t px-2 py-2">
      <Menu
        side="top"
        align="start"
        label="Account"
        trigger={
          <ControlButton size="sm" className="min-w-0 flex-1 justify-start gap-2">
            <span className="min-w-0 truncate">{user.login}</span>
          </ControlButton>
        }
      >
        {user.isAdmin ? (
          <>
            <MenuItem onClick={() => void navigate({ to: "/admin" })}>Admin</MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem onClick={() => void navigate({ to: "/settings" })} hint="⌘,">
          Settings
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            logout.mutate(undefined, {
              // Whatever the server said, this tab is done with the session.
              onSettled: () => void navigate({ to: "/login" }),
            });
          }}
        >
          Sign out
        </MenuItem>
      </Menu>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useNavigationStore((state) => state.sidebarCollapsed);
  const width = useNavigationStore((state) => state.sidebarWidth);
  const setSidebarWidth = useNavigationStore((state) => state.setSidebarWidth);
  const setCollapsed = useNavigationStore((state) => state.setSidebarCollapsed);
  const showShortcutHints = useSettingsStore((state) => state.settings.showShortcutHints);
  const draggingRef = useRef(false);

  // Pointer capture on the handle rather than listeners on the shell: a drag
  // that leaves the window still ends, and the text selection a bare mousemove
  // drag would paint never starts.
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
  }, []);

  const onResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      setSidebarWidth(event.clientX);
    },
    [setSidebarWidth],
  );

  const endResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", collapsed ? "0px" : `${width}px`);
  }, [collapsed, width]);

  if (collapsed) return null;

  return (
    <div
      className="border-border-divider bg-surface-sidebar relative flex h-full shrink-0 flex-col border-r"
      style={{ width }}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-fg-heading text-sm font-semibold">Session</span>
        <IconButton
          label="Hide sidebar"
          title="Hide sidebar (⇧⌘G)"
          onClick={() => setCollapsed(true)}
        >
          <PanelLeftClose size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <nav aria-label="Sections" className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            className={cn(
              "min-h-control-md flex items-center gap-2 rounded-md px-2.5 text-base",
              "text-fg-secondary no-underline transition-colors duration-[120ms]",
              "hover:bg-surface-sidebar-hover hover:text-fg-strong",
              "data-[status=active]:bg-surface-sidebar-hover data-[status=active]:text-fg-strong",
            )}
            activeProps={{ "aria-current": "page" }}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {showShortcutHints ? <ShortcutHint>{item.shortcut}</ShortcutHint> : null}
          </Link>
        ))}
      </nav>

      <div className="flex-1" />

      <AccountMenu />

      {/* The splitter. `role="slider"` rather than `separator`: a focusable
          window splitter is a widget, and the slider role is the one that
          carries a keyboard-adjustable value, so the width is reachable
          without a pointer drag. */}
      <div
        role="slider"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        tabIndex={0}
        className="hover:bg-accent-soft absolute inset-y-0 -right-1 w-2 cursor-col-resize"
        onPointerDown={startResize}
        onPointerMove={onResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setSidebarWidth(width - 16);
          else if (event.key === "ArrowRight") setSidebarWidth(width + 16);
        }}
      />
    </div>
  );
}
