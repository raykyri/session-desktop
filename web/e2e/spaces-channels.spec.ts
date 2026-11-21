// Channels end to end, M4 parts (02 §12.2 `spaces-channels`; W6.1-W6.3,
// W6.6, W6.7): join and leave from the header and Browse, leaving a private
// channel, New channel with its validation and CONFLICT, and About.
//
// The viewer owns one open channel; olga owns two open channels the viewer
// has not joined, two private ones the viewer joined by invite links, and a
// private one the viewer is not in. They are written through the sync
// routes before the specs run (`world.ts`).

import { expect, test } from "@playwright/test";

import { initials, signInAndOpen, toast } from "./spaces.js";
import { channelName, person, type Writer } from "./world.js";

const LOGIN = "e2e-channels";

const w = {
  me: null as Writer | null,
  own: "",
  open: "",
  browse: "",
  lab: "",
  leave: "",
  closed: "",
};

test.beforeAll(async ({ browser }) => {
  const olga = await person(browser, "e2e-channels-olga");
  const me = await person(browser, LOGIN);
  w.me = me;
  w.own = channelName("chan-own");
  const own = await me.channel(w.own);
  await me.post(own, "A thread in the viewer's channel");
  w.open = channelName("chan-open");
  const open = await olga.channel(w.open);
  await olga.post(open, "A thread in olga's channel");
  w.browse = channelName("chan-browse");
  await olga.channel(w.browse);
  w.lab = channelName("chan-lab");
  const lab = await olga.channel(w.lab, { vis: "private" });
  await me.join(lab, await olga.invite(lab));
  w.leave = channelName("chan-leave");
  const leave = await olga.channel(w.leave, { vis: "private" });
  await me.join(leave, await olga.invite(leave));
  w.closed = channelName("chan-closed");
  await olga.channel(w.closed, { vis: "private" });
});

test.beforeEach(async ({ page }) => {
  await signInAndOpen(page, LOGIN);
});

test("join and leave from the channel header", async ({ page }) => {
  await page.goto(`/c/${w.open}`);
  const header = page.locator(".sphead");
  await expect(header.getByRole("heading", { name: `#${w.open}` })).toBeVisible();
  // Not joined: no composer.
  await expect(page.getByRole("textbox", { name: "Ask or post" })).toHaveCount(0);
  await header.getByRole("button", { name: "Join" }).click();
  await expect(toast(page)).toHaveText(`Joined #${w.open}.`);
  await expect(page.getByRole("textbox", { name: "Ask or post" })).toBeVisible();
  // Stored: a reload reads the membership back.
  await page.reload();
  await expect(header.getByRole("button", { name: "Joined" })).toBeVisible();
  await header.getByRole("button", { name: "Joined" }).click();
  await expect(toast(page)).toHaveText(`Left #${w.open}.`);
  await expect(page).toHaveURL(new RegExp(`/c/${w.open}$`));
  await expect(header.getByRole("button", { name: "Join" })).toBeVisible();
});

test("leaving a private channel goes Home", async ({ page }) => {
  await page.goto(`/c/${w.leave}`);
  const header = page.locator(".sphead");
  await expect(header.getByRole("img", { name: "Private" })).toBeVisible();
  await header.getByRole("button", { name: "Joined" }).click();
  await expect(toast(page)).toHaveText(`Left #${w.leave}.`);
  await expect(page).toHaveURL(/\/$/);
});

test("the owner's header, info dialog and About editor", async ({ page }) => {
  const handle = w.me?.handle ?? "";
  await page.goto(`/c/${w.own}`);
  const header = page.locator(".sphead");
  await expect(header.getByText("Your channel")).toBeVisible();
  await header.getByRole("button", { name: "About this channel" }).click();
  const info = page.getByRole("dialog", { name: `#${w.own}` });
  await expect(info.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(info.locator("dd").first()).toHaveText(`${initials(handle)}@${handle}`);
  await expect(info).toContainText("Open: anyone can read and join");
  await info.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByRole("dialog", { name: `Edit #${w.own}` });
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
  // Stored on the server.
  await page.reload();
  await expect(header).toContainText("Science fiction, read closely.");
});

test("New channel: validation, CONFLICT, and the new channel", async ({ page }) => {
  const created = channelName("reading");
  await page.getByRole("button", { name: "New channel" }).click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  const name = dialog.getByRole("textbox", { name: /Name/ });
  await expect(name).toBeFocused();
  await name.fill("A");
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(dialog.getByText("Use 2 to 30 lowercase letters, numbers or dashes.")).toBeVisible();
  await name.fill(w.own);
  await dialog.getByRole("textbox", { name: "What is it for?" }).fill("Kept after a conflict.");
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(dialog.getByText(`#${w.own} already exists.`)).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "What is it for?" })).toHaveValue(
    "Kept after a conflict.",
  );

  await name.fill(created);
  await dialog.getByRole("radio", { name: /Private/ }).check();
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${created}$`));
  await expect(toast(page)).toHaveText(`#${created} is ready. Invite people by sharing its link.`);
  const header = page.locator(".sphead");
  await expect(header.getByRole("heading", { name: `#${created}` })).toBeVisible();
  await expect(header.getByText("Your channel")).toBeVisible();
  await expect(page.getByText("No threads here yet. Ask the first question.")).toBeVisible();
  await expect(page.getByRole("banner").getByRole("link", { name: `#${created}` })).toBeVisible();
});

test("Browse: search, its empty line, and Join that stays on Browse", async ({ page }) => {
  await page.goto("/browse");
  await expect(page.getByRole("heading", { name: "Browse channels", level: 2 })).toBeVisible();
  await expect(page.locator(".bcard", { hasText: `#${w.closed}` })).toHaveCount(0);
  await expect(page.locator(".bcard", { hasText: `#${w.lab}` })).toBeVisible();
  const search = page.getByRole("textbox", { name: "Search channels" });
  await search.fill("zzz");
  await expect(page.getByText("No channels match.")).toBeVisible();
  await search.fill(w.browse);
  const browse = page.locator(".bcard", { hasText: `#${w.browse}` });
  await expect(page.locator(".bcard")).toHaveCount(1);
  await browse.getByRole("button", { name: "Join" }).click();
  await expect(toast(page)).toHaveText(`Joined #${w.browse}.`);
  await expect(browse.getByRole("button", { name: "Joined" })).toBeVisible();
  await expect(page).toHaveURL(/\/browse$/);
  await search.fill(w.own);
  await expect(page.locator(".bcard", { hasText: `#${w.own}` }).getByText("Yours")).toBeVisible();
});

test("the moderation log stacks over the info dialog and Escape closes it", async ({ page }) => {
  await page.goto(`/c/${w.own}`);
  await page.getByRole("button", { name: "About this channel" }).click();
  const info = page.getByRole("dialog", { name: `#${w.own}` });
  const open = info.getByRole("button", { name: "Moderation log" });
  await open.click();
  const log = page.getByRole("dialog", { name: "Moderation log" });
  await expect(log).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(log).toHaveCount(0);
  await expect(info).toBeVisible();
  await expect(open).toBeFocused();
});
