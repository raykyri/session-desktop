// Shared steps for the end-to-end suite (`12-testing-linting-ci.md` §3.6).
//
// Every spec signs in through `POST /auth/test-login` rather than through
// GitHub: the route exists only under `SESSION_TEST_AUTH=1` and mints the same
// session cookie the OAuth callback does, so everything downstream — the CSRF
// header, the SSE subscription, the run queue — is the real thing.

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { APP_ORIGIN, E2E_RUN_ID_VARIABLE } from "./constants.js";

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

/**
 * The account a spec's login names in this run: the login with the run's id
 * and, on a retry, the attempt number, so neither a retry nor a second run
 * against the same server finds the folders, threads and counts an earlier
 * attempt left (`playwright.config.ts` sets the run id). A spec that needs
 * the login itself (an invitation, a member list) reads it from
 * `signIn`'s result.
 */
export function e2eLogin(base: string): string {
  const run = process.env[E2E_RUN_ID_VARIABLE] ?? "local";
  let retry = 0;
  try {
    retry = test.info().retry;
  } catch {
    // Outside a test (a setup script): the run id alone.
  }
  return `${base}-${run}${retry > 0 ? `r${retry}` : ""}`;
}

/** Signs in on the page's own context, so the cookie is the one the browser
 * will send. The account is the run's own (`e2eLogin`). */
export async function signIn(page: Page, options: SignInOptions): Promise<SignedInUser> {
  const response = await page.request.post(`${APP_ORIGIN}/auth/test-login`, {
    headers: MUTATION_HEADERS,
    data: { login: e2eLogin(options.login), isAdmin: options.isAdmin === true },
  });
  expect(response.ok(), `test-login failed: ${response.status()}`).toBe(true);
  return (await response.json()) as SignedInUser;
}

/** Signs in and opens the workspace's Home with its list rendered. */
export async function signInAndOpenHome(page: Page, options: SignInOptions): Promise<SignedInUser> {
  const user = await signIn(page, options);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.getByRole("feed", { name: "Recent activity" })).toBeVisible();
  return user;
}

/** The Home ask box's field. */
export function askBox(page: Page) {
  return page.getByRole("textbox", { name: "New question" });
}

/**
 * Types a question and launches it. The fixture provider reads a
 * `fixture:<scenario>` marker out of the prompt, so the scenario is chosen by
 * the text of the question (`packages/server/src/runs/fixtureProvider.ts`).
 */
export async function startResearch(page: Page, prompt: string): Promise<string> {
  const composer = askBox(page);
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
  // The middle of the first line: the paragraph's vertical middle can fall
  // exactly on a boundary between two lines, where a press starts no
  // selection.
  const y = box.y + Math.min(box.height / 2, 8);
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  // Two moves: the first crosses the drag threshold, the second is the one the
  // snapper acts on.
  await page.mouse.move(box.x + box.width * 0.3, y, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator("[data-research-selection-actions]")).toBeVisible();
}

/* ---------------------------------------------- tRPC calls, accounts */

/**
 * A tRPC mutation sent with a context's own session cookie: a page's
 * `request` shares its browser context's cookies, so the call is made as that
 * context's account.
 */
export async function mutation<T>(
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<T> {
  const response = await request.post(`${APP_ORIGIN}/api/trpc/${path}`, {
    headers: MUTATION_HEADERS,
    data: input ?? {},
  });
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

/** A mutation expected to fail, answering with its tRPC error code. */
export async function refusal(
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<string> {
  const response = await request.post(`${APP_ORIGIN}/api/trpc/${path}`, {
    headers: MUTATION_HEADERS,
    data: input ?? {},
  });
  expect(response.ok(), `${path} should be refused`).toBe(false);
  return ((await response.json()) as { error: { data: { code: string } } }).error.data.code;
}

export async function query<T>(
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<T> {
  const search = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const response = await request.get(`${APP_ORIGIN}/api/trpc/${path}${search}`);
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

/** The fields of `research.getTree`'s answer that the specs read. */
export interface Detail {
  tree: { id: string; role?: string };
  nodes: { id: string; authorId?: string | null; run?: { status: string } }[];
  queues?: Record<string, readonly { id: string }[]>;
}

/** A browser context of its own, signed in as the run's `login` account. */
export async function signedInContext(browser: Browser, login: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const user = await signIn(page, { login });
  return { context, page, user, request: page.request };
}

/** A thread whose root answer has completed, created through the API. */
export async function completedThread(page: Page, prompt: string): Promise<Detail> {
  const workspace = await mutation<{ id: string }>(page.request, "workspaces.ensureDefault", {});
  const detail = await mutation<Detail>(page.request, "research.createTree", {
    prompt,
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  await expect
    .poll(
      async () =>
        (await query<Detail>(page.request, "research.getTree", { treeId: detail.tree.id })).nodes[0]
          ?.run?.status,
    )
    .toBe("complete");
  return detail;
}
