// Home and the places around it (`10-home-feed-journal.md`,
// `12-testing-linting-ci.md` §3.6): notes and saved links, folders, nesting by
// drag, the two-step delete with the Trash, saved drafts, archiving, report
// import, and the ask box and settings surviving a reload.

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  askBox,
  responseRoot,
  signInAndOpenHome,
  startResearch,
  waitForAnswer,
} from "./helpers.js";

/** The X post the fixture providers resolve (`runs/fixtureProvider.ts`). */
const FIXTURE_TWEET_URL = "https://x.com/session/status/1599367266448994304";

function unfiled(page: Page): Locator {
  return page.getByRole("feed", { name: "Recent activity" });
}

/** A card's open button, by text in its accessible name. */
function card(scope: Locator | Page, name: string | RegExp): Locator {
  const pattern =
    typeof name === "string" ? new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : name;
  return scope
    .locator("[data-research-card-hit]")
    .and(scope.getByRole("button", { name: pattern }));
}

/** Saves `text` from the Home ask box as a note (a link when it is one URL). */
async function saveNote(page: Page, text: string): Promise<void> {
  await askBox(page).click();
  await page.getByRole("radio", { name: "Save as note" }).click();
  await askBox(page).fill(text);
  await page.getByRole("button", { name: /^Save (note|link)$/ }).click();
  await expect(askBox(page)).toHaveValue("");
}

/** Drags with the mouse from the middle of `from` to `to`'s point at
 * `(x, y)` fractions of its box, in steps, as the card drag needs. */
async function drag(page: Page, from: Locator, to: Locator, x = 0.5, y = 0.5): Promise<void> {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error("a drag end has no box");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 8, start.y + start.height / 2 + 8, {
    steps: 4,
  });
  await page.mouse.move(end.x + end.width * x, end.y + end.height * y, { steps: 12 });
  await page.mouse.move(end.x + end.width * x, end.y + end.height * y + 1, { steps: 2 });
  await page.mouse.up();
}

test("a note and a saved link show in Home, the link as its X post's label", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-notes" });

  await saveNote(page, "# Reading list\n\nBloom filters\n\n\nSkip lists");
  const note = card(unfiled(page), "Reading list");
  await expect(note).toBeVisible();
  // The heading shows in the title's style, the rest muted with the blank
  // lines removed.
  const preview = unfiled(page)
    .locator("[data-research-card]", { hasText: "Reading list" })
    .locator("[data-research-feed-preview]");
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((element) => element.textContent)).toBe(
    "Bloom filters\nSkip lists",
  );

  await askBox(page).click();
  await page.getByRole("radio", { name: "Save as note" }).click();
  await askBox(page).fill(FIXTURE_TWEET_URL);
  await expect(page.getByRole("button", { name: "Save link" })).toBeVisible();
  await page.getByRole("button", { name: "Save link" }).click();
  // The post resolved, so the card shows its label rather than the embed.
  await expect(unfiled(page).locator("[data-research-card-labels]")).toHaveText(
    "[Tweet: @session]",
  );
});

test("a new folder takes a dragged card, and a card dropped on another nests", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-folders" });

  await page.getByRole("button", { name: "+ New folder" }).click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await dialog.getByRole("textbox", { name: "Folder name" }).fill("Papers");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  const tray = page.getByRole("region", { name: "Papers" });
  await expect(tray).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Folders" })).toContainText("Papers");

  // A second folder with the same name is refused in the dialog.
  await page.getByRole("button", { name: "+ New folder" }).click();
  await dialog.getByRole("textbox", { name: "Folder name" }).fill("papers");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A folder named “papers” already exists.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await saveNote(page, "Parent note");
  await saveNote(page, "Child note");
  await saveNote(page, "Filed note");

  // The middle of a card nests the dragged one under it.
  await drag(page, card(unfiled(page), "Child note"), card(unfiled(page), "Parent note"));
  await expect(
    unfiled(page).getByRole("button", { name: /^Hide 1 item under “Parent note”/ }),
  ).toBeVisible();
  await expect(card(unfiled(page), /^Child note, in “Parent note”/)).toBeVisible();

  // A drop on a tray files the card there.
  await drag(page, card(unfiled(page), "Filed note"), tray.locator("header"));
  await expect(card(tray, "Filed note")).toBeVisible();
  await expect(card(unfiled(page), "Filed note")).toHaveCount(0);
});

