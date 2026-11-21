// Account invites, sign-up and waiting accounts end to end (02 §12.2
// `spaces-membership`, plan 04 I4): a member's link signs a new person up
// through the auth dialog and the profile step, a sign-in without a code
// waits and reads, redeems a code on "Invite required" and can ask, and a
// used code and an unknown one get the same message.
//
// Members are made with the test sign-in (`SESSION_TEST_AUTH=1`). New
// identities go through the real handshake against the server's fixture
// OAuth provider (`SESSION_FIXTURE_OAUTH=1`): the `session_fixture_identity`
// cookie names the provider account the fixture consent page signs in.

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { e2eLogin, signIn } from "./helpers.js";

const UNUSABLE = "This invite code doesn't work. Ask the person who invited you for a new one.";

/** A context whose next provider sign-in is the fixture account `login`. */
async function asProviderAccount(browser: Browser, login: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "session_fixture_identity", value: login, url: APP_ORIGIN }]);
  return context;
}

/** A handle for this run's account `base`: handles take no dashes. */
function handleFor(base: string): string {
  return e2eLogin(base).replace(/-/g, "_").slice(0, 20);
}

/** Creates an invite link on the Invites page and answers its code. */
async function createInvite(page: Page): Promise<string> {
  await page.goto("/invites");
  const box = page.locator(".invbox");
  await expect(box.getByRole("heading", { name: "Invite someone" })).toBeVisible();
  const before = await box.locator(".ilink").count();
  await box.getByRole("button", { name: /^Create (an invite link|a new link)$/ }).click();
  await expect(page.locator(".feed-toast")).toContainText(
    /Invite SESS-[A-Z2-9]{4}-[A-Z2-9]{2} created\. Send the link to one person\./,
  );
  await expect(box.locator(".ilink")).toHaveCount(before + 1);
  const text = (await page.locator(".feed-toast").textContent()) ?? "";
  const code = /SESS-[A-Z2-9]{4}-[A-Z2-9]{2}/.exec(text)?.[0];
  if (!code) throw new Error(`no code in "${text}"`);
  await expect(box.locator(".ilink code", { hasText: `/i#${code}` })).toBeVisible();
  return code;
}

/** The provider step of the dialog, then back from the fixture provider. */
async function continueWith(page: Page, provider: "GitHub" | "X") {
  const dialog = page.getByRole("dialog", { name: "Sign in to Session" });
  await expect(dialog.getByRole("heading", { name: `Sign in with ${provider}` })).toBeVisible();
  await expect(
    dialog.getByText(
      `Session uses your name, handle and profile picture from ${provider} for your profile. It cannot post or read your messages.`,
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: `Continue to ${provider}` }).click();
}

