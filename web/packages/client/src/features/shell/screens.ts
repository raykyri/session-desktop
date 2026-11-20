// What the shell does on each route (02 §2.1, §2.2): which routes are feeds
// (bar hides on scroll, layout toggle shown, bar aligned to the feed
// columns) and which show the channel strip.

/** Channel names, as the shared validator checks them (04 §4.2). */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{1,29}$/;

/** The channel a `/c/<name>` path opens, or null. */
export function channelOfPath(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return CHANNEL_NAME.test(name) ? name : null;
}

/** Home, Saved and channel feeds. */
export function isFeedPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/saved" || channelOfPath(pathname) !== null;
}

const STRIP_PAGES = new Set(["/browse", "/invites", "/usage", "/notifications", "/admin"]);

/** The channel strip shows on the feeds, Browse, Invites, Usage,
 * Notifications and Site Admin; not on `/welcome` or `/settings`. */
export function showsChannelStrip(pathname: string): boolean {
  return isFeedPath(pathname) || STRIP_PAGES.has(pathname.replace(/\/$/, "") || "/");
}
