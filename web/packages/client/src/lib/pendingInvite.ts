// Invite codes carried in a URL fragment (02 §2.1, 04 §3.2, §5): an account
// invite link (`/i#<code>`) or a channel invite link (`/c/<name>#<code>`).
//
// The fragment is never sent with a request. On page load it is read before
// the router or any request starts (`app/captureInvite.ts`), removed from the
// address bar with `history.replaceState`, and kept in memory for this page
// load only: it is not in the history, in a sign-in redirect or in storage.
// The auth dialog (02 W7.2) and channel join (W6.9) read it from here.

export type PendingInvite =
  { kind: "account"; code: string } | { kind: "channel"; channel: string; code: string };

/** The path an account invite link opens. */
export const INVITE_PATH = "/i";

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

function inviteOfPath(pathname: string, code: string): PendingInvite | null {
  if (pathname === INVITE_PATH || pathname === `${INVITE_PATH}/`) {
    return { kind: "account", code };
  }
  const channel = /^\/c\/([a-z0-9][a-z0-9-]{1,29})\/?$/.exec(pathname)?.[1];
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
  let code: string;
  try {
    code = decodeURIComponent(location.hash.slice(1));
  } catch {
    code = location.hash.slice(1);
  }
  const invite = inviteOfPath(location.pathname, code.trim());
  if (!invite) return null;
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  if (invite.code === "") return null;
  savePendingInvite(invite);
  return invite;
}
