// What the app bar shows that is not the viewer: the channels for the strip,
// the Saved count, the unread notification count and the usage reading.
//
// The app bar's parts take these as props; `useShellData` reads them from
// the replica (02 §9.1).

import { useCallback, useEffect } from "react";

import { useOnlineData, useReplica, useReplicaQuery } from "../../replica/ReplicaProvider.js";
import { savedCountOf, unreadCountOf, useChannels, usePrefsLayout } from "../../replica/queries.js";
import { UNKNOWN } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import { useOnline } from "../../stores/connection.js";
import { useNavigationStore, type ChannelScope, type FeedLayout } from "../../stores/navigation.js";

import { currentReading, type UsageReading } from "./usage.js";
import { canWrite, type Viewer } from "./viewer.js";

/** One channel as the strip lists it. */
export interface ShellChannel {
  id: string;
  /** Without `#`. */
  name: string;
  private: boolean;
  /** The viewer is a member. */
  joined: boolean;
  /** The viewer owns it. */
  owned: boolean;
}

export interface ShellData {
  /** The channels of the current scope, in strip order. */
  channels: ShellChannel[];
  savedCount: number;
  unreadCount: number;
  /** The current week's reading; null while unknown (`currentReading`). */
  usage: UsageReading | null;
  /** Offline the ring names when its reading was taken (02 §2.2 item 4). */
  usageOffline: boolean;
}

/** The scopes the picker offers (`SCOPES`): signed out only All, which is
 * then the same list Joined would be; "Channels you manage" only for
 * accounts that can write. */
export function scopesFor(viewer: Viewer): ChannelScope[] {
  if (viewer.kind === "signedOut") return ["all"];
  return canWrite(viewer) ? ["joined", "yours", "all"] : ["joined", "all"];
}

/** The scope in effect: the stored one when the viewer is offered it. */
export function effectiveScope(viewer: Viewer, stored: ChannelScope): ChannelScope {
  const offered = scopesFor(viewer);
  return offered.includes(stored) ? stored : (offered[0] ?? "all");
}

/** The channels a scope lists, from every channel the viewer can read: Joined
 * lists the viewer's channels, "Channels you manage" those the viewer owns,
 * All every open channel and the private ones the viewer is in (01 C7). */
export function channelsInScope(all: readonly ShellChannel[], scope: ChannelScope): ShellChannel[] {
  switch (scope) {
    case "joined":
      return all.filter((channel) => channel.joined);
    case "yours":
      return all.filter((channel) => channel.owned);
    case "all":
      return all.filter((channel) => !channel.private || channel.joined);
  }
}

const EMPTY_CHANNELS: ShellChannel[] = [];

/** The app bar's data, from the replica (02 §9.1: `useChannels(scope)`, the
 * save records of the user log, `useNotifications()`) and the online data
 * (`useUsage()`; the fixture build's reading until M5b). */
export function useShellData(viewer: Viewer): ShellData & { scope: ChannelScope } {
  const stored = useNavigationStore((state) => state.scope);
  const scope = effectiveScope(viewer, stored);
  const channels = useChannels();
  const savedCount = useReplicaQuery(savedCountOf, []);
  const unreadCount = useReplicaQuery(unreadCountOf, []);
  const online = useOnlineData();
  const source = useReplica();
  const connected = useOnline();
  const all =
    channels === UNKNOWN
      ? EMPTY_CHANNELS
      : channels.map((c) => ({
          id: c.id,
          name: c.name,
          private: c.private,
          joined: c.joined,
          owned: c.owned,
        }));
  return {
    scope,
    channels: channelsInScope(all, scope),
    savedCount: savedCount === UNKNOWN ? 0 : savedCount,
    unreadCount: unreadCount === UNKNOWN ? 0 : unreadCount,
    usage: currentReading(online.usage, source.now()),
    usageOffline: !connected,
  };
}

/**
 * The feed layout (02 §3.1): the `prefs` record of the user log, applied to
 * `navigation` so the first paint does not wait for the replica. A change
 * from the replica (this account's other tab or device) is applied as it
 * arrives; the toggle applies at once and writes one `prefs.set`.
 */
export function useLayoutPreference(viewer: Viewer): {
  layout: FeedLayout;
  toggle: () => void;
} {
  const layout = useNavigationStore((state) => state.layout);
  const setLayout = useNavigationStore((state) => state.setLayout);
  const stored = usePrefsLayout();
  const writes = useWrites();
  useEffect(() => {
    if (stored === "centred" || stored === "wide") setLayout(stored);
  }, [stored, setLayout]);
  const toggle = useCallback(() => {
    const next: FeedLayout =
      useNavigationStore.getState().layout === "centred" ? "wide" : "centred";
    setLayout(next);
    if (canWrite(viewer)) void writes.setLayout(next);
  }, [setLayout, viewer, writes]);
  return { layout, toggle };
}
