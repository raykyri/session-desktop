// Notifications end to end (02 §12.2 `spaces-notifications`, W2.6; 01 C16):
// every notification kind reaches its recipient, written with the write that
// causes it; the unread dot on the account avatar stays while the page is
// open; a row opens its thread in its channel's feed with the item selected
// and the bar shown; Mark all as read clears the dot.
//
// The viewer posts twice and asks once in ann's open channel. ann (the
// channel's owner) replies to the first post, mentions the viewer in a reply
// on her own post, branches from and comments on the viewer's ask, and
// removes the second post with a reason; a new account redeems the viewer's
// account invite. All of it is written through the sync routes and tRPC
// before the specs run (`world.ts`).

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { PROTOCOL_HEADERS, e2eLogin, mutation, signIn } from "./helpers.js";
import { initials, toast } from "./spaces.js";
import { channelName, person, ulid } from "./world.js";

const LOGIN = "e2e-notifications";
const REASON = "Please keep this channel to papers.";

const w = {
  channel: "",
  ann: "",
  newcomer: "",
  code: "",
  annPost: "",
  mentionReply: "",
};

test.beforeAll(async ({ browser }) => {
  const ann = await person(browser, "e2e-notifications-ann");
  const me = await person(browser, LOGIN);
  w.ann = ann.handle;
  w.channel = channelName("notifs");
  const space = await ann.channel(w.channel);
  await me.join(space);

  const replied = await me.post(space, "A post that gets a reply");
  const removed = await me.post(space, "A post that is removed");
  const asked = await me.ask(space, "fixture:success what makes a good benchmark");
  await me.answered(space, asked.run);

  // reply, mention (in a reply), branch, comment, removed
  await ann.reply(replied, "A reply to your post");
  w.annPost = await ann.post(space, "Ann's own post");
  w.mentionReply = await ann.reply(w.annPost, `Have a look, @${me.handle}`);
  const branch = await ann.fork(asked.thread, "r", "what about held-out sets");
  await ann.answered(space, branch.run);
  await ann.ok("comments.create", {
    id: ulid(),
    thread: asked.thread,
    node: "r",
    t: "A comment on your ask",
  });
  await ann.remove(removed, REASON);

  // invite_used: a new account redeems the viewer's account invite
  const made = await mutation<{ code: string }>(me.request, "accountInvites.create", {});
  w.code = made.code;
  const context = await browser.newContext();
  const login = e2eLogin("ntnew");
  const res = await context.request.post(`${APP_ORIGIN}/auth/test-login`, {
    headers: {
      "x-requested-with": "session",
      "content-type": "application/json",
      ...PROTOCOL_HEADERS,
    },
    data: { login, waiting: true },
  });
  expect(res.ok()).toBe(true);
  w.newcomer = login.replace(/-/g, "_").slice(0, 20);
  await mutation(context.request, "accountInvites.redeem", { code: w.code });
  await mutation(context.request, "account.create", { name: "Newcomer", handle: w.newcomer });
  await context.close();
});

const rows = (page: Page) => page.locator(".nlist .nrow");
const rowOf = (page: Page, kind: string) => page.locator(`.nrow[data-notif="${kind}"]`);
const account = (page: Page) => page.locator("header").getByRole("button", { name: /^Account/ });

