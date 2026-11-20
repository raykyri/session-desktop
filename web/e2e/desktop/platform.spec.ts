// Review round 1 of phase 3 (reviewer A), the Desktop app's platform in
// desktop mode: the server out of reach while the browser still says it is
// online (finding 8); the replica's file deleted at sign-out (finding 5);
// a second copy of the app on the same replica (finding 4); the storage
// problem with Copy text and Reset (finding 7); and a sign-in whose browser
// did not open, or whose token the Keychain refused (findings 2 and 10).

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "../constants.js";
import { MOCK_ME } from "../fixtures/mockup.js";
import { loadScenario, signInAs } from "../scenario.js";

import { keychainItem, openApp, signedInApp } from "./app.js";
import { TestBridge } from "./bridge.js";
import { replicaFileOf, storedOutbox } from "./files.js";
import { offline, reloadOffline } from "./net.js";
import { sf4 } from "./outbox.js";

const REPLY = "Does the replica keep this reply while the server is out of reach?";
const OFFLINE_BAR =
  "You’re offline. Changes are saved on this Mac and sent when the connection is back.";
const SERVER = `${APP_ORIGIN}/**`;

async function reply(p: Page, text = REPLY) {
  await p.getByRole("textbox", { name: "Write a reply" }).fill(text);
  await p.locator(".fu-box2").getByRole("button", { name: "Reply", exact: true }).click();
}

test("finding 8: the server out of reach while the browser says online: the bar shows, and the first answer after it sends the reply", async ({
  context,
}) => {
  const { page, bridge, records } = await signedInApp(context);
  await page.goto(`${page.url().replace(/\/$/, "")}${sf4(records).path}`);
  await expect(page.locator(".th-q")).toContainText("4.2 is out");
  // every request to the server fails as a refused connection does; the
  // browser's offline mode stays off
  await page.route(SERVER, (r) => r.abort("connectionrefused"));
  await reply(page);
  await expect(page.getByText(OFFLINE_BAR)).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await expect(page.locator(".sx-rp")).toContainText(REPLY);
  expect(storedOutbox(bridge).map((e) => e.name)).toEqual(["research.createPostFollowUp"]);
  // the server answers again: the app's next request (the outbox's backoff,
  // or the stream's reconnect) ends the offline state and sends the reply
  await page.unroute(SERVER);
  await expect(page.getByText(OFFLINE_BAR)).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(".rp").filter({ hasText: REPLY })).toBeVisible();
  await expect.poll(() => storedOutbox(bridge).filter((e) => e.state !== "answered")).toEqual([]);
  bridge.close();
});

test("finding 5: sign-out deletes the replica's file", async ({ context }) => {
  const { page, bridge } = await signedInApp(context);
  const file = replicaFileOf(bridge);
  await expect.poll(() => bridge.exists(file)).toBe(true);
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Session" })).toBeVisible();
  await expect.poll(() => bridge.exists(file)).toBe(false);
  expect(bridge.exists(`${file}-journal`)).toBe(false);
  bridge.close();
});

test("finding 4: a second copy of the app on the same replica shows that another copy is open, until the first quits", async ({
  context,
}) => {
  const first = await signedInApp(context);
  const second = new TestBridge(undefined, first.bridge.dir);
  second.keychain = keychainItem(first.device);
  const page = await openApp(context, second);
  await expect(
    page.getByRole("heading", { name: "Another copy of Session is open" }),
  ).toBeVisible();
  await expect(page.locator(".cs-na p.muted")).toHaveText(
    "It is using this Mac’s copy of your spaces. Quit the other copy of Session, then try again.",
  );
  await expect(page.getByRole("button", { name: /^Reset/ })).toHaveCount(0);
  // still open: Try again shows the same
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Another copy of Session is open" }),
  ).toBeVisible();
  // the first copy quits
  await first.page.close();
  first.bridge.quit();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: /^Account: / })).toBeVisible();
  second.quit();
  first.bridge.close();
});

