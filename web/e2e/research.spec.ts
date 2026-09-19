// The research flow end to end (`12-testing-linting-ci.md` §3.6): launch,
// stream, reload, a second tab, highlight, ask, a follow-up on another model,
// and the recap dialog.

import { expect, test } from "@playwright/test";

import {
  responseRoot,
  selectAnswerText,
  signIn,
  signInAndOpenHome,
  startResearch,
  waitForAnswer,
} from "./helpers.js";

test("streams run output, renders source citations, and restores state after reload", async ({
  page,
}) => {
  await signInAndOpenHome(page, { login: "e2e-stream" });
  await startResearch(page, "How does a bloom filter bound its false positive rate?");

  await waitForAnswer(page);
  await expect(responseRoot(page)).toContainText("probabilistic set-membership structure");
  // The footer only renders once the node is complete and something was cited.
  await expect(page.getByRole("region", { name: "Sources" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();

  // Persisted text loaded after reload matches streamed output.
  const streamed = (await responseRoot(page).textContent()) ?? "";
  await page.reload();
  await expect(responseRoot(page)).toHaveText(streamed);
});

test("resumes in-flight answer streaming after reload and synchronizes with concurrent tabs", async ({
  page,
  context,
}) => {
  await signInAndOpenHome(page, { login: "e2e-resume" });
  // `fixture:paced-answer` introduces intentional delays between deltas to simulate in-flight streaming.
  const treeId = await startResearch(page, "fixture:paced-answer consistent hashing on a ring");

  const answer = responseRoot(page);
  await expect(answer).toContainText("Consistent hashing", { timeout: 30_000 });
  const partial = (await answer.textContent()) ?? "";
  expect(partial.length).toBeGreaterThan(0);

  // A second tab on the same account picks the run up from the event stream
  // rather than from the first tab.
  const second = await context.newPage();
  await second.goto(`/r/${treeId}`);
  await expect(responseRoot(second)).toContainText("Consistent hashing", { timeout: 30_000 });

  await page.reload();
  // Whatever had arrived before the reload is still there afterwards: the
  // checkpointed turns are replayed and the stream continues from `seq`.
  await expect(answer).toContainText(partial.slice(0, 20), { timeout: 30_000 });

  await waitForAnswer(page);
  await waitForAnswer(second);
  const finished = (await answer.textContent()) ?? "";
  expect(finished).toContain("Virtual nodes smooth the distribution");
  await expect(responseRoot(second)).toHaveText(finished, { timeout: 30_000 });
  await second.close();
});

test("attaches highlight anchor to follow-up prompt and executes on selected model", async ({
  page,
}) => {
  await signInAndOpenHome(page, { login: "e2e-highlight" });
  await startResearch(page, "What is a bloom filter?");
  await waitForAnswer(page);

  await selectAnswerText(page);
  const actions = page.locator("[data-research-selection-actions]");
  await expect(actions.getByRole("button", { name: "Highlight" })).toBeVisible();
  // H is the chord the popover advertises; pressing it is the same path the
  // button takes.
  await page.keyboard.press("h");
  await expect(actions).toBeHidden();

  // The highlight is durable: the Highlights feed lists it.
  await page.goto("/highlights");
  await expect(page.getByRole("heading", { name: "Highlights", level: 1 })).toBeVisible();
  await expect(page.locator('[role="feed"][aria-label="Highlights"] [role="button"]')).toHaveCount(
    1,
  );
  await page.goBack();

  // A on a fresh selection docks the composer beside the passage.
  await selectAnswerText(page);
  await page.keyboard.press("a");
  const followup = page.getByRole("textbox", { name: "Follow-up question" });
  await expect(followup).toBeVisible();
  await expect(followup).toHaveAttribute("placeholder", "Ask about the highlighted text…");

  // A different model for the follow-up: the chip is a menu of the registry.
  await page.getByTitle("Model for this follow-up").click();
  await page.getByRole("menuitem", { name: "GPT-5.6 Luna" }).click();
  await expect(page.getByTitle("Model for this follow-up")).toContainText("GPT-5.6 Luna");

  await followup.fill("Why is the rate tunable?");
  // The submit button's name carries its chord ("Send Command Enter").
  await page.getByRole("button", { name: /^Send/ }).click();

  // A targeted question branches: it becomes a card in the rail beside the
  // passage it was asked about (`09-research-document-view.md` §6).
  const rail = page.getByRole("complementary", { name: "Follow-ups" });
  await expect(rail).toContainText("Why is the rate tunable?", { timeout: 60_000 });

  // The plain composer at the foot of the thread continues it inline instead,
  // and takes its own model.
  await expect(followup).toHaveAttribute("placeholder", "Ask a follow-up…", { timeout: 60_000 });
  await page.getByTitle("Model for this follow-up").click();
  await page.getByRole("menuitem", { name: "DeepSeek V4.1 Flash" }).click();
  await followup.fill("And how is the bit array sized?");
  // Send stays disabled until the field has text, so the fill comes first.
  await expect(page.getByRole("button", { name: /^Send/ })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Send/ }).click();

  await expect(page.locator("[data-research-response-root]")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator("[data-research-response-root]").nth(1)).toContainText(
    "probabilistic set-membership structure",
    { timeout: 60_000 },
  );
});

test("the recap dialog generates a candidate and applies it", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-recap" });
  // Response length exceeds `MIN_RECAP_CHARS`, triggering automated summary generation.
  await startResearch(page, "fixture:long-answer explain skip lists");
  await waitForAnswer(page);
  // "Generate summary" appears only once there is a summary to regenerate: the
  // first one is written by the metadata model when the run finishes
  // (`04-agent-runtime.md` §9).
  await expect(page.locator(".research-summary-text").first()).toContainText("Summary:", {
    timeout: 60_000,
  });

  await page.getByRole("button", { name: "Answer actions" }).first().click();
  await page.getByRole("menuitem", { name: "Generate summary" }).click();

  const dialog = page.getByRole("dialog", { name: "Generate summary" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Generate summary" }).click();

  const apply = dialog.getByRole("button", { name: "Use this summary" });
  await expect(apply).toBeVisible({ timeout: 60_000 });
  await apply.click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".research-summary-text").first()).toContainText(
    "space and error trade-off",
  );
});

test("the home feed is public and personal routes still require a session", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  await page.goto("/bookmarks");
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/highlights");
  await expect(page).toHaveURL(/\/login/);

  await signIn(page, { login: "e2e-guard" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
});
