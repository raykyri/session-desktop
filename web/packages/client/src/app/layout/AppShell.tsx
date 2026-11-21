import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useLogout, useMe } from "../../api/account.js";
import { AuthDialog } from "../../features/auth/AuthDialog.js";
import { openAuthDialog } from "../../features/auth/authDialog.js";
import { useAccountDialogs } from "../../features/auth/useAccountDialogs.js";
import { joinChannel } from "../../features/channels/ChannelHeader.js";
import { NewChannelDialog, useNewChannelDialog } from "../../features/channels/NewChannelDialog.js";
import { FeedViewerProvider } from "../../features/feed/FeedContext.js";
import { AppBar } from "../../features/shell/AppBar.js";
import { PageHeadingFocusContext } from "../../features/shell/Frames.js";
import { OutboxToast } from "../../features/shell/NotSent.js";
import { ToastHost } from "../../features/shell/Toast.js";
import { UpgradeNotice } from "../../features/shell/UpgradeNotice.js";
import { channelOfPath, isFeedPath, showsChannelStrip } from "../../features/shell/screens.js";
import { scopesFor, useLayoutPreference, useShellData } from "../../features/shell/shellData.js";
import { useBarAlign } from "../../features/shell/useBarAlign.js";
import { useBarAutoHide } from "../../features/shell/useBarAutoHide.js";
import { viewerOf, type Viewer } from "../../features/shell/viewer.js";
import { ReplicaProvider } from "../../replica/ReplicaProvider.js";
import { useWrites } from "../../replica/writes.js";
import { useOnline } from "../../stores/connection.js";
import { useNavigationStore } from "../../stores/navigation.js";
import { useOverlaysStore } from "../../stores/overlays.js";
import { DiagramLightbox, ImageLightbox } from "../../ui/Lightboxes.js";
import { NotificationStack } from "../../ui/NotificationStack.js";
import { useUserNotifications } from "../../ui/useUserNotifications.js";
import { SessionBoot } from "../SessionBoot.js";

/** An open Base UI dialog, popover, menu or select popup, if there is one.
 * Every Base UI layer has `data-open` while it is mounted and open; the
 * role narrows the match to the layers that own dismissal, so a hovering
 * tooltip (also `data-open`, but not dismissable) does not count. */
const BASE_UI_LAYER_SELECTOR =
  '[data-open][role="dialog"],[data-open][role="alertdialog"],' +
  '[data-open][role="menu"],[data-open][role="listbox"]';

/**
 * The application frame (02 §2): the app bar over one scroll container that
 * fills the viewport (W2.4), the routed screen inside it, the toasts and the
 * lightboxes.
 *
 * The bar is positioned over the scroll container, so hiding or showing it
 * never moves the page (02 §2.2 "Placement"); every screen reserves its
 * height (`.feed-inner`, `.page-inner`). On feeds it hides while scrolling
 * down (`useBarAutoHide`, W2.3) and, in layout `centred` above 860 px, it is
 * a floating card aligned to the feed's columns (`useBarAlign`).
 *
 * One capture-phase keydown listener gives Escape to the top of the overlay
 * stack (`stores/overlays`), for the layers Base UI does not own (02 §10.2).
 */
export function AppShell() {
  const me = useMe();
  const viewer = useMemo(() => viewerOf(me.data), [me.data]);
  return (
    <ReplicaProvider viewer={viewer}>
      <FeedViewerProvider viewer={viewer}>
        <ShellBody viewer={viewer} />
      </FeedViewerProvider>
    </ReplicaProvider>
  );
}

function ShellBody({ viewer }: { viewer: Viewer }) {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const logout = useLogout();
  const { notifications, dismiss } = useUserNotifications();
  const writes = useWrites();
  const openNewChannel = useNewChannelDialog((state) => state.setOpen);
  const online = useOnline();

  const { layout, toggle: toggleLayout } = useLayoutPreference(viewer);
  const setScope = useNavigationStore((state) => state.setScope);

  // Pages focus their heading on a route change, not on the screen the app
  // loaded on (02 §10.1). Set during render, so the page the first
  // navigation mounts already reads it.
  const [initialPathname] = useState(pathname);
  const [navigated, setNavigated] = useState(false);
  if (!navigated && pathname !== initialPathname) setNavigated(true);

  const isFeed = isFeedPath(pathname);
  const showStrip = showsChannelStrip(pathname);
  const data = useShellData(viewer);

  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const bar = useBarAutoHide(scroller, isFeed, menuOpen);
  const alignment = useBarAlign(shell, scroller, layout, isFeed);

  // A new screen starts at its top (the mock's `scrollTop = 0` on a channel
  // change). A thread address (`?t=`) scrolls to its row once the feed has
  // loaded it (02 §2.1).
  useLayoutEffect(() => {
    scroller?.scrollTo({ top: 0 });
  }, [scroller, pathname]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      // Base UI dismisses its own dialogs, menus and popovers with correct
      // nesting; while one is open the shell stands down.
      if (document.querySelector(BASE_UI_LAYER_SELECTOR)) return;
      if (useOverlaysStore.getState().dismissTop()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // Sign in and Join with invite open the auth dialog (02 W7.2).
  const openSignIn = useCallback(() => openAuthDialog({ step: "landing" }), []);
  const openJoin = useCallback(() => openAuthDialog({ step: "code" }), []);
  useAccountDialogs(viewer);

  const signOut = useCallback(() => {
    logout.mutate(undefined, {
      onSettled: () => {
        void router.invalidate();
        void navigate({ to: "/" });
      },
    });
  }, [logout, navigate, router]);

  const style = alignment
    ? ({ "--bl": `${alignment.left}px`, "--bw": `${alignment.width}px` } as CSSProperties)
    : undefined;

  return (
    <div
      ref={setShell}
      className="app-shell bg-surface-feed text-fg-primary"
      data-bar-aligned={alignment ? "" : undefined}
      data-bar-hidden={bar.hidden ? "" : undefined}
      style={style}
    >
      <SessionBoot />
      <div
        ref={barRef}
        className="app-bar-slot"
        data-hidden={bar.hidden ? "" : undefined}
        onFocus={bar.onFocusIn}
        onBlur={(event) => bar.onFocusOut(event.relatedTarget, barRef.current)}
      >
        <AppBar
          viewer={viewer}
          showStrip={showStrip}
          isFeed={isFeed}
          scopes={scopesFor(viewer)}
          scope={data.scope}
          onScopeChange={setScope}
          channels={data.channels}
          currentChannel={channelOfPath(pathname)}
          onJoin={(channel) => void joinChannel(writes, channel)}
          onNewChannel={() => openNewChannel(true)}
          usage={data.usage}
          savedCount={data.savedCount}
          onSaved={pathname === "/saved"}
          layout={layout}
          onToggleLayout={toggleLayout}
          unreadCount={data.unreadCount}
          onSignIn={openSignIn}
          onJoinWithInvite={openJoin}
          onSignOut={signOut}
          onMenuOpenChange={setMenuOpen}
        />
      </div>
      <div ref={setScroller} className="app-scroll" data-shell-scroll="">
        <PageHeadingFocusContext.Provider value={navigated}>
          <Outlet />
        </PageHeadingFocusContext.Provider>
      </div>
      <NewChannelDialog online={online} />
      <AuthDialog />
      <ToastHost />
      <OutboxToast />
      <UpgradeNotice />
      <ImageLightbox />
      <DiagramLightbox />
      <NotificationStack notifications={notifications} onDismiss={dismiss} />
    </div>
  );
}
