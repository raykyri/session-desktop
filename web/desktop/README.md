# Session for Mac (phase 3)

The new desktop client: the spaces web client (`@session/client`) in a Tauri 2
window on macOS, with its replica and outbox kept on the Mac in SQLite
(`@session/sync` with `persist: true`), device sign-in through the browser,
and the sync-state UI the web lacks (the offline bar, Unsent changes, queued,
held and refused writes, frozen copies, Update Session). Device runs (Claude
Code and Codex on the Mac) are phase 4. The current app (`/src`,
`/src-tauri`) stays as it is until the cutover (phase 5).

## Layout

- `src/main.tsx`: the entry. It picks the bridge (Tauri's, or the test's
  under Playwright), installs the platform the client reads, and shows the
  sign-in or the client's screens (`@session/client/shell`).
- `src/bridge.ts`: what the app needs from the Mac: SQLite files, the
  Keychain item, the browser, the window title, and what the app is.
  - `src/tauri.ts`: Tauri's IPC, `@tauri-apps/plugin-sql`,
    `@tauri-apps/plugin-opener` and the app's commands.
  - `src/testBridge.ts`: one function the test exposes on the page
    (`web/e2e/desktop/bridge.ts` keeps the files with better-sqlite3).
- `src/platform.ts`: the client's `Platform` (see
  `web/packages/client/src/platform.ts`): the server's origin and the bearer
  token, no cookie; one Keychain item holding the token, the device's id, the
  person's handle and their account as last read (so the app starts offline);
  each person's replica in `replica-<handle>.sqlite` behind `SqliteStorage`.
  Sign-out revokes the device's token on the server when it can and clears
  the replica, the outbox and the Keychain item; a token the server no longer
  takes (revoked, expired) does the same and returns to the sign-in.
- `src/signin.ts`, `src/SignIn.tsx`: device sign-in (the mockup's sx-si-app):
  `devices.authorize` with the Mac and the app, the browser opened at
  `<server>/device?request=<id>` (never a code in the link), the code shown
  for a browser on another computer, `devices.token` every 2 seconds until
  the browser approves or denies it or the request expires (10 minutes).
- `src-tauri/`: the app's own Rust, kept small: the SQL plugin; `sql_batch`
  (a batch of statements in one transaction on the plugin's pool, which
  `SqliteStorage` needs and the plugin's `execute` cannot give); the
  Keychain item (`keychain_get`, `keychain_set`, `keychain_delete`, through
  the `keyring` crate); `app_about`; the opener plugin.

The sync-state UI itself is the client's (`web/packages/client/src/spaces/
Outbox.tsx`, `outbox.ts`, `Frozen.tsx`, `UnsentPage.tsx`), shown only by a
session that keeps its outbox. The web build includes none of this package.

## Running it

From `web/`:

- `npm run build --workspace @session/desktop`: the frontend in
  `desktop/dist/app` (Tauri's `frontendDist`).
- On a Mac: `cd desktop && npx tauri dev` (the dev server on
  127.0.0.1:1490) or `npx tauri build`. The server it talks to is set at
  build time with `VITE_SESSION_SERVER` (default `https://session.app`);
  the server must list the app's origin (`tauri://localhost`, the default)
  in `SESSION_DESKTOP_ORIGINS`, and `tauri.conf.json`'s CSP `connect-src`
  must name the server.
- Tests: `npm test --workspace @session/desktop` (the platform and the
  sign-in flow over a bridge in Node), `cargo test` in `desktop/src-tauri`
  (Linux needs `libwebkit2gtk-4.1-dev`), and the desktop-mode e2e:
  `SESSION_E2E_HOST=127.0.0.1 npm run test:e2e:desktop` (`web/e2e/desktop`:
  the frontend in Chromium from its own origin, the test bridge in place of
  Tauri's, against the real server).

## Not verified until it runs on a Mac

Everything above was built and tested on Linux, where the macOS app cannot be
built or run. Check, on a Mac:

1. `npx tauri build` produces the app and the DMG (Xcode command line tools,
   the `apple-native` feature of `keyring`); the app opens its window.
2. The Keychain: signing in stores one generic password item (service
   `dev.session.spaces`, account `device`); restarting the app starts signed
   in; signing out and a revoked token delete it. An unsigned build may ask
   for Keychain access.
3. The Tauri origin: the web view's requests carry `Origin:
tauri://localhost`, the server's CORS answers them (the sign-in calls
   without a token, the rest with the bearer token), and the event stream
   (`GET /api/sync/events`, fetch-based SSE) stays open in WKWebView.
4. The SQL plugin's path: `Database.load("sqlite:replica-<handle>.sqlite")`
   makes the file under `~/Library/Application Support/dev.session.spaces/`
   (the plugin resolves relative paths against the app's configuration
   directory, which on macOS is that folder); `sql_batch` finds the pool the
   page loaded under the same name.
5. The CSP: `connect-src` admits the server (and `ipc:`), images from the
   server and avatars load, and nothing else is blocked.
6. A reload on a deep route (`/s/<space>/t/<thread>`) is served
   `index.html` by Tauri's asset protocol, as the e2e's static server does.
7. `navigator.onLine` and the `online`/`offline` events in WKWebView; the
   app also detects a network failure from its own requests.
8. `app_about`'s Mac name (`scutil --get ComputerName`) and macOS version
   (`sw_vers -productVersion`).
9. `window.setTitle` follows the page's title ("Session — Home"; "Session" on
   the sign-in after a sign-out).
10. A cited source and Share to X (`window.open` in the client goes through
    `platform().openExternal`) open in the default browser, and "Opened X with a
    link to the thread."
    shows only after it opened.

## Known gaps

- Update Session's "Open the download page" opens `<server>/download` in the
  browser (the mockup's "Download and restart" waits for the updater); the
  Tauri updater (and signing, notarization) is not part of this phase.
- The server reads the browser's account routes (`/api/me/preferences`,
  admin) only with a cookie (ADR-19 as amended), so the app keeps its
  appearance settings on the Mac only.
- An image a thread names by a path on the server (`/images/...`) loads
  from the app's origin; the links the person copies or shares use the
  server's origin (`siteOrigin` in the client's `platform.ts`).
