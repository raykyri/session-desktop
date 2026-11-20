// Phase 2b, slice 4: Account (its tabs), API keys, Usage, the profile, a
// Desktop app's sign-in approved in the browser, and the first run. On
// Desktop and Mobile Web. The web has no Devices tab (AGENTS.md).
//
// Device sign-in (phase 2 review round 1, finding 1): the page reads the
// request with `devices.request`, which the server agent adds in the same
// round. The screens below answer that read from the page's route with the
// agreed shape ({device, app, askedAt, sameComputer}), so they test the
// client half on its own; `@server-r1` tests run against the real read and
// are skipped unless SESSION_E2E_SERVER_R1=1 (after the server's branch is
// merged).

import { expect, test, type Page } from "@playwright/test";

import { loadScenario, signInAs } from "./scenario.js";

const HEADERS = { "x-requested-with": "session", "content-type": "application/json" };
const toastSays = (p: Page, t: string | RegExp) =>
  expect(p.locator(".cs-toast").getByText(t)).toBeVisible();

interface Screen {
  key: string;
  url: string;
  run: (p: Page) => Promise<void>;
}

/** The Mac app starts a sign-in (`devices.authorize`, signed out). */
async function authorize(p: Page): Promise<{ request: string; code: string }> {
  const r = await p.request.fetch("/api/rpc/devices.authorize", {
    method: "POST",
    headers: HEADERS,
    data: { name: "MacBook Air", kind: "mac" },
  });
  const body = (await r.json()) as { result?: { request: string; code: string } };
  expect(body.result).toBeTruthy();
  return body.result ?? { request: "", code: "" };
}

/** The page's read of the request, in the shape the server agent adds
 * (`devices.request`), answered here so the screen does not depend on it. */
async function answerRequest(p: Page, sameComputer: boolean) {
  await p.route("**/api/rpc/devices.request", (r) =>
    r.fulfill({
      json: {
        ok: true,
        result: {
          device: "MacBook Air · macOS 15.1",
          app: "Session for Mac 1.0.0",
          askedAt: new Date().toISOString(),
          sameComputer,
        },
        serverTime: Date.now(),
      },
    }),
  );
}

async function expectCard(p: Page, asked: string) {
  const card = p.locator(".sx-dcard");
  await expect(card.getByText("MacBook Air · macOS 15.1")).toBeVisible();
  await expect(card.getByText("Session for Mac 1.0.0")).toBeVisible();
  await expect(card.getByText(asked)).toBeVisible();
}

/** Whether the app could take its token: the sign-in was approved. */
async function tokenTaken(p: Page, request: string): Promise<boolean> {
  const r = await p.request.fetch("/api/rpc/devices.token", {
    method: "POST",
    headers: HEADERS,
    data: { request },
  });
  const body = (await r.json()) as { ok: boolean };
  return body.ok;
}

