// Owned runs end to end (05 M5a; 02 §3.3, §4; 03 E2-E5, G3, T1-T3) against
// the suite's server, whose run loop answers with fixture providers: an
// ask streams its answer (`paced-answer`), a reload mid-stream and a second
// tab show the same run; Continue, Branch, Branch here, Look up (the phrase,
// never the prompt) and Comment on an answered ask; Stop, then Run again as
// a new attempt.
//
// A question chooses its fixture by a `fixture:<name>` marker
// (`packages/server/src/runs/fixtureProvider.ts`); a branch replays the
// marker of the thread's root.

import { expect, test, type Page } from "@playwright/test";

import { card, compose, openFeed, signInAndOpen, toast } from "./spaces.js";
import { channelName, person, type Writer } from "./world.js";

const LOGIN = "e2e-runs";

const w = {
  me: null as Writer | null,
  space: "",
  name: "",
  /** olga's answered asks with a passage-rich, cited answer: one for the
   * follow-ups, one for the selections, so no test reads another's nodes. */
  follow: "",
  passage: "",
  sol: "",
};

test.beforeAll(async ({ browser }) => {
  const olga = await person(browser, "e2e-runs-olga");
  const sol = await person(browser, "e2e-runs-sol");
  const me = await person(browser, LOGIN);
  w.me = me;
  w.sol = sol.handle;
  w.name = channelName("runs");
  w.space = await olga.channel(w.name);
  for (const p of [me, sol]) await p.join(w.space);
  const follow = await olga.ask(w.space, "fixture:cited-answer what is a bloom filter");
  const passage = await olga.ask(w.space, "fixture:cited-answer how do bloom filters fill");
  w.follow = follow.thread;
  w.passage = passage.thread;
  await olga.answered(w.space, follow.run, passage.run);
});

const side = (page: Page, thread: string) => page.locator(`[data-side="${thread}"]`);
const answer = (page: Page, thread: string) => page.locator(`#pr-${thread}`);

/** The thread id of a card. */
const idOf = async (page: Page, title: string) =>
  (await card(page, title).getAttribute("data-thread")) ?? "";

/** Drags across the first `words` words of a passage of `thread`'s answer. */
async function selectWords(page: Page, thread: string, passage: number, words: number) {
  const box = await answer(page, thread)
    .locator(`[data-passage="${passage}"]`)
    .evaluate((el, n) => {
      const text = el.firstChild as Text;
      const range = document.createRange();
      const ends = [...text.data.matchAll(/\S+/g)].slice(0, n);
      const last = ends[ends.length - 1];
      range.setStart(text, 0);
      range.setEnd(text, (last?.index ?? 0) + (last?.[0].length ?? 0));
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      const r = range.getBoundingClientRect();
      return { x: r.right, y: r.bottom };
    }, words);
  await page.mouse.move(box.x, box.y);
  await page.mouse.up();
}

test("an ask streams its answer; a reload mid-stream and a second tab show the same run", async ({
  page,
}) => {
  await signInAndOpen(page, LOGIN);
  const title = "fixture:paced-answer how does consistent hashing work";
  await compose(page, title);
  const thread = card(page, title);
  await expect(thread.getByText(/^Researching · Step \d of 4$/)).toBeVisible();
  // the text arrives as it is written, before the run ends
  await expect(thread.locator(".runp .partial")).toContainText("Consistent hashing places");
  await expect(thread.getByRole("button", { name: "Stop" })).toBeVisible();

  // a reload in the middle: the replica pulls the run, and `/live` the text
  await page.reload();
  await expect(thread.getByText(/^Researching · Step \d of 4$/)).toBeVisible();
  await expect(thread.locator(".runp .partial")).toContainText("Consistent hashing");

  // a second tab on the same run
  const other = await page.context().newPage();
  await openFeed(other);
  const there = card(other, title);
  await expect(there.locator(".runp .partial")).toContainText("Consistent hashing");

  // both end on the answer
  for (const c of [thread, there]) {
    await expect(c.getByText(/The trade is bookkeeping/)).toBeVisible({ timeout: 30_000 });
    await expect(c.locator(".runp")).toHaveCount(0);
  }
  await other.close();
});