test("Delete moves to the Trash; Restore brings it back; Empty Trash deletes", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-trash" });
  await saveNote(page, "Disposable note");
  const note = card(unfiled(page), "Disposable note");
  await expect(note).toBeVisible();

  const openDelete = async () => {
    await note.hover();
    await unfiled(page)
      .locator("[data-research-card]", { hasText: "Disposable note" })
      .getByRole("button", { name: "Thread actions" })
      .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    return page.getByRole("dialog", { name: "Delete “Disposable note”?" });
  };

  // Delete now asks a second time; Cancel keeps the note.
  let dialog = await openDelete();
  await dialog.getByRole("button", { name: "Delete now" }).click();
  await expect(page.getByRole("dialog", { name: "Delete permanently?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(note).toBeVisible();

  dialog = await openDelete();
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(note).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Folders" })
    .getByRole("link", { name: "Trash" })
    .click();
  await expect(page.getByRole("heading", { name: "Trash", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Restore Disposable note" }).click();
  await expect(page.getByRole("list", { name: "Items in the Trash" })).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Research" })
    .getByRole("link", { name: "Home" })
    .click();
  await expect(note).toBeVisible();
  dialog = await openDelete();
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(note).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Folders" })
    .getByRole("link", { name: "Trash" })
    .click();
  await page.getByRole("button", { name: "Empty Trash" }).click();
  const empty = page.getByRole("dialog", { name: "Empty the Trash?" });
  await expect(empty).toContainText("1 item will be deleted.");
  await empty.getByRole("button", { name: "Empty Trash" }).click();
  await expect(page.getByText("The Trash is empty.")).toBeVisible();
});

test("a saved draft opens from Drafts and sends as a question", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-drafts" });
  await askBox(page).click();
  await askBox(page).fill("What is a trie?");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Save draft" }).click();
  await expect(askBox(page)).toHaveValue("");

  const drafts = page.getByRole("region", { name: "Drafts" });
  const draft = card(drafts, "Draft: What is a trie?");
  await expect(draft).toBeVisible();
  await draft.click();

  await expect(page).toHaveURL(/\/drafts\/[^/?]+/);
  const field = page.getByRole("textbox", { name: "Draft question" });
  await expect(field).toHaveValue("What is a trie?");
  await field.fill("What is a radix trie?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForURL(/\/r\/[^/?]+/, { timeout: 30_000 });
  await waitForAnswer(page);

  await page.goto("/drafts");
  await expect(page.getByText("No drafts.", { exact: false })).toBeVisible();
});

test("a finished thread shows in Home, and Move to Archive files it there", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-library" });
  await startResearch(page, "What is a skip list?");
  await waitForAnswer(page);

  await page.goto("/");
  const row = unfiled(page).locator("[data-research-card]").first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole("button", { name: "Thread actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(unfiled(page).locator("[data-research-card]")).toHaveCount(0);
  // The thread behind the menu is not opened by the same click.
  await expect(page).not.toHaveURL(/\/r\//);
  const archive = page.getByRole("region", { name: "Archive" });
  await expect(archive.locator("[data-research-card]")).toHaveCount(1);
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

test("preserves unsubmitted prompt draft text across page reload", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-draft" });

  await askBox(page).click();
  await askBox(page).fill("What is a rope data structure?");
  // Draft state is restored immediately from `sessionStorage`, with server persistence debounced.
  await page.waitForTimeout(500);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(askBox(page)).toHaveValue("What is a rope data structure?");
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

  await page.getByRole("combobox", { name: "Color theme" }).click();
  await page.getByRole("option", { name: "Warm" }).click();
  await expect(html).toHaveAttribute("data-color-theme", "orange-blob");

  // The mirror is pushed on a debounce, so the assertion after the reload is
  // what proves the account's copy — not the local one — was written.
  await page.waitForTimeout(1_000);
  await page.reload();
  await expect(html).toHaveAttribute("data-appearance", "light");
  await expect(html).toHaveAttribute("data-color-theme", "orange-blob");
});

test("the desktop's Reduce motion and Require ⌘↵ settings take effect and persist", async ({
  page,
}) => {
  await signInAndOpenHome(page, { login: "e2e-settings-input" });
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-reduce-motion", "");

  await page.goto("/settings");
  await page.getByRole("checkbox", { name: "Reduce motion" }).click();
  await expect(html).toHaveAttribute("data-reduce-motion", "");
  await page.getByRole("checkbox", { name: /^Require .+ to send/ }).click();
  await expect(page.getByRole("checkbox", { name: /^Require .+ to send/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Widgets in answers/ })).toBeChecked();
  await expect(page.getByText("Show tool calls")).toHaveCount(0);

  await page.waitForTimeout(1_000);
  await page.reload();
  await expect(html).toHaveAttribute("data-reduce-motion", "");

  // Without Require ⌘↵, a bare Enter sends from the Home ask box.
  await page.goto("/");
  await askBox(page).click();
  await askBox(page).fill("What is a skip list?");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/r\/[^/?]+/, { timeout: 30_000 });
});
