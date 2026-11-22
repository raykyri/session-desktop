// Channels end to end (02 §12.2 `spaces-channels`). M4: join and leave from
// the header and Browse, leaving a private channel, New channel with its
// validation and CONFLICT, and About (W6.1-W6.3, W6.6, W6.7). M6 (04 B3, B4,
// §6.6): a member sees a new About without a reload; a private channel's
// invite link admits one person and refuses the next; the owner removes a
// member's post with a reason, which the member sees as the placeholder and
// a notification and the moderation log lists; the owner bans a member of
// an open channel, the log lists the ban, and the member's writes there are
// refused with the ban message. At 400 px wide, the member list's avatars
// keep their size and an invite link's row stays inside its dialog.
//
// The viewer owns one open channel; olga owns two open channels the viewer
// has not joined, two private ones the viewer joined by invite links, and a
// private one the viewer is not in. They are written through the sync
// routes before the specs run (`world.ts`).

import { expect, test } from "@playwright/test";

import { signIn } from "./helpers.js";
import { card, initials, signInAndOpen, toast } from "./spaces.js";
import { MODEL, channelName, person, ulid, type Writer } from "./world.js";

const LOGIN = "e2e-channels";

const w = {
  me: null as Writer | null,
  own: "",
  ownId: "",
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
  w.ownId = own;
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

// ---------------------------------------------------------------- M6

const REMOVED_POST = "A post the owner of the channel removes";
const REASON = "Off topic for this channel.";

const m = {
  mona: null as Writer | null,
  nick: null as Writer | null,
  priv: "",
  removed: "",
};

test.beforeAll(async ({ browser }) => {
  const me = w.me;
  if (!me) throw new Error("the viewer is made first");
  const mona = await person(browser, "e2e-channels-mona");
  const nick = await person(browser, "e2e-channels-nick");
  m.mona = mona;
  m.nick = nick;
  await mona.join(w.ownId);
  await nick.join(w.ownId);
  m.removed = await mona.post(w.ownId, REMOVED_POST);
  m.priv = channelName("chan-priv");
  const priv = await me.channel(m.priv, { vis: "private" });
  await me.post(priv, "Notes for the members of the private channel");
});

test("B3: a member's open info dialog shows the new About without a reload", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const member = await context.newPage();
  await signIn(member, { login: "e2e-channels-mona" });
  await member.goto(`/c/${w.own}`);
  await member.getByRole("button", { name: "About this channel" }).click();
  const info = member.getByRole("dialog", { name: `#${w.own}` });
  await expect(info).toBeVisible();
  await w.me?.ok("spaces.update", { id: w.ownId, desc: "Read slowly, and argue kindly." });
  await expect(info).toContainText("Read slowly, and argue kindly.");
  await context.close();
});

test("B4: a private channel's link admits one person; the same link is refused to the next", async ({
  browser,
  page,
}) => {
  await page.goto(`/c/${m.priv}`);
  await page.getByRole("button", { name: "About this channel" }).click();
  const info = page.getByRole("dialog", { name: new RegExp(`^#${m.priv}`) });
  await info.getByRole("button", { name: `Invite to #${m.priv}` }).click();
  const links = page.getByRole("dialog", { name: `Invite to #${m.priv}` });
  await links.getByRole("button", { name: "Create an invite link" }).click();
  await expect(toast(page)).toHaveText("Invite link created.");
  const link = (await links.locator(".ilink").first().textContent()) ?? "";
  expect(link).toMatch(new RegExp(`/c/${m.priv}#[0-9a-z]{26}$`));

  // a second account opens it, joins and reads the channel
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  const joined = await signIn(guestPage, { login: "e2e-channels-guest" });
  await guestPage.goto(link);
  await expect(toast(guestPage)).toHaveText(`Joined #${m.priv}.`);
  await expect(guestPage).toHaveURL(new RegExp(`/c/${m.priv}$`));
  await expect(card(guestPage, "Notes for the members of the private channel")).toBeVisible();
  await expect(guestPage.locator(".sphead").getByRole("button", { name: "Joined" })).toBeVisible();

  // a third account using the same link is refused
  const late = await browser.newContext();
  const latePage = await late.newPage();
  await signIn(latePage, { login: "e2e-channels-late" });
  await latePage.goto(link);
  await expect(toast(latePage, "alert")).toHaveText(
    "This invite link has expired or was already used.",
  );
  await expect(latePage.locator(".sphead").getByText("Members only")).toBeVisible();
  await expect(card(latePage, "Notes for the members of the private channel")).toHaveCount(0);

  // the owner sees who used it
  const handle = (joined as { handle?: string }).handle ?? "";
  await expect(links).toContainText(`Used by @${handle}`);
  await guest.close();
  await late.close();
});

