// What the app bar shows that is not the viewer: the channels for the strip,
// the Saved count, the unread notification count and the usage reading.
//
// The app bar's parts take these as props. `useShellData` is the stub that
// feeds them until the replica lands (02 §9.1): `useChannels(scope)` for the
// strip, the save records of the user log for the Saved count,
// `useNotifications()` for the unread count, and `useUsage()` (`usage.get`,
// M5b) for the ring. Until then the strip is empty, both counts are zero and
// the ring reads an unused allowance.

import { useNavigationStore, type ChannelScope } from "../../stores/navigation.js";

import type { UsageReading } from "./usage.js";
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
  usage: UsageReading;
}

/** Included tokens per member per week (03 K3). */
export const WEEKLY_ALLOWANCE = 2_000_000;

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

/** Stub source of the app bar's data; see the head of this file. */
export function useShellData(viewer: Viewer): ShellData & { scope: ChannelScope } {
  const stored = useNavigationStore((state) => state.scope);
  const scope = effectiveScope(viewer, stored);
  return {
    scope,
    channels: channelsInScope(EMPTY_CHANNELS, scope),
    savedCount: 0,
    unreadCount: 0,
    usage: { used: 0, allowance: WEEKLY_ALLOWANCE, resetsAt: null },
  };
}
