// Channels end to end, M4 parts (02 §12.2 `spaces-channels`; W6.1-W6.3,
// W6.6, W6.7): join and leave from the header and Browse, leaving a private
// channel, New channel with its validation and CONFLICT, and About.

import { expect, test } from "@playwright/test";

import { signInAndOpen, toast } from "./spaces.js";

test.beforeEach(async ({ page }) => {
  await signInAndOpen(page, "e2e-channels");
});

test("join and leave from the channel header", async ({ page }) => {
  await page.goto("/c/history");
  const header = page.locator(".sphead");
  await expect(header.getByRole("heading", { name: "#history" })).toBeVisible();
  // Not joined: no composer.
  await expect(page.getByRole("textbox", { name: "Ask or post" })).toHaveCount(0);
  await header.getByRole("button", { name: "Join" }).click();
  await expect(toast(page)).toHaveText("Joined #history.");
  await expect(page.getByRole("textbox", { name: "Ask or post" })).toBeVisible();
  await header.getByRole("button", { name: "Joined" }).click();
  await expect(toast(page)).toHaveText("Left #history.");
  await expect(page).toHaveURL(/\/c\/history$/);
});

test("leaving a private channel goes Home", async ({ page }) => {
  await page.goto("/c/grant-review");
  const header = page.locator(".sphead");
  await expect(header.getByRole("img", { name: "Private" })).toBeVisible();
  await header.getByRole("button", { name: "Joined" }).click();
  await expect(toast(page)).toHaveText("Left #grant-review.");
  await expect(page).toHaveURL(/\/$/);
});

test("the owner's header, info dialog and About editor", async ({ page }) => {
  await page.goto("/c/sci-fi");
  const header = page.locator(".sphead");
  await expect(header.getByText("Your channel")).toBeVisible();
  await header.getByRole("button", { name: "About this channel" }).click();
  const info = page.getByRole("dialog", { name: "#sci-fi" });
  await expect(info.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(info.locator("dd").first()).toHaveText("IV@ines.v");
  await expect(info).toContainText("Open: anyone can read and join");
  await info.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByRole("dialog", { name: "Edit #sci-fi" });
  const about = editor.getByRole("textbox", { name: /About/ });
  await expect(about).toBeFocused();
  await about.fill("Science fiction, read closely.");
  await expect(editor.getByText("30 / 300")).toBeVisible();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toHaveText("Channel updated.");
  await expect(info.getByRole("button", { name: "Edit" })).toBeFocused();
  await expect(info).toContainText("Science fiction, read closely.");
  await page.keyboard.press("Escape");
  await expect(info).toHaveCount(0);
  await expect(header).toContainText("Science fiction, read closely.");
});

test("New channel: validation, CONFLICT, and the new channel", async ({ page }) => {
  await page.getByRole("button", { name: "New channel" }).click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  const name = dialog.getByRole("textbox", { name: /Name/ });
  await expect(name).toBeFocused();
  await name.fill("A");
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(dialog.getByText("Use 2 to 30 lowercase letters, numbers or dashes.")).toBeVisible();
  await name.fill("public");
  await dialog.getByRole("textbox", { name: "What is it for?" }).fill("Kept after a conflict.");
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(dialog.getByText("#public already exists.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "What is it for?" })).toHaveValue(
    "Kept after a conflict.",
  );

  await name.fill("reading-group");
  await dialog.getByRole("radio", { name: /Private/ }).check();
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(page).toHaveURL(/\/c\/reading-group$/);
  await expect(toast(page)).toHaveText(
    "#reading-group is ready. Invite people by sharing its link.",
  );
  const header = page.locator(".sphead");
  await expect(header.getByRole("heading", { name: "#reading-group" })).toBeVisible();
  await expect(header.getByText("Your channel")).toBeVisible();
  await expect(page.getByText("No threads here yet. Ask the first question.")).toBeVisible();
  await expect(
    page.getByRole("banner").getByRole("link", { name: "#reading-group" }),
  ).toBeVisible();
});

test("Browse: search, its empty line, and Join that stays on Browse", async ({ page }) => {
  await page.goto("/browse");
  await expect(page.getByRole("heading", { name: "Browse channels", level: 2 })).toBeVisible();
  await expect(page.locator(".bcard", { hasText: "#northwind-eng" })).toHaveCount(0);
  await expect(page.locator(".bcard", { hasText: "#grant-review" })).toBeVisible();
  const search = page.getByRole("textbox", { name: "Search channels" });
  await search.fill("zzz");
  await expect(page.getByText("No channels match.")).toBeVisible();
  await search.fill("histor");
  const history = page.locator(".bcard", { hasText: "#history" });
  await expect(page.locator(".bcard")).toHaveCount(1);
  await history.getByRole("button", { name: "Join" }).click();
  await expect(toast(page)).toHaveText("Joined #history.");
  await expect(history.getByRole("button", { name: "Joined" })).toBeVisible();
  await expect(page).toHaveURL(/\/browse$/);
  await search.fill("sci");
  await expect(page.locator(".bcard", { hasText: "#sci-fi" }).getByText("Yours")).toBeVisible();
});