/** Whether box `inner` lies inside box `outer`, to the pixel. */
function inside(
  inner: { x: number; y: number; width: number; height: number } | null,
  outer: { x: number; y: number; width: number; height: number } | null,
): boolean {
  if (!inner || !outer) return false;
  return (
    inner.x >= outer.x - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

test("at 400px wide the member list's avatars keep their 20 px circle", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  // the owner and two members
  await page.goto(`/c/${w.own}`);
  await page.getByRole("button", { name: "About this channel" }).click();
  const info = page.getByRole("dialog", { name: `#${w.own}` });
  await info.getByRole("button", { name: /^Members, \d+$/ }).click();
  const members = page.getByRole("dialog", { name: `Members of #${w.own}` });
  const avatars = members.locator('.mlist li > span[aria-hidden="true"]');
  await expect(avatars).toHaveCount(3);
  for (const avatar of await avatars.all()) {
    const box = await avatar.boundingBox();
    expect(box?.width).toBeCloseTo(20, 0);
    expect(box?.height).toBeCloseTo(20, 0);
  }
  // the Owner chip keeps its width too: it is not stretched across the row
  const chip = members.locator(".mlist li .chip");
  expect((await chip.boundingBox())?.width ?? 0).toBeLessThan(80);
});

test("at 400px wide an invite link is cut off inside its row and Copy and Revoke stay in the dialog", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`/c/${m.priv}`);
  await page.getByRole("button", { name: "About this channel" }).click();
  await page
    .getByRole("dialog", { name: new RegExp(`^#${m.priv}`) })
    .getByRole("button", { name: `Invite to #${m.priv}` })
    .click();
  const links = page.getByRole("dialog", { name: `Invite to #${m.priv}` });
  await links.getByRole("button", { name: "Create an invite link" }).click();
  await expect(toast(page)).toHaveText("Invite link created.");
  const row = links.locator(".ilist li").first();
  const dialog = await links.boundingBox();
  expect(dialog?.width).toBeLessThanOrEqual(400);
  const copy = row.getByRole("button", { name: /^Copy link 1/ });
  const revoke = row.getByRole("button", { name: /^Revoke link 1/ });
  expect(inside(await row.boundingBox(), dialog)).toBe(true);
  expect(inside(await copy.boundingBox(), dialog)).toBe(true);
  expect(inside(await revoke.boundingBox(), dialog)).toBe(true);
  const code = row.locator(".ilink");
  const link = (await code.textContent()) ?? "";
  expect(link).toMatch(new RegExp(`/c/${m.priv}#[0-9a-z]{26}$`));
  const codeBox = await code.boundingBox();
  const copyBox = await copy.boundingBox();
  expect((codeBox?.x ?? 0) + (codeBox?.width ?? Infinity)).toBeLessThanOrEqual(copyBox?.x ?? 0);
  expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // plain text, not the Invites page's link chip (`.invbox .ilink`): no
  // fill, padding, rounding or margin, and "Expires …" right under it
  expect(
    await code.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.backgroundColor, style.padding, style.margin, style.borderRadius];
    }),
  ).toEqual(["rgba(0, 0, 0, 0)", "0px", "0px", "0px"]);
  const expires = await row.locator("small").boundingBox();
  expect(Math.abs((expires?.y ?? 0) - ((codeBox?.y ?? 0) + (codeBox?.height ?? 0)))).toBeLessThan(
    1,
  );
  // the full link is its title, and Copy copies all of it
  await expect(code).toHaveAttribute("title", link);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await copy.click();
  await expect(toast(page)).toHaveText("Link copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
});