test("every kind reaches the viewer; the dot stays; a row opens its thread; Mark all as read", async ({
  page,
}) => {
  await signIn(page, { login: LOGIN });
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Notifications", level: 2 })).toBeVisible();
  await expect(rows(page)).toHaveCount(6);
  // no summary line; the six unread rows carry their dots
  await expect(page.getByText(/unread notification|Mentions, replies/)).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Unread" })).toHaveCount(6);
  const ann = `@${w.ann}`;
  await expect(rowOf(page, "mention")).toContainText(
    `${ann} mentioned you in a reply on “Ann's own post”`,
  );
  await expect(rowOf(page, "reply")).toContainText(
    `${ann} replied to your post “A post that gets a reply”`,
  );
  await expect(rowOf(page, "branch")).toContainText(
    `${ann} branched from your ask “fixture:success what makes a good benchmark”`,
  );
  await expect(rowOf(page, "comment")).toContainText(
    `${ann} commented on your ask “fixture:success what makes a good benchmark”`,
  );
  await expect(rowOf(page, "removed")).toContainText(`${ann} removed your post: “${REASON}”`);
  await expect(rowOf(page, "removed")).not.toContainText("A post that is removed");
  // the notification stores no code (`04` I1)
  await expect(rowOf(page, "invite_used")).toContainText(
    `@${w.newcomer} joined Session with your invite`,
  );
  await expect(rowOf(page, "invite_used")).not.toContainText(w.code);
  await expect(rowOf(page, "invite_used")).toContainText("Invites · ");
  await expect(rowOf(page, "reply")).toContainText(`#${w.channel} · `);
  for (const kind of ["mention", "reply", "branch", "comment", "removed", "invite_used"])
    await expect(rowOf(page, kind).getByRole("img", { name: "Unread" })).toBeVisible();

  // each row's avatar is the mock's 28 px, and the kind badge at its corner
  // stays off the initials
  for (const kind of ["mention", "reply", "branch", "comment", "removed"]) {
    const geometry = await rowOf(page, kind)
      .locator(".nav-av")
      .evaluate((wrap) => {
        const avatar = wrap.firstElementChild as HTMLElement;
        const badge = wrap.querySelector(".nk") as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(avatar);
        const rect = (el: { getBoundingClientRect(): DOMRect }) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
        };
        return {
          avatar: rect(avatar),
          badge: rect(badge),
          text: rect(range),
          initials: avatar.textContent,
        };
      });
    expect(geometry.initials, kind).toBe(initials(w.ann));
    expect(geometry.avatar.w, kind).toBeCloseTo(28, 0);
    expect(geometry.avatar.h, kind).toBeCloseTo(28, 0);
    const { avatar, badge, text } = geometry;
    // the badge stays in the corner: clear of the avatar's centre, and
    // over less than a quarter of the initials' line box (at 20 px it
    // reached past the centre and covered over half of it)
    expect(badge.x, kind).toBeGreaterThan(avatar.x + avatar.w / 2);
    expect(badge.y, kind).toBeGreaterThan(avatar.y + avatar.h / 2);
    const overlap =
      Math.max(0, Math.min(text.right, badge.right) - Math.max(text.x, badge.x)) *
      Math.max(0, Math.min(text.bottom, badge.bottom) - Math.max(text.y, badge.y));
    expect(overlap / (text.w * text.h), kind).toBeLessThan(0.25);
  }

  // the dot is on the avatar, and opening the page does not clear it
  await expect(account(page)).toHaveAccessibleName("Account, 6 unread notifications");
  await expect(page.locator("[data-unread-dot]")).toBeVisible();

  // a reply mention opens the post in its feed with the reply selected and
  // the bar shown
  await rowOf(page, "mention").click();
  await expect(page).toHaveURL(
    new RegExp(`/c/${w.channel}\\?t=${w.annPost}&sel=${w.mentionReply}$`),
  );
  const card = page.locator(`#card-${w.annPost}`);
  await expect(card).toBeVisible();
  const tree = page.locator(".feed-row", { has: card }).getByRole("tree", { name: "Replies" });
  await expect(tree.getByRole("treeitem", { selected: true })).toContainText("Have a look");
  await expect(page.locator("header.app-bar")).toBeInViewport();
  await expect(account(page)).toHaveAccessibleName("Account, 5 unread notifications");

  // read on the server: still read after a reload
  await page.goto("/notifications");
  await expect(rowOf(page, "mention").getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(page.getByText(/unread notification|All caught up/)).toHaveCount(0);
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(toast(page)).toHaveText("All notifications marked as read.");
  await expect(page.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(page.locator("[data-unread-dot]")).toHaveCount(0);
  await expect(account(page)).toHaveAccessibleName("Account");
  await expect(page.getByRole("button", { name: "Mark all as read" })).toBeDisabled();

  // an invite row goes to Invites
  await rowOf(page, "invite_used").click();
  await expect(page).toHaveURL(/\/invites$/);
});
