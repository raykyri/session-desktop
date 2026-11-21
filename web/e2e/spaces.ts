// Shared steps of the spaces specs (02 §12.2). The client of the end-to-end
// build reads the fixture replica (02 §9.6): the members mockup's channels
// and threads, read as @ines.v by a signed-in member and through the read
// rules signed out. Each page load starts from the fixtures again.

import { expect, type Page } from "@playwright/test";

import { signIn } from "./helpers.js";

/** The mockup's first thread: an ask by @ines.v in #public with three
 * passage trees. */
export const FIRST_ASK = "01M7HWGZJGT7JTFFVSYPX055KV";
/** A post by @hal_b in #public with three replies. */
export const REPLY_POST_TEXT = "Is anyone else seeing the follow-up count lag";

export async function openFeed(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator(".tcard").first()).toBeVisible();
}

export async function signInAndOpen(page: Page, login: string, path = "/") {
  await signIn(page, { login });
  await openFeed(page, path);
}

/** The card of a thread by a piece of its title. */
export function card(page: Page, title: string | RegExp) {
  return page.locator(".tcard").filter({ has: page.locator(".tt-title", { hasText: title }) });
}

/** The feed row (card and side column) of a thread. */
export function row(page: Page, title: string | RegExp) {
  return page.locator(".feed-row").filter({ has: page.locator(".tt-title", { hasText: title }) });
}

/** The toast pill in its live region: `status` for notices, `alert` for
 * refusals. Finding it asserts the region's role. */
export function toast(page: Page, role: "status" | "alert" = "status") {
  return page.locator("[data-toast-region]").and(page.getByRole(role)).locator(".feed-toast");
}

interface FixtureControls {
  hold: (state: "queued" | "running" | null) => void;
  flush: () => void;
  seedPosts: (channel: string, count: number) => Promise<void>;
}

interface FixtureWindow {
  __sessionFixtures: FixtureControls;
}

/** Keeps new runs at "Researching" (or queued) until `flushRuns`
 * (`window.__sessionFixtures` of the fixture build, `fixtureReplica.ts`). */
export const holdRuns = (page: Page, state: "queued" | "running" | null) =>
  page.evaluate((s) => (window as unknown as FixtureWindow).__sessionFixtures.hold(s), state);
/** Answers every held run. */
export const flushRuns = (page: Page) =>
  page.evaluate(() => (window as unknown as FixtureWindow).__sessionFixtures.flush());
/** Writes `count` posts to a channel as the viewer. */
export const seedPosts = (page: Page, channel: string, count: number) =>
  page.evaluate(
    ([name, n]) => (window as unknown as FixtureWindow).__sessionFixtures.seedPosts(name, n),
    [channel, count] as const,
  );

/** Waits until the feed's scroll offset is the same on two polls in a row. */
export async function scrollSettled(page: Page) {
  const scroller = page.locator("[data-shell-scroll]");
  let previous = Number.NaN;
  await expect
    .poll(
      async () => {
        const top = await scroller.evaluate((el) => el.scrollTop);
        const still = top === previous;
        previous = top;
        return still;
      },
      { intervals: [100] },
    )
    .toBe(true);
}

/** A client-side navigation: the fixtures survive it, where a page load
 * starts them again. */
export async function navigate(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** Writes in the new-thread composer and sends it as an ask or a post. */
export async function compose(page: Page, text: string, mode: "Ask" | "Post" = "Ask") {
  if (mode === "Post") {
    await page.getByRole("button", { name: "Ask or post" }).click();
    await page.getByRole("menuitemradio", { name: /^Post/ }).click();
  }
  const field = page.getByRole("textbox", { name: "Ask or post" });
  await field.fill(text);
  await page.getByRole("button", { name: mode, exact: true }).click();
}
