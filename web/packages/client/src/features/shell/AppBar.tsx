// The app bar (02 §2.2; `appbar`, `appbarOut`), left to right: the name as
// the home button, the scope picker and channel strip, then the usage ring,
// Saved, the layout toggle (feeds only) and the account menu. Accounts
// without an invite get no ring, Saved or layout toggle. Signed out it is
// the name, the strip of open channels, "Join with invite" and "Sign in".
//
// Every part takes its data as props; `AppShell` feeds them.

import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/cn.js";
import type { ChannelScope, FeedLayout } from "../../stores/navigation.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { AccountMenu } from "./AccountMenu.js";
import { ChannelStrip } from "./ChannelStrip.js";
import { LayoutToggle } from "./LayoutToggle.js";
import { SavedButton } from "./SavedButton.js";
import { ScopePicker } from "./ScopePicker.js";
import { UsageRing } from "./UsageRing.js";
import { AgentIcon } from "./icons.js";
import type { ShellChannel } from "./shellData.js";
import type { UsageReading } from "./usage.js";
import { canWrite, type Viewer } from "./viewer.js";

/** The app's name as the home button (`brandBtn`). At 520 px and below only the
 * mark shows, so the strip has room. */
export function BrandButton() {
  return (
    <Link
      to="/"
      search={{}}
      aria-label="Session home"
      className={cn(
        "text-fg-heading text-md -ml-1.5 inline-flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1",
        FOCUS_RING,
      )}
    >
      <span
        aria-hidden="true"
        className="bg-accent-soft text-accent inline-grid size-5 place-items-center rounded-md"
      >
        <AgentIcon />
      </span>
      <b className="phone:hidden">Session</b>
    </Link>
  );
}

export interface AppBarProps {
  viewer: Viewer;
  /** Whether the route shows the channel strip (02 §2.2 item 3). */
  showStrip: boolean;
  /** Whether the route is a feed: the layout toggle shows. */
  isFeed: boolean;
  scopes: readonly ChannelScope[];
  scope: ChannelScope;
  onScopeChange: (scope: ChannelScope) => void;
  /** Null while the replica loads them. */
  channels: readonly ShellChannel[] | null;
  currentChannel: string | null;
  onJoin?: ((channel: ShellChannel) => void) | undefined;
  onNewChannel?: (() => void) | undefined;
  usage: UsageReading | null;
  usageOffline?: boolean;
  /** Null while the replica loads the saves. */
  savedCount: number | null;
  onSaved: boolean;
  layout: FeedLayout;
  onToggleLayout: () => void;
  unreadCount: number;
  onSignIn: () => void;
  onJoinWithInvite: () => void;
  onSignOut: () => void;
  /** Called when one of the bar's menus opens or closes. */
  onMenuOpenChange?: (open: boolean) => void;
}

export function AppBar(props: AppBarProps) {
  const { viewer } = props;
  const writer = canWrite(viewer);
  return (
    <header className="app-bar bg-surface-header border-border-divider phone:gap-2 flex h-12 items-center border-b">
      <BrandButton />
      <div className="phone:ml-0 ml-1.5 flex h-full min-w-0 flex-1 items-center gap-1.5">
        {props.showStrip ? (
          <>
            <ScopePicker
              scopes={props.scopes}
              scope={props.scope}
              onScopeChange={props.onScopeChange}
              {...(props.onMenuOpenChange ? { onOpenChange: props.onMenuOpenChange } : {})}
            />
            <ChannelStrip
              channels={props.channels}
              scope={props.scope}
              current={props.currentChannel}
              canWrite={writer}
              onJoin={props.onJoin}
              onNewChannel={props.onNewChannel}
            />
          </>
        ) : null}
      </div>
      {viewer.kind === "signedOut" ? (
        <>
          <button
            type="button"
            onClick={props.onJoinWithInvite}
            className={cn(
              "text-fg-secondary hover:bg-surface-fill-hover hover:text-fg-heading h-[30px] shrink-0 rounded-[15px] px-3 text-sm font-medium",
              FOCUS_RING,
            )}
          >
            Join with invite
          </button>
          <button
            type="button"
            onClick={props.onSignIn}
            className={cn(
              "bg-accent-strong text-fg-on-accent inline-flex h-7 shrink-0 items-center rounded-[14px] px-3 text-xs font-semibold",
              FOCUS_RING,
            )}
          >
            Sign in
          </button>
        </>
      ) : (
        <>
          {viewer.kind === "member" ? (
            <>
              <UsageRing reading={props.usage} offline={props.usageOffline ?? false} />
              <SavedButton count={props.savedCount} current={props.onSaved} />
              {props.isFeed ? (
                <LayoutToggle layout={props.layout} onToggle={props.onToggleLayout} />
              ) : null}
            </>
          ) : null}
          <AccountMenu
            viewer={viewer}
            unreadCount={props.unreadCount}
            onSignOut={props.onSignOut}
            {...(props.onMenuOpenChange ? { onOpenChange: props.onMenuOpenChange } : {})}
          />
        </>
      )}
    </header>
  );
}
