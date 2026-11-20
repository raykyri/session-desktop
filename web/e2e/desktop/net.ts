// The Mac's connection in the desktop-mode e2e. The app's own files come
// from its bundle in Tauri, and from `DESKTOP_ORIGIN` here, so "offline"
// cuts the server only: every request to the server's origin fails as a
// network failure does, and the browser's offline mode closes the open
// event stream and fires the `offline` event. A reload while offline turns
// the browser's offline mode off for the load of the app's files, and on
// again after.

import type { Page } from "@playwright/test";

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