const SCREENS: Screen[] = [
  {
    key: "acx-b-account",
    url: "/settings/account",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
      await expect(p.getByRole("button", { name: "Account", exact: true }).last()).toHaveAttribute(
        "aria-current",
        "page",
      );
      await p.locator("#ac-name").fill("Inès V.");
      await p.getByRole("button", { name: "Save profile" }).click();
      await toastSays(p, "Profile saved.");
    },
  },
  {
    key: "acx-b-usage",
    url: "/settings/usage",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Usage" })).toBeVisible();
      await expect(p.getByText("Included tokens", { exact: true })).toBeVisible();
      await expect(p.getByText(/tokens this month/)).toBeVisible();
    },
  },
  {
    key: "ac-key-add",
    url: "/settings/keys",
    run: async (p) => {
      await p.getByRole("button", { name: "Add a key" }).click();
      const d = p.getByRole("dialog", { name: "Add an API key" });
      await d.locator("#key-in").fill("sk-ant-api03-test-key-123456");
      await d.locator("#key-name").fill("Work key");
      await d.getByRole("button", { name: "Add key" }).click();
      await toastSays(p, /Key added/);
      const row = p.locator(".ak-row").filter({ hasText: "Work key" });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Revoke" }).click();
      await p
        .getByRole("alertdialog", { name: "Revoke Work key?" })
        .getByRole("button", { name: "Revoke" })
        .click();
      await toastSays(p, "Revoked Work key.");
      await expect(row).toHaveCount(0);
    },
  },
  {
    key: "acx-b-spaces",
    url: "/settings/spaces",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Your spaces" })).toBeVisible();
      await expect(p.locator(".ak-row").first()).toBeVisible();
    },
  },
  {
    key: "no-devices-tab",
    url: "/settings/account",
    run: async (p) => {
      const tabs = p.getByRole("navigation", { name: "Account sections" });
      await expect(tabs.getByRole("button", { name: "Your spaces" })).toBeVisible();
      await expect(tabs.getByRole("button", { name: "Devices" })).toHaveCount(0);
    },
  },
  {
    key: "sx-si-web",
    url: "/",
    run: async (p) => {
      const signIn = await authorize(p);
      await answerRequest(p, true);
      await p.goto(`/device?request=${signIn.request}`);
      await expect(p.getByRole("heading", { name: "Sign in on a Mac?" })).toBeVisible();
      await expect(
        p.getByText("Approve only if you just started this on your own Mac.", { exact: false }),
      ).toBeVisible();
      await expectCard(p, "Just now, from this computer");
      // one click: no code field
      await expect(p.locator("#sx-dcode")).toHaveCount(0);
      await p.getByRole("button", { name: "Approve this Mac" }).click();
      await expect(p.getByRole("heading", { name: "This Mac is signed in" })).toBeVisible();
      await expect(
        p.getByText("Go back to the Session app. You can close this tab."),
      ).toBeVisible();
      await toastSays(p, "Signed in successfully.");
      expect(await tokenTaken(p, signIn.request)).toBe(true);
    },
  },
  {
    key: "sx-si-other",
    url: "/",
    run: async (p) => {
      const signIn = await authorize(p);
      await answerRequest(p, false);
      await p.goto(`/device?request=${signIn.request}`);
      await expect(
        p.getByText(
          "The request came from another computer. Enter the code the Session app shows on the Mac. If you didn’t start this sign-in, deny it.",
          { exact: false },
        ),
      ).toBeVisible();
      await expectCard(p, "Just now, from another computer");
      const field = p.getByLabel("The code the Mac shows");
      await expect(field).toHaveAttribute("placeholder", "ABC-DEF");
      const approve = p.getByRole("button", { name: "Approve this Mac" });
      await expect(approve).toBeDisabled();
      await field.fill(signIn.code);
      await expect(approve).toBeEnabled();
      await approve.click();
      await expect(p.getByRole("heading", { name: "This Mac is signed in" })).toBeVisible();
      await toastSays(p, "Signed in successfully.");
      expect(await tokenTaken(p, signIn.request)).toBe(true);
    },
  },
  {
    key: "sx-si-wrong",
    url: "/",
    run: async (p) => {
      const signIn = await authorize(p);
      await answerRequest(p, false);
      await p.goto(`/device?request=${signIn.request}`);
      const field = p.getByLabel("The code the Mac shows");
      await field.fill(signIn.code === "ZAN-NTB" ? "ZAN-NTC" : "ZAN-NTB");
      await p.getByRole("button", { name: "Approve this Mac" }).click();
      const err = p.locator("#sx-derr");
      await expect(err).toHaveText(
        "This code doesn’t match the one on your Mac. Check the code in the Session app and try again.",
      );
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toBeFocused();
      // nothing was approved
      expect(await tokenTaken(p, signIn.request)).toBe(false);
      await field.press("Backspace");
      await expect(err).toHaveCount(0);
      await expect(field).not.toHaveAttribute("aria-invalid", "true");
      // a deny needs no code
      await field.fill("");
      await p.getByRole("button", { name: "Deny" }).click();
      await expect(p.getByRole("heading", { name: "Sign-in denied" })).toBeVisible();
    },
  },
  {
    key: "ac-onb-terms",
    url: "/welcome",
    run: async (p) => {
      const go = p.getByRole("button", { name: "Continue" });
      await expect(go).toBeDisabled();
      await p.getByLabel(/I accept the terms/).check();
      await go.click();
      await expect(p.getByRole("heading", { name: "Join spaces" })).toBeVisible();
      await p.getByRole("button", { name: "Continue" }).click();
      await p.getByRole("button", { name: "Skip" }).click();
      await expect(p).toHaveURL(/\/$/);
    },
  },
  {
    key: "nm-browse",
    url: "/spaces/browse",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Browse spaces" })).toBeVisible();
      await p.getByRole("button", { name: /^Closed/ }).click();
      await expect(p.locator(".br-grp .br-row").first()).toBeVisible();
      await expect(
        p.locator(".br-grp").getByRole("button", { name: "#replication-club" }),
      ).toBeVisible();
    },
  },
  {
    key: "ow-create",
    url: "/spaces/new",
    run: async (p) => {
      await p.locator("#cs-crname").fill("field-recordings");
      await p.locator("#cs-crdesc").fill("Recordings made outdoors, and how they were made.");
      await expect(p.locator(".cs-crprev")).toContainText("#field-recordings");
      await p.getByRole("button", { name: "Create space" }).click();
      await expect(p).toHaveURL(/\/s\/field-recordings$/);
      await expect(p.getByRole("heading", { name: "#field-recordings" })).toBeVisible();
    },
  },
  {
    key: "ac-pf-more",
    url: "/u/hal_b",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: /hal|Hal/ }).first()).toBeVisible();
      await p.getByRole("button", { name: "More" }).click();
      await p.getByRole("menuitem", { name: "Mute hal_b" }).click();
      await toastSays(p, /Muted hal_b/);
      await expect(p.getByText("You muted hal_b.", { exact: false })).toBeVisible();
    },
  },
];

