// Everything that happens to a thread after it finishes
// (`12-testing-linting-ci.md` §3.6): bookmarking and the two feeds, archiving,
// importing a report, an encyclopedia page reached from a wikilink, and the
// appearance settings surviving a reload.

import { expect, test } from "@playwright/test";

import { responseRoot, signInAndOpenHome, startResearch, waitForAnswer } from "./helpers.js";

test("a bookmarked thread shows in Home and Bookmarks, and archiving hides it", async ({
  page,
}) => {
  await signInAndOpenHome(page, { login: "e2e-library" });
  await startResearch(page, "What is a skip list?");
  await waitForAnswer(page);

  // Thread actions menu is displayed below the root question after run completion.
  await page.getByRole("button", { name: "Bookmark", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove bookmark" })).toBeVisible();

  const title = "What is a skip list?";

  await page.goto("/");
  const home = page.getByRole("feed", { name: "Home" });
  // The row and the card are both articles, so the outermost match is taken.
  await expect(home.getByRole("article").filter({ hasText: title }).first()).toBeVisible();

  await page.goto("/bookmarks");
  await expect(page.getByRole("heading", { name: "Bookmarks", level: 1 })).toBeVisible();
  const bookmarks = page.getByRole("feed", { name: "Bookmarks" });
  await expect(bookmarks.getByRole("article").filter({ hasText: title }).first()).toBeVisible();

  // Archive lives in the thread menu, which the sidebar row and the Home card
  // share (`features/research/treeMenu.tsx`).
  const sidebar = page.getByRole("region", { name: "Research" });
  // The sidebar labels a row with the generated thread title, not the prompt,
  // so the row is counted rather than named.
  const rows = sidebar.getByRole("button", { name: /^Actions for / });
  await expect(rows).toHaveCount(1);
  // The ⋯ trigger is pointer-events-none until the row is hovered.
  await sidebar.locator("[data-research-row]").first().hover();
  await rows.first().click();
  const archive = page.getByRole("menuitem", { name: /^Archive/ });
  await expect(archive).toBeVisible();
  // A plain mouse click, which is the path that used to break: the row's drag
  // handler took pointer capture on React's replayed `pointerdown` from the
  // portalled item and the browser then dispatched the click on `<body>`
  // (`ResearchSidebarSection.tsx`, `isOwnRowEvent`).
  await archive.click();

  await expect(rows).toHaveCount(0);
  // The thread behind the menu is not opened by the same click.
  await expect(page).toHaveURL(/\/bookmarks$/);
  await expect(page.locator("[data-base-ui-inert]")).toHaveCount(0);

  // The item is filtered from the active view; switching to the archived filter displays it.
  await sidebar.getByRole("button", { name: /^Show .* research$/ }).click();
  await page.getByRole("menuitem", { name: "archived" }).click();
  await expect(rows).toHaveCount(1);
});

test("a Markdown report is imported as a thread", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-import" });

  await page.locator('input[type="file"][accept=".md,text/markdown"]').setInputFiles({
    name: "b-trees.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# B-trees\n\nA B-tree keeps its fan-out high so the tree stays short.\n"),
  });

  const dialog = page.getByRole("dialog", { name: "Import report" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("b-trees.md");
  await dialog
    .getByRole("textbox", { name: "Prompt that generated this report" })
    .fill("Explain B-trees.");
  await dialog.getByRole("button", { name: "Import report" }).click();

  await page.waitForURL(/\/r\/[^/?]+/, { timeout: 30_000 });
  await expect(responseRoot(page)).toContainText("fan-out high");
});

test("a wikilink in an answer opens an encyclopedia page for the term", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-encyclopedia" });
  await startResearch(page, "Explain bloom filters.");
  await waitForAnswer(page);

  // The recorded answer contains `[[Bloom filter]]`, which renders as a
  // wikilink rather than an href (`features/markdown/wikilinks.tsx`).
  const wikilink = responseRoot(page).locator('[data-wikilink="Bloom filter"]').first();
  await expect(wikilink).toBeVisible();
  await wikilink.click();
  // No page yet, so the click asks first (`features/markdown/ResearchMarkdown.tsx`).
  await page.getByRole("button", { name: "Create page" }).click();

  await page.waitForURL(/\/e\/bloom-filter/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Bloom filter/i, {
    timeout: 60_000,
  });
  // The page the metadata model writes carries its own wikilinks.
  await expect(page.locator(".research-prose")).toContainText("probabilistic set", {
    timeout: 60_000,
  });
});

test("preserves unsubmitted prompt draft text across page reload", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-draft" });

  const composer = page.getByRole("textbox", { name: "What do you want to investigate?" });
  await composer.click();
  await composer.fill("What is a rope data structure?");
  // Draft state is restored immediately from `sessionStorage`, with server persistence debounced.
  await page.waitForTimeout(500);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "What do you want to investigate?" })).toHaveValue(
    "What is a rope data structure?",
  );
});

test("persists theme and appearance preferences across page reloads", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-settings" });
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-appearance", "dark");
  await expect(html).toHaveAttribute("data-color-theme", "green-blob");

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  await page.getByRole("combobox", { name: "Appearance" }).click();
  await page.getByRole("option", { name: "Light" }).click();
  await expect(html).toHaveAttribute("data-appearance", "light");

  await page.getByRole("combobox", { name: "Theme" }).click();
  await page.getByRole("option", { name: "Warm" }).click();
  await expect(html).toHaveAttribute("data-color-theme", "orange-blob");

  // The mirror is pushed on a debounce, so the assertion after the reload is
  // what proves the account's copy — not the local one — was written.
  await page.waitForTimeout(1_000);
  await page.reload();
  await expect(html).toHaveAttribute("data-appearance", "light");
  await expect(html).toHaveAttribute("data-color-theme", "orange-blob");
});
