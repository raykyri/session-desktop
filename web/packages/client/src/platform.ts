// Where the client runs (phase 3): a browser tab on the server's origin (the
// web), or the Desktop app, which renders this same client in Tauri (macOS)
// and installs its own platform before the first render (`web/desktop`).
// The client reads everything that differs between the two from here:
//
// - requests: the server's origin ("" on the web: same origin), the headers
//   (the web's CSRF header; the desktop's bearer device token) and fetch's
//   credentials mode (the web sends its cookie; the desktop never does);
// - the replica: the web keeps it in memory with `persist: false`; the
//   desktop keeps it, and the outbox, in SQLite with `persist: true`
//   (AGENTS.md, "Planned: desktop client and sync core");
// - the account as last read (`lastMe`), so the desktop starts offline from
//   its replica;
// - opening a link in the system browser, signing out, and Update Session.
//
// The web build never includes desktop code: the desktop's platform lives in
// `web/desktop`, and only its entry module calls `setPlatform`.

import type { StorageAdapter } from "@session/sync/client";

export interface Platform {
  /** "web": a browser tab; "desktop": the Desktop app. */
  readonly kind: "web" | "desktop";
  /** The server's origin without a trailing "/"; "" when the page is
   * served by the server (the web). */
  readonly origin: string;
  /** Headers every request to the server carries (the web's CSRF header;
   * none on the desktop, whose origin's preflight admits only the sync
   * headers). */
  headers(): Record<string, string>;
  /** The bearer device token, sent as `Authorization: Bearer`, or null
   * (the web's cookie needs none). A sign-in's token is also what an answer
   * is bound to: an answer to a request made with an earlier sign-in's
   * token changes nothing of a later one (review round 1 of phase 3,
   * finding 1). */
  token(): string | null;
  /** `fetch`'s credentials mode. */
  readonly credentials: RequestCredentials;
  /** Whether the outbox is kept across time (`persist` of the sync
   * client): writes wait offline and survive a restart. */
  readonly persist: boolean;
  /** Where a person's replica and outbox are kept; null: in memory. */
  storage(user: string): StorageAdapter | null;
  /** The account (`/api/me`) as last read, for a start without a
   * connection; null when none is kept. */
  lastMe(): unknown;
  /** Keep the account as read now (null: signed out), read with `token`:
   * kept only while `token` is still the sign-in's, and the account is its
   * person's. */
  rememberMe(me: unknown, token: string | null): void;
  /** Open a link of the server's site in the system browser. */
  openExternal(url: string): void;
  /** Sign this device or browser out. */
  signOut(): Promise<void>;
  /** The server no longer takes `token` (revoked or expired): the desktop
   * forgets its sign-in and shows the sign-in, when `token` is still the
   * sign-in's. */
  unauthorized(token: string | null): void;
  /** `user`'s replica could not be opened or made (the desktop: another
   * copy of the app holds its file, or SQLite failed): the desktop shows
   * what happened, with Try again and Reset. */
  storageFailed(user: string, error: unknown): void;
  /** Update Session's action: the web reloads the page. */
  update(): void;
  /** What the person calls this device in the sync-state copy ("this
   * Mac"); null on the web. */
  readonly here: string | null;
}

/** CSRF defense: a cross-origin page cannot set a custom header without a
 * preflight the server refuses. */
export const REQUESTED_WITH_HEADER = "X-Requested-With";
export const REQUESTED_WITH_VALUE = "session";

export const webPlatform: Platform = {
  kind: "web",
  origin: "",
  headers: () => ({ [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE }),
  token: () => null,
  credentials: "same-origin",
  persist: false,
  storage: () => null,
  lastMe: () => null,
  rememberMe: () => undefined,
  openExternal: (url) => void window.open(url, "_blank", "noopener"),
  // the web's sign-out is `logout` (api/account.ts): POST /auth/logout
  signOut: () => Promise.resolve(),
  unauthorized: () => undefined,
  storageFailed: () => undefined,
  update: () => location.reload(),
  here: null,
};

let current: Platform = webPlatform;

/** Installs the platform (the desktop's entry, before the first render;
 * tests). Null restores the web's. */
export function setPlatform(p: Platform | null): void {
  current = p ?? webPlatform;
}

export function platform(): Platform {
  return current;
}

/** The server's site, for the links the person copies or shares: the
 * page's own origin on the web; the server's in the Desktop app, whose page
 * is served from the app (`tauri://localhost`). */
export const siteOrigin = () => current.origin || location.origin;
export const siteHost = () => (current.origin ? new URL(current.origin).host : location.host);

/** Whether the client runs in the Desktop app. */
export const isDesktop = () => current.kind === "desktop";
