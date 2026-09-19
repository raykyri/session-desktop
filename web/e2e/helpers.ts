// Shared steps for the end-to-end suite (`12-testing-linting-ci.md` §3.6).
//
// Every spec signs in through `POST /auth/test-login` rather than through
// GitHub: the route exists only under `SESSION_TEST_AUTH=1` and mints the same
// session cookie the OAuth callback does, so everything downstream — the CSRF
// header, the SSE subscription, the run queue — is the real thing.

import { expect, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";

/** Required CSRF header for mutation requests (`06-auth-and-users.md` §5). */
const MUTATION_HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

export interface SignInOptions {
  /** One login per spec keeps the accounts, and therefore the feeds, apart. */
  login: string;
  isAdmin?: boolean;
}

export interface SignedInUser {
  id: string;
  login: string;
  isAdmin: boolean;
}

/** Signs in on the page's own context, so the cookie is the one the browser
 * will send. */
export async function signIn(page: Page, options: SignInOptions): Promise<SignedInUser> {
  const response = await page.request.post(`${APP_ORIGIN}/auth/test-login`, {
    headers: MUTATION_HEADERS,
    data: { login: options.login, isAdmin: options.isAdmin === true },
  });
  expect(response.ok(), `test-login failed: ${response.status()}`).toBe(true);
  return (await response.json()) as SignedInUser;
}

/** Signs in and lands on Home with the feed rendered. */
export async function signInAndOpenHome(page: Page, options: SignInOptions): Promise<SignedInUser> {
  const user = await signIn(page, options);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "All Users", level: 1 })).toBeVisible();
  return user;
}

/**
 * Types a question and launches it. The fixture provider reads a
 * `fixture:<scenario>` marker out of the prompt, so the scenario is chosen by
 * the text of the question (`packages/server/src/runs/fixtureProvider.ts`).
 */
export async function startResearch(page: Page, prompt: string): Promise<string> {
  const composer = page.getByRole("textbox", { name: "What do you want to investigate?" });
  await composer.click();
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Start research" }).click();
  await page.waitForURL(/\/r\/[^/?]+/, { timeout: 30_000 });
  return treeIdFrom(page.url());
}

export function treeIdFrom(url: string): string {
  const match = /\/r\/([^/?#]+)/.exec(url);
  if (!match?.[1]) throw new Error(`no tree id in ${url}`);
  return match[1];
}

/** The live answer text of the first (root) segment. */
export function responseRoot(page: Page) {
  return page.locator("[data-research-response-root]").first();
}

/** Waits until the run has settled: the status line is gone and the footer's
 * word count is there. */
export async function waitForAnswer(page: Page, timeout = 60_000): Promise<void> {
  await expect(responseRoot(page)).toBeVisible({ timeout });
  await expect(page.getByRole("status").filter({ hasText: /Queued|Thinking|Working/ })).toHaveCount(
    0,
    { timeout },
  );
}

/**
 * Selects a run of text inside the answer with a real drag, which is what the
 * selection code listens for: a press records the anchor offset, movement past
 * three pixels snaps to word boundaries, and the release captures
 * (`09-research-document-view.md` §5).
 */
export async function selectAnswerText(page: Page): Promise<void> {
  const paragraph = responseRoot(page).locator("p").first();
  await expect(paragraph).toBeVisible();
  const box = await paragraph.boundingBox();
  if (!box) throw new Error("the answer paragraph has no box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  // Two moves: the first crosses the drag threshold, the second is the one the
  // snapper acts on.
  await page.mouse.move(box.x + box.width * 0.3, y, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator("[data-research-selection-actions]")).toBeVisible();
}
