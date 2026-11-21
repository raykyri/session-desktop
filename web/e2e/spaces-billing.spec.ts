// The weekly allowance end to end (05 M5b; 02 §5, W3.3, W8.1; 03 K6, K8,
// K9): a member who starts a hundred tokens short of the allowance asks;
// the run crosses the allowance, continues on overdraft (billing `pause`)
// and stops at the overdraft limit, ending complete with its partial text
// and the stop note. The app bar ring and the Usage page then read the
// spend, and the next ask is refused in the composer before it is sent,
// with its text kept, while a post still sends.
//
// The server runs with fixture providers (`spending-answer` streams for six
// seconds) and `SESSION_OVERDRAFT_TOKENS=1000` (`playwright.config.ts`);
// `test-login`'s `spent` records the member's earlier spending.

import { expect, test } from "@playwright/test";

import { signIn } from "./helpers.js";
import { card, compose, toast } from "./spaces.js";
import { Writer, channelName, person } from "./world.js";

const ALLOWANCE = 2_000_000;
const OUT_MSG =
  "You're out of tokens until Friday. You can still post, or add an API key in Usage.";
const STOP_NOTE = "Stopped: this week's included tokens ran out.";

test("an ask that crosses the allowance stops with the note; the ring and Usage read the spend; the next ask is refused", async ({
  page,
  browser,
}) => {
  const olga = await person(browser, "e2e-billing-olga");
  const name = channelName("billing");
  const space = await olga.channel(name);
  await olga.post(space, "Spending notes for the week");

  const user = await signIn(page, { login: "e2e-billing", spent: ALLOWANCE - 100 });
  const handle = (user as typeof user & { handle?: string | null }).handle ?? "";
  await new Writer(page.request, { ...user, handle }).join(space);
  await page.goto(`/c/${name}`);
  await expect(card(page, "Spending notes for the week")).toBeVisible();

  const ring = page.getByRole("link", { name: /included tokens left this week/ });
  await expect(ring).toHaveAccessibleName(/^100 of 2M included tokens left this week/);
  await expect(ring).toHaveAttribute("data-tone", "bad");

  await test.step("the ask crosses the allowance and stops at the overdraft limit", async () => {
    const title = "fixture:spending-answer what does a long answer cost";
    await compose(page, title);
    const thread = card(page, title);
    await expect(thread.locator(".runnote")).toHaveText(STOP_NOTE, { timeout: 30_000 });
    await expect(
      thread.getByText(/Tokens are counted while the call runs\./).first(),
    ).toBeVisible();
    await expect(thread.locator(".runp")).toHaveCount(0);
  });

  await test.step("the ring reads the spend", async () => {
    await expect(ring).toHaveAccessibleName(/^0 of 2M included tokens left this week; resets in/);
    await expect(ring).toHaveAttribute("data-tone", "bad");
  });

  await test.step("the out-of-tokens refusal in the composer; a post still sends", async () => {
    const field = page.getByRole("textbox", { name: "Ask or post" });
    await field.fill("one more question this week");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(toast(page, "alert")).toHaveText(OUT_MSG);
    await expect(field).toHaveValue("one more question this week");
    await expect(card(page, "one more question this week")).toHaveCount(0);

    await field.fill("");
    await compose(page, "A post goes out of tokens too", "Post");
    await expect(card(page, "A post goes out of tokens too")).toBeVisible();
  });

  await test.step("the Usage page reads the spend", async () => {
    await page.goto("/usage");
    await expect(page.locator(".usent")).toHaveText(
      /^You have 0% of usage left this week\. Next reset on Fri, in (\d+d )?\d+h\.$/,
    );
    await expect(page.getByRole("img", { name: "0% left" })).toBeVisible();
    const runs = page.getByRole("region", { name: "Recent runs" });
    await expect(
      runs.locator(".urun").filter({ hasText: "what does a long answer cost" }),
    ).toContainText("<1%");
  });
});
