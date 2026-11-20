// Phase 3, slices 1 and 2: the Desktop app's frontend in desktop mode (the
// test bridge in place of Tauri's) signs in with its device token, keeps its
// replica in SQLite through the bridge, and starts from it offline after a
// reload.

import { expect, test } from "@playwright/test";

import { signedInApp } from "./app.js";
import { replicaFileOf } from "./files.js";
import { offline, online, reloadOffline } from "./net.js";

const OFFLINE_BAR =
  "You’re offline. Changes are saved on this Mac and sent when the connection is back.";

test("the app reads with its device token and keeps its replica in SQLite", async ({ context }) => {
  const { page, bridge } = await signedInApp(context);
  // the person's spaces, from their logs
  await expect(page.locator(".hnav").getByRole("button", { name: "Sablefield" })).toBeVisible();
  const file = replicaFileOf(bridge);
  await expect
    .poll(
      () =>
        bridge.query<{ n: number }>(file, "SELECT count(*) AS n FROM sync_client_records")[0]?.n,
    )
    .toBeGreaterThan(50);
  const meta = bridge.query<{ v: string }>(file, "SELECT v FROM sync_client_meta WHERE k = 'meta'");
  expect(JSON.parse(meta[0]?.v ?? "{}")).toMatchObject({ user: "ines.v" });
  // the Keychain item keeps the account as read
  await expect
    .poll(() => JSON.parse(bridge.keychain ?? "{}") as unknown)
    .toMatchObject({ handle: "ines.v", me: { u: "ines.v" } });
  // the window's title follows the page's
  await expect.poll(() => bridge.title).toMatch(/^Session/);
  bridge.close();
});

test("offline, a reload starts from the replica (sx-off-app)", async ({ context }) => {
  const { page, bridge } = await signedInApp(context);
  const first = page.locator(".rows .row-t").first();
  await expect(first).toBeVisible();
  const title = await first.textContent();
  await expect
    .poll(
      () =>
        bridge.query<{ n: number }>(
          replicaFileOf(bridge),
          "SELECT count(*) AS n FROM sync_client_logs",
        )[0]?.n,
    )
    .toBeGreaterThan(1);
  await offline(page);
  await expect(page.getByText(OFFLINE_BAR)).toBeVisible();
  await reloadOffline(page);
  await expect(page.getByText(OFFLINE_BAR)).toBeVisible();
  await expect(page.locator(".hnav").getByRole("button", { name: "Sablefield" })).toBeVisible();
  await expect(page.locator(".rows .row-t").first()).toHaveText(title ?? "");
  // back online (the browser's online event): the bar goes
  await online(page);
  await expect(page.getByText(OFFLINE_BAR)).toBeHidden();
  bridge.close();
});