/** The profile step: name and handle, then Create account. */
async function createAccount(page: Page, name: string, handle: string) {
  const dialog = page.getByRole("dialog", { name: "Sign in to Session" });
  await expect(dialog.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("textbox", { name: /Handle on Session/ }).fill(handle);
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toHaveCount(0);
}

test("a member's link signs a new person up, who appears under the member", async ({
  browser,
  page,
}) => {
  const inviter = await signIn(page, { login: "inviter" });
  const code = await createInvite(page);

  const joinerLogin = e2eLogin("joiner");
  const joinerHandle = handleFor("joiner");
  const context = await asProviderAccount(browser, joinerLogin);
  const joiner = await context.newPage();
  await joiner.goto(`/i#${code}`);
  const dialog = joiner.getByRole("dialog", { name: "Sign in to Session" });
  await expect(dialog.getByText(`${inviter.login} invited you to Session`)).toBeVisible();
  await expect(dialog.getByText(`@${handleFor("inviter")}`)).toBeVisible();
  // The code left the address bar before anything else read the URL.
  expect(joiner.url()).not.toContain("#");
  expect(joiner.url()).not.toContain(code);
  await dialog.getByRole("button", { name: "Continue with GitHub" }).click();
  await continueWith(joiner, "GitHub");

  await expect(dialog.getByText(`Signed in with GitHub as @${joinerLogin}`)).toBeVisible();
  await expect(dialog.getByText(`Invited by ${inviter.login}`)).toBeVisible();
  await createAccount(joiner, "Joiner", joinerHandle);
  await expect(joiner.locator(".feed-toast")).toHaveText(
    `Account created. ${inviter.login} invited you.`,
  );
  // A member: the composer asks.
  await expect(joiner.getByRole("textbox", { name: "Ask or post" })).toHaveAttribute(
    "placeholder",
    "Ask anything",
  );
  await context.close();

  await page.reload();
  const box = page.locator(".invbox");
  await expect(box.getByRole("heading", { name: "You invited" })).toBeVisible();
  await expect(box.locator(".ip", { hasText: joinerHandle })).toContainText("Joined");
  const tree = page.getByRole("list", { name: "Invite tree" });
  await expect(tree.getByRole("listitem").filter({ hasText: joinerHandle })).toHaveAttribute(
    "aria-level",
    /\d+/,
  );
  // The used link is no longer listed as open.
  await expect(box.locator(".ilink code", { hasText: code })).toHaveCount(0);
});

test("without a code an account waits, reads, then redeems a code and can ask", async ({
  browser,
  page,
}) => {
  const inviter = await signIn(page, { login: "host" });
  const code = await createInvite(page);

  const waiterLogin = e2eLogin("waiter");
  const context = await asProviderAccount(browser, waiterLogin);
  const waiter = await context.newPage();
  await waiter.goto("/");
  await waiter.locator("header").getByRole("button", { name: "Sign in" }).click();
  const dialog = waiter.getByRole("dialog", { name: "Sign in to Session" });
  await dialog.getByRole("button", { name: "Sign in with X" }).click();
  await continueWith(waiter, "X");

  await expect(
    dialog.getByRole("heading", { name: `No Session account for @${waiterLogin}` }),
  ).toBeVisible();
  await expect(waiter).toHaveURL(/\/welcome$/);
  await dialog.getByRole("button", { name: "Continue without one" }).click();
  await expect(dialog).toHaveCount(0);

  // A waiting account reads every open channel and cannot ask.
  await expect(waiter.locator(".tcard").first()).toBeVisible();
  await expect(waiter.getByText("You don't have an invite yet.")).toBeVisible();
  await expect(waiter.getByRole("textbox", { name: "Ask or post" })).toHaveCount(0);
  await expect(
    waiter.locator(".tcard").first().getByRole("button", { name: /^Save/ }),
  ).toBeDisabled();

  await waiter.getByRole("button", { name: "Enter a code" }).click();
  await expect(waiter.getByRole("heading", { name: "Invite required" })).toBeVisible();
  await waiter
    .getByRole("textbox", { name: "Invite code" })
    .fill(`${APP_ORIGIN}/i#${code.toLowerCase()}`);
  await waiter.getByRole("button", { name: "Use code" }).click();
  await createAccount(waiter, "Waiter", handleFor("waiter"));
  await expect(waiter.locator(".feed-toast")).toHaveText(
    `You're in. ${inviter.login} invited you.`,
  );
  await expect(waiter).toHaveURL(/\/$/);
  await expect(waiter.getByRole("textbox", { name: "Ask or post" })).toHaveAttribute(
    "placeholder",
    "Ask anything",
  );
  await context.close();
});

test("a used code and an unknown code show the same message", async ({ browser, page }) => {
  await signIn(page, { login: "spender" });
  const code = await createInvite(page);
  // Someone redeems it.
  const first = await asProviderAccount(browser, e2eLogin("first"));
  const firstPage = await first.newPage();
  await firstPage.goto(`/i#${code}`);
  const firstDialog = firstPage.getByRole("dialog", { name: "Sign in to Session" });
  await firstDialog.getByRole("button", { name: "Continue with X" }).click();
  await continueWith(firstPage, "X");
  await createAccount(firstPage, "First", handleFor("first"));
  await first.close();

  const late = await browser.newContext();
  const latePage = await late.newPage();
  await latePage.goto(`/i#${code}`);
  const dialog = latePage.getByRole("dialog", { name: "Sign in to Session" });
  await expect(
    dialog.getByRole("heading", { name: "This invite link no longer works" }),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "It has already been used or was revoked. Ask the person who sent it for a new one.",
    ),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "I have an invite code" }).click();
  await expect(dialog.getByRole("heading", { name: "Join with invite?" })).toBeVisible();
  const field = dialog.getByRole("textbox", { name: "Invite code" });
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter the code from your invite.");
  await field.fill(code);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(UNUSABLE);
  const used = await dialog.getByRole("alert").textContent();
  await field.fill("SESS-ZZZZ-ZZ");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(UNUSABLE);
  expect(await dialog.getByRole("alert").textContent()).toBe(used);
  await expect(dialog.getByRole("button", { name: /^Sign up with/ })).toHaveCount(0);
  await late.close();
});
