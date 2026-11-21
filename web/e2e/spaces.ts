// Shared steps of the spaces specs (02 §12.2). The client reads the sync
// replica over the suite's server (02 §9.1); each spec writes the channels
// and threads it reads through the sync routes first (`world.ts`).

import { expect, type Page } from "@playwright/test";

import { signIn } from "./helpers.js";

/** Why a step is not run against this server: an ask is queued and answered
 * by the run loop, which arrives with M5a. */
export const NO_RUNS = "Asks are answered by the run loop (05 M5a); this server queues them.";

export async function openFeed(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator(".tcard").first()).toBeVisible();
}

export async function signInAndOpen(page: Page, login: string, path = "/") {
  const user = await signIn(page, { login });
  await openFeed(page, path);
  return user;
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

/** A client-side navigation, without a page load. */
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

/** A handle's avatar text (`initialsOf` of `ui/Avatar.tsx`): the first
 * letters of its first two parts split at `.` or `_`, otherwise its first
 * two letters, upper-cased. */
export function initials(handle: string): string {
  const parts = handle.split(/[._]/).filter(Boolean);
  const letters =
    parts.length > 1
      ? `${(parts[0] ?? "").slice(0, 1)}${(parts[1] ?? "").slice(0, 1)}`
      : handle.slice(0, 2);
  return letters.toUpperCase();
}