for (const [layout, viewport] of [
  ["Desktop", { width: 1318, height: 900 }],
  ["Mobile Web", { width: 390, height: 844 }],
] as const) {
  test.describe(`slice 4 screens, ${layout}`, () => {
    test.use({ viewport });
    for (const s of SCREENS) {
      test(s.key, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await loadScenario(page.context().request, "seed");
        await signInAs(page.context());
        await page.goto(s.url);
        await s.run(page);
        expect(errors).toEqual([]);
      });
    }
  });
}

test("acx-out: Account signed out asks to log in", async ({ page }) => {
  await loadScenario(page.context().request, "seed");
  await page.goto("/settings/keys");
  await expect(page.getByText("Log in to see your account, usage and API keys.")).toBeVisible();
});

// After the server's branch is merged: the page's own read of the request.
// The e2e browser and the request context both reach the server from
// 127.0.0.1, so the request is from this computer and one click approves it.
test("sx-si-web over the real devices.request @server-r1", async ({ page }) => {
  test.skip(process.env["SESSION_E2E_SERVER_R1"] !== "1", "needs the server's devices.request");
  await loadScenario(page.context().request, "seed");
  await signInAs(page.context());
  await page.goto("/");
  const signIn = await authorize(page);
  await page.goto(`/device?request=${signIn.request}`);
  await expect(page.locator(".sx-dcard").getByText(/from this computer$/)).toBeVisible();
  await expect(page.locator("#sx-dcode")).toHaveCount(0);
  await page.getByRole("button", { name: "Approve this Mac" }).click();
  await expect(page.getByRole("heading", { name: "This Mac is signed in" })).toBeVisible();
});
