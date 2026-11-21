// Reply trees on posts (02 §12.2 `spaces-replies`, W4.3): selecting a reply,
// replying to it, Reply at root, the footer's Reply, and the mention toast.

import { expect, test, type Page } from "@playwright/test";

import { REPLY_POST_TEXT, row, signInAndOpen, toast } from "./spaces.js";

const post = (page: Page) => row(page, REPLY_POST_TEXT);

test.beforeEach(async ({ page }) => {
  await signInAndOpen(page, "e2e-replies");
});

test("a reply's card, and a reply to it is selected in the tree", async ({ page }) => {
  const tree = post(page).getByRole("tree", { name: "Replies" });
  await expect(tree.getByRole("treeitem")).toHaveCount(3);
  await tree.getByRole("treeitem", { name: /Confirmed, it is on the alpha/ }).click();
  const preview = post(page).locator(".preview");
  await expect(preview).toContainText("sol");
  await expect(preview).toContainText("Confirmed, it is on the alpha known-issues page.");
  await preview.getByRole("button", { name: "Reply", exact: true }).click();
  const field = post(page).getByRole("textbox", { name: "Reply to @sol" });
  await expect(field).toBeFocused();
  await field.fill("Thanks @sol, and @nobody.here too");
  await field.press("Control+Enter");
  await expect(toast(page)).toHaveText("Notified @sol. @nobody.here isn't a member.");
  const selected = tree.getByRole("treeitem", { selected: true });
  await expect(selected).toContainText("Thanks @sol");
  await expect(selected).toHaveAttribute("aria-level", "2");
  await expect(post(page).locator(".preview .mention")).toHaveText("@sol");
});

test("Reply at root and the footer's Reply open the root composer", async ({ page }) => {
  await post(page).getByRole("button", { name: "Reply at root" }).click();
  const field = post(page).getByRole("textbox", { name: "Reply to @hal_b" });
  await expect(field).toBeFocused();
  await post(page).getByRole("button", { name: "Close reply" }).click();
  await expect(field).toHaveCount(0);

  await post(page).getByRole("button", { name: "Reply, 3 replies" }).click();
  await expect(post(page).getByRole("textbox", { name: "Reply to @hal_b" })).toBeFocused();
  await post(page).getByRole("textbox", { name: "Reply to @hal_b" }).fill("Same here.");
  await post(page).getByRole("button", { name: "Reply", exact: true }).last().click();
  await expect(post(page).getByRole("tree", { name: "Replies" }).getByRole("treeitem")).toHaveCount(
    4,
  );
  await expect(post(page).getByRole("button", { name: "Reply, 4 replies" })).toBeVisible();
});

test("the reply tree moves by keyboard", async ({ page }) => {
  const tree = post(page).getByRole("tree", { name: "Replies" });
  await tree.getByRole("treeitem").first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(tree.getByRole("treeitem").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem").nth(2)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tree.getByRole("treeitem").nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tree.getByRole("treeitem").nth(1)).toHaveAttribute("aria-selected", "true");
});
