// Signed-out reading (02 §9.5, §12.2 `spaces-signed-out`): the open
// channels' threads, their branches and replies, nothing of a private
// channel, and every write control leading to sign-in.

import { expect, test } from "@playwright/test";

import { FIRST_ASK, REPLY_POST_TEXT, openFeed, row } from "./spaces.js";

test.beforeEach(async ({ page }) => {
  await openFeed(page);
});

test("a thread, its branches and its replies read signed out", async ({ page }) => {
  const side = page.locator(`[data-side="${FIRST_ASK}"]`);
  await side.getByRole("treeitem", { name: /how does the darknet/ }).click();
  await expect(side.locator(".preview")).toContainText("Tasks are posted to the darknet");
  // No write actions on the card.
  await expect(side.getByRole("button", { name: "Continue" })).toHaveCount(0);
  await expect(side.getByRole("button", { name: "Comment" })).toHaveCount(0);

  const post = row(page, REPLY_POST_TEXT);
  await post.getByRole("treeitem", { name: /Same here/ }).click();
  await expect(post.locator(".preview")).toContainText(
    "The count seems to include direct follow-ups",
  );
  await expect(post.getByRole("button", { name: "Sign in to reply" })).toBeVisible();
});

test("private channels are not read", async ({ page }) => {
  await expect(page.locator(".ttm", { hasText: "#grant-review" })).toHaveCount(0);
  await expect(page.locator(".fmeta", { hasText: "#grant-review" })).toHaveCount(0);
  await page.goto("/c/grant-review");
  await expect(page.getByText("This channel is private. Ask @sol to add you.")).toBeVisible();
});

test("write controls open sign-in", async ({ page }) => {
  const cover = page.getByRole("button", { name: "Sign in to ask or post" });
  await expect(page.locator(`textarea[aria-label="Ask or post"]`)).toHaveAttribute(
    "placeholder",
    "Sign in to ask or post",
  );
  await cover.click();
  await expect(page).toHaveURL(/\/login\?redirect=/);

  await openFeed(page);
  await page.locator(`#card-${FIRST_ASK}`).getByRole("button", { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/login\?redirect=/);

  await openFeed(page);
  await page
    .locator(`#card-${FIRST_ASK}`)
    .getByRole("button", { name: /^Ask a follow-up/ })
    .click();
  await expect(page).toHaveURL(/\/login\?redirect=/);
});
