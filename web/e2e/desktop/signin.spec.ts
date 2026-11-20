// Phase 3, slice 4: device sign-in end to end in desktop mode (the mockup's
// sx-si-app, sx-si-web, sx-si-done): the app asks for a sign-in, opens the
// browser at /device?request=<id> (never a code in the link) and shows the
// code; the browser, on the same address, approves with one click; the app
// takes its token, keeps it in the Keychain and opens Home with "Signed in
// successfully.". A revoked token returns the app to its sign-in and clears
// the replica.

import { expect, test } from "@playwright/test";

import { APP_ORIGIN } from "../constants.js";
import { MOCK_ME } from "../fixtures/mockup.js";
import { loadScenario, signInAs } from "../scenario.js";

import { openApp } from "./app.js";
import { TestBridge } from "./bridge.js";
import { replicaFileOf } from "./files.js";

const HOST = APP_ORIGIN.replace(/^https?:\/\//, "");
const HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

test("device sign-in: the browser approves the Mac with one click; a revoked token returns to sign-in", async ({
  browser,
  context,
}) => {
  await loadScenario(context.request);
  const bridge = new TestBridge();
  const app = await openApp(context, bridge);
  // the app's first window (sx-si-app, start)
  await expect(app.getByRole("heading", { name: "Sign in to Session" })).toBeVisible();
  await expect(app.locator(".cs-na p.muted")).toHaveText(
    `Session opens ${HOST} in your browser. Approve this Mac there, and the app signs in.`,
  );
  await expect.poll(() => bridge.title).toBe("Session");
  await app.getByRole("button", { name: "Sign in with the browser" }).click();
  // waiting for the browser, with the code
  await expect(
    app.getByRole("heading", { name: "Approve this Mac in your browser" }),
  ).toBeVisible();
  await expect(app.locator(".cs-na p.muted").first()).toHaveText(
    `Session opened ${HOST}/device in your browser. Approve this Mac there. The app then stores a device token in the macOS Keychain.`,
  );
  await expect(app.locator(".sx-code-l")).toHaveText("If the browser asks for a code, enter");
  const code = await app.getByLabel("Sign-in code").textContent();
  expect(code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  await expect(app.locator(".sx-wait")).toHaveText("Waiting for the browser…");
  await expect(app.locator(".cs-fine")).toHaveText("The request expires in 10 minutes.");
  await expect.poll(() => bridge.opened.length).toBe(1);
  const link = bridge.opened[0] ?? "";
  expect(link).toMatch(new RegExp(`^${APP_ORIGIN}/device\\?request=[0-9A-Z]{26}$`));
  expect(link).not.toContain((code ?? "").replace("-", ""));
  // Open the page again
  await app.getByRole("button", { name: "Open the page again" }).click();
  await expect(app.locator(".cs-toast")).toHaveText(`Opened ${HOST}/device in your browser.`);
  expect(bridge.opened[1]).toBe(link);

  // the browser, signed in as the same person, at the same address (sx-si-web)
  const web = await browser.newContext();
  await signInAs(web, MOCK_ME);
  const tab = await web.newPage();
  await tab.goto(link);
  await expect(tab.getByRole("heading", { name: "Sign in on a Mac?" })).toBeVisible();
  await expect(tab.getByText("Just now, from this computer")).toBeVisible();
  await tab.getByRole("button", { name: "Approve this Mac" }).click();
  await expect(tab.getByRole("heading", { name: "This Mac is signed in" })).toBeVisible();

  // the app takes its token (sx-si-done)
  await expect(app.getByRole("button", { name: /^Account: / })).toBeVisible();
  await expect(app.locator(".cs-toast")).toHaveText("Signed in successfully.");
  await expect(app.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect.poll(() => bridge.title).toBe("Session — Home");
  const item = JSON.parse(bridge.keychain ?? "{}") as {
    token?: string;
    device?: string;
    handle?: string;
  };
  expect(item.handle).toBe(MOCK_ME);
  expect(item.token).toMatch(/^[\w-]{20,}$/);
  // the replica is the person's
  await expect
    .poll(
      () =>
        bridge.query<{ n: number }>(
          replicaFileOf(bridge),
          "SELECT count(*) AS n FROM sync_client_records",
        )[0]?.n,
    )
    .toBeGreaterThan(10);

  // the browser revokes the device: the app returns to its sign-in, and its
  // token and replica are gone
  const revoke = await web.request.post(`${APP_ORIGIN}/api/rpc/devices.revoke`, {
    headers: HEADERS,
    data: { id: item.device },
  });
  expect(revoke.ok()).toBe(true);
  await expect(app.getByRole("heading", { name: "Sign in to Session" })).toBeVisible();
  await expect.poll(() => bridge.keychain).toBeNull();
  await expect
    .poll(
      () =>
        bridge.query<{ n: number }>(
          replicaFileOf(bridge, MOCK_ME),
          "SELECT count(*) AS n FROM sync_client_records",
        )[0]?.n,
    )
    .toBe(0);
  await web.close();
  bridge.close();
});

test("device sign-in: a denied sign-in can be started again", async ({ browser, context }) => {
  await loadScenario(context.request);
  const bridge = new TestBridge();
  const app = await openApp(context, bridge);
  await app.getByRole("button", { name: "Sign in with the browser" }).click();
  await expect.poll(() => bridge.opened.length).toBe(1);
  const web = await browser.newContext();
  await signInAs(web, MOCK_ME);
  const tab = await web.newPage();
  await tab.goto(bridge.opened[0] ?? "");
  await tab.getByRole("button", { name: "Deny" }).click();
  await expect(tab.getByRole("heading", { name: "Sign-in denied" })).toBeVisible();
  await expect(app.getByRole("heading", { name: "Sign-in was denied" })).toBeVisible();
  await expect(app.locator(".cs-na p.muted")).toHaveText(
    "The browser denied this Mac. Start again if that was a mistake.",
  );
  await app.getByRole("button", { name: "Start again" }).click();
  await expect(
    app.getByRole("heading", { name: "Approve this Mac in your browser" }),
  ).toBeVisible();
  await expect.poll(() => bridge.opened.length).toBe(2);
  // Cancel goes back to the start
  await app.getByRole("button", { name: "Cancel" }).click();
  await expect(app.getByRole("heading", { name: "Sign in to Session" })).toBeVisible();
  expect(bridge.keychain).toBeNull();
  await web.close();
  bridge.close();
});

test("sign-out from the account menu revokes the device and clears it", async ({ context }) => {
  const { signedInApp } = await import("./app.js");
  const { page, bridge, device } = await signedInApp(context);
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Session" })).toBeVisible();
  expect(bridge.keychain).toBeNull();
  // the sign-in's window title names no screen
  await expect.poll(() => bridge.title).toBe("Session");
  // the server no longer takes the token
  const r = await context.request.get(`${APP_ORIGIN}/api/me`, {
    headers: { Authorization: `Bearer ${device.token}` },
  });
  expect(r.status()).toBe(401);
  bridge.close();
});
