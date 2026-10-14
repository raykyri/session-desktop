// The research flow end to end (`12-testing-linting-ci.md` §3.6): launch,
// stream, reload, a second tab, the paired columns of the thread page
// (`09-research-document-view.md`), Branch to right, the server's follow-up
// queue, notes, rerun, keyboard navigation and the recap dialog.
//
// Threads the tests do not launch from Home are created through the API, so
// those tests depend only on the thread page.

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import {
  responseRoot,
  selectAnswerText,
  signIn,
  signInAndOpenHome,
  startResearch,
  waitForAnswer,
} from "./helpers.js";

const MUTATION_HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

async function trpcMutation<T>(page: Page, path: string, input: unknown): Promise<T> {
  const response = await page.request.post(`${APP_ORIGIN}/api/trpc/${path}`, {
    headers: MUTATION_HEADERS,
    data: input ?? {},
  });
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

interface CreatedThread {
  tree: { id: string };
  nodes: { id: string }[];
}

/** Launches a question through the API and opens its thread. */
async function openThread(page: Page, prompt: string): Promise<CreatedThread> {
  const workspace = await trpcMutation<{ id: string }>(page, "workspaces.ensureDefault", {});
  const detail = await trpcMutation<CreatedThread>(page, "research.createTree", {
    prompt,
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  await page.goto(`/r/${detail.tree.id}`);
  return detail;
}

/** Saves a note through the API and opens it. */
async function openNote(page: Page, body: string): Promise<CreatedThread> {
  const workspace = await trpcMutation<{ id: string }>(page, "workspaces.ensureDefault", {});
  const detail = await trpcMutation<CreatedThread>(page, "research.createPost", {
    body,
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  await page.goto(`/r/${detail.tree.id}`);
  return detail;
}

function messageList(page: Page) {
  return page.getByRole("region", { name: /^Messages: / }).getByRole("list", { name: "Messages" });
}

/** The rows of the root level's messages column. */
function messageRows(page: Page) {
  return messageList(page).locator("[data-research-row]");
}

/** A row of the root level's messages column, by its question. */
function messageRow(page: Page, question: string) {
  return messageList(page).getByRole("button", { name: question });
}

function rootComposer(page: Page) {
  return page.getByRole("textbox", { name: "Follow-up in this conversation" });
}

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

test("a thread is a messages column paired with an answer column; the keyboard moves the selection and a reload restores it", async ({
  page,
}) => {
  await signIn(page, { login: "e2e-columns" });
  const { tree } = await openThread(page, "What is a bloom filter?");
  await waitForAnswer(page);

  const messages = page.getByRole("region", { name: /^Messages: / });
  await expect(messages).toBeVisible();
  await expect(page.getByRole("region", { name: /^Answer to: / })).toContainText(
    "probabilistic set-membership structure",
  );

  // ⌘↵ (Ctrl+↵ off Apple platforms) sends a follow-up through the queue,
  // which sends it at once when nothing runs.
  await rootComposer(page).fill("And how is the bit array sized?");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(messageRows(page)).toHaveCount(2, { timeout: 60_000 });
  await waitForAnswer(page);

  // ↑ moves focus to the root message; Enter selects it and shows its answer.
  const followUpRow = messageRow(page, "And how is the bit array sized?");
  await followUpRow.click();
  await expect(followUpRow).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowUp");
  const rootRow = messageRow(page, "What is a bloom filter?");
  await expect(rootRow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rootRow).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(new RegExp(`/r/${tree.id}\\?(.*&)?sel=`));

  // The selection is in the URL: a reload opens the same message.
  await page.reload();
  await expect(rootRow).toHaveAttribute("aria-current", "true");
  await expect(followUpRow).not.toHaveAttribute("aria-current", "true");

  // Back returns to the follow-up selected before.
  await page.goBack();
  await expect(followUpRow).toHaveAttribute("aria-current", "true");
});

test("a highlight is saved, and Branch to right asks about a passage on another model", async ({
  page,
}) => {
  await signIn(page, { login: "e2e-highlight" });
  await openThread(page, "What is a bloom filter?");
  await waitForAnswer(page);

  await selectAnswerText(page);
  const actions = page.locator("[data-research-selection-actions]");
  await expect(actions.getByRole("button", { name: "Highlight" })).toBeVisible();
  // H is the key the toolbar names; pressing it takes the button's path.
  await page.keyboard.press("h");
  await expect(actions).toBeHidden();

  // The highlight is durable: the Highlights feed lists it.
  await page.goto("/highlights");
  await expect(page.getByRole("heading", { name: "Highlights", level: 1 })).toBeVisible();
  const feed = page.locator('[role="feed"][aria-label="Highlights"]');
  await expect(feed.locator("[data-highlight-open]")).toHaveCount(1);
  // Grouped under the thread's title, with Remove and Refresh as on the desktop.
  await expect(feed.getByRole("region")).toHaveCount(1);
  await page.getByRole("button", { name: "Refresh Highlights" }).click();
  await expect(feed.locator("[data-highlight-open]")).toHaveCount(1);
  await feed.locator("article").hover();
  await feed.getByRole("button", { name: "Remove highlight" }).click();
  await expect(
    page.getByText("No highlights. Select text in an answer and choose Highlight."),
  ).toBeVisible();
  await page.goBack();
  await waitForAnswer(page);

  // Branch to right opens a new branch beside the answer, about the passage.
  await selectAnswerText(page);
  await actions.getByRole("button", { name: "Branch to right" }).click();
  const branchQuestion = page.getByRole("textbox", { name: "New branch question" });
  await expect(branchQuestion).toBeFocused();
  await expect(branchQuestion).toHaveAttribute("placeholder", "Ask about this passage");

  // The branch takes its own model.
  await page.getByTitle("Model for this follow-up").last().click();
  await page.getByRole("menuitem", { name: "GPT-5.6 Luna" }).click();
  await expect(page.getByTitle("Model for this follow-up").last()).toContainText("GPT-5.6 Luna");

  await branchQuestion.fill("Why is the rate tunable?");
  await page.keyboard.press("ControlOrMeta+Enter");

  // The branch is the next pair: the branches column lists it beside the
  // answer it was asked from, with its own answer to the right.
  const branches = page.getByRole("region", { name: "Branches" });
  await expect(branches.getByRole("heading", { name: /^Branches ?· 1$/ })).toBeVisible({
    timeout: 60_000,
  });
  await expect(branches.getByRole("button", { name: "Why is the rate tunable?" })).toBeVisible();
  await expect(branches).toContainText("“A Bloom filter is a probabilistic set”");
  await expect(page.getByRole("region", { name: /^Answer to: / })).toHaveCount(2);
  await waitForAnswer(page);
  await expect(page.getByRole("region", { name: /^Answer to: / }).nth(1)).toContainText(
    "probabilistic set-membership structure",
  );
  // The answer it branched from marks the passage in its margin, as open.
  await expect(
    page.getByRole("button", { name: /^1 branch from this paragraph, one is open\./ }),
  ).toBeVisible();
});

test("a follow-up asked while the answer streams is queued on the server; it can be cancelled", async ({
  page,
}) => {
  await signIn(page, { login: "e2e-queue" });
  await openThread(page, "fixture:paced-answer consistent hashing on a ring");

  // While the answer runs, the composer queues rather than refusing. Only the
  // first Queue needs the root still running (a paced answer of about ten
  // seconds); the second queues behind the first whatever the root does, and
  // the first is itself a paced answer, so the second cannot be sent before
  // Cancel reaches it.
  const queued = page.locator("[data-research-queued]");
  await expect(rootComposer(page)).toHaveAttribute("placeholder", "Queue a follow-up");
  await rootComposer(page).fill("fixture:paced-answer And how are virtual nodes placed?");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(queued).toContainText("And how are virtual nodes placed?");
  await rootComposer(page).fill("A question to cancel");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  const cancelled = queued.filter({ hasText: "A question to cancel" });
  await expect(cancelled).toHaveCount(1);
  await cancelled.getByRole("button", { name: "Cancel this queued message" }).click();
  await expect(cancelled).toHaveCount(0);

  // The answer finishes; the server sends the queued question as the next
  // message of the thread, and the cancelled one never.
  await expect(queued).toHaveCount(0, { timeout: 60_000 });
  await expect(messageRows(page)).toHaveCount(2, { timeout: 60_000 });
  await expect(messageRow(page, "And how are virtual nodes placed?")).toBeVisible();
});

test("Edit question on a queued follow-up behind a stopped answer moves it to the ask box", async ({
  page,
}) => {
  await signIn(page, { login: "e2e-queue-edit" });
  await openThread(page, "fixture:paced-answer what is a merkle tree");
  const queued = page.locator("[data-research-queued]");
  await expect(rootComposer(page)).toHaveAttribute("placeholder", "Queue a follow-up");
  await rootComposer(page).fill("How are proofs checked?");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(queued).toContainText("How are proofs checked?");

  // Stopping the answer stalls the queue: the item says so and offers Edit.
  await page.getByRole("button", { name: "Stop", exact: true }).first().click();
  await expect(queued).toContainText("The last answer stopped; retry it, or edit this question.");
  await expect(queued).toContainText("Not sent");
  await queued.getByRole("button", { name: "Edit question" }).click();
  await expect(queued).toHaveCount(0);
  await expect(rootComposer(page)).toHaveValue("How are proofs checked?");
});

test("a note takes follow-up notes, and a double-click edits it; a stale edit is refused", async ({
  page,
}) => {
  await signIn(page, { login: "e2e-note" });
  const { nodes } = await openNote(page, "A note about consistent hashing");
  const note = page.getByRole("region", { name: /^Note: / });
  await expect(note).toContainText("A note about consistent hashing");

  // A follow-up note is added under it; no agent reads it.
  const followUps = page.getByRole("region", { name: "Follow-ups" });
  const field = followUps.getByRole("textbox", { name: "Follow-up" });
  await field.click();
  await followUps.getByRole("radio", { name: "Add a note" }).click();
  await expect(field).toHaveAttribute("placeholder", "Add a note (not visible to agent)");
  await field.fill("Ring positions come from a hash of the node id.");
  await followUps.getByRole("button", { name: "Add note" }).click();
  await expect(followUps).toContainText("Ring positions come from a hash of the node id.");

  // A double-click on the note opens its editor.
  await note.getByText("A note about consistent hashing").dblclick();
  const editor = page.getByRole("textbox", { name: "Note text" });
  await expect(editor).toHaveValue("A note about consistent hashing");

  // Another tab saves first; this edit is refused rather than overwriting it.
  await trpcMutation(page, "research.updatePost", {
    nodeId: nodes[0]?.id,
    text: "A note edited elsewhere",
    expectedText: "A note about consistent hashing",
  });
  await editor.fill("An edit made here");
  await page.getByRole("button", { name: /^Save/ }).click();
  // The refusal offers the latest version and keeps the text.
  const prompt = page.getByRole("dialog", { name: "This note changed" });
  await expect(prompt.getByRole("textbox", { name: "Your text" })).toHaveValue("An edit made here");
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(/the note changed while you were editing/)).toBeVisible();
  await expect(editor).toHaveValue("An edit made here");
});

test("a double-click on a note's card on Home opens the note in the editor", async ({ page }) => {
  await signIn(page, { login: "e2e-note-home" });
  await openNote(page, "A note to edit from Home");
  await page.goto("/");
  const card = page
    .getByRole("feed", { name: "Recent activity" })
    .locator("[data-research-card-hit]")
    .and(page.getByRole("button", { name: /A note to edit from Home/ }))
    .first();
  await card.dblclick();
  await expect(page).toHaveURL(/\/r\//);
  await expect(page.getByRole("textbox", { name: "Note text" })).toHaveValue(
    "A note to edit from Home",
  );
  await expect(page).not.toHaveURL(/edit=/);
});

test("Rerun replaces a complete answer after confirmation", async ({ page }) => {
  await signIn(page, { login: "e2e-rerun" });
  await openThread(page, "What is a bloom filter?");
  await waitForAnswer(page);

  await messageRows(page).first().hover();
  await page.getByRole("button", { name: "Answer actions" }).first().click();
  await page.getByRole("menuitem", { name: "Rerun" }).click();
  const dialog = page.getByRole("dialog", { name: "Rerun" });
  await expect(dialog).toContainText("Rerun will replace the current answer. Continue?");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toBeHidden();

  // The run starts again in place and finishes with a new answer.
  await waitForAnswer(page);
  await expect(responseRoot(page)).toContainText("probabilistic set-membership structure");
  await expect(messageRows(page)).toHaveCount(1);
});

test("the recap dialog generates a candidate and applies it", async ({ page }) => {
  await signIn(page, { login: "e2e-recap" });
  // An answer past `MIN_RECAP_CHARS`, so the run schedules a recap.
  await openThread(page, "fixture:long-answer explain skip lists");
  await waitForAnswer(page);
  // The first recap is written by the metadata model when the run finishes
  // (`04-agent-runtime.md` §9).
  const recap = page.locator(".research-recap-text").first();
  await expect(recap).toContainText("Recap:", { timeout: 60_000 });

  await messageRows(page).first().hover();
  await page.getByRole("button", { name: "Answer actions" }).first().click();
  await page.getByRole("menuitem", { name: "Generate recap" }).click();

  const dialog = page.getByRole("dialog", { name: "Generate recap" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Generate candidate" }).click();

  const apply = dialog.getByRole("button", { name: "Use this recap" });
  await expect(apply).toBeVisible({ timeout: 60_000 });
  await apply.click();

  await expect(dialog).toBeHidden();
  await expect(recap).toContainText("space and error trade-off");
});

test("the home feed is public and personal routes still require a session", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "All Users", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  await page.goto("/highlights");
  await expect(page).toHaveURL(/\/login/);

  await signIn(page, { login: "e2e-guard" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
});
