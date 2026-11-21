// The feed end to end (02 §12.2 `spaces-feed`, M4 parts): a post, a save and
// the Saved count, no model or effort text in a card, delete, the removed
// placeholder, the owner's Remove… dialog, thread addresses (one outside the
// window, 01 R1, R3), the virtualised feed past 60 rows, another person's
// post arriving without a reload, and the in-flight-only outbox: a failed
// request shows "Not sent", and a reload keeps nothing but the draft.
//
// The channels and threads are written through the sync routes before the
// specs run (`world.ts`); asks are answered by the run loop with fixture
// providers.

import { expect, test } from "@playwright/test";

import {
  card,
  compose,
  navigate,
  openFeed,
  row,
  scrollSettled,
  signInAndOpen,
  toast,
} from "./spaces.js";
import { channelName, person, ulid, type Writer } from "./world.js";

const LOGIN = "e2e-feed";

const w = {
  me: null as Writer | null,
  olga: null as Writer | null,
  feed: { id: "", name: "" },
  own: { id: "", name: "" },
  many: { id: "", name: "" },
  /** olga's post in #feed that the specs save. */
  saved: "",
  /** The viewer's post with sol's reply under it. */
  answered: "",
  /** olga's first post in #feed, older than the 60 seeded after it. */
  oldest: "",
  /** The oldest post of #many, outside its window. */
  outside: "",
};

test.beforeAll(async ({ browser }) => {
  const olga = await person(browser, "e2e-feed-olga");
  const sol = await person(browser, "e2e-feed-sol");
  const tomasz = await person(browser, "e2e-feed-tomasz");
  const me = await person(browser, LOGIN);
  w.me = me;
  w.olga = olga;
  // #feed first: the composer posts to the first channel the viewer joined
  w.feed.name = channelName("feed");
  w.feed.id = await olga.channel(w.feed.name);
  w.own.name = channelName("feed-own");
  w.own.id = await me.channel(w.own.name);
  w.many.name = channelName("feed-many");
  w.many.id = await olga.channel(w.many.name);
  for (const p of [me, sol]) await p.join(w.feed.id);
  for (const p of [olga, tomasz]) await p.join(w.own.id);

  w.oldest = await olga.post(w.feed.id, "The oldest post in the channel");
  w.saved = await olga.post(w.feed.id, "A post worth saving");
  w.answered = await me.post(w.feed.id, "My question for the group");
  await sol.reply(w.answered, "An answer from sol");

  await tomasz.post(w.own.id, "Reading group: Accelerando");
  const gone = await olga.post(w.own.id, "A duplicate of another thread");
  await me.remove(gone, "Duplicate of the earlier thread.");

  // #many: its oldest post, with a reply, and 100 newer ones; the window
  // serves the newest 100 in full (`SESSION_WEB_WINDOW_CAP`)
  w.outside = await olga.post(w.many.id, "Before the hundred");
  await sol.join(w.many.id);
  await sol.reply(w.outside, "A reply on the oldest post");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await olga.all(
    Array.from(
      { length: 100 },
      (_, i) =>
        [
          "threads.create",
          { id: ulid(), space: w.many.id, kind: "post", q: `Hundred ${i + 1}` },
        ] as const,
    ),
  );
});

test.beforeEach(async ({ page }) => {
  await signInAndOpen(page, LOGIN);
});