test("§6.6: a removal with a reason reaches the member, their notifications and the log", async ({
  browser,
  page,
}) => {
  const mona = m.mona?.handle ?? "";
  const me = w.me?.handle ?? "";
  const context = await browser.newContext();
  const member = await context.newPage();
  await signIn(member, { login: "e2e-channels-mona" });
  await member.goto(`/c/${w.own}`);
  await expect(card(member, REMOVED_POST)).toBeVisible();

  // the owner opens the log first: it lists the removal without a reload
  await page.goto(`/c/${w.own}`);
  const post = card(page, REMOVED_POST);
  await post.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  const dialog = page.getByRole("dialog", { name: `Remove @${mona}'s post` });
  await expect(dialog).toContainText(`“${REMOVED_POST}”`);
  await dialog.getByRole("textbox", { name: /Reason, shown with the removal/ }).fill(REASON);
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(toast(page)).toHaveText("Removed.");
  const placeholder = page.locator(`#card-${m.removed}`);
  await expect(placeholder).toContainText(`Removed by @${me}`);
  await page.getByRole("button", { name: "About this channel" }).click();
  await page
    .getByRole("dialog", { name: `#${w.own}` })
    .getByRole("button", { name: "Moderation log" })
    .click();
  const log = page.getByRole("dialog", { name: "Moderation log" });
  await expect(log).toContainText(`@${me} removed @${mona}'s post`);
  await expect(log).toContainText(`Reason: “${REASON}”`);
  await expect(log).not.toContainText(REMOVED_POST);

  // the member's feed shows the placeholder with the reason and no text, also
  // after a reload
  const theirs = member.locator(`#card-${m.removed}`);
  for (const reload of [false, true]) {
    if (reload) await member.reload();
    await expect(theirs).toContainText(`Removed by @${me}`);
    await expect(theirs).toContainText(`Reason: “${REASON}”`);
    await expect(theirs).toContainText(`Post by [deleted] in #${w.own}`);
    await expect(theirs).not.toContainText(REMOVED_POST);
  }
  // and the member's notifications list the removal with the reason
  await member.goto("/notifications");
  await expect(member.locator('.nrow[data-notif="removed"]')).toContainText(
    `@${me} removed your post: “${REASON}”`,
  );
  await context.close();
});

test("§6.6: the owner bans a member of an open channel; the log lists it; their writes are refused", async ({
  browser,
  page,
}) => {
  const nick = m.nick?.handle ?? "";
  const me = w.me?.handle ?? "";
  await page.goto(`/c/${w.own}`);
  await page.getByRole("button", { name: "About this channel" }).click();
  const info = page.getByRole("dialog", { name: `#${w.own}` });
  await info.getByRole("button", { name: /^Members, \d+$/ }).click();
  const members = page.getByRole("dialog", { name: `Members of #${w.own}` });
  const row = members.locator(`[data-member="${nick}"]`);
  await row.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: `Ban from #${w.own}` }).click();
  // the ban asks first, naming the person and the channel
  const confirm = page.getByRole("alertdialog", { name: `Ban @${nick} from #${w.own}?` });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Ban" }).click();
  await expect(toast(page)).toHaveText(`Banned @${nick} from #${w.own}.`);
  await expect(members.locator(`[data-banned="${nick}"]`)).toBeVisible();
  await expect(members.locator(`[data-member="${nick}"]`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await info.getByRole("button", { name: "Moderation log" }).click();
  const log = page.getByRole("dialog", { name: "Moderation log" });
  await expect(log).toContainText(`@${me} banned @${nick} from #${w.own}`);

  // the banned member still reads the open channel; an ask there is refused
  // with the ban message, and so is joining again
  const answer = await m.nick?.send([
    ["threads.create", { id: ulid(), space: w.ownId, kind: "ask", q: "Still here?", ...MODEL }],
  ]);
  expect(answer?.[0]?.error?.message).toBe(`You are banned from #${w.own}.`);
  const context = await browser.newContext();
  const banned = await context.newPage();
  await signIn(banned, { login: "e2e-channels-nick" });
  await banned.goto(`/c/${w.own}`);
  await expect(card(banned, "A thread in the viewer's channel")).toBeVisible();
  await expect(banned.getByRole("textbox", { name: "Ask or post" })).toHaveCount(0);
  await banned.locator(".sphead").getByRole("button", { name: "Join" }).click();
  await expect(toast(banned, "alert")).toHaveText(`You are banned from #${w.own}.`);
  await expect(banned.locator(".sphead").getByRole("button", { name: "Join" })).toBeVisible();
  await context.close();
});
