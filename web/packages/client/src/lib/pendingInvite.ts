// Invite codes carried in a URL fragment (02 §2.1, 04 §3.2, §5): an account
// invite link (`/i#<code>`) or a channel invite link (`/c/<name>#<code>`).
//
// The fragment is never sent with a request. On page load it is read before
// the router or any request starts (`app/captureInvite.ts`), removed from the
// address bar with `history.replaceState`, and kept in memory. A navigation
// inside the app to `/i#<code>` or `/c/<name>#<code>` is caught by its route
// (`app/router.tsx`) the same way. The code is not in the history or in a
// sign-in redirect. The auth dialog (02 W7.2) and channel join (W6.9) read
// it from here.
//
// A channel invite also survives the provider sign-in round trip: starting a
// sign-in writes it to this tab's `sessionStorage` (`CHANNEL_INVITE_KEY`),
// and the next page load moves it back into memory and removes it from
// storage. It expires 30 minutes after it was written. The only request that
// carries it is the `spaces.join` that redeems it.

export type PendingInvite =
  { kind: "account"; code: string } | { kind: "channel"; channel: string; code: string };

/** The path an account invite link opens. */
export const INVITE_PATH = "/i";

/** The `sessionStorage` key of a channel invite kept across a sign-in. */
export const CHANNEL_INVITE_KEY = "session.channelInvite";

/** How long a channel invite kept across a sign-in stays usable. */
export const CHANNEL_INVITE_TTL_MS = 30 * 60 * 1000;

let pending: PendingInvite | null = null;

export function savePendingInvite(invite: PendingInvite): void {
  pending = invite;
}

export function readPendingInvite(): PendingInvite | null {
  return pending;
}

export function clearPendingInvite(): void {
  pending = null;
}

/** The channel a pending channel invite is for, or null. An account that
 * becomes a member while one waits goes to that channel's page, which joins
 * it (`useChannelInvite`). A new identity's sign-in returns to `/welcome`,
 * not to the channel, so the channel page would otherwise never mount. */
export function pendingInviteChannel(): string | null {
  return pending?.kind === "channel" ? pending.channel : null;
}

type TabStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): TabStore | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Before the page leaves for a sign-in provider: writes the pending channel
 * invite, if there is one, to this tab's `sessionStorage` with the time.
 */
export function keepChannelInviteForSignIn(
  storage: TabStore | null = tabStorage(),
  now = Date.now(),
): void {
  if (pending?.kind !== "channel" || !storage) return;
  try {
    storage.setItem(
      CHANNEL_INVITE_KEY,
      JSON.stringify({ channel: pending.channel, code: pending.code, at: now }),
    );
  } catch {
    // storage is full or blocked: the person opens the link again
  }
}

/**
 * On page load: removes a channel invite kept across a sign-in from
 * `sessionStorage` and, unless it has expired or this page load already
 * holds an invite, puts it back in memory. Answers the invite it restored.
 */
export function restoreChannelInvite(
  storage: TabStore | null = tabStorage(),
  now = Date.now(),
): PendingInvite | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(CHANNEL_INVITE_KEY);
    storage.removeItem(CHANNEL_INVITE_KEY);
  } catch {
    return null;
  }
  if (raw === null || pending !== null) return null;
  let kept: { channel?: unknown; code?: unknown; at?: unknown } | null;
  try {
    kept = JSON.parse(raw) as typeof kept;
  } catch {
    return null;
  }
  if (
    typeof kept?.channel !== "string" ||
    typeof kept.code !== "string" ||
    kept.code === "" ||
    typeof kept.at !== "number" ||
    now < kept.at ||
    now - kept.at >= CHANNEL_INVITE_TTL_MS
  )
    return null;
  pending = { kind: "channel", channel: kept.channel, code: kept.code };
  return pending;
}

/** A fragment's code, decoded and trimmed; "" when there is none. */
export function fragmentCode(hash: string): string {
  const raw = hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

/** The channel a channel page's path names, or undefined. */
export function channelOfPath(pathname: string): string | undefined {
  return /^\/c\/([a-z0-9][a-z0-9-]{1,29})\/?$/.exec(pathname)?.[1];
}

function inviteOfPath(pathname: string, code: string): PendingInvite | null {
  if (pathname === INVITE_PATH || pathname === `${INVITE_PATH}/`) {
    return { kind: "account", code };
  }
  const channel = channelOfPath(pathname);
  return channel ? { kind: "channel", channel, code } : null;
}

/**
 * On an invite link: keeps the code in memory and replaces the address with
 * the same path and search but no fragment. Answers the invite, or null when
 * the URL is not an invite link with a fragment.
 */
export function captureInviteFragment(
  location: Pick<Location, "pathname" | "search" | "hash"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): PendingInvite | null {
  if (location.hash.length <= 1) return null;
  const invite = inviteOfPath(location.pathname, fragmentCode(location.hash));
  if (!invite) return null;
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  if (invite.code === "") return null;
  savePendingInvite(invite);
  return invite;
}
