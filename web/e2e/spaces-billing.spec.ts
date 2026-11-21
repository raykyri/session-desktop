// The weekly allowance end to end (05 M5b; 02 §3.3, §5, W3.3, W8.1; 03 K6,
// K8, K9, K10):
//
// - a member who starts a hundred tokens short of the allowance asks; the
//   run crosses the allowance, continues on overdraft (billing `pause`) and
//   stops at the overdraft limit, ending complete with its partial text and
//   the stop note. The app bar ring and the Usage page then read the spend,
//   and the next ask is refused in the composer before it is sent, with its
//   text kept, while a post still sends (in UTC, where the reset is Friday);
// - an ask the server applies with nothing to pay ends `failed { why:
//   "tokens" }`: its asker reads the out-of-tokens copy with the reset's
//   weekday in their own zone (Thursday in Los Angeles), and Run again is
//   refused before it is sent; another member reads the author's copy and
//   has no Run again; with the previous week's reading in the browser (a tab
//   left open across the reset) the copy is in the past tense and Run again
//   is sent, and the server decides;
// - a member with billing `key` and an Anthropic key crosses the allowance
//   between two steps; the Usage page lists the run as "Included +
//   Anthropic key".
//
// The server runs with fixture providers and `SESSION_OVERDRAFT_TOKENS=1000`
// (`playwright.config.ts`); `test-login`'s `spent` records the member's
// earlier spending. `spending-answer` paces 600 deltas 10 ms apart, at
// least six seconds of streaming, but the first run passes allowance plus
// overdraft before the first ledger checkpoint (every 2 s) and stops there.
// The server's clock cannot be moved, so the reset is the browser's: its
// `usage.get` answers are rewritten to name a reset an hour ago.

import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers.js";
import { card, compose, toast } from "./spaces.js";
import { Writer, channelName, person, ulid } from "./world.js";

const ALLOWANCE = 2_000_000;
const OUT_MSG =
  "You're out of tokens until Friday. You can still post, or add an API key in Usage.";
const OUT_MSG_LOS_ANGELES =
  "You're out of tokens until Thursday. You can still post, or add an API key in Usage.";
const TOKENS_PAST = "This ask did not run: included tokens had run out. Run again to start it.";
const TOKENS_OTHER = "This ask did not run: its author had no included tokens left.";
const STOP_NOTE = "Stopped: this week's included tokens ran out.";
const ACCEPTED = "sk-ant-e2e-billing-key-00000000000000a1f9";

/** A member of `space` signed in on `page`, writing as themselves. */
async function member(page: Page, login: string, space: string, spent?: number) {
  const user = await signIn(page, { login, ...(spent === undefined ? {} : { spent }) });
  const handle = (user as typeof user & { handle?: string | null }).handle ?? "";
  const writer = new Writer(page.request, { ...user, handle });
  await writer.join(space);
  return writer;
}

/** An ask on `model`; its run id. */
async function ask(writer: Writer, space: string, q: string, model = "gemini-flash") {
  const r = (await writer.ok("threads.create", {
    id: ulid(),
    space,
    kind: "ask",
    q,
    model,
    effort: "medium",
  })) as { run: string };
  return r.run;
}

/** The sync writes the page sends from now on, by mutator. */
function sentWrites(page: Page): string[] {
  const names: string[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/sync/apply")) return;
    const body = request.postDataJSON() as { envelopes?: { name: string }[] } | null;
    for (const envelope of body?.envelopes ?? []) names.push(envelope.name);
  });
  return names;
}

