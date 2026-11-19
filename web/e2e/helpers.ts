// Shared steps for the end-to-end suite (`12-testing-linting-ci.md` §3.6).
//
// Every spec signs in through `POST /auth/test-login` rather than through
// GitHub: the route exists only under `SESSION_TEST_AUTH=1` and mints the same
// session cookie the OAuth callback does, so everything downstream is the
// real thing.

import { expect, test, type Page } from "@playwright/test";

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

/** Signs in and opens Home (the shell's placeholder, phase 2a). */
export async function signInAndOpenHome(page: Page, options: SignInOptions): Promise<SignedInUser> {
  const user = await signIn(page, options);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  return user;
}
