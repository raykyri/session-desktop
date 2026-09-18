// Admin model gating end to end (`12-testing-linting-ci.md` §3.6).
//
// `claude-fable` is `adminOnly`, and `system.runtimeConfig` omits it entirely
// for a non-admin rather than sending it disabled — so what a non-admin cannot
// launch, a non-admin also cannot see. The admin flag is set through the
// test-login route, which is the same `users.setAdmin` the `db:admin` script
// calls.

import { expect, test } from "@playwright/test";

import { signInAndOpenHome } from "./helpers.js";

const GATED_MODEL = "Claude Fable 5.1";

test("an admin sees the gated model in the composer's model chip", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-admin", isAdmin: true });

  await page.getByTitle("Model (Tab)").click();
  // The popup takes its accessible name from the trigger (the current model),
  // so it is addressed by role alone.
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: GATED_MODEL })).toBeVisible();

  await menu.getByRole("menuitem", { name: GATED_MODEL }).click();
  await expect(page.getByTitle("Model (Tab)")).toContainText(GATED_MODEL);
});

test("a non-admin is not offered it", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-plain" });

  await page.getByTitle("Model (Tab)").click();
  // The popup takes its accessible name from the trigger (the current model),
  // so it is addressed by role alone.
  const menu = page.getByRole("menu");
  // The menu is populated — this is not an empty-list false pass.
  // Exact: the registry also holds "Gemini 3.8 Flash (Google Search)".
  await expect(menu.getByRole("menuitem", { name: "Gemini 3.8 Flash", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: GATED_MODEL })).toHaveCount(0);
});
