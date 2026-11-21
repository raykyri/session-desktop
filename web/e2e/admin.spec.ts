// The Site Admin settings end to end (02 W8.2, §12.2; 03 K15): a site admin
// changes the default model and the default effort, with the two toasts; the
// page lists only models payable with included tokens; a member's composer
// starts on both after a reload; a member who is not a site admin gets the
// not-found page at /admin.

import { expect, test, type Page } from "@playwright/test";

import { mutation, signIn, signedInContext } from "./helpers.js";
import { toast } from "./spaces.js";

/** The registry's models payable with included tokens, in registry order. */
const INCLUDED_MODELS = [
  "Gemini 3.8 Flash",
  "DeepSeek V4.1 Flash",
  "GPT-5.6 Luna",
  "Claude Fable 5.1",
];

/** The composer's model button, and the effort its menu shows. */
async function composerChoice(page: Page): Promise<{ model: string; effort: string }> {
  const button = page.getByTitle("Model and effort");
  await expect(button).toBeVisible();
  const model = (await button.textContent()) ?? "";
  await button.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const effort = (await menu.locator(".mi-v").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  return { model, effort };
}

test.afterEach(async ({ browser }) => {
  // Put the site defaults back for the specs that run after this one.
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, { login: "e2e-admin-reset", isAdmin: true });
  await mutation(page.request, "admin.models.setDefault", { model: "gemini-flash" });
  await mutation(page.request, "admin.models.setDefaultEffort", { effort: "medium" });
  await context.close();
});

test("a site admin sets the default model and effort; a member's composer starts on both", async ({
  page,
  browser,
}) => {
  await signIn(page, { login: "e2e-admin", isAdmin: true });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Site Admin", level: 2 })).toBeVisible();
  await expect(page.getByText("Settings for everyone on Session.")).toBeVisible();

  const models = page.getByRole("radiogroup", { name: "Default model" });
  const efforts = page.getByRole("radiogroup", { name: "Default effort" });
  const modelRadios = models.getByRole("radio");
  await expect(modelRadios).toHaveCount(INCLUDED_MODELS.length);
  for (const label of INCLUDED_MODELS) {
    await expect(models.getByRole("radio", { name: new RegExp(label) })).toBeVisible();
  }
  await expect(efforts.getByRole("radio")).toHaveCount(4);
  for (const effort of ["Low", "Medium", "High", "Max"]) {
    await expect(efforts.getByRole("radio", { name: effort })).toBeEnabled();
  }

  await models.getByRole("radio", { name: /DeepSeek V4\.1 Flash/ }).check();
  await expect(toast(page)).toHaveText("Default model set to DeepSeek V4.1 Flash.");
  await efforts.getByRole("radio", { name: "Low" }).check();
  await expect(toast(page)).toHaveText("Default effort set to Low.");

  // The settings are stored: they survive a reload of the page.
  await page.reload();
  await expect(models.getByRole("radio", { name: /DeepSeek V4\.1 Flash/ })).toBeChecked();
  await expect(efforts.getByRole("radio", { name: "Low" })).toBeChecked();

  // A member's composer starts on both, and again after a reload.
  const member = await signedInContext(browser, "e2e-admin-member");
  await member.page.goto("/");
  await expect
    .poll(() => composerChoice(member.page))
    .toEqual({ model: "DeepSeek", effort: "Low" });
  await member.page.reload();
  await expect
    .poll(() => composerChoice(member.page))
    .toEqual({ model: "DeepSeek", effort: "Low" });

  // A default effort the default model does not accept steps down: Max on a
  // model that stops at High starts the composer on High.
  await efforts.getByRole("radio", { name: "Max" }).check();
  await expect(toast(page)).toHaveText("Default effort set to Max.");
  await member.page.reload();
  await expect
    .poll(() => composerChoice(member.page))
    .toEqual({ model: "DeepSeek", effort: "High" });

  // A member who is not a site admin gets the not-found page.
  await member.page.goto("/admin");
  await expect(member.page.getByRole("alert")).toContainText("Not found");
  await expect(member.page.getByRole("radiogroup", { name: "Default model" })).toHaveCount(0);
  await member.context.close();
});
