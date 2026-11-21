// Signed-out reading (02 §9.5, §12.2 `spaces-signed-out`; 04 I5): the open
// channels' threads and replies through the same replica as a member's,
// nothing of a private channel but its landing, and every write control
// leading to sign-in.
//
// olga's open channel holds hal's post with two replies and olga's answered
// ask with its branches; her private channel is only reached by its
// address. They are written through the sync routes, and the ask answered
// by the run loop, before the specs run (`world.ts`).

import { expect, test } from "@playwright/test";

import { openFeed, row } from "./spaces.js";
import { branchedAsk, channelName, person, type Writer } from "./world.js";

const POST = "Where do the reading notes for this week live?";

const w = { olga: null as Writer | null, open: "", lab: "", post: "", ask: "" };

test.beforeAll(async ({ browser }) => {
  const olga = await person(browser, "e2e-out-olga");
  const hal = await person(browser, "e2e-out-hal");
  const sol = await person(browser, "e2e-out-sol");
  w.olga = olga;
  w.open = channelName("out");
  const open = await olga.channel(w.open);
  w.lab = channelName("out-lab");
  const lab = await olga.channel(w.lab, { vis: "private" });
  await olga.post(lab, "Not for readers outside the channel");
  for (const p of [hal, sol]) await p.join(open);
  w.post = await hal.post(open, POST);
  await sol.reply(w.post, "In the pinned doc, under week three.");
  await olga.reply(w.post, "Same here, the pinned doc has them all.");
  w.ask = (await branchedAsk(olga, sol, open)).thread;
});

// The channel's feed: Home reads every open channel, other specs' too.
test.beforeEach(async ({ page }) => {
  await openFeed(page, `/c/${w.open}`);
});

test("a thread and its replies read signed out", async ({ page }) => {
  const post = row(page, POST);
  await post.getByRole("treeitem", { name: /Same here/ }).click();
  await expect(post.locator(".preview")).toContainText("the pinned doc has them all");
  await expect(post.getByRole("button", { name: "Sign in to reply" })).toBeVisible();
});

test("an ask's branches read signed out", async ({ page }) => {
  const side = page.locator(`[data-side="${w.ask}"]`);
  await page.locator(`#card-${w.ask}`).scrollIntoViewIfNeeded();
  await expect(page.locator(`#pr-${w.ask}`)).toContainText("Bloom filters answer set");
  await side.getByRole("treeitem", { name: /how does the darknet/ }).click();
  await expect(side.locator(".preview")).toContainText("Bloom filters answer set");
  // No write actions on the card.
  await expect(side.getByRole("button", { name: "Continue" })).toHaveCount(0);
  await expect(side.getByRole("button", { name: "Comment" })).toHaveCount(0);
  await expect(side.getByRole("button", { name: "Run again" })).toHaveCount(0);
});

test("private channels are not read; their address shows the landing", async ({ page }) => {
  await expect(page.locator(".ttm", { hasText: `#${w.lab}` })).toHaveCount(0);
  await expect(page.getByText("Not for readers outside the channel")).toHaveCount(0);
  await page.goto(`/c/${w.lab}`);
  await expect(
    page.getByText(`This channel is private. Ask @${w.olga?.handle ?? ""} to add you.`),
  ).toBeVisible();
});

test("write controls open the auth dialog", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Sign in to Session" });
  const close = async () => {
    await expect(dialog.getByRole("button", { name: "Sign in with X" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/c/${w.open}$`));
  };
  const cover = page.getByRole("button", { name: "Sign in to ask or post" });
  await expect(page.locator(`textarea[aria-label="Ask or post"]`)).toHaveAttribute(
    "placeholder",
    "Sign in to ask or post",
  );
  await cover.click();
  await close();

  const card = page.locator(`#card-${w.post}`);
  await card.getByRole("button", { name: /^Save/ }).click();
  await close();

  await card.getByRole("button", { name: /^Reply/ }).click();
  await close();
});
