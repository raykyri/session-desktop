// The shell's admin page and sign-in end to end (phase 2a;
// `12-testing-linting-ci.md` §3.6). The admin flag is set through the
// test-login route, which is the same `users.setAdmin` the `db:admin` script
// calls.

import { expect, test } from "@playwright/test";

import { signIn, signInAndOpenHome } from "./helpers.js";

test("an admin opens the admin page and makes sign-up codes", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-admin", isAdmin: true });
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole("button", { name: "Create codes" }).click();
  await expect(page.getByText(/[A-Z0-9]{6,}/).first()).toBeVisible();
});

test("an account that is no admin has no Admin link", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-plain" });
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
});

test("a guest is sent to sign in, and a signed-in account comes back", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
  await signIn(page, { login: "e2e-login" });
  await page.goto("/login?redirect=%2Fsettings");
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});
