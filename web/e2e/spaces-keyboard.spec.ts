// Keyboard and motion (02 §10, §12.2 `spaces-keyboard`): focus moving into
// and out of the feed's layers, the Escape order of stacked layers, and
// reduced motion.

import { expect, test } from "@playwright/test";

import { FIRST_ASK, compose, signInAndOpen } from "./spaces.js";

test.describe("focus and Escape", () => {
  test.beforeEach(async ({ page }) => {
    await signInAndOpen(page, "e2e-keyboard");
  });

  test("a card's controls in order, and a tree is one tab stop", async ({ page }) => {
    const card = page.locator(`#card-${FIRST_ASK}`);
    await card.getByRole("button", { name: "More" }).focus();
    const names: string[] = [];
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press("Tab");
      names.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent ??
            "",
        ),
      );
    }
    // Citations and count buttons in reading order, then the footer, then
    // the side column's trees, one stop each.
    expect(names.slice(0, 3)).toEqual([
      "Source 5",
      "1 branch on this passage. Open the first",
      "Source 1",
    ]);
    const footer = names.indexOf("Ask a follow-up, 6 branches");
    expect(footer).toBeGreaterThan(2);
    expect(names[footer + 1]).toBe("Save, saved by 26");
    const trees = await page.evaluate(() =>
      document.activeElement?.closest('[role="tree"]') ? "in a tree" : "outside",
    );
    expect(trees).toBe("in a tree");
  });

  test("Escape closes the About editor, then the info dialog", async ({ page }) => {
    await page.goto("/c/sci-fi");
    await page.getByRole("button", { name: "About this channel" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("dialog", { name: "Edit #sci-fi" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Edit #sci-fi" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "#sci-fi" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "About this channel" })).toBeFocused();
  });

  test("the delete confirmation starts on Cancel and returns to More", async ({ page }) => {
    await compose(page, "To be deleted.", "Post");
    const more = page.locator(".tcard").first().getByRole("button", { name: "More" });
    await more.click();
    await page.getByRole("menuitem", { name: "Delete post" }).click();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test("Escape closes a menu, then the selection actions, then the composer", async ({ page }) => {
    const side = page.locator(`[data-side="${FIRST_ASK}"]`);
    await page
      .locator(`#card-${FIRST_ASK}`)
      .getByRole("button", { name: /^Ask a follow-up/ })
      .click();
    const field = side.getByRole("textbox", { name: "Ask about the answer" });
    await field.fill("draft");
    // A selection in the answer shows its actions.
    await page.locator(`#pr-${FIRST_ASK} [data-passage="2"]`).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    });
    await expect(page.getByRole("button", { name: "Branch here" })).toBeVisible();
    // A menu elsewhere, opened from the keyboard.
    await page.getByTitle("Model and effort").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Branch here" })).toBeVisible();
    await field.focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Branch here" })).toHaveCount(0);
    await expect(field).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("no bar transition, no status pulse, instant scrolls", async ({ page }) => {
    await signInAndOpen(page, "e2e-motion");
    const duration = await page
      .locator(".app-bar-slot")
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
    expect(duration).toBeLessThan(0.001);
    await compose(page, "a question that runs");
    const status = page.locator(".tcard").first().locator(".status");
    await expect(status).toBeVisible();
    expect(await status.evaluate((el) => getComputedStyle(el, "::before").animationName)).toBe(
      "none",
    );
  });
});