test("finding 7: a replica that fails to open: its unsent change can be copied, then Reset deletes the file and reads the spaces again", async ({
  context,
}) => {
  const { page, bridge, records } = await signedInApp(context);
  await page.goto(`${page.url().replace(/\/$/, "")}${sf4(records).path}`);
  await expect(page.locator(".th-q")).toContainText("4.2 is out");
  await offline(page);
  await reply(page);
  await expect(page.locator(".sx-rp")).toContainText(REPLY);
  await expect.poll(() => storedOutbox(bridge).length).toBe(1);
  // the app starts again, and the replica fails to open once
  bridge.quit();
  bridge.failOpen.push({ code: "FAILED", message: "file is not a database" });
  await reloadOffline(page);
  await expect(
    page.getByRole("heading", { name: "Session can’t open its data on this Mac" }),
  ).toBeVisible();
  await expect(page.getByText("file is not a database")).toBeVisible();
  await expect(page.locator(".cs-na p.muted").nth(2)).toHaveText(
    "1 unsent change would be deleted with it. Copy the text you want to keep first.",
  );
  const row = page.getByRole("list", { name: "Unsent changes" }).locator(".sx-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(REPLY);
  await row.getByRole("button", { name: "Copy text" }).click();
  await expect(page.locator(".cs-toast")).toHaveText("Text copied.");
  // Reset asks once more
  await page.getByRole("button", { name: "Reset…" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Reset deletes this Mac’s copy of your spaces and 1 unsent change.",
  );
  await context.setOffline(false);
  await page.unroute(SERVER);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Account: / })).toBeVisible();
  // the replica was made again from the server, without the unsent reply
  await expect
    .poll(
      () =>
        bridge.query<{ n: number }>(
          replicaFileOf(bridge),
          "SELECT count(*) AS n FROM sync_client_records",
        )[0]?.n,
    )
    .toBeGreaterThan(10);
  expect(storedOutbox(bridge)).toEqual([]);
  bridge.close();
});

test("finding 7: a replica that cannot be read at all: Reset says it deletes every unsent change", async ({
  context,
}) => {
  const { page, bridge } = await signedInApp(context);
  bridge.quit();
  bridge.failOpen.push(
    { code: "FAILED", message: "disk I/O error" },
    { code: "FAILED", message: "disk I/O error" },
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Session can’t open its data on this Mac" }),
  ).toBeVisible();
  await expect(
    page.getByText("Session can’t read the unsent changes on this Mac. Resetting deletes them."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset…" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Reset deletes this Mac’s copy of your spaces and every unsent change on it.",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  // Try again opens it (the failure has passed)
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: /^Account: / })).toBeVisible();
  bridge.close();
});

test("findings 2 and 10: a browser that did not open is said so, with the link; a token the Keychain refused is revoked and the sign-in starts over", async ({
  browser,
  context,
}) => {
  await loadScenario(context.request);
  const bridge = new TestBridge();
  bridge.openFails = true;
  const app = await openApp(context, bridge);
  await app.getByRole("button", { name: "Sign in with the browser" }).click();
  await expect(
    app.getByRole("heading", { name: "Approve this Mac in your browser" }),
  ).toBeVisible();
  const said = app.getByRole("alert");
  await expect(said).toContainText("Session couldn’t open your browser. Open ");
  const link = /(https?:\/\/\S+\/device\?request=[0-9A-Z]{26})/.exec(
    (await said.textContent()) ?? "",
  )?.[1];
  expect(link).toBeTruthy();
  await app.getByRole("button", { name: "Open the page again" }).click();
  await expect(app.locator(".cs-toast")).toHaveText("Session couldn’t open your browser.");
  expect(bridge.opened).toEqual([]);

  // the person opens the link by hand and approves; the Keychain refuses
  // the token
  bridge.keychainFails = true;
  const web = await browser.newContext();
  await signInAs(web, MOCK_ME);
  const tab = await web.newPage();
  await tab.goto(link ?? "");
  await tab.getByRole("button", { name: "Approve this Mac" }).click();
  await expect(tab.getByRole("heading", { name: "This Mac is signed in" })).toBeVisible();
  await expect(app.locator(".cs-toast")).toContainText(
    "Session couldn’t keep the sign-in in the macOS Keychain (",
  );
  await expect(app.getByRole("heading", { name: "Sign in to Session" })).toBeVisible();
  expect(bridge.keychain).toBeNull();
  await expect(app.getByRole("button", { name: /^Account: / })).toHaveCount(0);
  // the token the app took is revoked: the person has no device left
  await expect
    .poll(
      async () =>
        (await (await web.request.get(`${APP_ORIGIN}/api/me/devices`)).json()) as unknown[],
    )
    .toEqual([]);
  await web.close();
  bridge.close();
});
