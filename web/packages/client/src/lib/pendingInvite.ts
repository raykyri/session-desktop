// The token of an invitation link (`/invite#<token>`, `03-api-and-events.md`
// §2 `invites.create`), held between opening the link and accepting it.
//
// The token is the URL fragment, which no request carries. On page load it is
// read before the router or any request starts (`app/captureInvite.ts`),
// removed from the address bar with `history.replaceState`, and kept in this
// tab's `sessionStorage`, so it is not in the history, in the `/login`
// redirect or in the GitHub sign-in round trip; `/invite` reads it back and
// posts it to `invites.accept`. Without `sessionStorage` (blocked storage) it
// is kept in memory, which lasts until the page reloads.

const STORAGE_KEY = "session.pending-invite.v1";

/** A stored token older than this is dropped rather than accepted: a sign-in
 * abandoned an hour ago should not accept an invitation later. */
export const PENDING_INVITE_TTL_MS = 60 * 60 * 1000;

/** The path an invitation link opens. */
export const INVITE_PATH = "/invite";

let memory: { token: string; savedAt: number } | null = null;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps `token` until it is accepted or cleared. */
export function savePendingInvite(token: string, at: number = Date.now()): void {
  const entry = { token, savedAt: at };
  memory = entry;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Quota or blocked storage: the in-memory copy is used.
  }
}

/** The token saved in this tab, unless it is older than the TTL. */
export function readPendingInvite(at: number = Date.now()): string | null {
  let entry = memory;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { token?: unknown }).token === "string" &&
        typeof (parsed as { savedAt?: unknown }).savedAt === "number"
      ) {
        entry = parsed as { token: string; savedAt: number };
      }
    }
  } catch {
    // Unreadable storage: fall back to memory.
  }
  if (!entry || entry.token === "" || at - entry.savedAt > PENDING_INVITE_TTL_MS) {
    return null;
  }
  return entry.token;
}

export function clearPendingInvite(): void {
  memory = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}

function isInvitePath(pathname: string): boolean {
  return pathname === INVITE_PATH || pathname === `${INVITE_PATH}/`;
}

/**
 * On an invitation link (`/invite#<token>`): saves the token and replaces the
 * address with `/invite`, keeping the history entry's state. Answers the
 * token, or null when this is not an invitation link with a fragment.
 */
export function captureInviteFragment(
  location: Pick<Location, "pathname" | "search" | "hash"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): string | null {
  if (!isInvitePath(location.pathname) || location.hash.length <= 1) {
    return null;
  }
  let token: string;
  try {
    token = decodeURIComponent(location.hash.slice(1));
  } catch {
    token = location.hash.slice(1);
  }
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  if (token.trim() === "") {
    return null;
  }
  savePendingInvite(token);
  return token;
}
