// Admin model gating end to end (`12-testing-linting-ci.md` §3.6).
//
// `claude-fable` is `adminOnly`, and `system.runtimeConfig` omits it entirely
// for non-admin users so they cannot view or select it. The admin flag is set
// through the test-login route, which is the same `users.setAdmin` the `db:admin` script
// calls.

import { expect, test, type Page } from "@playwright/test";

import { askBox, signInAndOpenHome } from "./helpers.js";

const GATED_MODEL = "Claude Fable 5.1";

/** Opens the ask box's model menu: the selected Ask segment opens it. */
async function openModelMenu(page: Page) {
  await askBox(page).click();
  await page.getByRole("radio", { name: /^Ask with / }).click();
  return page.getByRole("menu", { name: "Model" });
}

test("an admin sees the gated model in the ask box's model menu", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-admin", isAdmin: true });

  const menu = await openModelMenu(page);
  await expect(menu.getByRole("menuitem", { name: GATED_MODEL })).toBeVisible();

  await menu.getByRole("menuitem", { name: GATED_MODEL }).click();
  await expect(page.getByRole("radio", { name: `Ask with ${GATED_MODEL}` })).toBeVisible();
});

test("hides admin-only models from non-admin users in the model menu", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-plain" });

  const menu = await openModelMenu(page);
  // The menu is populated — this is not an empty-list false pass.
  // Exact: the registry also holds "Gemini 3.8 Flash (Google Search)".
  await expect(menu.getByRole("menuitem", { name: "Gemini 3.8 Flash", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: GATED_MODEL })).toHaveCount(0);
});
