import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import { ChevronUp, PanelLeftClose } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLogout, useMe } from "../../api/queries.js";
import memMonochromeLightLogoUrl from "../../assets/brand/mem-monochrome-light.svg";
import memMonochromeLogoUrl from "../../assets/brand/mem-monochrome.svg";
import { SidebarBody } from "../../features/sidebar/SidebarBody.js";
import { SIDEBAR_ROW } from "../../features/sidebar/rows.js";
import { useResolvedAppearance } from "../../lib/appearance.js";
import { cn } from "../../lib/cn.js";
import { formatChord } from "../../lib/platform.js";
import {
  NARROW_LAYOUT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useNavigationStore,
} from "../../stores/navigation.js";
import { selectAppearance, useSettingsStore } from "../../stores/settings.js";
import { IconButton } from "../../ui/Button.js";
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.js";
import { DIALOG_BACKDROP } from "../../ui/surfaces.js";

/** The sidebar account footer displaying the current user profile and sign-out controls.). `auth.logout` deletes the session rows; the Hono layer clears the
 * cookie on the same response, so the navigation that follows lands on
 * `/login` with no session to find. */
function AccountMenu() {
  const navigate = useNavigate();
  const me = useMe();
  const logout = useLogout();
  const user = me.data;
  if (!user) return null;

  return (
    <div className="flex items-center gap-2 px-2 pt-0.5 pb-2">
      <Menu
        side="top"
        align="start"
        label="Account"
        trigger={
          <button type="button" className={cn(SIDEBAR_ROW, "border-0 bg-transparent text-left")}>
            <span className="min-w-0 flex-1 truncate">{user.login}</span>
            <ChevronUp size={14} aria-hidden="true" className="shrink-0" />
          </button>
        }
      >
        {user.isAdmin ? (
          <>
            <MenuItem
              onClick={() => void navigate({ to: "/admin", search: (previous) => previous })}
            >
              Admin
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem
          onClick={() => void navigate({ to: "/settings", search: (previous) => previous })}
          hint={formatChord("mod+,")}
        >
          Settings
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            logout.mutate(undefined, {
              // Clear local session state and redirect to login regardless of server logout response.
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

/** True while the viewport is narrower than the drawer breakpoint (08 §7). */
export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    // `matchMedia` is the only layout measurement the shell makes, and jsdom
    // ships without it; absent, the layout is the wide one, which is what a
    // test renders against.
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(max-width: ${NARROW_LAYOUT_WIDTH - 1}px)`);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return narrow;
}

/** The sidebar's top row: the desktop's monochrome "M" mark (20px wide, one
 * file per appearance) and the hide control. */
function SidebarChrome({ onHide }: { onHide: () => void }) {
  const appearance = useResolvedAppearance(useSettingsStore(selectAppearance));
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-2.5">
      <span className="flex items-center px-0.5" aria-label="Session">
        <img
          src={appearance === "light" ? memMonochromeLightLogoUrl : memMonochromeLogoUrl}
          alt=""
          aria-hidden="true"
          className="block h-auto w-5"
        />
      </span>
      <IconButton
        label="Hide sidebar"
        title={`Hide sidebar (${formatChord("mod+shift+g")})`}
        onClick={onHide}
      >
        <PanelLeftClose size={16} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useNavigationStore((state) => state.sidebarCollapsed);
  const width = useNavigationStore((state) => state.sidebarWidth);
  const setSidebarWidth = useNavigationStore((state) => state.setSidebarWidth);
  const setCollapsed = useNavigationStore((state) => state.setSidebarCollapsed);
  const narrow = useNarrowLayout();
  const draggingRef = useRef(false);

  // Crossing into the narrow layout closes the drawer: a column that was open
  // beside the page would otherwise reappear as a sheet covering it.
  useEffect(() => {
    if (narrow) setCollapsed(true);
  }, [narrow, setCollapsed]);

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
    document.documentElement.style.setProperty(
      "--sidebar-width",
      collapsed || narrow ? "0px" : `${width}px`,
    );
  }, [collapsed, narrow, width]);

  // Under the breakpoint the column would leave no room for the reading
  // surface, so the same body becomes a dismissable drawer over it (08 §7).
  // `collapsed` doubles as the drawer's open flag, so the shell's restore
  // button and Shift-Cmd-G drive both layouts.
  if (narrow) {
    return (
      <BaseDialog.Root open={!collapsed} onOpenChange={(open) => setCollapsed(!open)}>
        <BaseDialog.Portal>
          <BaseDialog.Backdrop className={DIALOG_BACKDROP} />
          <BaseDialog.Popup
            aria-label="Sidebar"
            className={cn(
              "border-border-divider bg-surface-sidebar fixed inset-y-0 left-0 z-(--z-dialog)",
              "shadow-dialog flex w-[min(320px,85vw)] flex-col border-r",
            )}
          >
            <SidebarChrome onHide={() => setCollapsed(true)} />
            <SidebarBody />
            <AccountMenu />
          </BaseDialog.Popup>
        </BaseDialog.Portal>
      </BaseDialog.Root>
    );
  }

  if (collapsed) return null;

  return (
    <div
      className="border-border-divider bg-surface-sidebar relative flex h-full shrink-0 flex-col border-r"
      style={{ width }}
    >
      <SidebarChrome onHide={() => setCollapsed(true)} />
      <SidebarBody />
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
        className="hover:bg-accent-soft/50 absolute inset-y-0 -right-1 w-2 cursor-col-resize"
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
