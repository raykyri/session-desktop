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

export function toast(page: Page) {
  return page.locator(".feed-toast");
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