test("Continue, Branch and Comment on an answered ask", async ({ page }) => {
  await signInAndOpen(page, LOGIN);
  const thread = page.locator(`#card-${w.follow}`);
  await thread.scrollIntoViewIfNeeded();
  await thread.getByRole("button", { name: /^Ask a follow-up/ }).click();
  const field = side(page, w.follow).getByRole("textbox", { name: "Ask about the answer" });
  await field.fill("how big does the filter get");
  await field.press("Control+Enter");
  const first = side(page, w.follow).getByRole("treeitem", { name: /how big does the filter get/ });
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(first).toHaveAttribute("aria-level", "1");
  // answered by the run loop
  await expect(side(page, w.follow).locator(".preview")).toContainText("Bloom filters answer set", {
    timeout: 30_000,
  });

  // Continue under it
  await side(page, w.follow).getByRole("button", { name: "Continue" }).click();
  const cont = side(page, w.follow).getByRole("textbox", { name: "Continue ask" });
  await cont.fill("and when it is full");
  await cont.press("Control+Enter");
  const under = side(page, w.follow).getByRole("treeitem", { name: /and when it is full/ });
  await expect(under).toHaveAttribute("aria-level", "2");
  await expect(side(page, w.follow).locator(".preview")).toContainText("Bloom filters answer set", {
    timeout: 30_000,
  });

  // Branch beside it: a sibling, at the same level
  await side(page, w.follow).getByRole("button", { name: "Branch", exact: true }).click();
  const beside = side(page, w.follow).getByRole("textbox", { name: "Ask beside this" });
  await beside.fill("and with deletions");
  await side(page, w.follow).getByRole("button", { name: "Ask", exact: true }).click();
  await expect(
    side(page, w.follow).getByRole("treeitem", { name: /and with deletions/ }),
  ).toHaveAttribute("aria-level", "2");

  // Comment on the first branch: no run
  await first.click();
  await expect(side(page, w.follow).locator(".preview")).toContainText("Bloom filters answer set");
  await side(page, w.follow).getByRole("button", { name: "Comment" }).click();
  const comment = side(page, w.follow).getByRole("textbox", { name: "Comment here" });
  await comment.fill(`Worth a counting filter. @${w.sol}`);
  await side(page, w.follow).getByRole("button", { name: "Comment", exact: true }).last().click();
  await expect(side(page, w.follow).getByText("1 comment")).toBeVisible();
  await expect(toast(page)).toHaveText(`Notified @${w.sol}.`);
});

test("Branch here quotes the selection; Look up on two words shows the phrase, not the prompt", async ({
  page,
}) => {
  await signInAndOpen(page, LOGIN);
  await page.locator(`#card-${w.passage}`).scrollIntoViewIfNeeded();
  await selectWords(page, w.passage, 1, 6);
  await expect(page.getByRole("button", { name: "Look up" })).toHaveCount(0);
  await page.getByRole("button", { name: "Branch here" }).click();
  const field = side(page, w.passage).getByRole("textbox", { name: "Ask about this passage" });
  await expect(field).toBeFocused();
  await expect(side(page, w.passage).locator(".bq")).toContainText(
    "In these systems, a public score",
  );
  await field.fill("which score");
  await field.press("Control+Enter");
  const quoted = side(page, w.passage).getByRole("treeitem", { name: /which score/ });
  await expect(quoted).toHaveAttribute("aria-selected", "true");
  await expect(side(page, w.passage).locator(".preview .bq")).toContainText("In these systems");

  // Look up takes 1 to 4 whole words (`03` G2)
  await selectWords(page, w.passage, 0, 5);
  await expect(page.getByRole("button", { name: "Branch here" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toHaveCount(0);
  await selectWords(page, w.passage, 0, 4);
  await expect(page.getByRole("button", { name: "Look up" })).toBeVisible();
  await selectWords(page, w.passage, 0, 2);
  await page.getByRole("button", { name: "Look up" }).click();
  const row = side(page, w.passage).getByRole("treeitem", { selected: true });
  await expect(row).toContainText("Bloom filters");
  await expect(row.getByTitle("Look up")).toBeVisible();
  await expect(side(page, w.passage).locator(".lookh")).toContainText("Look upBloom filters");
  // the prompt the server built is stored, never shown
  await expect(side(page, w.passage)).not.toContainText("as it is used in this answer");
  await expect(side(page, w.passage).locator(".preview")).toContainText(
    "Bloom filters answer set",
    {
      timeout: 30_000,
    },
  );
  await expect(side(page, w.passage)).not.toContainText("as it is used in this answer");
});

test("Stop ends the run with its partial text; Run again answers it as a new attempt", async ({
  page,
}) => {
  await signInAndOpen(page, LOGIN);
  const title = "fixture:paced-answer what does a ring of hashes do";
  await compose(page, title);
  const thread = card(page, title);
  await expect(thread.locator(".runp .partial")).toContainText("Consistent hashing");
  await thread.getByRole("button", { name: "Stop" }).click();
  await expect(thread.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(thread.locator(".runp .partial")).toContainText("Consistent hashing");
  await expect(thread.getByText(/The trade is bookkeeping/)).toHaveCount(0);
  const id = await idOf(page, title);

  await thread.getByRole("button", { name: "Run again" }).click();
  await expect(thread.getByText(/^(Queued|Researching · Step \d of 4)$/)).toBeVisible();
  await expect(thread.getByText(/The trade is bookkeeping/)).toBeVisible({ timeout: 30_000 });
  await expect(thread.locator(".runp")).toHaveCount(0, { timeout: 30_000 });
  // this thread's root run, not any run of the channel
  const runs = await w.me?.runs(w.space);
  const root = [...(runs?.values() ?? [])].filter((r) => r.th === id && r.node === "r");
  expect(root, `the root run of ${id}`).toHaveLength(1);
  expect(root[0]).toMatchObject({ status: "complete", attempt: 2 });
});
