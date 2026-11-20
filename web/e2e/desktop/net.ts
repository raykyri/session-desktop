// The Mac's connection in the desktop-mode e2e. The app's own files come
// from its bundle in Tauri, and from `DESKTOP_ORIGIN` here, so "offline"
// cuts the server only: every request to the server's origin fails as a
// network failure does, and the browser's offline mode closes the open
// event stream and fires the `offline` event. A reload while offline turns
// the browser's offline mode off for the load of the app's files, and on
// again after.

import { expect, type BrowserContext, type Page, type Request } from "@playwright/test";

import { APP_ORIGIN } from "../constants.js";

const SERVER = `${APP_ORIGIN}/**`;

export async function offline(page: Page): Promise<void> {
  await page.route(SERVER, (r) => r.abort("internetdisconnected"));
  await page.context().setOffline(true);
}

export async function online(page: Page): Promise<void> {
  await page.unroute(SERVER);
  await page.context().setOffline(false);
}

/** Reload the app with the server out of reach. */
export async function reloadOffline(page: Page): Promise<void> {
  await page.context().setOffline(false);
  await page.reload();
  await page.context().setOffline(true);
}

/** Go to a screen inside the app (the router's own navigation), which
 * works offline: a page load of the app's files would not. */
export async function appGo(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, path);
}

/** The app's reads and writes in flight (every page of the context; the
 * event stream and the test's own routes are left out). `quiet` waits until
 * none has been in flight for `ms`: the app's start-up reads (register,
 * snapshots, the first pulls) are done, so a change the test makes on the
 * server after it reaches the app through the event stream, as the server
 * writes it, and not through a read already under way. Install it before
 * the app opens. */
export function trackRequests(context: BrowserContext) {
  const live = new Set<Request>();
  let last = Date.now();
  const counted = (r: Request) =>
    r.url().startsWith(`${APP_ORIGIN}/api/`) &&
    !r.url().includes("/api/sync/events") &&
    !r.url().includes("/api/test/");
  context.on("request", (r) => {
    if (!counted(r)) return;
    live.add(r);
    last = Date.now();
  });
  const done = (r: Request) => {
    if (live.delete(r)) last = Date.now();
  };
  context.on("requestfinished", done);
  context.on("requestfailed", done);
  // a page that loads again drops its old document's requests, which may
  // end with no event at all
  context.on("page", (p) =>
    p.on("framenavigated", (f) => {
      if (f !== p.mainFrame()) return;
      for (const r of [...live]) {
        let page: Page | null = null;
        try {
          page = r.frame().page();
        } catch {
          page = null;
        }
        if (page === p) live.delete(r);
      }
    }),
  );
  return {
    quiet: (ms = 750) =>
      expect
        .poll(
          () =>
            live.size === 0 && Date.now() - last >= ms
              ? "quiet"
              : [...live].map((r) => `${r.method()} ${r.url()}`).join(", ") || "settling",
          { timeout: 30_000 },
        )
        .toBe("quiet"),
  };
}
