// Reply trees on posts (02 §12.2 `spaces-replies`, W4.3): selecting a reply,
// replying to it, Reply at root, the footer's Reply, the mention toast, the
// tree's keys, collapsing a reply's replies, and where focus goes from a
// reply's composer (02 §10.1): Escape and Close return it to the selected
// row, a send moves it to the new reply.
//
// hal's post has three replies: mira's, sol's, and one under sol's. They are
// written through the sync routes before the specs run (`world.ts`).

import { expect, test, type Page } from "@playwright/test";

import { row, signInAndOpen, toast } from "./spaces.js";
import { channelName, person, type Writer } from "./world.js";

const LOGIN = "e2e-replies";
const POST = "Is anyone else seeing the follow-up count lag";

const w = { hal: null as Writer | null, sol: null as Writer | null };

test.beforeAll(async ({ browser }) => {
  const hal = await person(browser, "e2e-replies-hal");
  const sol = await person(browser, "e2e-replies-sol");
  const mira = await person(browser, "e2e-replies-mira");
  const me = await person(browser, LOGIN);
  w.hal = hal;
  w.sol = sol;
  const space = await hal.channel(channelName("replies"));
  for (const p of [sol, mira, me]) await p.join(space);
  const post = await hal.post(space, `${POST} after a branch is deleted?`);
  await mira.reply(post, "Same here, it stays one behind.");
  const confirmed = await sol.reply(post, "Confirmed, it is on the alpha known-issues page.");
  await mira.reply(post, "Thanks, I missed that page.", confirmed);
});

const post = (page: Page) => row(page, POST);

test.beforeEach(async ({ page }) => {
  await signInAndOpen(page, LOGIN);
});

test("a reply's card, and a reply to it is selected in the tree", async ({ page }) => {
  const sol = w.sol?.handle ?? "";
  const tree = post(page).getByRole("tree", { name: "Replies" });
  await expect(tree.getByRole("treeitem")).toHaveCount(3);
  await tree.getByRole("treeitem", { name: /Confirmed, it is on the alpha/ }).click();
  const preview = post(page).locator(".preview");
  await expect(preview).toContainText(sol);
  await expect(preview).toContainText("Confirmed, it is on the alpha known-issues page.");
  await preview.getByRole("button", { name: "Reply", exact: true }).click();
  const field = post(page).getByRole("textbox", { name: `Reply to @${sol}` });
  await expect(field).toBeFocused();
  await field.fill(`Thanks @${sol}, and @nobody.here too`);
  await field.press("Control+Enter");
  await expect(toast(page)).toHaveText(`Notified @${sol}. @nobody.here isn't a member.`);
  const selected = tree.getByRole("treeitem", { selected: true });
  await expect(selected).toContainText(`Thanks @${sol}`);
  await expect(selected).toHaveAttribute("aria-level", "2");
  await expect(post(page).locator(".preview .mention")).toHaveText(`@${sol}`);
});

test("Reply at root and the footer's Reply open the root composer", async ({ page }) => {
  const hal = w.hal?.handle ?? "";
  await post(page).getByRole("button", { name: "Reply at root" }).click();
  const field = post(page).getByRole("textbox", { name: `Reply to @${hal}` });
  await expect(field).toBeFocused();
  await post(page).getByRole("button", { name: "Close reply" }).click();
  await expect(field).toHaveCount(0);

  const footer = post(page).getByRole("button", { name: /^Reply, \d+ replies$/ });
  const before = Number((await footer.getAttribute("aria-label"))?.match(/\d+/)?.[0]);
  await footer.click();
  await expect(post(page).getByRole("textbox", { name: `Reply to @${hal}` })).toBeFocused();
  await post(page)
    .getByRole("textbox", { name: `Reply to @${hal}` })
    .fill("Same here.");
  await post(page).getByRole("button", { name: "Reply", exact: true }).last().click();
  await expect(post(page).getByRole("tree", { name: "Replies" }).getByRole("treeitem")).toHaveCount(
    before + 1,
  );
  await expect(
    post(page).getByRole("button", { name: `Reply, ${before + 1} replies` }),
  ).toBeVisible();
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
  await page.keyboard.press("ArrowUp");
  await expect(tree.getByRole("treeitem").nth(0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(tree.getByRole("treeitem").last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tree.getByRole("treeitem").nth(0)).toBeFocused();
});

test("a reply's replies collapse with Left and expand with Right or +N", async ({ page }) => {
  const tree = post(page).getByRole("tree", { name: "Replies" });
  const parent = tree.getByRole("treeitem", { name: /Confirmed, it is on the alpha/ });
  const count = await tree.getByRole("treeitem").count();
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  await parent.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(parent).toHaveAttribute("aria-expanded", "false");
  await expect(parent).toBeFocused();
  const hidden = count - (await tree.getByRole("treeitem").count());
  expect(hidden).toBeGreaterThan(0);
  await page.keyboard.press("ArrowRight");
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("treeitem")).toHaveCount(count);

  await page.keyboard.press("ArrowLeft");
  const more = post(page).getByRole("button", {
    name: `Show ${hidden} more ${hidden === 1 ? "reply" : "replies"}`,
  });
  await expect(post(page).locator(".rhid")).toHaveText(`+${hidden}`);
  await more.click();
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("treeitem")).toHaveCount(count);
});

// Last: it adds a reply, which the counts above do not expect.
test("Escape and Close on a reply's composer return focus to its row; a send moves it to the new reply", async ({
  page,
}) => {
  const sol = w.sol?.handle ?? "";
  const tree = post(page).getByRole("tree", { name: "Replies" });
  const solRow = tree.getByRole("treeitem", { name: /Confirmed, it is on the alpha/ });
  await solRow.click();
  const preview = post(page).locator(".preview");
  const field = post(page).getByRole("textbox", { name: `Reply to @${sol}` });

  await preview.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(solRow).toBeFocused();

  await preview.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(field).toBeFocused();
  await post(page).locator("form.icomp").getByRole("button", { name: "Close" }).click();
  await expect(field).toHaveCount(0);
  await expect(solRow).toBeFocused();

  await preview.getByRole("button", { name: "Reply", exact: true }).click();
  await field.fill("Focus moves to this reply.");
  await field.press("Control+Enter");
  const fresh = tree.getByRole("treeitem", { name: /Focus moves to this reply/ });
  await expect(fresh).toHaveAttribute("aria-selected", "true");
  await expect(fresh).toBeFocused();
});
