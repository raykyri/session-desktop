// The feed end to end (02 §12.2 `spaces-feed`, M4 parts): a post, a save and
// the Saved count, the footer meta with no model or effort text, an ask
// that runs and is answered (mocked until M5a), delete, the removed
// placeholder, and thread addresses.

import { expect, test } from "@playwright/test";

import { FIRST_ASK, card, compose, signInAndOpen, toast } from "./spaces.js";

test.beforeEach(async ({ page }) => {
  await signInAndOpen(page, "e2e-feed");
});

test("a post goes to the top of Home with its channel beside the avatar", async ({ page }) => {
  await compose(page, "Reading list for the winter, suggestions welcome.", "Post");
  const first = page.locator(".tcard").first();
  await expect(first.locator(".tt-title")).toHaveText(
    "Reading list for the winter, suggestions welcome.",
  );
  await expect(first.locator(".ttm")).toHaveText("#public");
  await expect(first.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  // The composer empties and its send button is disabled again.
  await expect(page.getByRole("textbox", { name: "Ask or post" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Post", exact: true })).toBeDisabled();
});

test("save: the toasts, the Saved count and the Saved feed", async ({ page }) => {
  const thread = page.locator(`#card-${FIRST_ASK}`);
  const save = thread.getByRole("button", { name: /^Save/ });
  await expect(save).toHaveAttribute("aria-label", "Save, saved by 26");
  await save.click();
  await expect(toast(page)).toHaveText("Saved.");
  await expect(thread.getByRole("button", { name: /^Saved/ })).toHaveAttribute(
    "aria-label",
    "Saved, saved by 27",
  );
  // Back at the top, the bar shows.
  await page.locator("[data-shell-scroll]").evaluate((el) => el.scrollTo(0, 0));
  await expect(page.getByRole("link", { name: "Saved, 1" })).toBeVisible();

  await page.getByRole("link", { name: "Saved, 1" }).click();
  await expect(page).toHaveURL(/\/saved$/);
  await expect(page.locator(".tcard")).toHaveCount(1);
  await page
    .locator(`#card-${FIRST_ASK}`)
    .getByRole("button", { name: /^Saved/ })
    .click();
  await expect(toast(page)).toHaveText("Removed from saved.");
  await expect(page.getByRole("heading", { name: "Nothing saved yet" })).toBeVisible();
});

test("an ask's footer meta, and no model or effort text in a card", async ({ page }) => {
  const thread = page.locator(`#card-${FIRST_ASK}`);
  await expect(thread.locator(".fmeta")).toHaveText("7 sources · 184k tokens · #public");
  await expect(thread.getByRole("button", { name: "Ask a follow-up, 6 branches" })).toBeVisible();
  // The model and effort are stored on the records and shown nowhere: not in
  // a title row or footer, and not in any card's markup.
  const chrome = (await page.locator(".tcard .tt, .tcard .card-f").allInnerTexts()).join("\n");
  expect(chrome).not.toMatch(/\b(Fable|Gemini|Luna|DeepSeek|effort|Low|Medium|High|Max)\b/);
  const markup = (
    await page.locator(".tcard").evaluateAll((cards) => cards.map((c) => c.outerHTML))
  ).join("");
  expect(markup).not.toMatch(/claude-fable|gemini-flash|data-effort|data-model/);
});

test("an ask runs and is answered", async ({ page }) => {
  await compose(page, "what is a bloom filter");
  const thread = card(page, "what is a bloom filter");
  await expect(thread.getByText("Researching · Step 1 of 4")).toBeVisible();
  // The follow-up button is hidden while the root answer runs.
  await expect(thread.getByRole("button", { name: /^Ask a follow-up/ })).toHaveCount(0);
  await expect(thread.getByText(/^Mock answer to "what is a bloom filter"/)).toBeVisible();
  await expect(thread.locator(".fmeta")).toHaveText("41k tokens · #public");
});

test("deleting one's own post asks first", async ({ page }) => {
  await compose(page, "A post to delete.", "Post");
  const thread = card(page, "A post to delete.");
  await thread.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete post" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this thread?" });
  await expect(dialog).toContainText("This can't be undone.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(thread).toHaveCount(0);
});

test("Delete is not offered once someone else has responded", async ({ page }) => {
  await page.locator(`#card-${FIRST_ASK}`).getByRole("button", { name: "More" }).click();
  const item = page.getByRole("menuitem", { name: /Delete ask/ });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toContainText("Not available once someone else has responded");
});

test("a removed thread shows its placeholder and no text", async ({ page }) => {
  const removed = page.locator(".tcard.removed").first();
  await removed.scrollIntoViewIfNeeded();
  await expect(removed).toContainText("Removed by @mira_k");
  await expect(removed).toContainText(
    "Reason: “Duplicate of the Nov 12 thread on the same paper. Please continue there.”",
  );
  await expect(removed).toContainText("Ask by [deleted] in #replication-club");
  await expect(removed.locator(".card-f")).toHaveCount(0);
});

test("a thread address scrolls to its thread and selects the item", async ({ page }) => {
  await page.goto(`/c/markets?t=01M7HGRPJ0E7RGZ45D4KENBQ6P`);
  const thread = page.locator("#card-01M7HGRPJ0E7RGZ45D4KENBQ6P");
  await expect(thread).toBeInViewport();
  await expect(thread).toHaveClass(/flash/);
  await expect(thread).not.toHaveClass(/flash/, { timeout: 3000 });
});

test("a thread address the viewer cannot read shows a toast", async ({ page }) => {
  await page.goto(`/?t=01M7AAAAAAAAAAAAAAAAAAAAAA`);
  await expect(toast(page)).toHaveText("This thread is not available.");
});