test("a post goes to the top of Home with its channel beside the avatar", async ({ page }) => {
  await compose(page, "Reading list for the winter, suggestions welcome.", "Post");
  const first = page.locator(".tcard").first();
  await expect(first.locator(".tt-title")).toHaveText(
    "Reading list for the winter, suggestions welcome.",
  );
  await expect(first.locator(".ttm")).toHaveText(`#${w.feed.name}`);
  await expect(first.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  // The composer empties and its send button is disabled again.
  await expect(page.getByRole("textbox", { name: "Ask or post" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Post", exact: true })).toBeDisabled();
  // Stored: a reload reads it back from the server.
  await page.reload();
  await expect(card(page, "Reading list for the winter, suggestions welcome.")).toBeVisible();
});

test("save: the toasts, the Saved count and the Saved feed", async ({ page }) => {
  const thread = page.locator(`#card-${w.saved}`);
  const save = thread.getByRole("button", { name: /^Save/ });
  await expect(save).toHaveAttribute("aria-label", "Save");
  await save.click();
  await expect(toast(page)).toHaveText("Saved.");
  await expect(thread.getByRole("button", { name: /^Saved/ })).toHaveAttribute(
    "aria-label",
    "Saved, saved by 1",
  );
  // Back at the top, the bar shows.
  await page.locator("[data-shell-scroll]").evaluate((el) => el.scrollTo(0, 0));
  await expect(page.getByRole("link", { name: "Saved, 1" })).toBeVisible();

  await page.getByRole("link", { name: "Saved, 1" }).click();
  await expect(page).toHaveURL(/\/saved$/);
  await expect(page.locator(".tcard")).toHaveCount(1);
  await page
    .locator(`#card-${w.saved}`)
    .getByRole("button", { name: /^Saved/ })
    .click();
  await expect(toast(page)).toHaveText("Removed from saved.");
  await expect(page.getByRole("heading", { name: "Nothing saved yet" })).toBeVisible();
});

test("no model or effort text in a card", async ({ page }) => {
  await compose(page, "what is a bloom filter");
  const thread = card(page, "what is a bloom filter");
  await expect(thread).toBeVisible();
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
  await compose(page, "fixture:success what is a skip list");
  const thread = card(page, "what is a skip list");
  await expect(thread.getByText(/^(Queued|Researching · Step \d of 4)$/)).toBeVisible();
  await expect(thread.getByText(/is a layered linked list/)).toBeVisible({ timeout: 30_000 });
  await expect(thread.locator(".status")).toHaveCount(0);
  // the footer's meta counts the answer's tokens once it is answered
  await expect(thread.locator(".fmeta")).toContainText(/tokens/);
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
  await page.reload();
  await expect(page.locator(".tcard").first()).toBeVisible();
  await expect(card(page, "A post to delete.")).toHaveCount(0);
});

test("Delete is not offered once someone else has responded", async ({ page }) => {
  await page.locator(`#card-${w.answered}`).getByRole("button", { name: "More" }).click();
  const item = page.getByRole("menuitem", { name: /Delete post/ });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toContainText("Not available once someone else has responded");
});

test("a removed thread shows its placeholder and no text", async ({ page }) => {
  await page.goto(`/c/${w.own.name}`);
  const removed = page.locator(".tcard.removed").first();
  await removed.scrollIntoViewIfNeeded();
  await expect(removed).toContainText(`Removed by @${w.me?.handle ?? ""}`);
  await expect(removed).toContainText("Reason: “Duplicate of the earlier thread.”");
  await expect(removed).toContainText(`Post by [deleted] in #${w.own.name}`);
  await expect(removed).not.toContainText("A duplicate of another thread");
  await expect(removed.locator(".card-f")).toHaveCount(0);
});

test("a thread address scrolls to its thread", async ({ page }) => {
  await page.goto(`/c/${w.feed.name}?t=${w.oldest}`);
  const thread = page.locator(`#card-${w.oldest}`);
  await scrollSettled(page);
  await expect(thread).toBeInViewport();
});

test("a thread address outside the window fetches the thread and shows it in its feed", async ({
  page,
}) => {
  const fetched = page.waitForRequest((req) => {
    if (!req.url().endsWith("/api/sync/read")) return false;
    const body = (req.postDataJSON() ?? {}) as { reads?: { tier?: string; threads?: string[] }[] };
    return (body.reads ?? []).some(
      (read) => read.tier === "threads" && (read.threads ?? []).includes(w.outside),
    );
  });
  await page.goto(`/c/${w.many.name}?t=${w.outside}`);
  await fetched;
  const outside = row(page, "Before the hundred");
  await expect(outside.locator(".tcard")).toBeInViewport();
  // Its replies came with it: the window served it as a summary.
  await expect(outside.getByRole("tree", { name: "Replies" })).toContainText(
    "A reply on the oldest post",
  );
});

test("a thread address the viewer cannot read shows a toast", async ({ page }) => {
  await page.goto(`/?t=01M7AAAAAAAAAAAAAAAAAAAAAA`);
  await expect(toast(page)).toHaveText("This thread is not available.");
});

test("the owner's Remove… dialog starts in the reason; Escape returns to More", async ({
  page,
}) => {
  await page.goto(`/c/${w.own.name}`);
  const thread = card(page, /^Reading group: Accelerando/);
  const more = thread.getByRole("button", { name: "More" });
  await more.click();
  await expect(page.getByRole("menuitem", { name: `Ban from #${w.own.name}` })).toBeVisible();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Remove @/ });
  await expect(dialog.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("another person's post arrives without a reload", async ({ page }) => {
  await expect(page.locator(".tcard").first()).toBeVisible();
  await w.olga?.post(w.feed.id, "Arrived over the stream");
  await expect(page.locator(".tcard").first().locator(".tt-title")).toHaveText(
    "Arrived over the stream",
  );
});

test("past 60 rows the feed is virtualised, and a thread address still reaches its thread", async ({
  page,
}) => {
  await w.olga?.all(
    Array.from(
      { length: 60 },
      (_, i) =>
        [
          "threads.create",
          { id: ulid(), space: w.feed.id, kind: "post", q: `Seeded post ${i + 1}` },
        ] as const,
    ),
  );
  await expect(page.locator(".tcard").first().locator(".tt-title")).toHaveText(/^Seeded post/);
  // Only the rows near the viewport are rendered.
  await expect.poll(() => page.locator(".feed-row").count()).toBeLessThan(60);
  await expect(page.locator(`#card-${w.oldest}`)).toHaveCount(0);
  await navigate(page, `/?t=${w.oldest}`);
  const thread = page.locator(`#card-${w.oldest}`);
  await expect(thread).toBeVisible();
  await scrollSettled(page);
  await expect(thread).toBeInViewport();
});

test("a failed request shows Not sent; Retry sends it; a reload keeps only the draft", async ({
  page,
  context,
}) => {
  // Offline: the post is shown, marked Not sent.
  await context.setOffline(true);
  await compose(page, "Written while offline", "Post");
  const offline = card(page, "Written while offline");
  const notSent = page.locator("[data-not-sent]").filter({ hasText: "Not sent" });
  await expect(offline).toBeVisible();
  await expect(notSent).toHaveCount(1);
  // Retry once online: sent with the same mutation id.
  await context.setOffline(false);
  const applied = page.waitForResponse((res) => res.url().endsWith("/api/sync/apply"));
  await notSent.getByRole("button", { name: "Retry" }).click();
  expect((await applied).status()).toBe(200);
  await expect(notSent).toHaveCount(0);

  // A second one offline, and text typed in the composer but not sent.
  await context.setOffline(true);
  await compose(page, "Lost on reload", "Post");
  await expect(notSent).toHaveCount(1);
  const field = page.getByRole("textbox", { name: "Ask or post" });
  await field.fill("Kept as a draft");
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator(".tcard").first()).toBeVisible();
  // The outbox kept nothing; the draft is in its composer.
  await expect(card(page, "Written while offline")).toBeVisible();
  await expect(card(page, "Lost on reload")).toHaveCount(0);
  await expect(page.locator("[data-not-sent]")).toHaveCount(0);
  await expect(field).toHaveValue("Kept as a draft");
});

test("a signed-out reader reaches a post by its address", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openFeed(page, `/c/${w.feed.name}?t=${w.answered}`);
  const thread = row(page, "My question for the group");
  await expect(thread.locator(".tcard")).toBeInViewport();
  await expect(thread.getByRole("tree", { name: "Replies" })).toContainText("An answer from sol");
  await context.close();
});
