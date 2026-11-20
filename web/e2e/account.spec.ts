// Phase 2b, slice 4: Account (its tabs), API keys, Usage, the profile,
// devices and a Desktop app's sign-in approved in the browser, and the first
// run. On Desktop and Mobile Web.

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
    key: "devices",
    url: "/settings/devices",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Devices" })).toBeVisible();
      await expect(p.getByText(/Devices that signed in to the Session app/)).toBeVisible();
    },
  },
  {
    key: "sx-si-web",
    url: "/",
    run: async (p) => {
      const r = await p.context().request.post("/api/rpc/devices.authorize", {
        headers: HEADERS,
        data: { name: "MacBook Air", kind: "mac" },
      });
      const body = (await r.json()) as { result?: { request: string; code: string } };
      expect(body.result).toBeTruthy();
      await p.goto(`/device?request=${body.result?.request ?? ""}`);
      await expect(p.getByRole("heading", { name: "Sign in on a Mac?" })).toBeVisible();
      await p.locator("#sx-code").fill(body.result?.code ?? "");
      await p.getByRole("button", { name: "Approve this Mac" }).click();
      await expect(p.getByRole("heading", { name: "Mac signed in" })).toBeVisible();
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