test.describe("in UTC", () => {
  test.use({ timezoneId: "UTC" });

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

  test("a run with an Anthropic key past the allowance is listed as Included + Anthropic key", async ({
    page,
    browser,
  }) => {
    const olga = await person(browser, "e2e-billing-key-olga");
    const name = channelName("billkey");
    const space = await olga.channel(name);
    const writer = await member(page, "e2e-billing-key", space, ALLOWANCE - 100);

    await test.step("an Anthropic key, and billing on it", async () => {
      await page.goto("/usage");
      const row = page.locator('[data-key="anthropic"]');
      await row.getByRole("button", { name: "Add key" }).click();
      await row.getByLabel("Anthropic API key").fill(ACCEPTED);
      await row.getByRole("button", { name: "Save" }).click();
      await expect(row.getByText("Valid", { exact: true })).toBeVisible();
      await page.getByRole("radio", { name: /Continue on my Anthropic key/ }).check();
      await expect(toast(page)).toHaveText("Asks will continue on your API key.");
    });

    await test.step("the first step spends the allowance; the next runs on the key", async () => {
      // `success-with-tools`: two tool steps, then the answer; its first step
      // reads 900 input tokens, past the 100 left
      const run = await ask(
        writer,
        space,
        "fixture:success-with-tools what crossed the allowance",
        "claude-fable",
      );
      await writer.answered(space, run);
      await page.goto("/usage");
      const runs = page.getByRole("region", { name: "Recent runs" });
      await expect(
        runs.locator(".urun").filter({ hasText: "what crossed the allowance" }),
      ).toContainText(/^.*Included \+ Anthropic key · [A-Z][a-z]{2} \d{1,2}$/);
    });
  });
});

test.describe("west of UTC", () => {
  // Friday 00:00 UTC is Thursday afternoon here.
  test.use({ timezoneId: "America/Los_Angeles" });

  test("a run failed tokens: the asker's copy and refused Run again, another member's copy, and Run again after the reset", async ({
    page,
    browser,
  }) => {
    const olga = await person(browser, "e2e-billing-out-olga");
    const name = channelName("billout");
    const space = await olga.channel(name);
    const writer = await member(page, "e2e-billing-out", space, ALLOWANCE);
    const title = "fixture:success what runs once the week resets";
    // the server applies the ask with nothing to pay (`03` K8)
    const run = await ask(writer, space, title);
    await expect.poll(async () => (await writer.runs(space)).get(run)?.status).toBe("failed");

    await test.step("the asker: the reset's weekday here, and Run again refused", async () => {
      await page.goto(`/c/${name}`);
      const thread = card(page, title);
      await expect(thread.locator("[data-run-status]")).toHaveText(OUT_MSG_LOS_ANGELES);
      const ring = page.getByRole("link", { name: /included tokens left this week/ });
      await expect(ring).toHaveAccessibleName(/^0 of 2M included tokens left this week/);
      const sent = sentWrites(page);
      await thread.getByRole("button", { name: "Run again" }).click();
      await expect(toast(page, "alert")).toHaveText(OUT_MSG_LOS_ANGELES);
      // a refused write is not sent at all: nothing reaches the sync route
      await page.waitForTimeout(500);
      expect(sent).toEqual([]);
      expect((await writer.runs(space)).get(run)?.attempt).toBe(1);
    });

    await test.step("another member reads the author's copy and has no Run again", async () => {
      const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
      const other = await context.newPage();
      await signIn(other, { login: "e2e-billing-out-olga" });
      await other.goto(`/c/${name}`);
      const thread = card(other, title);
      await expect(thread.locator("[data-run-status]")).toHaveText(TOKENS_OTHER);
      await expect(thread.getByRole("button", { name: "Run again" })).toHaveCount(0);
      await context.close();
    });

    await test.step("with the previous week's reading, Run again is sent", async () => {
      // the browser's readings name a reset an hour ago: the week they
      // describe is over
      const past = Date.now() - 3_600_000;
      await page.route("**/api/trpc/**", async (route) => {
        if (!route.request().url().includes("usage.get")) return route.fallback();
        const response = await route.fetch();
        const body = (await response.text()).replace(/"resetAt":\d+/g, `"resetAt":${past}`);
        await route.fulfill({ response, body });
      });
      await page.reload();
      const thread = card(page, title);
      await expect(thread.locator("[data-run-status]")).toHaveText(TOKENS_PAST);
      await expect(
        page.getByRole("link", { name: "Included tokens left this week: unknown" }),
      ).toBeVisible();
      const retried = page.waitForRequest(
        (request) =>
          request.url().includes("/api/sync/apply") &&
          (request.postData() ?? "").includes('"research.retryNode"'),
      );
      await thread.getByRole("button", { name: "Run again" }).click();
      await retried;
      // the server's week has not turned: it writes the new attempt failed
      // tokens again (`03` K8, K10)
      await expect
        .poll(async () => (await writer.runs(space)).get(run))
        .toMatchObject({ attempt: 2, status: "failed" });
    });
  });
});
